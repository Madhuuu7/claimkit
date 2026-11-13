import 'server-only'
import { formatRupees } from './money'
import { ClaimNotFound, NotPermitted, getClaim, requireOwner, toClientClaim } from './claims'
import { prisma } from './db'
import type { SettlementInput } from './schemas'
import { appendServerOp } from './sync'

/**
 * Recording what the insurer actually paid.
 *
 * This is the one write in ClaimKit that is not a family editing their
 * own claim. It is a transcription: a letter arrives saying "settled
 * ₹2,41,300, deducted ₹18,000 non-medical consumables", and the owner
 * copies it in. So it is owner-only, and it is checked like a
 * transcription rather than like a form -- the arithmetic on the letter
 * is exactly the thing worth catching.
 *
 * Moving the claim to settled goes through the op log rather than
 * straight into the column, so the phones in the family see it the same
 * way they see each other's edits, and the log and the tables stay in
 * step. See appendServerOp.
 */

export class SettlementRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementRefused'
  }
}

export async function recordSettlement(
  userId: string,
  claimId: string,
  input: SettlementInput,
): Promise<void> {
  await requireOwner(userId, claimId)

  const detail = await getClaim(userId, claimId)
  const claim = toClientClaim(detail)

  if (input.settledAmountPaise < 0) {
    throw new SettlementRefused('A settled amount cannot be negative')
  }
  if (input.settledAmountPaise > claim.finalBillPaise) {
    // Not a rule of the insurer's: a settlement larger than the bill
    // means the final bill on this claim is wrong, and silently
    // accepting it would make the reconciliation say nothing.
    throw new SettlementRefused(
      `The insurer cannot settle more than the final bill of ${formatRupees(
        claim.finalBillPaise,
      )}. Correct the bill first.`,
    )
  }

  const withheld = claim.finalBillPaise - input.settledAmountPaise
  const deducted = input.deductions.reduce((total, d) => total + d.amountPaise, 0)
  if (deducted > withheld) {
    throw new SettlementRefused(
      `The deductions come to ${formatRupees(deducted)}, but only ${formatRupees(
        withheld,
      )} was withheld`,
    )
  }

  // Already settled: the owner is correcting a figure they mistyped, or
  // adding a deduction off the second page of the letter. There is no
  // status to move, and refusing would leave the wrong number on screen
  // with no way to fix it.
  const alreadySettled = claim.status === 'settled'

  if (!alreadySettled) {
    const outcome = await appendServerOp(
      userId,
      claimId,
      { type: 'set_status', status: 'settled' },
      'The insurer',
    )
    if (!outcome.ok) throw new SettlementRefused(outcome.reason)
  }

  await prisma.$transaction(async (tx) => {
    await tx.claim.update({
      where: { id: claimId },
      data: {
        settledAmountPaise: input.settledAmountPaise,
        // Kept at the first recording: this is when the claim was
        // settled, not when the owner last corrected a typo.
        settledAt: detail.settledAt ?? new Date(),
      },
    })

    // Replaced wholesale rather than diffed. The deductions are one
    // list copied off one letter; a half-updated list is a figure that
    // belongs to no letter at all.
    await tx.deduction.deleteMany({ where: { claimId } })
    if (input.deductions.length > 0) {
      await tx.deduction.createMany({
        data: input.deductions.map((d) => ({
          claimId,
          amountPaise: d.amountPaise,
          reason: d.reason,
        })),
      })
    }

    await tx.activityLog.create({
      data: {
        claimId,
        actorId: userId,
        kind: alreadySettled ? 'settlement.corrected' : 'settlement.recorded',
        summary: alreadySettled
          ? `corrected the settlement to ${formatRupees(input.settledAmountPaise)}`
          : `recorded a settlement of ${formatRupees(input.settledAmountPaise)}`,
      },
    })
  })
}

/** Undo a settlement typed against the wrong claim. Owner only. */
export async function clearSettlement(userId: string, claimId: string): Promise<void> {
  await requireOwner(userId, claimId)

  const detail = await getClaim(userId, claimId)
  if (detail.settledAt === null) throw new ClaimNotFound()
  if (detail.status !== 'SETTLED') {
    throw new NotPermitted('This claim is not settled')
  }

  // The status stays where it is. A settled claim is terminal in the
  // state machine on purpose, and reopening one is not a thing an
  // insurer does because a family mistyped a figure -- the figure is
  // what gets cleared, so it can be entered again.
  await prisma.$transaction(async (tx) => {
    await tx.deduction.deleteMany({ where: { claimId } })
    await tx.claim.update({
      where: { id: claimId },
      data: { settledAmountPaise: null, settledAt: null },
    })
    await tx.activityLog.create({
      data: {
        claimId,
        actorId: userId,
        kind: 'settlement.cleared',
        summary: 'cleared the settlement figures',
      },
    })
  })
}
