import { z } from 'zod'
import { MoneyError, parseRupees } from './money'
import type { OpBody } from './ops'

/**
 * Every value that arrives from a browser passes through here.
 *
 * Forms send strings, and the interesting ones are money and dates.
 * Money is parsed into integer paise at the edge, so nothing downstream
 * ever holds a rupee float; dates stay as `YYYY-MM-DD` strings until
 * Prisma turns them into a date column, because a timestamp would carry
 * a time of day that no one typed and that would move the deadline for
 * anyone in another zone.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A calendar day, and a real one: 2026-02-31 is rejected, not rounded. */
export const dayString = z
  .string()
  .regex(DAY, 'Use a date like 2026-10-19')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    return (
      date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    )
  }, 'That date does not exist')

/** Rupees as a person types them, out as integer paise. */
export const rupees = z.string().transform((value, ctx) => {
  try {
    return parseRupees(value)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof MoneyError ? error.message : 'Enter an amount',
    })
    return z.NEVER
  }
})

export const positivePaise = rupees.refine((paise) => paise > 0, 'Enter an amount above zero')

export const createClaimSchema = z
  .object({
    patientName: z.string().trim().min(1, 'Whose admission is this?').max(120),
    hospital: z.string().trim().min(1, 'Which hospital?').max(160),
    admittedOn: dayString,
    dischargedOn: dayString,
    finalBillPaise: positivePaise,
    // Policies differ, so this is asked rather than assumed. The ceiling
    // is a year: anything larger is a typo, not a policy.
    submissionWindowDays: z.coerce
      .number()
      .int('Whole days only')
      .min(1, 'At least one day')
      .max(365, 'More than a year is probably a typo'),
  })
  .refine((claim) => claim.dischargedOn >= claim.admittedOn, {
    message: 'Discharge cannot be before admission',
    path: ['dischargedOn'],
  })

export type CreateClaimInput = z.infer<typeof createClaimSchema>

export const checklistItemSchema = z.object({
  label: z.string().trim().min(1, 'Name the document').max(120),
  kind: z.enum(['BILL', 'RECORD']),
  expected: z.coerce.number().int().min(1).max(99).nullable().optional(),
  required: z.boolean().default(true),
})

/** What the browser may ask to upload, before anything is signed. */
export const uploadRequestSchema = z.object({
  claimId: z.string().min(1),
  checklistItemId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  // Checked again when the upload is recorded: this is the list the
  // presigned URL is restricted to, not a hint.
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024, 'Files must be 10 MB or smaller'),
})

export const statusChangeSchema = z.object({
  to: z.enum([
    'DRAFT',
    'SUBMITTED',
    'QUERY_RAISED',
    'QUERY_RESOLVED',
    'SETTLED',
    'REJECTED',
  ]),
  note: z.string().trim().max(500).optional(),
})

export const settlementSchema = z.object({
  settledAmountPaise: rupees,
  deductions: z
    .array(
      z.object({
        amountPaise: positivePaise,
        reason: z.string().trim().min(1, 'Say why it was deducted').max(300),
      }),
    )
    .default([]),
})

export type SettlementInput = z.infer<typeof settlementSchema>

/* ------------------------------------------------------------------ *
 * Operations
 *
 * The sync endpoint's boundary. An op arrives as JSON a device wrote, so
 * it is parsed into the exact shape the pure replay code expects -- and
 * no further: whether the op is *allowed* is a question about the claim,
 * answered by validateOp against the server's own state, not by a schema.
 * ------------------------------------------------------------------ */

const uploadedDocSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  amountPaise: z.number().int().nullable(),
  uploadedBy: z.string().min(1).max(120),
  uploadedAt: z.string().min(1),
  pending: z.boolean().optional(),
})

export const opBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_doc'),
    itemId: z.string().min(1),
    doc: uploadedDocSchema,
  }),
  z.object({
    type: z.literal('remove_doc'),
    itemId: z.string().min(1),
    docId: z.string().min(1),
  }),
  z.object({
    type: z.literal('set_amount'),
    itemId: z.string().min(1),
    docId: z.string().min(1),
    amountPaise: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('set_item_done'),
    itemId: z.string().min(1),
    done: z.boolean(),
  }),
  z.object({ type: z.literal('set_final_bill'), amountPaise: z.number().int() }),
  z.object({
    type: z.literal('set_status'),
    status: z.enum([
      'draft',
      'submitted',
      'query_raised',
      'query_resolved',
      'settled',
      'rejected',
    ]),
  }),
  z.object({
    type: z.literal('add_item'),
    item: z.object({
      id: z.string().min(1).max(64),
      // Only the shape is pinned here. Whether the name is blank, too
      // long or already on the checklist is validateOp's question,
      // because its answer is a sentence the family reads.
      label: z.string().max(200),
      kind: z.enum(['bill', 'record']),
      expected: z.number().int().nullable(),
      required: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('rename_item'),
    itemId: z.string().min(1),
    label: z.string().max(200),
  }),
  z.object({ type: z.literal('remove_item'), itemId: z.string().min(1) }),
])

/**
 * Checked by the compiler rather than by a test that someone has to
 * remember to extend: every op the replay understands must be an op the
 * endpoint will let in. Adding a body to OpBody without adding it above
 * is a type error here, instead of an edit that works in every test and
 * is refused as malformed by the first real phone.
 */
type _EveryOpBodyHasASchema = OpBody extends z.infer<typeof opBodySchema> ? true : never
const _everyOpBodyHasASchema: _EveryOpBodyHasASchema = true
void _everyOpBodyHasASchema

export const opSchema = z.object({
  // `${deviceId}:${counter}`, minted by the device and used as the
  // idempotency key, so its shape is pinned rather than trusted.
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}:\d{1,12}$/, 'Malformed operation id'),
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  by: z.string().min(1).max(120),
  clock: z.number().int().nonnegative(),
  at: z.string().min(1),
  after: z.number().int().nonnegative().nullable().optional(),
  body: opBodySchema,
})

export const pushSchema = z.object({
  ops: z.array(opSchema).min(1).max(100),
})

export const pullSchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
})
