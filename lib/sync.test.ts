import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uploadedTotal } from './claim'
import { ClaimNotFound, createClaim, toClientClaim, getClaim } from './claims'
import { prisma } from './db'
import type { Op, OpBody } from './ops'
import type { CreateClaimInput } from './schemas'
import { pullOps, pushOps, replayedClaim, snapshotFor } from './sync'

/**
 * The server half of sync, against a real database.
 *
 * What is being checked is not that the functions return the right
 * shape -- it is that the op log and the tables cannot drift apart, that
 * an op is applied exactly once however many times it arrives, and that
 * the server's own state is what decides whether an edit is allowed.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const input: CreateClaimInput = {
  patientName: "Appa's admission",
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
}

let counter = 0

function op(body: OpBody, options: { clock?: number; after?: number | null; device?: string } = {}): Op {
  const device = options.device ?? 'phone-test'
  return {
    id: `${device}:${++counter}`,
    deviceId: device,
    by: 'Madhura',
    clock: options.clock ?? counter,
    at: '2026-11-13T00:00:00Z',
    after: options.after,
    body,
  }
}

const receipt = (amountPaise: number | null = 5_000_00) => ({
  id: `doc-${++counter}`,
  name: `receipt-${counter}.jpg`,
  amountPaise,
  uploadedBy: 'Madhura',
  uploadedAt: '2026-11-13T00:00:00Z',
})

describe.skipIf(!hasDatabase)('pushing operations', () => {
  let owner: string
  let stranger: string
  const made: string[] = []

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const [a, b] = await Promise.all(
      ['sync-owner', 'sync-stranger'].map((who) =>
        prisma.user.create({
          data: { name: who, email: `${who}-${unique}@example.test` },
          select: { id: true },
        }),
      ),
    )
    owner = a.id
    stranger = b.id
    made.push(owner, stranger)
  })

  afterAll(async () => {
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  async function freshClaim() {
    const { id } = await createClaim(owner, input)
    const claim = await getClaim(owner, id)
    const pharmacy = claim.items.find((i) => i.label === 'Pharmacy bills')!
    return { id, pharmacyItemId: pharmacy.id, firstItemId: claim.items[0].id }
  }

  it('records an accepted upload in the log and in the tables', async () => {
    const { id, pharmacyItemId } = await freshClaim()
    const doc = receipt(11_200_00)

    const { results } = await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc }),
    ])

    expect(results[0]).toMatchObject({ ok: true })
    const row = await prisma.document.findUnique({ where: { id: doc.id } })
    expect(row).toMatchObject({ name: doc.name, amountPaise: 11_200_00, claimId: id })
    // The bytes are still on the phone, so the file has no key yet.
    expect(row?.storageKey).toBeNull()

    const { ops } = await pullOps(owner, id, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0].body.type).toBe('add_doc')
  })

  it('applies an op once however many times it arrives', async () => {
    // At-least-once delivery: a lost acknowledgement means the client
    // sends the same upload again, and twice must not mean two receipts.
    const { id, pharmacyItemId } = await freshClaim()
    const theOp = op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(1_000_00) })

    const first = await pushOps(owner, id, [theOp])
    const second = await pushOps(owner, id, [theOp])

    expect(second.results[0]).toEqual(first.results[0])
    expect(await prisma.document.count({ where: { claimId: id } })).toBe(1)
    expect(await prisma.op.count({ where: { claimId: id } })).toBe(1)
  })

  it('refuses an edit its own state will not allow, and writes nothing', async () => {
    const { id, pharmacyItemId } = await freshClaim()

    const { results } = await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(9_00_000_00) }),
    ])

    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]).toHaveProperty('reason', expect.stringContaining('final bill'))
    expect(await prisma.document.count({ where: { claimId: id } })).toBe(0)
    expect(await prisma.op.count({ where: { claimId: id } })).toBe(0)
  })

  it('judges an edit against the server state, not the one the phone had', async () => {
    // The honest offline case: this device priced a receipt that someone
    // else deleted while it had no signal. Nothing local could catch it.
    const { id, pharmacyItemId } = await freshClaim()
    const doc = receipt(2_000_00)
    await pushOps(owner, id, [op({ type: 'add_doc', itemId: pharmacyItemId, doc })])
    await pushOps(owner, id, [op({ type: 'remove_doc', itemId: pharmacyItemId, docId: doc.id })])

    const { results } = await pushOps(owner, id, [
      op({ type: 'set_amount', itemId: pharmacyItemId, docId: doc.id, amountPaise: 3_000_00 }),
    ])

    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]).toHaveProperty('reason', expect.stringContaining('no longer on this claim'))
  })

  it('does not let one refusal undo the good edits around it', async () => {
    const { id, pharmacyItemId } = await freshClaim()
    const good = receipt(1_500_00)
    const tooBig = receipt(9_00_000_00)
    const alsoGood = receipt(2_500_00)

    const { results } = await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: good }),
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: tooBig }),
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: alsoGood }),
    ])

    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    const names = await prisma.document.findMany({
      where: { claimId: id },
      select: { name: true },
    })
    expect(names.map((d) => d.name).sort()).toEqual([alsoGood.name, good.name].sort())
  })

  it('ticks a checklist item that has no file to upload', async () => {
    const { id, firstItemId } = await freshClaim()
    await pushOps(owner, id, [op({ type: 'set_item_done', itemId: firstItemId, done: true })])
    const item = await prisma.checklistItem.findUniqueOrThrow({ where: { id: firstItemId } })
    expect(item.markedDone).toBe(true)
  })

  it('moves the claim through the state machine and records who did it', async () => {
    const { id } = await freshClaim()
    const { results } = await pushOps(owner, id, [op({ type: 'set_status', status: 'submitted' })])
    expect(results[0]).toMatchObject({ ok: true })

    const claim = await prisma.claim.findUniqueOrThrow({ where: { id } })
    expect(claim.status).toBe('SUBMITTED')

    const events = await prisma.statusEvent.findMany({
      where: { claimId: id },
      orderBy: { at: 'asc' },
    })
    // The claim's own creation is the first event; this is the second.
    expect(events.map((e) => e.to)).toEqual(['DRAFT', 'SUBMITTED'])
    expect(events[1]).toMatchObject({ from: 'DRAFT', byId: owner })
  })

  it('refuses a status move the machine forbids', async () => {
    const { id } = await freshClaim()
    const { results } = await pushOps(owner, id, [op({ type: 'set_status', status: 'settled' })])
    expect(results[0]).toMatchObject({ ok: false })
    expect(await prisma.claim.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'DRAFT',
    })
  })

  it('writes an activity line a person can read', async () => {
    const { id, pharmacyItemId } = await freshClaim()
    const doc = receipt(3_200_00)
    await pushOps(owner, id, [op({ type: 'add_doc', itemId: pharmacyItemId, doc })])

    const activity = await prisma.activityLog.findMany({
      where: { claimId: id },
      orderBy: { at: 'asc' },
    })
    expect(activity.map((a) => a.kind)).toEqual(['claim.created', 'add_doc'])
    expect(activity[1].summary).toContain(doc.name)
    expect(activity[1].summary).toContain('Pharmacy bills')
  })

  it('keeps the tables and the log agreeing with each other', async () => {
    // If these two ever disagree, one of them is lying to the family:
    // the checklist and the export read the tables, while the conflict
    // detection reads the log.
    const { id, pharmacyItemId, firstItemId } = await freshClaim()
    const a = receipt(4_000_00)
    const b = receipt(6_000_00)

    await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: a }),
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: b }),
      op({ type: 'set_amount', itemId: pharmacyItemId, docId: a.id, amountPaise: 4_500_00 }),
      op({ type: 'set_item_done', itemId: firstItemId, done: true }),
      op({ type: 'set_status', status: 'submitted' }),
    ])

    const { fromTables, fromLog } = await replayedClaim(owner, id)
    expect(uploadedTotal(fromLog)).toBe(uploadedTotal(fromTables))
    expect(uploadedTotal(fromTables)).toBe(10_500_00)
    expect(fromLog.items.map((i) => i.markedDone)).toEqual(
      fromTables.items.map((i) => i.markedDone),
    )
    expect(fromLog.status).toBe(fromTables.status)
  })

  it('hands a phone a snapshot and the log position it belongs to', async () => {
    const { id, pharmacyItemId } = await freshClaim()
    await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(7_000_00) }),
    ])

    const snapshot = await snapshotFor(owner, id)
    expect(snapshot.seq).toBeGreaterThan(0)
    expect(uploadedTotal(snapshot.claim)).toBe(7_000_00)

    // Nothing new since: a phone that is caught up asks and gets nothing.
    const { ops } = await pullOps(owner, id, snapshot.seq)
    expect(ops).toEqual([])
  })

  it('pages forward from where a phone left off', async () => {
    const { id, pharmacyItemId } = await freshClaim()
    const first = await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(1_000_00) }),
    ])
    const seq = first.results[0].ok ? first.results[0].seq : 0

    await pushOps(owner, id, [
      op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(2_000_00) }),
    ])

    const { ops } = await pullOps(owner, id, seq)
    expect(ops).toHaveLength(1)
  })

  it('tells a stranger the claim does not exist, on both verbs', async () => {
    const { id, pharmacyItemId } = await freshClaim()

    await expect(pullOps(stranger, id, 0)).rejects.toThrow(ClaimNotFound)
    await expect(
      pushOps(stranger, id, [
        op({ type: 'add_doc', itemId: pharmacyItemId, doc: receipt(100) }),
      ]),
    ).rejects.toThrow(ClaimNotFound)
    expect(await prisma.document.count({ where: { claimId: id } })).toBe(0)
  })

  it('does not let an op name a checklist item from another claim', async () => {
    // The id is a string a client sent, so it is checked against this
    // claim rather than trusted to belong to it.
    const mine = await freshClaim()
    const other = await freshClaim()

    const { results } = await pushOps(owner, mine.id, [
      op({ type: 'add_doc', itemId: other.pharmacyItemId, doc: receipt(100) }),
    ])

    expect(results[0]).toMatchObject({ ok: false })
    expect(await prisma.document.count({ where: { claimId: mine.id } })).toBe(0)
  })

  it('leaves the snapshot a phone replays over in the engine shape', async () => {
    const { id } = await freshClaim()
    const { claim } = await snapshotFor(owner, id)
    const sheet = toClientClaim(await getClaim(owner, id))
    expect(claim).toEqual(sheet)
  })
})
