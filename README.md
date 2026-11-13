# ClaimKit

A shared workspace where a family puts together one complete health-insurance
reimbursement claim — built to work in the place the work actually happens: a
hospital corridor with no signal.

![The claim sheet: a ₹6,400 gap between the hospital bill and the receipts
uploaded against it, above a ledger of the documents the insurer
expects](docs/sheet.png)

> **Live at [claimkit-sepia.vercel.app](https://claimkit-sepia.vercel.app).**
> The [demo](https://claimkit-sepia.vercel.app/demo) needs no account: it runs
> on invented data and lets you cut the signal yourself. Signing in is by
> Google, and the OAuth client is still in Google's testing mode, so only
> listed test accounts get past the consent screen. Behind it: 266 unit and
> integration tests against a real Postgres, plus an end-to-end run in a
> browser. File storage and reminder email are not configured on the live
> deployment — see [Deploying](#deploying).

## The problem

When a family member is treated at a hospital outside the insurer's network,
the family pays upfront and must claim the money back. They must submit
original bills, the discharge summary, pharmacy receipts and lab reports within
a deadline set by the policy. These papers end up spread across several family
members' phones. A missing document triggers an insurer query or a reduced
payout. Insurer apps only handle their own policies, and one user at a time.

ClaimKit lets the whole family build one complete claim together.

## Why it is built this way

A claim is assembled in a ward, in a corridor, at a pharmacy counter — places
where a phone has one bar or none. An app that needs the network to accept a
tap is an app that loses the receipt. So the client here does not send "the new
claim" to a server and wait:

- Every edit becomes an **operation** in a log, written to **IndexedDB before
  it is sent**, and acknowledged by the server later.
- What you see is always `replay(last snapshot from the server, server ops +
  my outbox)`. An optimistic edit is an op that has not been acknowledged yet,
  so **rolling one back is replaying the log without it** — there is no undo
  path to get wrong.
- Operations are ordered by a **Lamport clock**, not wall time, because phone
  clocks disagree by minutes and a fast one would otherwise win every conflict
  forever. Ties break on device id, so every device lands on the same order.
- Each write to a single-value field carries the clock of the value it was
  typed over — the same idea as an ETag in `If-Match`. That is what separates
  **an edit** ("I changed the amount after seeing yours") from **a conflict**
  ("we both changed it without seeing each other").
- A conflict converges on the later write, but **the losing value is kept and
  shown**. Two people typing different figures for one receipt is how a family
  posts the wrong number to an insurer, and software cannot know which figure
  is right. A person chooses; the choice is an ordinary write that causally
  dominates both sides, so it clears on every device.
- Delivery is at-least-once, so the server sees the same op twice whenever an
  acknowledgement is what got lost. Every op carries an **idempotency key**.

Money is an integer number of paise everywhere — never a float. The whole point
of the app is to tell a family that ₹6,400 is missing, a number arrived at by
subtraction, and binary floating point cannot represent 0.1.

Dates are all-UTC. A first version read a UTC-parsed date with local getters
and moved every deadline a day earlier for anyone behind UTC; the suite now
runs under both IST and `America/New_York`.

## Try the offline behaviour

The demo runs the authoritative server **in the browser**, on purpose: the
interesting half of this app is what the client does when the wire is cut, and
you cannot ask a visitor to pull a cable. It still holds the op log, validates
every op against its own state rather than trusting the client's, hands out the
sequence numbers clients page through, and is idempotent on op id — so swapping
in an HTTP endpoint is a change of transport, not of design.

With the app running, at `/demo`:

1. **Cut the signal** (the switch in the bottom bar) and add a pharmacy
   receipt. It lands on the sheet at once, the gap at the top moves, and the
   bar says one edit is waiting.
2. **Reload the page.** The edit is still queued — it was on disk before it was
   ever sent.
3. **Turn the signal back on.** The queue drains and "waiting for signal"
   disappears.
4. **Open the second phone**, cut its signal and yours, change the same
   receipt's amount on both, then reconnect. Both phones raise the same
   conflict, with the same winner, each side labelled from that device's point
   of view. Choose a figure on one; the other picks it up on its next poll.
5. **Tick "Lose the server's replies"** and add a file. The server applies it
   and the reply never arrives, so the client sends it again — and the receipt
   appears exactly once.

## What is in it

| | |
|---|---|
| **The cover sheet** | One claim per hospital stay. The gap between the final bill and the receipts against it is the single loud element on the page. |
| **The ledger** | The documents the insurer expects, each with its files and amounts. An item can be ticked by hand, for a paper handed over at the desk that never existed as a file. |
| **The family** | Invite by link, revoke a link, remove a member. Removal takes effect on every device immediately. |
| **Uploads** | Straight from the phone to a private bucket, in a queue of their own so a 9 MB scan cannot hold up a tick. |
| **Export** | The whole claim as one PDF: an index page first, giving the page each document starts on, then the documents in checklist order. |
| **Settlement** | The insurer's letter, transcribed. What they withheld, less the deductions they named, is money that left the claim with no reason attached. |
| **History** | Where the claim has been, and everything the family did to it, in the words written at the time. |
| **Reminders** | A daily sweep emails the family a week out and two days out, unsubmitted claims only. |

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Cache Components) + TypeScript |
| Styling | Tailwind CSS 4 |
| Database | Postgres (Neon) + Prisma 7 via the Neon HTTP driver adapter |
| Auth | Auth.js (NextAuth v5) with Google, database sessions |
| Files | Cloudflare R2, presigned uploads, signed short-lived views |
| Email | Resend, from a Vercel Cron job |
| Validation | Zod |
| Tests | Vitest (266, against a real Postgres) + one Playwright end-to-end run |
| Deploy | Vercel |

## Access control

Every row that matters hangs off a `Claim`, and a `Claim` is reached only
through `ClaimMember`. There is no other path in, which makes "a user must
never see another family's claim" a property of the data model rather than a
rule each route has to remember. Every route and server action resolves the
current user to a membership first; a non-member gets a 404, not a 403, because
confirming a claim exists is itself a leak.

There is exactly one query in the codebase that is not scoped by membership,
and it is named `claimForJob` so it can be found: the reminder sweep runs on a
schedule with nobody asking, and turns what it reads into an email addressed to
people who are already members.

Sessions live in the database rather than in a JWT. A JWT costs no query per
request but stays valid until it expires, and this app has one authorisation
decision that has to take effect immediately: an owner removing a family
member. With database sessions, revoking access is a delete. It also means the
end-to-end test can sign in by writing the row Auth.js would have written,
instead of the app carrying a test-only back door.

## Private file storage

Documents are medical records, so the bucket is private and nothing is ever
served from it directly. The browser uploads straight to Cloudflare R2 with a
**presigned URL** scoped to one key, one content type and one exact length, and
viewing a file mints a **two-minute signed URL**. File type (jpg, png, pdf) and
size (max 10 MB) are validated on the server, where the limit cannot be edited
by the person uploading. The server HEADs the bucket before it records that a
file arrived.

## Running it locally

```bash
git clone https://github.com/Madhuuu7/claimkit.git
cd claimkit
npm install
cp .env.example .env     # then fill it in
npm run db:migrate       # create the schema
npm run dev
```

Only three values are needed to sign in and use the app: `DATABASE_URL`,
`AUTH_SECRET` (`npx auth secret`) and a Google OAuth client. The rest of
`.env.example` is optional and the app says so rather than breaking: with no
R2, a chosen file stays on the phone and the claim still reconciles; with no
Resend key, the reminder sweep runs and records what it would have sent.

The Google client needs `http://localhost:3000/api/auth/callback/google` as an
authorised redirect URI, and the deployed origin's equivalent in production.

No database to hand? `npx prisma dev --name claimkit` runs a real Postgres
locally and prints the connection string. Two warnings, both paid for: use
`connect_timeout=5` rather than the `0` it suggests, because zero means *wait
forever* and a dead database then hangs the test suite instead of failing it;
and it is an experimental SQLite-backed server that wedges under sustained
load — still listening, resetting every connection — at which point restart it.
Auth.js reports a dead database as *nobody is signed in*, so that is the first
thing to suspect when the app offers to sign you in while the header already
knows your name.

```bash
npm test          # unit and integration tests
npm run test:e2e  # the browser run; needs the app's database
npm run lint
npm run build
```

## Deploying

The app is built for Vercel and carries its own cron schedule in
`vercel.json`.

1. Create a Neon database and run `npx prisma migrate deploy` against it. Use
   the **pooled** connection string (the host ends in `-pooler`): a serverless
   function is a process that lives for one request, and an unpooled host runs
   out of connections long before it runs out of traffic. `lib/db.ts` picks
   Neon's HTTP driver from the hostname, so nothing else changes.
2. Create a Google OAuth client and add `https://<origin>/api/auth/callback/google`
   as an authorised redirect URI.
3. Set the environment variables from `.env.example` in the Vercel project.
   `CRON_SECRET` is what the daily sweep checks; without it the endpoint
   refuses every request in production.
4. Deploy. `vercel.json` pins the functions to `sin1`, beside the database
   in Neon's Singapore region. The cron entry runs `/api/cron/reminders` at 03:30 UTC, which is
   09:00 in India — a morning there rather than the middle of one.

A new account is given a sample claim to look at: a six-day admission, most of
its documents gathered, ₹6,400 unaccounted for. It is labelled as a sample
above the claim, in the list and on the first page of the export, and it is an
ordinary claim in the ordinary tables — every button on it does the real thing,
and deleting it leaves nothing behind.

## Tests

```
266 passing — lib/claim, money, ops, outbox, engine, sync, claims,
settlement, family, history, reminders, sample, export, uploader
```

The access-control, sync and settlement suites run against a **real Postgres**,
because what they test is not a function — it is whether the *queries* can
reach another family's claim. A mocked Prisma client would answer a question
nobody asked. Without `DATABASE_URL` they skip, so a contributor with no
database can still run the unit tests; CI always has one.

The single Playwright run creates a claim in the form, uploads a file, ticks a
document off, checks that the tick reached Postgres rather than React state,
and downloads the exported PDF.

## Not in scope

OCR of bills, talking to insurer systems, payments.

The sample claim uses invented data and is clearly marked. No real medical
documents are in this repository or in the demo.
