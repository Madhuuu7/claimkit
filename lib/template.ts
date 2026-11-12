import type { ItemKind } from './generated/prisma/enums'

/**
 * The checklist every new claim starts from.
 *
 * These are the documents a reimbursement claim is generally built out
 * of, in the order an insurer's own form asks for them -- which is also
 * the order of the exported PDF. Nothing here is insurer-specific, and
 * deliberately so: inventing a rule like "Star Health wants two copies"
 * would be a guess dressed up as help. Families add, rename and remove
 * items, because the real list comes from the letter their insurer sent.
 */

export type TemplateItem = {
  label: string
  kind: ItemKind
  /** How many files to expect, when it is knowable in advance. */
  expected: number | null
  required: boolean
}

export const DEFAULT_CHECKLIST: readonly TemplateItem[] = [
  { label: 'Claim form', kind: 'RECORD', expected: 1, required: true },
  { label: 'Final hospital bill', kind: 'BILL', expected: 1, required: true },
  { label: 'Itemised bill', kind: 'RECORD', expected: 1, required: true },
  // However many times the family paid at the counter.
  { label: 'Payment receipts', kind: 'BILL', expected: null, required: true },
  { label: 'Discharge summary', kind: 'RECORD', expected: 1, required: true },
  { label: 'Pharmacy bills', kind: 'BILL', expected: null, required: true },
  { label: 'Lab and investigation reports', kind: 'RECORD', expected: null, required: true },
  { label: 'Doctor prescriptions', kind: 'RECORD', expected: null, required: true },
  { label: 'ID proof', kind: 'RECORD', expected: 1, required: true },
  { label: 'Cancelled cheque', kind: 'RECORD', expected: 1, required: true },
]
