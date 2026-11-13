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
  /**
   * The bytes are in the bucket. False means the row exists but the file
   * is still on the phone that photographed it, which is a normal state
   * here and not an error -- it is what offline uploading looks like.
   */
  stored?: boolean
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
  /** Seeded as a worked example, and said so wherever it shows. */
  isSample?: boolean
  /**
   * Present only once the insurer has paid. Not part of the op log: a
   * settlement is a record of what someone else did, transcribed from a
   * letter by the owner, rather than a field the family edits between
   * themselves on two phones.
   */
  settlement?: Settlement | null
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

/* ------------------------------------------------------------------ *
 * Settlement
 *
 * The end of the story, and the part a family is least equipped to
 * argue with. An insurer almost never pays the whole bill: it settles a
 * figure and sends a letter listing what it took off. The letter's
 * reasons and its arithmetic are two different things, and only the
 * second can be checked.
 *
 * So ClaimKit records both and subtracts. What the insurer withheld,
 * minus the deductions it was willing to name, is money that left the
 * claim with no reason attached -- the one number worth taking back to
 * them.
 * ------------------------------------------------------------------ */

export type Deduction = {
  id: string
  amountPaise: Paise
  /** The insurer's wording, as the family read it off the letter. */
  reason: string
}

export type Settlement = {
  settledAmountPaise: Paise
  /** ISO instant. Display only -- nothing is ordered by it. */
  settledAt: string
  deductions: Deduction[]
}

/** The difference between the hospital bill and what the insurer paid. */
export function amountWithheld(claim: Claim, settlement: Settlement): Paise {
  return claim.finalBillPaise - settlement.settledAmountPaise
}

/** The part of that the insurer gave a reason for. */
export function deductionsTotal(settlement: Settlement): Paise {
  return sum(settlement.deductions.map((d) => d.amountPaise))
}

/**
 * Withheld, less the reasons given. Positive means the insurer kept
 * money it has not explained; this is the figure to put in a grievance.
 *
 * Negative is possible and is not an error: the reasons add up to more
 * than was actually withheld, which usually means a deduction was
 * waived or double-counted, and is just as worth querying.
 */
export function unexplainedWithholding(claim: Claim, settlement: Settlement): Paise {
  return amountWithheld(claim, settlement) - deductionsTotal(settlement)
}

/** The sentence under the settled figure. */
export function settlementNote(claim: Claim, settlement: Settlement): string {
  const withheld = amountWithheld(claim, settlement)
  if (withheld === 0) return 'settled in full, with nothing withheld'

  const unexplained = unexplainedWithholding(claim, settlement)
  if (unexplained === 0) {
    return `${formatRupees(withheld)} withheld, every rupee of it accounted for`
  }
  if (unexplained > 0) {
    return `${formatRupees(withheld)} withheld, of which ${formatRupees(
      unexplained,
    )} has no reason against it`
  }
  return `${formatRupees(withheld)} withheld, but the reasons given add up to ${formatRupees(
    -unexplained,
  )} more`
}
