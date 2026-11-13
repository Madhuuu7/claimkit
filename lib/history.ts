import 'server-only'
import type { ClaimStatus as ClientStatus } from './claim'
import { requireMembership } from './claims'
import { prisma } from './db'
import type { ClaimStatus } from './generated/prisma/enums'

/**
 * What has happened to this claim.
 *
 * Two different records, deliberately not merged into one stream.
 *
 * The **timeline** is the claim's own story: six states, in order, each
 * with the day it was reached. It is short, it is what an insurer asks
 * about on the phone, and it reads as a progression.
 *
 * The **activity log** is everything the family did -- every file, every
 * amount, every tick. It is long, it is written at the time in the words
 * of the claim as it then stood, and it reads as a list, newest first.
 *
 * Interleaving the two would bury "submitted on the 24th" under forty
 * receipts. Both are membership-scoped, by asking the data layer rather
 * than by remembering to add a where clause here.
 */

const TO_CLIENT: Record<ClaimStatus, ClientStatus> = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  QUERY_RAISED: 'query_raised',
  QUERY_RESOLVED: 'query_resolved',
  SETTLED: 'settled',
  REJECTED: 'rejected',
}

export type TimelineEntry = {
  id: string
  from: ClientStatus | null
  to: ClientStatus
  at: Date
  by: string
  note: string | null
}

export type ActivityEntry = {
  id: string
  kind: string
  /** The sentence, already written. Shown after the actor's name. */
  summary: string
  at: Date
  /** Null once the account behind the line has been deleted. */
  by: string | null
}

export type History = {
  timeline: TimelineEntry[]
  activity: ActivityEntry[]
  /** True when the log was cut short, so the page can say so. */
  truncated: boolean
}

/** How many activity lines a page shows before it admits there are more. */
const ACTIVITY_LIMIT = 200

export async function claimHistory(userId: string, claimId: string): Promise<History> {
  await requireMembership(userId, claimId)

  const [events, activity] = await Promise.all([
    prisma.statusEvent.findMany({
      where: { claimId },
      // Oldest first: this is a progression, and reading it backwards
      // would mean reading the claim's story backwards.
      orderBy: { at: 'asc' },
      include: { by: { select: { name: true, email: true } } },
    }),
    prisma.activityLog.findMany({
      where: { claimId },
      orderBy: { at: 'desc' },
      take: ACTIVITY_LIMIT + 1,
      include: { actor: { select: { name: true, email: true } } },
    }),
  ])

  return {
    timeline: events.map((event) => ({
      id: event.id,
      from: event.from ? TO_CLIENT[event.from] : null,
      to: TO_CLIENT[event.to],
      at: event.at,
      by: event.by.name ?? event.by.email ?? 'A family member',
      note: event.note,
    })),
    activity: activity.slice(0, ACTIVITY_LIMIT).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      summary: entry.summary,
      at: entry.at,
      // Null only when the account itself has been deleted. Leaving a
      // family does not take the person's name out of the log: who
      // uploaded this has to stay answerable after the argument.
      by: entry.actor ? (entry.actor.name ?? entry.actor.email ?? null) : null,
    })),
    truncated: activity.length > ACTIVITY_LIMIT,
  }
}
