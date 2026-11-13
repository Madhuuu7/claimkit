import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClaim, getClaim, toClientClaim } from './claims'
import { prisma } from './db'
import type { Op, OpBody } from './ops'
import { BANDS, bandFor, reminderMessage, sendReminders } from './reminders'
import type { CreateClaimInput } from './schemas'
import { pushOps } from './sync'

/**
 * The reminder sweep.
 *
 * Two failures matter and nothing else does. A family that gets no
 * warning because the cron missed a day has been failed by the one
 * feature that exists to count for them; a family that gets the same
 * warning twice learns to ignore the next one. So: bands rather than
 * exact days, and a unique row per band as the guard.
 *
 * No email leaves these tests. With no API key configured sendEmail
 * refuses before it reaches the network, which is also exactly what
 * happens on a laptop.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const base: CreateClaimInput = {
  patientName: 'Appa admission',
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
}

/** A claim discharged so that `left` whole days remain on `now`. */
function dischargedFor(left: number, now: Date): string {
  const day = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return new Date(day + (left - base.submissionWindowDays) * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

describe('which claims are due a reminder', () => {
  const now = new Date('2026-11-13T09:00:00Z')
  const at = (left: number) => ({
    dischargedOn: dischargedFor(left, now),
    submissionWindowDays: base.submissionWindowDays,
  })

  it('says nothing while the deadline is still far off', () => {
    expect(bandFor(at(20), now)).toBeNull()
    expect(bandFor(at(8), now)).toBeNull()
  })

  it('reminds at a week out', () => {
    expect(bandFor(at(7), now)?.daysBefore).toBe(7)
  })

  it('still reminds at six, five, four and three days', () => {
    // The band, not the exact day. A cron that misses a morning must not
    // cost a family their only warning.
    for (const left of [6, 5, 4, 3]) {
      expect(bandFor(at(left), now)?.daysBefore).toBe(7)
    }
  })

  it('reminds again at two days, and on the day itself', () => {
    expect(bandFor(at(2), now)?.daysBefore).toBe(2)
    expect(bandFor(at(1), now)?.daysBefore).toBe(2)
    expect(bandFor(at(0), now)?.daysBefore).toBe(2)
  })

  it('stops once the window has closed', () => {
    // Nothing useful left to say, and saying it anyway is cruel.
    expect(bandFor(at(-1), now)).toBeNull()
    expect(bandFor(at(-30), now)).toBeNull()
  })

  it('leaves no gap between the two bands', () => {
    const covered = new Set<number>()
    for (let left = 0; left <= 7; left++) {
      const band = bandFor(at(left), now)
      expect(band).not.toBeNull()
      covered.add(band!.daysBefore)
    }
    expect([...covered].sort()).toEqual(BANDS.map((b) => b.daysBefore).sort())
  })
})

describe('what the reminder says', () => {
  const now = new Date('2026-11-13T09:00:00Z')

  function claimWith(left: number) {
    return {
      id: 'claim-1',
      patientName: 'Appa',
      hospital: 'Manipal Hospital',
      admittedOn: '2026-10-13',
      dischargedOn: dischargedFor(left, now),
      finalBillPaise: 2_80_000_00,
      submissionWindowDays: base.submissionWindowDays,
      status: 'draft' as const,
      members: [],
      items: [
        {
          id: 'i1',
          label: 'Pharmacy bills',
          kind: 'bill' as const,
          expected: 5,
          required: true,
          docs: [
            {
              id: 'd1',
              name: 'p.jpg',
              amountPaise: 2_73_600_00,
              uploadedBy: 'Madhura',
              uploadedAt: '2026-11-01T00:00:00Z',
            },
          ],
        },
      ],
    }
  }

  it('puts the days left and the patient in the subject', () => {
    expect(reminderMessage(claimWith(7), now).subject).toBe(
      "7 days left to submit Appa's claim",
    )
  })

  it('says so plainly on the last day', () => {
    expect(reminderMessage(claimWith(0), now).subject).toBe(
      "Last day to submit Appa's claim",
    )
  })

  it('leads with the money that has no receipt against it', () => {
    const { text } = reminderMessage(claimWith(7), now)
    expect(text).toContain('₹6,400')
    expect(text).toContain('Pharmacy bills: 1 of 5')
  })

  it('links to the claim', () => {
    const { text, html } = reminderMessage(claimWith(7), now)
    expect(text).toContain('/claims/claim-1')
    expect(html).toContain('/claims/claim-1')
  })

  it('escapes a hospital name that contains markup', () => {
    // The hospital is typed by a family, and it ends up in an HTML mail.
    const claim = { ...claimWith(7), hospital: '<script>alert(1)</script>' }
    const { html } = reminderMessage(claim, now)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe.skipIf(!hasDatabase)('the sweep', () => {
  let owner: string
  const made: string[] = []
  let counter = 0

  function op(body: OpBody): Op {
    counter += 1
    return {
      id: `phone-remind:${counter}`,
      deviceId: 'phone-remind',
      by: 'Madhura',
      clock: counter,
      at: '2026-11-13T00:00:00Z',
      after: null,
      body,
    }
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        name: 'remind-owner',
        email: `remind-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
      select: { id: true },
    })
    owner = user.id
    made.push(owner)
  })

  afterAll(async () => {
    await prisma.claim.deleteMany({ where: { createdById: { in: made } } })
    await prisma.user.deleteMany({ where: { id: { in: made } } })
  })

  /**
   * The sweep looks at every draft claim in the database, including the
   * ones other test files left behind, so each assertion is made about
   * this claim rather than about the run as a whole.
   */
  async function claimDue(left: number, now: Date) {
    const { id } = await createClaim(owner, {
      ...base,
      dischargedOn: dischargedFor(left, now),
    })
    return id
  }

  it('reminds a draft claim once per band, however often it runs', async () => {
    const now = new Date()
    const id = await claimDue(5, now)

    await sendReminders(now)
    await sendReminders(now)
    await sendReminders(now)

    const rows = await prisma.reminder.findMany({ where: { claimId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].daysBefore).toBe(7)
  })

  it('reminds a second time when the claim reaches the two-day band', async () => {
    const now = new Date()
    const id = await claimDue(5, now)
    await sendReminders(now)

    // Three days later, with the claim still unsubmitted.
    const later = new Date(now.getTime() + 3 * 86_400_000)
    await sendReminders(later)

    const rows = await prisma.reminder.findMany({
      where: { claimId: id },
      orderBy: { daysBefore: 'desc' },
    })
    expect(rows.map((r) => r.daysBefore)).toEqual([7, 2])
  })

  it('says nothing about a claim that has already been submitted', async () => {
    const now = new Date()
    const id = await claimDue(5, now)
    await pushOps(owner, id, [op({ type: 'set_status', status: 'submitted' })])

    await sendReminders(now)

    // A claim the insurer already has cannot miss this deadline, and a
    // reminder about it teaches the family to ignore the next one.
    expect(await prisma.reminder.count({ where: { claimId: id } })).toBe(0)
  })

  it('says nothing about a claim with weeks left', async () => {
    const now = new Date()
    const id = await claimDue(20, now)
    await sendReminders(now)
    expect(await prisma.reminder.count({ where: { claimId: id } })).toBe(0)
  })

  it('says nothing once the window has closed', async () => {
    const now = new Date()
    const id = await claimDue(-3, now)
    await sendReminders(now)
    expect(await prisma.reminder.count({ where: { claimId: id } })).toBe(0)
  })

  it('records a reminder it could not actually send', async () => {
    // No API key here, which is also a laptop and a deployment where
    // reminders have not been switched on. The row is still written, so
    // turning the key on later does not deliver a week of backlog.
    const now = new Date()
    const id = await claimDue(1, now)
    const run = await sendReminders(now)

    const row = await prisma.reminder.findFirst({ where: { claimId: id } })
    expect(row?.daysBefore).toBe(2)
    expect(row?.recipients).toBe(0)
    expect(run.configured).toBe(false)
  })

  it('addresses the whole family, not just the owner', async () => {
    const now = new Date()
    const id = await claimDue(5, now)
    const claim = await getClaim(owner, id)
    expect(toClientClaim(claim).members).toHaveLength(1)

    const cousin = await prisma.user.create({
      data: {
        name: 'remind-cousin',
        email: `remind-cousin-${Date.now()}@example.test`,
      },
      select: { id: true },
    })
    made.push(cousin.id)
    await prisma.claimMember.create({
      data: { claimId: id, userId: cousin.id, role: 'CONTRIBUTOR' },
    })

    const run = await sendReminders(now)
    const outcome = run.sent.find((s) => s.claimId === id)
    // Two members, two refusals, because email is not configured here --
    // what matters is that both were attempted.
    expect(outcome?.failures).toHaveLength(2)
  })
})
