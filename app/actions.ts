'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import {
  ClaimNotFound,
  InviteInvalid,
  NotPermitted,
  acceptInvite,
  createClaim,
  createInvite,
  removeMember,
  revokeInvite,
} from '@/lib/claims'
import { clearSettlement, recordSettlement, SettlementRefused } from '@/lib/settlement'
import { createClaimSchema, settlementSchema } from '@/lib/schemas'

/**
 * Server actions.
 *
 * Each one starts the same way: who is asking, then what they sent. A
 * server action is a public endpoint -- it is reachable by anyone who
 * can post to this origin, not only by the form that renders it -- so
 * the session check is first and the Zod parse is second, every time.
 *
 * They return errors rather than throwing them, because these are
 * mistakes a person makes in a form ("discharge cannot be before
 * admission"), and a thrown error in a server action reaches the browser
 * as a generic failure with the message stripped out in production.
 */

export type ActionResult = { error: string } | { ok: true }

async function requireUserId(): Promise<string> {
  const user = await currentUser()
  // Not an error for the form to render: there is nothing useful to say
  // to someone who is not signed in except "sign in".
  if (!user) redirect('/signin')
  return user.id
}

/**
 * Shaped for `useActionState`, which calls it with the previous result
 * and the form data, so a failed submission can keep what was typed.
 */
export async function createClaimAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId()

  const parsed = createClaimSchema.safeParse({
    patientName: formData.get('patientName'),
    hospital: formData.get('hospital'),
    admittedOn: formData.get('admittedOn'),
    dischargedOn: formData.get('dischargedOn'),
    finalBillPaise: formData.get('finalBill'),
    submissionWindowDays: formData.get('submissionWindowDays'),
  })

  if (!parsed.success) {
    // The first message, not all of them: this form is five fields long
    // and a list of complaints reads worse than the one that matters.
    return { error: parsed.error.issues[0]?.message ?? 'Check the details and try again' }
  }

  const { id } = await createClaim(userId, parsed.data)
  redirect(`/claims/${id}`)
}

export async function createInviteAction(claimId: string): Promise<ActionResult> {
  const userId = await requireUserId()
  try {
    await createInvite(userId, claimId)
  } catch (error) {
    return { error: messageFor(error) }
  }
  revalidatePath(`/claims/${claimId}/family`)
  return { ok: true }
}

export async function revokeInviteAction(
  claimId: string,
  inviteId: string,
): Promise<ActionResult> {
  const userId = await requireUserId()
  try {
    await revokeInvite(userId, inviteId)
  } catch (error) {
    return { error: messageFor(error) }
  }
  revalidatePath(`/claims/${claimId}/family`)
  return { ok: true }
}

export async function removeMemberAction(
  claimId: string,
  memberUserId: string,
): Promise<ActionResult> {
  const userId = await requireUserId()
  try {
    await removeMember(userId, claimId, memberUserId)
  } catch (error) {
    return { error: messageFor(error) }
  }
  revalidatePath(`/claims/${claimId}/family`)
  return { ok: true }
}

export async function acceptInviteAction(token: string): Promise<ActionResult> {
  const userId = await requireUserId()
  let claimId: string
  try {
    ;({ claimId } = await acceptInvite(userId, token))
  } catch (error) {
    return { error: messageFor(error) }
  }
  redirect(`/claims/${claimId}`)
}

function messageFor(error: unknown): string {
  // A refused settlement is arithmetic the family can fix: the letter
  // says one thing and the deductions another, and the sentence saying
  // so is the useful part.
  if (error instanceof SettlementRefused) return error.message
  if (error instanceof NotPermitted) return error.message
  if (error instanceof InviteInvalid) return error.message
  // Including ClaimNotFound: someone who is not in the family is told
  // the same thing whether the claim is missing or merely not theirs.
  if (error instanceof ClaimNotFound) return error.message
  throw error
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

/**
 * The letter from the insurer, typed in.
 *
 * The deductions arrive as two parallel lists, because that is what a
 * repeated pair of inputs posts. Rows left entirely blank are dropped
 * rather than rejected: the form always offers an empty row, and
 * refusing to submit because of one is a form arguing with the person
 * filling it in.
 */
export async function recordSettlementAction(
  claimId: string,
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId()

  const amounts = formData.getAll('deductionAmount').map(String)
  const reasons = formData.getAll('deductionReason').map(String)
  const rows = amounts
    .map((amount, i) => ({ amountPaise: amount.trim(), reason: (reasons[i] ?? '').trim() }))
    .filter((row) => row.amountPaise !== '' || row.reason !== '')

  const parsed = settlementSchema.safeParse({
    settledAmountPaise: formData.get('settledAmount'),
    deductions: rows,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the figures and try again' }
  }

  try {
    await recordSettlement(userId, claimId, parsed.data)
  } catch (error) {
    return { error: messageFor(error) }
  }

  revalidatePath(`/claims/${claimId}`)
  revalidatePath(`/claims/${claimId}/settlement`)
  return { ok: true }
}

export async function clearSettlementAction(claimId: string): Promise<ActionResult> {
  const userId = await requireUserId()
  try {
    await clearSettlement(userId, claimId)
  } catch (error) {
    return { error: messageFor(error) }
  }
  revalidatePath(`/claims/${claimId}`)
  revalidatePath(`/claims/${claimId}/settlement`)
  return { ok: true }
}
