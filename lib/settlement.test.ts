import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unexplainedWithholding } from './claim'
import {
  ClaimNotFound,
  NotPermitted,
  acceptInvite,
  createClaim,
  createInvite,
  getClaim,
  toClientClaim,
} from './claims'
import { prisma } from './db'
import type { Op, OpBody } from './ops'
import type { CreateClaimInput } from './schemas'
import { SettlementRefused, clearSettlement, recordSettlement } from './settlement'
import { pullOps, pushOps, replayedClaim } from './sync'

/**
 * Settlement, against a real database.
 *
 * Two things are worth testing here and the rest is bookkeeping: that
 * the owner is the only person who can transcribe a letter, and that
 * recording one leaves the op log and the tables saying the same thing
 * -- because the status moves through the log, not around it.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const input: CreateClaimInput = {
  patientName: 'Amma admission',
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
}

let counter = 0

function op(body: OpBody): Op {
  counter += 1
  return {
    id: `phone-settle:${counter}`,
    deviceId: 'phone-settle',
    by: 'Madhura',
    clock: counter,
    at: '2026-11-13T00:00:00Z',
    after: null,
    body,
  }
}

describe.skipIf(!hasDatabase)('recording a settlement', () => {
  let owner: string
  let cousin: string
  let stranger: string
  const made: string[] = []

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const users = await Promise.all(
      ['settle-owner', 'settle-cousin', 'settle-stranger'].map((who) =>
        prisma.user.create({
          data: { name: who, email: `${who}-${unique}@example.test` },
          select: { id: true },
        }),
      ),
    )
    ;[owner, cousin, stranger] = users.map((u) => u.id)
    made.push(owner, cousin, stranger)
  })

  afterAll(async () => {
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  /** A claim the insurer could actually settle: submitted, not a draft. */
  async function submittedClaim() {
    const { id } = await createClaim(owner, input)
    await pushOps(owner, id, [op({ type: 'set_status', status: 'submitted' })])
    return id
  }

  it('records the figure and the reasons, and settles the claim', async () => {
    const id = await submittedClaim()

    await recordSettlement(owner, id, {
      settledAmountPaise: 2_62_000_00,
      deductions: [
        { amountPaise: 12_000_00, reason: 'Non-medical consumables' },
        { amountPaise: 2_000_00, reason: 'Room rent above eligibility' },
      ],
    })

    const claim = toClientClaim(await getClaim(owner, id))
    expect(claim.status).toBe('settled')
    expect(claim.settlement?.settledAmountPaise).toBe(2_62_000_00)
    // 18,000 withheld, 14,000 of it explained. The remaining 4,000 is
    // the number this whole feature exists to produce.
    expect(unexplainedWithholding(claim, claim.settlement!)).toBe(4_000_00)
  })

  it('moves the claim through the op log, so the family phones see it', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, { settledAmountPaise: 2_80_000_00, deductions: [] })

    const { ops } = await pullOps(owner, id, 0)
    const last = ops[ops.length - 1]
    expect(last.deviceId).toBe('server')
    expect(last.body).toEqual({ type: 'set_status', status: 'settled' })
    // One past everything the phones had, which is what stops a device
    // that was offline from overwriting it on reconnect.
    expect(last.clock).toBeGreaterThan(ops[0].clock)
  })

  it('leaves the log and the tables saying the same thing', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, { settledAmountPaise: 2_70_000_00, deductions: [] })

    const { fromTables, fromLog } = await replayedClaim(owner, id)
    expect(fromLog.status).toBe(fromTables.status)
  })

  it('writes a status event, so the timeline can say when', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, { settledAmountPaise: 2_70_000_00, deductions: [] })

    const events = await prisma.statusEvent.findMany({
      where: { claimId: id },
      orderBy: { at: 'asc' },
    })
    expect(events.map((e) => e.to)).toEqual(['DRAFT', 'SUBMITTED', 'SETTLED'])
  })

  it('refuses to settle a claim that was never submitted', async () => {
    // An insurer cannot pay a claim it has not been sent, and a figure
    // typed against a draft is a figure typed against the wrong claim.
    const { id } = await createClaim(owner, input)
    await expect(
      recordSettlement(owner, id, { settledAmountPaise: 1_00_000_00, deductions: [] }),
    ).rejects.toThrow(SettlementRefused)
    expect((await getClaim(owner, id)).settledAt).toBeNull()
  })

  it('refuses a settlement larger than the final bill', async () => {
    const id = await submittedClaim()
    await expect(
      recordSettlement(owner, id, { settledAmountPaise: 3_00_000_00, deductions: [] }),
    ).rejects.toThrow(/cannot settle more than the final bill/)
  })

  it('refuses deductions that add up to more than was withheld', async () => {
    // The arithmetic on the letter is the thing a family cannot check in
    // their head, so it is checked here before it is believed.
    const id = await submittedClaim()
    await expect(
      recordSettlement(owner, id, {
        settledAmountPaise: 2_79_000_00,
        deductions: [{ amountPaise: 5_000_00, reason: 'Consumables' }],
      }),
    ).rejects.toThrow(/was withheld/)
  })

  it('refuses a negative settlement', async () => {
    const id = await submittedClaim()
    await expect(
      recordSettlement(owner, id, { settledAmountPaise: -1, deductions: [] }),
    ).rejects.toThrow(SettlementRefused)
  })

  it('lets the owner correct a figure without reopening the claim', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, { settledAmountPaise: 2_62_000_00, deductions: [] })
    const first = (await getClaim(owner, id)).settledAt

    await recordSettlement(owner, id, {
      settledAmountPaise: 2_61_000_00,
      deductions: [{ amountPaise: 19_000_00, reason: 'Consumables' }],
    })

    const claim = await getClaim(owner, id)
    expect(claim.settledAmountPaise).toBe(2_61_000_00)
    expect(claim.deductions).toHaveLength(1)
    // When the claim was settled, not when the typo was noticed.
    expect(claim.settledAt).toEqual(first)
    // And no second status op: it was already settled.
    const { ops } = await pullOps(owner, id, 0)
    expect(ops.filter((o) => o.deviceId === 'server')).toHaveLength(1)
  })

  it('replaces the deductions rather than appending to them', async () => {
    const id = await submittedClaim()
    const letter = { settledAmountPaise: 2_60_000_00 }
    await recordSettlement(owner, id, {
      ...letter,
      deductions: [{ amountPaise: 20_000_00, reason: 'Consumables' }],
    })
    await recordSettlement(owner, id, {
      ...letter,
      deductions: [
        { amountPaise: 15_000_00, reason: 'Consumables' },
        { amountPaise: 5_000_00, reason: 'Room rent' },
      ],
    })

    const claim = toClientClaim(await getClaim(owner, id))
    expect(claim.settlement?.deductions).toHaveLength(2)
    expect(unexplainedWithholding(claim, claim.settlement!)).toBe(0)
  })

  it('does not let a contributor record a settlement', async () => {
    const id = await submittedClaim()
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(
      recordSettlement(cousin, id, { settledAmountPaise: 1_00_000_00, deductions: [] }),
    ).rejects.toThrow(NotPermitted)
  })

  it('tells a stranger the claim does not exist', async () => {
    const id = await submittedClaim()
    await expect(
      recordSettlement(stranger, id, { settledAmountPaise: 1_00_000_00, deductions: [] }),
    ).rejects.toThrow(ClaimNotFound)
  })

  it('clears a settlement typed against the wrong claim', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, {
      settledAmountPaise: 2_62_000_00,
      deductions: [{ amountPaise: 18_000_00, reason: 'Consumables' }],
    })

    await clearSettlement(owner, id)

    const claim = toClientClaim(await getClaim(owner, id))
    expect(claim.settlement).toBeNull()
    expect(await prisma.deduction.count({ where: { claimId: id } })).toBe(0)
    // The claim stays settled: an insurer does not un-pay a claim
    // because a family mistyped a figure.
    expect(claim.status).toBe('settled')
  })

  it('does not let a contributor clear one', async () => {
    const id = await submittedClaim()
    await recordSettlement(owner, id, { settledAmountPaise: 2_62_000_00, deductions: [] })
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(clearSettlement(cousin, id)).rejects.toThrow(NotPermitted)
  })
})
