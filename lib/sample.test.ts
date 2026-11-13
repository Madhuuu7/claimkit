import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockers, completeness, itemState, unaccounted } from './claim'
import { getClaim, listClaims, toClientClaim } from './claims'
import { prisma } from './db'
import { bandFor } from './reminders'
import { SAMPLE_PATIENT, ensureSampleClaim, hasSampleClaim } from './sample'

/**
 * The sample claim.
 *
 * It exists to say one thing in the first five seconds -- that ₹6,400
 * of this bill has no receipt against it -- so that figure is what is
 * tested, along with the two ways it could embarrass someone: being
 * mistaken for a real claim, or quietly emailing them a deadline
 * reminder about a worked example.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDatabase)('the sample claim', () => {
  let user: string
  const made: string[] = []

  beforeAll(async () => {
    const row = await prisma.user.create({
      data: {
        name: 'sample-user',
        email: `sample-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
      select: { id: true },
    })
    user = row.id
    made.push(user)
  })

  afterAll(async () => {
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  it('shows the gap the app exists to point at', async () => {
    const created = await ensureSampleClaim(user)
    const claim = toClientClaim(await getClaim(user, created!.id))
    expect(unaccounted(claim)).toBe(6_400_00)
    expect(blockers(claim)[0].kind).toBe('gap')
  })

  it('is flagged as a sample everywhere it appears', async () => {
    const [summary] = await listClaims(user)
    expect(summary.isSample).toBe(true)
    expect(summary.patientName).toBe(SAMPLE_PATIENT)

    const claim = toClientClaim(await getClaim(user, summary.id))
    // The cover sheet reads this to say so above the claim itself.
    expect(claim.isSample).toBe(true)
  })

  it('is partly done, so the checklist has something to show', async () => {
    const [summary] = await listClaims(user)
    const claim = toClientClaim(await getClaim(user, summary.id))
    const { done, total } = completeness(claim)
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(total)
  })

  it('includes an item ticked by hand with no file behind it', async () => {
    // The case the tick exists for: a report handed over at the desk
    // that never existed as a photograph.
    const [summary] = await listClaims(user)
    const claim = toClientClaim(await getClaim(user, summary.id))
    const lab = claim.items.find((i) => i.label === 'Lab and investigation reports')!
    expect(lab.docs).toHaveLength(0)
    expect(itemState(lab)).toBe('complete')
  })

  it('never claims to hold bytes it does not have', async () => {
    const [summary] = await listClaims(user)
    const claim = toClientClaim(await getClaim(user, summary.id))
    const docs = claim.items.flatMap((i) => i.docs)
    expect(docs.length).toBeGreaterThan(0)
    // There is no photograph of a hospital bill this app is entitled to
    // invent, so no sample document pretends to be viewable.
    expect(docs.every((doc) => doc.stored === false)).toBe(true)
  })

  it('is not seeded twice', async () => {
    expect(await hasSampleClaim(user)).toBe(true)
    expect(await ensureSampleClaim(user)).toBeNull()
    expect((await listClaims(user)).filter((c) => c.isSample)).toHaveLength(1)
  })

  it('is never close enough to the deadline to send a reminder', async () => {
    // Nobody should be chased by email about a worked example.
    const [summary] = await listClaims(user)
    expect(
      bandFor({
        dischargedOn: summary.dischargedOn.toISOString().slice(0, 10),
        submissionWindowDays: summary.submissionWindowDays,
      }),
    ).toBeNull()
  })

  it('belongs to the person it was made for, like any other claim', async () => {
    const stranger = await prisma.user.create({
      data: { name: 'sample-stranger', email: `stranger-${Date.now()}@example.test` },
      select: { id: true },
    })
    made.push(stranger.id)
    // Not a demo mode: it sits in the same tables under the same
    // membership rules as a real admission.
    expect(await listClaims(stranger.id)).toHaveLength(0)
  })
})
