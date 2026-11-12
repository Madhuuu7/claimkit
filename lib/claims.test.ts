import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClaimNotFound,
  NotPermitted,
  InviteInvalid,
  acceptInvite,
  createClaim,
  createInvite,
  getClaim,
  listClaims,
  membershipOf,
  removeMember,
  requireOwner,
  revokeInvite,
  toClientClaim,
} from './claims'
import { prisma } from './db'
import { unaccounted } from './claim'
import type { CreateClaimInput } from './schemas'

/**
 * These run against a real Postgres, because the thing being tested is
 * not a function -- it is whether the *queries* can reach another
 * family's claim. A mocked Prisma client would answer a question nobody
 * asked.
 *
 * `npx prisma dev` provides one locally; CI runs a Postgres service.
 * Without DATABASE_URL the suite skips rather than failing, so a
 * contributor with no database can still run the unit tests.
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

describe.skipIf(!hasDatabase)('access control', () => {
  let owner: string
  let stranger: string
  let cousin: string
  const made: string[] = []

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const users = await Promise.all(
      ['owner', 'stranger', 'cousin'].map((who) =>
        prisma.user.create({
          data: { name: who, email: `${who}-${unique}@example.test` },
          select: { id: true },
        }),
      ),
    )
    ;[owner, stranger, cousin] = users.map((u) => u.id)
    made.push(owner, stranger, cousin)
  })

  afterAll(async () => {
    // Claims cascade from the user that created them; memberships and
    // documents cascade from the claim.
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  it('makes the person who creates a claim its owner', async () => {
    const { id } = await createClaim(owner, input)
    expect(await membershipOf(owner, id)).toEqual({ role: 'OWNER' })
    await expect(requireOwner(owner, id)).resolves.toBeUndefined()
  })

  it('starts a claim from the default checklist, in order', async () => {
    const { id } = await createClaim(owner, input)
    const claim = await getClaim(owner, id)
    expect(claim.items).toHaveLength(10)
    expect(claim.items[0].label).toBe('Claim form')
    expect(claim.items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    // Nothing is ticked, and the whole bill is unaccounted for, because
    // not a single receipt has been uploaded yet.
    expect(unaccounted(toClientClaim(claim))).toBe(2_80_000_00)
  })

  it('tells a stranger the claim does not exist', async () => {
    // Not 403. Confirming the id is real would turn a stolen link into
    // proof that this family is making a claim.
    const { id } = await createClaim(owner, input)
    await expect(getClaim(stranger, id)).rejects.toThrow(ClaimNotFound)
    expect(await membershipOf(stranger, id)).toBeNull()
  })

  it('keeps a stranger out of the list', async () => {
    await createClaim(owner, input)
    expect(await listClaims(stranger)).toEqual([])
    expect((await listClaims(owner)).length).toBeGreaterThan(0)
  })

  it('refuses to let a stranger mint an invite to a claim', async () => {
    const { id } = await createClaim(owner, input)
    await expect(createInvite(stranger, id)).rejects.toThrow(ClaimNotFound)
  })

  it('lets someone in through an invite link, as a contributor', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)

    const joined = await acceptInvite(cousin, token)
    expect(joined).toEqual({ claimId: id, alreadyMember: false })
    expect(await membershipOf(cousin, id)).toEqual({ role: 'CONTRIBUTOR' })
    await expect(getClaim(cousin, id)).resolves.toBeDefined()
  })

  it('does not mint a second membership when a link is opened twice', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    expect(await acceptInvite(cousin, token)).toEqual({ claimId: id, alreadyMember: true })
    const claim = await getClaim(owner, id)
    expect(claim.members.filter((m) => m.userId === cousin)).toHaveLength(1)
  })

  it('refuses a revoked link', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    const invite = await prisma.invite.findUniqueOrThrow({ where: { token } })

    await revokeInvite(owner, invite.id)

    await expect(acceptInvite(cousin, token)).rejects.toThrow(InviteInvalid)
    expect(await membershipOf(cousin, id)).toBeNull()
  })

  it('refuses an expired link', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await prisma.invite.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(acceptInvite(cousin, token)).rejects.toThrow(InviteInvalid)
  })

  it('refuses a link nobody issued', async () => {
    await expect(acceptInvite(cousin, 'not-a-real-token')).rejects.toThrow(InviteInvalid)
  })

  it('cuts off a member the owner removes, immediately', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(getClaim(cousin, id)).resolves.toBeDefined()

    await removeMember(owner, id, cousin)

    await expect(getClaim(cousin, id)).rejects.toThrow(ClaimNotFound)
    // Scoped to this claim: the cousin is still in other families' claims
    // from the tests above, and removal is per claim, not per person.
    expect((await listClaims(cousin)).map((c) => c.id)).not.toContain(id)
  })

  it('ends the removed member sessions rather than waiting for a token to expire', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await prisma.session.create({
      data: {
        userId: cousin,
        sessionToken: `session-${Math.random()}`,
        expires: new Date(Date.now() + 86_400_000),
      },
    })

    await removeMember(owner, id, cousin)

    // This is the reason sessions are rows and not JWTs: being removed
    // from a family has to take effect now, not in thirty days.
    expect(await prisma.session.count({ where: { userId: cousin } })).toBe(0)
  })

  it('does not let a contributor remove anyone', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(removeMember(cousin, id, owner)).rejects.toThrow(NotPermitted)
  })

  it('does not let the owner be removed, even by themselves', async () => {
    // A claim with no owner can never be invited to, renamed or settled.
    const { id } = await createClaim(owner, input)
    await expect(removeMember(owner, id, owner)).rejects.toThrow(NotPermitted)
  })

  it('does not let a stranger remove a member', async () => {
    const { id } = await createClaim(owner, input)
    const { token } = await createInvite(owner, id)
    await acceptInvite(cousin, token)
    await expect(removeMember(stranger, id, cousin)).rejects.toThrow(ClaimNotFound)
  })
})

describe.skipIf(!hasDatabase)('the snapshot sent to a phone', () => {
  let owner: string
  const made: string[] = []

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: 'Madhura', email: `snapshot-${Date.now()}@example.test` },
      select: { id: true },
    })
    owner = user.id
    made.push(owner)
  })

  afterAll(async () => {
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  it('reads back as the same dates that went in, in any timezone', async () => {
    // A timestamp would carry a time of day nobody typed, and reading it
    // back with local getters is what moved every deadline a day earlier
    // for anyone behind UTC the first time around.
    const { id } = await createClaim(owner, input)
    const claim = toClientClaim(await getClaim(owner, id))
    expect(claim.admittedOn).toBe('2026-10-13')
    expect(claim.dischargedOn).toBe('2026-10-19')
  })

  it('arrives in the shape the offline engine already replays over', async () => {
    const { id } = await createClaim(owner, input)
    const claim = toClientClaim(await getClaim(owner, id))
    expect(claim.status).toBe('draft')
    expect(claim.members[0]).toMatchObject({ name: 'Madhura', initials: 'M' })
    expect(claim.items.map((i) => i.kind)).toContain('bill')
    expect(claim.items.every((i) => i.docs.length === 0)).toBe(true)
  })
})
