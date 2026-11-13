import 'server-only'
import {
  blockers,
  daysRemaining,
  dueDate,
  unaccounted,
  type Claim as ClientClaim,
} from './claim'
import { claimForJob, toClientClaim } from './claims'
import { prisma } from './db'
import { sendEmail, type Message } from './email'
import { formatRupees } from './money'

/**
 * The deadline reminder.
 *
 * A family misses the window because nobody is counting, so something
 * has to count for them. Twice: once with a week left, while there is
 * still time to go back to the hospital for a missing bill, and once
 * with two days left, when the only thing that helps is submitting what
 * there is.
 *
 * Three decisions hold this together.
 *
 * **Only unsubmitted claims.** A claim already with the insurer has no
 * deadline left to miss, and a reminder about it is noise that teaches
 * the family to ignore the next one.
 *
 * **Bands, not exact days.** The seven-day reminder goes out at any
 * point from seven days left down to three, and the two-day one from two
 * days down to the deadline itself. A cron that misses a day -- a failed
 * deploy, a platform incident -- would otherwise skip a family's only
 * warning entirely, which is the one failure this feature cannot have.
 *
 * **A row per reminder sent.** The unique index on (claim, band) is what
 * makes the job idempotent, so a retry after a timeout, or two
 * invocations racing, cannot email the same family twice. Checking a
 * timestamp in application code would not: both would read "not sent".
 */

/** The two bands, in the order they are reached. */
export const BANDS = [
  { daysBefore: 7, from: 7, to: 3 },
  { daysBefore: 2, from: 2, to: 0 },
] as const

export type Band = (typeof BANDS)[number]

/** Which band a claim is in today, or null if it is in neither. */
export function bandFor(
  claim: Parameters<typeof daysRemaining>[0],
  now: Date = new Date(),
): Band | null {
  const left = daysRemaining(claim, now)
  return BANDS.find((band) => left <= band.from && left >= band.to) ?? null
}

/* ------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function appUrl(): string {
  // Set explicitly in production. The Vercel-provided host is the
  // fallback so a preview deployment still sends links to itself rather
  // than to localhost.
  const configured = process.env.APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!configured) return 'http://localhost:3000'
  return configured.startsWith('http') ? configured : `https://${configured}`
}

function daysPhrase(left: number): string {
  if (left <= 0) return 'today'
  if (left === 1) return 'tomorrow'
  return `in ${left} days`
}

/**
 * What the email says.
 *
 * Pure, so it can be read in a test rather than in an inbox. It is
 * short on purpose: the deadline, what is still missing, and a link.
 * Anything longer gets skimmed, and the whole message is one sentence
 * of actual news.
 */
export function reminderMessage(
  claim: ClientClaim,
  now: Date = new Date(),
): Omit<Message, 'to'> {
  const left = daysRemaining(claim, now)
  const due = dueDate(claim).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const gap = unaccounted(claim)
  const problems = blockers(claim).slice(0, 6)
  const link = `${appUrl()}/claims/${claim.id}`

  const subject =
    left <= 0
      ? `Last day to submit ${claim.patientName}'s claim`
      : `${left} ${left === 1 ? 'day' : 'days'} left to submit ${claim.patientName}'s claim`

  const opening =
    `The window for ${claim.patientName}'s claim at ${claim.hospital} closes ` +
    `${daysPhrase(left)}, on ${due}.`

  const money =
    gap > 0
      ? `${formatRupees(gap)} of the hospital bill still has no receipt against it.`
      : 'Every rupee on the bill has a receipt against it.'

  const text = [
    opening,
    '',
    money,
    '',
    problems.length > 0 ? 'Still outstanding:' : 'Nothing is outstanding.',
    ...problems.map((problem) => `  - ${problem.text}`),
    '',
    `Open the claim: ${link}`,
    '',
    'You are getting this because you are on this claim in ClaimKit.',
  ].join('\n')

  const html = [
    '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#13211f;max-width:34rem">',
    `<p>${escapeHtml(opening)}</p>`,
    `<p style="color:${gap > 0 ? '#a8620e' : '#5d6b67'}">${escapeHtml(money)}</p>`,
    problems.length > 0
      ? `<p style="color:#5d6b67">Still outstanding:</p><ul style="color:#5d6b67">${problems
          .map((problem) => `<li>${escapeHtml(problem.text)}</li>`)
          .join('')}</ul>`
      : '',
    `<p><a href="${escapeHtml(link)}" style="color:#0b5e55">Open the claim</a></p>`,
    '<p style="color:#8d9894;font-size:13px">You are getting this because you are on this claim in ClaimKit.</p>',
    '</div>',
  ].join('')

  return { subject, text, html }
}

/* ------------------------------------------------------------------ *
 * The job
 * ------------------------------------------------------------------ */

export type ReminderOutcome = {
  claimId: string
  daysBefore: number
  recipients: number
  failures: string[]
}

export type ReminderRun = {
  considered: number
  sent: ReminderOutcome[]
  /** Claims in a band that had already been reminded for it. */
  alreadySent: number
  configured: boolean
}

/** How far back to look. A window longer than this is not a policy. */
const MAX_WINDOW_DAYS = 400

export async function sendReminders(now: Date = new Date()): Promise<ReminderRun> {
  const candidates = await prisma.claim.findMany({
    // Unsubmitted only. Anything the insurer already has cannot miss
    // this deadline.
    where: {
      status: 'DRAFT',
      dischargedOn: { gte: new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000) },
    },
    select: { id: true, dischargedOn: true, submissionWindowDays: true },
  })

  const run: ReminderRun = {
    considered: candidates.length,
    sent: [],
    alreadySent: 0,
    configured: true,
  }

  for (const candidate of candidates) {
    const band = bandFor(
      {
        dischargedOn: candidate.dischargedOn.toISOString().slice(0, 10),
        submissionWindowDays: candidate.submissionWindowDays,
      },
      now,
    )
    if (!band) continue

    // Claimed before anything is sent, so a second invocation finds the
    // row and stops. The send may still fail afterwards, and that is the
    // right way round: a reminder that was not sent is a disappointment,
    // one sent twice is a product that cries wolf.
    let claimed: boolean
    try {
      await prisma.reminder.create({
        data: { claimId: candidate.id, daysBefore: band.daysBefore },
      })
      claimed = true
    } catch {
      claimed = false
    }

    if (!claimed) {
      run.alreadySent += 1
      continue
    }

    const detail = await claimForJob(candidate.id)
    if (!detail) continue

    const claim = toClientClaim(detail)
    const message = reminderMessage(claim, now)
    const recipients = detail.members
      .map((member) => member.user.email)
      .filter((email): email is string => Boolean(email))

    const outcome: ReminderOutcome = {
      claimId: candidate.id,
      daysBefore: band.daysBefore,
      recipients: 0,
      failures: [],
    }

    for (const to of recipients) {
      const result = await sendEmail({ ...message, to })
      if (result.ok) {
        outcome.recipients += 1
      } else {
        outcome.failures.push(result.reason)
        if (!result.configured) run.configured = false
      }
    }

    await prisma.reminder.update({
      where: { claimId_daysBefore: { claimId: candidate.id, daysBefore: band.daysBefore } },
      data: { recipients: outcome.recipients },
    })

    run.sent.push(outcome)
  }

  return run
}
