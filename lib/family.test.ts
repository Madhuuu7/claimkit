import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NotPermitted,
  acceptInvite,
  createClaim,
  createInvite,
  getClaim,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from './claims'
import { prisma } from './db'
import type { Op, OpBody } from './ops'
import type { CreateClaimInput } from './schemas'
import { pushOps } from './sync'

/**
 * What the family screen reads.
 *
 * The one that matters is listInvites: a token is the link, so handing
 * it to a contributor would let anyone in the family give the claim
 * away. The rest is making sure the screen can say something true
 * before a destructive button is pressed.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const input: CreateClaimInput = {
  patientName: 'Thatha admission',
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
}

let counter = 0

function op(body: OpBody, device: string): Op {
  counter += 1
  return {
    id: `${device}:${counter}`,
    deviceId: device,
    by: 'A family member',
    clock: counter,
    at: '2026-11-13T00:00:00Z',
    after: null,
    body,
  }
}

describe.skipIf(!hasDatabase)('the family screen', () => {
  let owner: string
  let cousin: string
  let stranger: string
  const made: string[] = []

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const users = await Promise.all(
      ['family-owner', 'family-cousin', 'family-stranger'].map((who) =>
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

  async function claimWithCousin() {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    return id
  }

  it('lists the family oldest first, owner included', async () => {
    const id = await claimWithCousin()
    const members = await listMembers(owner, id)
    expect(members.map((m) => m.role)).toEqual(['OWNER', 'CONTRIBUTOR'])
    expect(members[1].userId).toBe(cousin)
  })

  it('lets a contributor see who else is on the claim', async () => {
    // It is their father's hospital bill too.
    const id = await claimWithCousin()
    expect(await listMembers(cousin, id)).toHaveLength(2)
  })

  it('counts what each person added, so removing them is an informed click', async () => {
    const id = await claimWithCousin()
    const claim = await getClaim(owner, id)
    const item = claim.items.find((i) => i.label === 'Pharmacy bills')!

    await pushOps(
      cousin,
      id,
      [1, 2].map((n) =>
        op(
          {
            type: 'add_doc',
            itemId: item.id,
            doc: {
              id: `fam-doc-${Date.now()}-${n}`,
              name: `bill-${n}.jpg`,
              amountPaise: 1_000_00,
              uploadedBy: 'cousin',
              uploadedAt: '2026-11-13T00:00:00Z',
            },
          },
          'phone-cousin',
        ),
      ),
    )

    const members = await listMembers(owner, id)
    expect(members.find((m) => m.userId === cousin)?.documentCount).toBe(2)
    expect(members.find((m) => m.userId === owner)?.documentCount).toBe(0)
  })

  it('shows the owner their live links', async () => {
    const id = await claimWithCousin()
    const invites = await listInvites(owner, id)
    expect(invites).toHaveLength(1)
    expect(invites[0].live).toBe(true)
    expect(invites[0].token).toHaveLength(43)
  })

  it('never hands a token to a contributor', async () => {
    // The token is the link. A contributor who could read it could give
    // the whole claim to anyone.
    const id = await claimWithCousin()
    await expect(listInvites(cousin, id)).rejects.toThrow(NotPermitted)
  })

  it('never hands a token to a stranger', async () => {
    const id = await claimWithCousin()
    await expect(listInvites(stranger, id)).rejects.toThrow()
  })

  it('keeps a revoked link listed, and marks it dead', async () => {
    // It may still be sitting in a family chat, and the owner has to be
    // able to recognise it when someone says the link is broken.
    const id = await claimWithCousin()
    const [invite] = await listInvites(owner, id)
    await revokeInvite(owner, invite.id)

    const after = await listInvites(owner, id)
    expect(after).toHaveLength(1)
    expect(after[0].live).toBe(false)
    expect(after[0].revokedAt).not.toBeNull()
  })

  it('counts an expired link as dead without anyone revoking it', async () => {
    const id = await claimWithCousin()
    const [invite] = await listInvites(owner, id)
    await prisma.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect((await listInvites(owner, id))[0].live).toBe(false)
  })

  it('drops a removed member off the list', async () => {
    const id = await claimWithCousin()
    await removeMember(owner, id, cousin)
    expect(await listMembers(owner, id)).toHaveLength(1)
  })

  it('leaves the files a removed member added on the claim', async () => {
    const id = await claimWithCousin()
    const claim = await getClaim(owner, id)
    const item = claim.items.find((i) => i.label === 'Pharmacy bills')!
    const docId = `fam-keep-${Date.now()}`

    await pushOps(cousin, id, [
      op(
        {
          type: 'add_doc',
          itemId: item.id,
          doc: {
            id: docId,
            name: 'pharmacy.jpg',
            amountPaise: 2_000_00,
            uploadedBy: 'cousin',
            uploadedAt: '2026-11-13T00:00:00Z',
          },
        },
        'phone-cousin-2',
      ),
    ])

    await removeMember(owner, id, cousin)

    // The claim is the family's, not the uploader's: losing a receipt
    // because someone left would be a worse outcome than either.
    expect(await prisma.document.count({ where: { claimId: id, id: docId } })).toBe(1)
  })
})
