import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClaimNotFound,
  acceptInvite,
  createClaim,
  createInvite,
  getClaim,
  removeMember,
} from './claims'
import { prisma } from './db'
import { claimHistory } from './history'
import type { Op, OpBody } from './ops'
import type { CreateClaimInput } from './schemas'
import { recordSettlement } from './settlement'
import { pushOps } from './sync'

/**
 * The history page's two records.
 *
 * The thing worth testing is that both survive the claim changing
 * underneath them: a renamed label, a deleted document, a family member
 * who left. An activity log that stops making sense the moment someone
 * is removed is an activity log nobody can use in an argument.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const input: CreateClaimInput = {
  patientName: 'Paati admission',
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
}

let counter = 0

function op(body: OpBody, device = 'phone-history'): Op {
  counter += 1
  return {
    id: `${device}:${counter}`,
    deviceId: device,
    by: 'Madhura',
    clock: counter,
    at: '2026-11-13T00:00:00Z',
    after: null,
    body,
  }
}

describe.skipIf(!hasDatabase)('the history of a claim', () => {
  let owner: string
  let cousin: string
  let stranger: string
  const made: string[] = []

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const users = await Promise.all(
      ['history-owner', 'history-cousin', 'history-stranger'].map((who) =>
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

  it('starts the timeline at draft, with nobody having moved it there', async () => {
    const { id } = await createClaim(owner, input)
    const { timeline } = await claimHistory(owner, id)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].from).toBeNull()
    expect(timeline[0].to).toBe('draft')
  })

  it('reads the timeline forwards, as a progression', async () => {
    const { id } = await createClaim(owner, input)
    await pushOps(owner, id, [op({ type: 'set_status', status: 'submitted' })])
    await pushOps(owner, id, [op({ type: 'set_status', status: 'query_raised' })])
    await recordSettlement(owner, id, {
      settledAmountPaise: 2_70_000_00,
      deductions: [],
    }).catch(() => undefined)

    const { timeline } = await claimHistory(owner, id)
    // Settling a queried claim is not a legal move, so the third entry
    // is the query and nothing after it.
    expect(timeline.map((t) => t.to)).toEqual(['draft', 'submitted', 'query_raised'])
    expect(timeline[1].from).toBe('draft')
  })

  it('logs what the family did, newest first', async () => {
    const { id } = await createClaim(owner, input)
    const claim = await getClaim(owner, id)
    const item = claim.items.find((i) => i.label === 'Pharmacy bills')!

    await pushOps(owner, id, [
      op({
        type: 'add_doc',
        itemId: item.id,
        doc: {
          id: `hist-${Date.now()}`,
          name: 'pharmacy.jpg',
          amountPaise: 4_000_00,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-11-13T00:00:00Z',
        },
      }),
    ])

    const { activity } = await claimHistory(owner, id)
    expect(activity[0].summary).toContain('added pharmacy.jpg to Pharmacy bills')
    // The claim being started is the oldest thing that ever happened to
    // it, so it is last.
    expect(activity[activity.length - 1].kind).toBe('claim.created')
  })

  it('keeps a sentence readable after the document it describes is gone', async () => {
    const { id } = await createClaim(owner, input)
    const claim = await getClaim(owner, id)
    const item = claim.items.find((i) => i.label === 'Pharmacy bills')!
    const docId = `hist-gone-${Date.now()}`

    await pushOps(owner, id, [
      op({
        type: 'add_doc',
        itemId: item.id,
        doc: {
          id: docId,
          name: 'deleted-later.jpg',
          amountPaise: 1_000_00,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-11-13T00:00:00Z',
        },
      }),
    ])
    await pushOps(owner, id, [op({ type: 'remove_doc', itemId: item.id, docId })])

    const { activity } = await claimHistory(owner, id)
    // Written at the time, in the words of the claim as it then stood.
    expect(activity.some((a) => a.summary.includes('deleted-later.jpg'))).toBe(true)
  })

  it('still names the person after they have left the family', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    const claim = await getClaim(owner, id)
    const item = claim.items[0]

    await pushOps(
      cousin,
      id,
      [
        op(
          {
            type: 'add_doc',
            itemId: item.id,
            doc: {
              id: `hist-left-${Date.now()}`,
              name: 'claim-form.pdf',
              amountPaise: null,
              uploadedBy: 'cousin',
              uploadedAt: '2026-11-13T00:00:00Z',
            },
          },
          'phone-cousin-hist',
        ),
      ],
    )

    await removeMember(owner, id, cousin)

    const { activity } = await claimHistory(owner, id)
    const entry = activity.find((a) => a.summary.includes('claim-form.pdf'))!
    expect(entry).toBeDefined()
    // Removing someone from a family does not delete their account, so
    // the log still names them. That is the point: "who uploaded this"
    // has to stay answerable after the argument that got them removed.
    expect(entry.by).toBe('history-cousin')
  })

  it('survives the account behind a line being deleted outright', async () => {
    const { id } = await createClaim(owner, input)
    const visitor = await prisma.user.create({
      data: { name: 'history-visitor', email: `visitor-${Date.now()}@example.test` },
      select: { id: true },
    })
    const { token } = await createInvite(owner, id)
    await acceptInvite(visitor.id, token)

    await prisma.user.delete({ where: { id: visitor.id } })

    const { activity } = await claimHistory(owner, id)
    const entry = activity.find((a) => a.kind === 'member.joined')!
    // The actor is nulled rather than cascaded, so deleting an account
    // does not take a chunk of the claim's history with it.
    expect(entry).toBeDefined()
    expect(entry.by).toBeNull()
  })

  it('records a settlement in both records', async () => {
    const { id } = await createClaim(owner, input)
    await pushOps(owner, id, [op({ type: 'set_status', status: 'submitted' })])
    await recordSettlement(owner, id, {
      settledAmountPaise: 2_62_000_00,
      deductions: [{ amountPaise: 18_000_00, reason: 'Consumables' }],
    })

    const { timeline, activity } = await claimHistory(owner, id)
    expect(timeline[timeline.length - 1].to).toBe('settled')
    expect(activity[0].kind).toBe('settlement.recorded')
    expect(activity[0].summary).toContain('2,62,000')
  })

  it('is not readable by someone outside the family', async () => {
    const { id } = await createClaim(owner, input)
    await expect(claimHistory(stranger, id)).rejects.toThrow(ClaimNotFound)
  })

  it('is readable by every member, not only the owner', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(claimHistory(cousin, id)).resolves.toBeDefined()
  })
})
