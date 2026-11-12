import { formatRupees, sum, type Paise } from './money'

/**
 * The domain model. Deliberately free of React, the database and the
 * network, so the rules below can be tested on their own and reused by
 * the offline client without dragging a server in.
 */

export type ClaimStatus =
  | 'draft'
  | 'submitted'
  | 'query_raised'
  | 'query_resolved'
  | 'settled'
  | 'rejected'

export type DocumentKind = 'bill' | 'record'

export type UploadedDoc = {
  id: string
  name: string
  /** Only bills carry an amount; a discharge summary has no rupee value. */
  amountPaise: Paise | null
  uploadedBy: string
  uploadedAt: string
  /** Not yet synced: it exists on this device and nowhere else. */
  pending?: boolean
}

export type ChecklistItem = {
  id: string
  label: string
  kind: DocumentKind
  /** How many files the insurer expects, when the family knows. */
  expected: number | null
  required: boolean
  /**
   * Ticked by hand. Some documents are handed over at the hospital desk
   * and never exist as a file, so the family needs to be able to say
   * "this one is done" without uploading anything. An override, never
   * derived: false means no override, not "not done".
   */
  markedDone?: boolean
  docs: UploadedDoc[]
}

export type Claim = {
  id: string
  patientName: string
  hospital: string
  admittedOn: string
  dischargedOn: string
  /** The final hospital bill, the figure everything reconciles against. */
  finalBillPaise: Paise
  /** Days the policy allows after discharge. Entered, never hardcoded. */
  submissionWindowDays: number
  status: ClaimStatus
  members: { id: string; name: string; initials: string }[]
  items: ChecklistItem[]
}

export type ItemState = 'complete' | 'partial' | 'empty'

export function itemState(item: ChecklistItem): ItemState {
  if (item.markedDone) return 'complete'
  if (item.docs.length === 0) return 'empty'
  if (item.expected !== null && item.docs.length < item.expected) return 'partial'
  return 'complete'
}

/** Bills uploaded so far, in paise. Records contribute nothing. */
export function uploadedTotal(claim: Claim): Paise {
  return sum(
    claim.items.flatMap((i) => i.docs.map((d) => d.amountPaise ?? 0)),
  )
}

/**
 * The gap: money on the hospital bill that no uploaded receipt accounts
 * for. Positive means receipts are missing, which is what gets a claim
 * queried or cut. Negative would mean the uploads exceed the final bill,
 * which is a different mistake and worth saying out loud.
 */
export function unaccounted(claim: Claim): Paise {
  return claim.finalBillPaise - uploadedTotal(claim)
}

export function completeness(claim: Claim): { done: number; total: number } {
  const required = claim.items.filter((i) => i.required)
  return {
    done: required.filter((i) => itemState(i) === 'complete').length,
    total: required.length,
  }
}

/**
 * The last day the insurer will accept this claim. Depends only on the
 * claim itself, so it is safe to prerender -- unlike the countdown.
 */
export type Deadline = Pick<Claim, 'dischargedOn' | 'submissionWindowDays'>

export function dueDate(claim: Deadline): Date {
  // Deliberately all-UTC. Parsing "2026-10-19" gives UTC midnight, so
  // reading it back with local getters lands on the previous day for
  // anyone behind UTC -- which would quietly move every deadline a day
  // earlier for a user in, say, New York. Date.UTC also handles the
  // month overflow, so day 19 + 30 becomes 18 November by itself.
  const [y, m, d] = claim.dischargedOn.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + claim.submissionWindowDays))
}

/**
 * Whole days left to submit, counted in calendar days. Can go negative.
 *
 * "now" is reduced to the viewer's local calendar date, because a family
 * in Bengaluru cares which day it is where they are, not in UTC.
 */
export function daysRemaining(claim: Deadline, now: Date = new Date()): number {
  const localDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((dueDate(claim).getTime() - localDay) / 86_400_000)
}

/**
 * Everything standing between this claim and a clean submission, worst
 * first. This is the sentence the app exists to be able to say.
 */
export type Blocker = { kind: 'gap' | 'missing' | 'partial'; text: string }

export function blockers(claim: Claim): Blocker[] {
  const out: Blocker[] = []
  const gap = unaccounted(claim)

  if (gap > 0) {
    out.push({
      kind: 'gap',
      text: `${formatRupees(gap)} of the hospital bill has no receipt against it`,
    })
  } else if (gap < 0) {
    out.push({
      kind: 'gap',
      text: `Uploaded bills exceed the final bill by ${formatRupees(-gap)}`,
    })
  }

  for (const item of claim.items) {
    if (!item.required) continue
    const state = itemState(item)
    if (state === 'empty') {
      out.push({ kind: 'missing', text: `${item.label} has not been uploaded` })
    } else if (state === 'partial') {
      out.push({
        kind: 'partial',
        text: `${item.label}: ${item.docs.length} of ${item.expected} uploaded`,
      })
    }
  }
  return out
}

export const STATUS_LABEL: Record<ClaimStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  query_raised: 'Query raised',
  query_resolved: 'Query resolved',
  settled: 'Settled',
  rejected: 'Rejected',
}

/** Legal moves. An insurer cannot settle a claim that was never sent. */
export const ALLOWED_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ['submitted'],
  submitted: ['query_raised', 'settled', 'rejected'],
  query_raised: ['query_resolved'],
  query_resolved: ['settled', 'rejected', 'query_raised'],
  settled: [],
  rejected: [],
}

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}
