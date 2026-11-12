# ClaimKit

A shared workspace where a family puts together one complete health-insurance
reimbursement claim — built to work in the place the work actually happens: a
hospital corridor with no signal.

> **Status: in progress.** The offline core, the domain rules and the claim
> sheet are built and tested. Auth and the database schema are in. Uploads,
> export, reminders and the deploy are next; see [Where this is](#where-this-is).

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

With the app running:

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

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Cache Components) + TypeScript |
| Styling | Tailwind CSS 4 |
| Database | Postgres (Neon) + Prisma 7 via the Neon HTTP driver adapter |
| Auth | Auth.js (NextAuth v5) with Google, database sessions |
| Validation | Zod |
| Tests | Vitest (112 and counting), Playwright for one end-to-end run |
| Deploy | Vercel |

## Access control

Every row that matters hangs off a `Claim`, and a `Claim` is reached only
through `ClaimMember`. There is no other path in, which makes "a user must
never see another family's claim" a property of the data model rather than a
rule each route has to remember. Every route and server action resolves the
current user to a membership first; a non-member gets a 404, not a 403, because
confirming a claim exists is itself a leak.

Sessions live in the database rather than in a JWT. A JWT costs no query per
request but stays valid until it expires, and this app has one authorisation
decision that has to take effect immediately: an owner removing a family
member. With database sessions, revoking access is a delete.

## Private file storage

Documents are medical records, so the bucket is private and nothing is ever
served from it directly. The browser uploads straight to Cloudflare R2 with a
**presigned URL** scoped to one key, and viewing a file mints a **short-lived
signed URL**. File type (jpg, png, pdf) and size (max 10 MB) are validated on
the server, where the limit cannot be edited by the person uploading.

## Running it locally

```bash
git clone https://github.com/Madhuuu7/claimkit.git
cd claimkit
npm install
cp .env.example .env     # then fill it in, see below
npm run db:migrate       # create the schema
npm run dev
```

`.env` needs four values:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string (host ends in `-pooler`) |
| `AUTH_SECRET` | `npx auth secret` |
| `AUTH_GOOGLE_ID` | Google Cloud → Credentials → OAuth client ID (Web application) |
| `AUTH_GOOGLE_SECRET` | the same client |

The Google client needs `http://localhost:3000/api/auth/callback/google` as an
authorised redirect URI, and the deployed origin's equivalent in production.

No database to hand? `npx prisma dev` runs a real Postgres locally; point
`DATABASE_URL` at what it prints.

```bash
npm test          # unit and integration tests
npm run lint
npm run build
```

## Where this is

Built and tested:

- the operation log, conflict rules and validation (`lib/ops.ts`)
- the durable IndexedDB outbox (`lib/outbox.ts`)
- the sync engine: optimistic edits, rollback, retry with backoff, compaction
  (`lib/engine.ts`)
- the in-browser authoritative server and the switchable network (`lib/server.ts`)
- reconciliation in paise, the deadline arithmetic and the status machine
  (`lib/claim.ts`, `lib/money.ts`)
- the claim sheet, the ledger, the conflict panel and the two-phone demo
- the Postgres schema and Google sign-in

Still to come: claims and membership on the server, invite links, R2 uploads,
the merged PDF export, deadline reminder emails, the settlement and deduction
records, the activity log, the end-to-end test, and the live deploy with a
sample claim.

## Not in scope

OCR of bills, talking to insurer systems, payments.

The live demo is seeded with one example claim using invented data, clearly
marked as a sample. No real medical documents are in this repository or the
demo.
