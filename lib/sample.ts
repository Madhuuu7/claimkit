import 'server-only'
import { prisma } from './db'
import { DEFAULT_CHECKLIST } from './template'

/**
 * The sample claim.
 *
 * Somebody opening ClaimKit for the first time has no hospital bill to
 * hand and nothing to look at, and an empty checklist explains nothing
 * about what this is for. So a new account starts with one worked
 * example: a real-shaped admission, most of the documents gathered, and
 * a gap of ₹6,400 that nobody has accounted for -- which is the entire
 * point of the app, visible in the first five seconds.
 *
 * It is flagged `isSample` everywhere it appears: on the claims list, on
 * the cover sheet and on the first page of the exported PDF. A family
 * that mistook this for their own claim and submitted it would be worse
 * off than one that saw nothing at all.
 *
 * Deliberately not a demo mode. It is an ordinary claim, in the same
 * tables, under the same membership rules -- so every button on it does
 * the real thing, and deleting it leaves nothing behind.
 */

export const SAMPLE_PATIENT = 'Sample: a six-day admission'

/**
 * Dates are relative to the day the account is made, so the deadline is
 * always meaningful. Far enough out that the sample never triggers a
 * reminder email -- nobody should be chased about a worked example.
 */
const DISCHARGED_DAYS_AGO = 6
const STAY_DAYS = 6
const WINDOW_DAYS = 30

const FINAL_BILL_PAISE = 2_80_000_00

/**
 * What has been gathered so far, by checklist label. The amounts come to
 * ₹2,73,600 against a bill of ₹2,80,000, which is the ₹6,400 the cover
 * sheet is loud about.
 */
const GATHERED: Record<
  string,
  { files: { name: string; amountPaise: number | null }[]; markedDone?: boolean }
> = {
  'Claim form': {
    files: [{ name: 'claim-form-signed.pdf', amountPaise: null }],
  },
  'Final hospital bill': {
    files: [{ name: 'final-bill.pdf', amountPaise: 2_41_000_00 }],
  },
  'Itemised bill': {
    files: [{ name: 'itemised-bill.pdf', amountPaise: null }],
  },
  'Payment receipts': {
    files: [
      { name: 'receipt-admission.jpg', amountPaise: 20_000_00 },
      { name: 'receipt-discharge.jpg', amountPaise: 8_600_00 },
    ],
  },
  'Discharge summary': {
    files: [{ name: 'discharge-summary.pdf', amountPaise: null }],
  },
  'Pharmacy bills': {
    files: [
      { name: 'pharmacy-day-1.jpg', amountPaise: 2_400_00 },
      { name: 'pharmacy-day-3.jpg', amountPaise: 1_600_00 },
    ],
  },
  // Handed over at the hospital desk and never photographed, which is
  // what the tick is for.
  'Lab and investigation reports': { files: [], markedDone: true },
}

function day(offsetDays: number, from: Date): Date {
  const utc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  return new Date(utc + offsetDays * 86_400_000)
}

/** Does this person already have the sample? Idempotent by design. */
export async function hasSampleClaim(userId: string): Promise<boolean> {
  const existing = await prisma.claim.findFirst({
    where: { isSample: true, members: { some: { userId } } },
    select: { id: true },
  })
  return existing !== null
}

export async function ensureSampleClaim(userId: string): Promise<{ id: string } | null> {
  if (await hasSampleClaim(userId)) return null

  const now = new Date()
  const dischargedOn = day(-DISCHARGED_DAYS_AGO, now)
  const admittedOn = day(-DISCHARGED_DAYS_AGO - STAY_DAYS, now)

  return prisma.$transaction(async (tx) => {
    const claim = await tx.claim.create({
      data: {
        patientName: SAMPLE_PATIENT,
        hospital: 'Manipal Hospital, Old Airport Road',
        admittedOn,
        dischargedOn,
        finalBillPaise: FINAL_BILL_PAISE,
        submissionWindowDays: WINDOW_DAYS,
        isSample: true,
        createdById: userId,
        members: { create: { userId, role: 'OWNER' } },
        items: {
          create: DEFAULT_CHECKLIST.map((item, index) => ({
            label: item.label,
            kind: item.kind,
            expected: item.expected,
            required: item.required,
            markedDone: GATHERED[item.label]?.markedDone ?? false,
            position: index,
          })),
        },
        statusEvents: { create: { from: null, to: 'DRAFT', byId: userId } },
      },
      select: { id: true, items: { select: { id: true, label: true } } },
    })

    for (const item of claim.items) {
      const gathered = GATHERED[item.label]
      if (!gathered) continue

      for (const [index, file] of gathered.files.entries()) {
        await tx.document.create({
          data: {
            claimId: claim.id,
            checklistItemId: item.id,
            name: file.name,
            amountPaise: file.amountPaise,
            // No bytes behind it, and no pretending otherwise: there is
            // no photograph of a hospital bill that this app is entitled
            // to invent. The row is what the checklist and the
            // reconciliation are built from, and both are real.
            storageKey: null,
            contentType: null,
            sizeBytes: null,
            uploadedById: userId,
            uploadedAt: day(-DISCHARGED_DAYS_AGO + index, now),
          },
        })
      }
    }

    await tx.activityLog.create({
      data: {
        claimId: claim.id,
        actorId: userId,
        kind: 'claim.created',
        summary: 'started this sample claim, so there is something to look at',
      },
    })

    return { id: claim.id }
  })
}
