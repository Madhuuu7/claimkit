import 'server-only'
import type { Claim as ClientClaim } from './claim'
import { STATUS_FROM_CLIENT, getClaim, requireMembership, toClientClaim } from './claims'
import { prisma } from './db'
import {
  compareOps,
  describeOp,
  registerOf,
  replay,
  validateOp,
  type Op,
  type OpBody,
} from './ops'

/**
 * The server half of sync.
 *
 * Two things live here, and keeping them straight is the whole design:
 *
 *  - The **op log** is the transport and the record. It is what phones
 *    push and page through, what carries the clocks that make conflict
 *    detection possible, and what the activity log is written from.
 *  - The **tables** are the materialised state. They are what the
 *    checklist, the export, the reminder job and the claims list read,
 *    because those are ordinary queries and should not have to replay a
 *    log to answer "how much has been uploaded".
 *
 * An accepted op writes both, in one transaction. If the row cannot be
 * written the op is not accepted either, so the two never drift.
 *
 * Validation runs against the server's own materialised claim, never
 * against what the client believed. A phone that has been offline for
 * three hours is arguing from a state that may no longer exist -- the
 * receipt it is pricing may have been deleted by someone else.
 */

/**
 * A refusal discovered inside the transaction rather than before it.
 *
 * Validation runs against the claim as it was a moment ago, so a push
 * that was legal when it was checked can stop being legal while it is
 * being written -- someone on another phone adds a file to the very line
 * this op removes. Thrown here, it aborts the transaction and comes back
 * to the phone as an ordinary permanent refusal, which the client
 * already knows how to roll back and explain.
 */
export class OpRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'OpRefused'
  }
}

export type PushOutcome =
  | { opId: string; ok: true; seq: number }
  /** Permanent: the client drops it, rolls it off the sheet and says why. */
  | { opId: string; ok: false; reason: string }

export type Snapshot = { claim: ClientClaim; seq: number }

/** Where the log is now, so a client knows what "caught up" means. */
async function headSeq(claimId: string): Promise<number> {
  const last = await prisma.op.findFirst({
    where: { claimId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  return last ? Number(last.seq) : 0
}

/**
 * What a phone starts from: the claim as the tables have it, and the log
 * position that state corresponds to.
 */
export async function snapshotFor(userId: string, claimId: string): Promise<Snapshot> {
  const claim = await getClaim(userId, claimId)
  return { claim: toClientClaim(claim), seq: await headSeq(claimId) }
}

/** Everything accepted after `since`. How a reconnecting phone catches up. */
export async function pullOps(
  userId: string,
  claimId: string,
  since: number,
): Promise<{ ops: Op[]; seq: number }> {
  await requireMembership(userId, claimId)

  const rows = await prisma.op.findMany({
    where: { claimId, seq: { gt: BigInt(Math.max(0, since)) } },
    orderBy: { seq: 'asc' },
    take: 500,
    include: { actor: { select: { name: true, email: true } } },
  })

  const ops: Op[] = rows.map((row) => ({
    id: row.opId,
    deviceId: row.deviceId,
    by: row.actor.name ?? row.actor.email ?? 'A family member',
    clock: row.clock,
    at: row.acceptedAt.toISOString(),
    after: row.after,
    body: row.body as Op['body'],
  }))

  return {
    ops,
    // The last row returned, not the head: with `take` in play, claiming
    // to be at the head would make a client skip whatever it did not
    // receive. Short by a page is harmless -- it asks again.
    seq: rows.length > 0 ? Number(rows[rows.length - 1].seq) : since,
  }
}

/**
 * Accept or refuse a batch, in the order the family made them.
 *
 * Each op gets its own transaction rather than one for the batch: ops are
 * independent, and a single refusal in the middle should not undo the
 * three good edits in front of it. The client walks its queue in order
 * for the same reason the server applies them in order -- a later edit
 * can depend on an earlier one.
 */
export async function pushOps(
  userId: string,
  claimId: string,
  ops: readonly Op[],
): Promise<{ results: PushOutcome[]; seq: number }> {
  await requireMembership(userId, claimId)

  const results: PushOutcome[] = []

  for (const op of ops) {
    // At-least-once delivery: this is the same edit arriving twice
    // because an acknowledgement was lost, not a second edit.
    const existing = await prisma.op.findUnique({
      where: { claimId_opId: { claimId, opId: op.id } },
      select: { seq: true },
    })
    if (existing) {
      results.push({ opId: op.id, ok: true, seq: Number(existing.seq) })
      continue
    }

    const detail = await getClaim(userId, claimId)
    const claim = toClientClaim(detail)

    const refusal = validateOp(claim, op)
    if (refusal) {
      results.push({ opId: op.id, ok: false, reason: refusal })
      continue
    }

    try {
      const seq = await prisma.$transaction(async (tx) => {
        const row = await tx.op.create({
          data: {
            opId: op.id,
            claimId,
            deviceId: op.deviceId,
            clock: op.clock,
            after: op.after ?? null,
            body: op.body,
            actorId: userId,
          },
          select: { seq: true },
        })

        await applyToTables(tx, claimId, userId, op, claim)

        await tx.activityLog.create({
          data: {
            claimId,
            actorId: userId,
            kind: op.body.type,
            // Written now, in the words of the claim as it stands: labels
            // get renamed, and an old entry should still read correctly.
            summary: describeOp(op, claim),
          },
        })

        return Number(row.seq)
      })

      results.push({ opId: op.id, ok: true, seq })
    } catch (error) {
      if (error instanceof OpRefused) {
        results.push({ opId: op.id, ok: false, reason: error.message })
        continue
      }
      // A unique violation here is the same op racing itself from two
      // tabs. Both callers should hear "accepted".
      if (isUniqueViolation(error)) {
        const row = await prisma.op.findUnique({
          where: { claimId_opId: { claimId, opId: op.id } },
          select: { seq: true },
        })
        results.push({ opId: op.id, ok: true, seq: row ? Number(row.seq) : 0 })
        continue
      }
      throw error
    }
  }

  return { results, seq: await headSeq(claimId) }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * The materialised effect of one op.
 *
 * Deliberately the only place that writes these tables on behalf of a
 * phone. The pure replay in lib/ops.ts decides what an op *means*; this
 * decides where that lands in Postgres, and the two are tested against
 * each other by replaying the log and comparing.
 */
async function applyToTables(
  tx: Tx,
  claimId: string,
  userId: string,
  op: Op,
  claim: ClientClaim,
): Promise<void> {
  const body = op.body

  switch (body.type) {
    case 'add_doc': {
      await tx.document.create({
        data: {
          id: body.doc.id,
          claimId,
          checklistItemId: body.itemId,
          name: body.doc.name,
          amountPaise: body.doc.amountPaise,
          // The bytes are still on the phone. The row exists so the
          // checklist and the reconciliation are right immediately; the
          // upload fills these in when there is signal.
          storageKey: null,
          contentType: null,
          sizeBytes: null,
          uploadedById: userId,
          uploadedAt: new Date(body.doc.uploadedAt),
        },
      })
      return
    }

    case 'remove_doc': {
      // The object in the bucket is left for the sweeper: deleting it
      // inside this transaction would mean a rolled-back transaction had
      // already destroyed the file.
      await tx.document.deleteMany({ where: { id: body.docId, claimId } })
      return
    }

    case 'set_amount': {
      await tx.document.updateMany({
        where: { id: body.docId, claimId },
        data: { amountPaise: body.amountPaise },
      })
      return
    }

    case 'set_item_done': {
      await tx.checklistItem.updateMany({
        where: { id: body.itemId, claimId },
        data: { markedDone: body.done },
      })
      return
    }

    case 'set_final_bill': {
      await tx.claim.update({
        where: { id: claimId },
        data: { finalBillPaise: body.amountPaise },
      })
      return
    }

    case 'add_item': {
      // Appended, and positioned from the table rather than from the
      // length of the list: removals leave gaps, and reusing a position
      // would put the new line in the middle of the exported PDF.
      const last = await tx.checklistItem.findFirst({
        where: { claimId },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      await tx.checklistItem.create({
        data: {
          id: body.item.id,
          claimId,
          label: body.item.label,
          kind: body.item.kind === 'bill' ? 'BILL' : 'RECORD',
          expected: body.item.expected,
          required: body.item.required,
          position: (last?.position ?? -1) + 1,
        },
      })
      return
    }

    case 'rename_item': {
      await tx.checklistItem.updateMany({
        where: { id: body.itemId, claimId },
        data: { label: body.label },
      })
      return
    }

    case 'remove_item': {
      // Documents cascade from their checklist item, so this delete is
      // the one place in the app that could destroy a family's files
      // without being asked to. Counted again inside the transaction,
      // because validation ran against a claim from before this one:
      // between the two, another phone's upload may have landed.
      const holding = await tx.document.count({
        where: { checklistItemId: body.itemId, claimId },
      })
      if (holding > 0) {
        const item = claim.items.find((i) => i.id === body.itemId)
        throw new OpRefused(
          `${item?.label ?? 'That document'} was given ${holding} ${
            holding === 1 ? 'file' : 'files'
          } while this was waiting for signal, so it is still on the checklist.`,
        )
      }
      await tx.checklistItem.deleteMany({ where: { id: body.itemId, claimId } })
      return
    }

    case 'set_status': {
      const to = STATUS_FROM_CLIENT[body.status]
      await tx.claim.update({ where: { id: claimId }, data: { status: to } })
      // The timeline is a separate record from the op log because it is
      // what a person reads: who moved this claim, when, and why.
      await tx.statusEvent.create({
        data: { claimId, from: STATUS_FROM_CLIENT[claim.status], to, byId: userId },
      })
      return
    }
  }
}

/**
 * A consistency check used by the tests: replaying the whole log over a
 * claim's starting point must agree with what the tables say. If these
 * two ever disagree, one of them is lying to the family.
 */
export async function replayedClaim(
  userId: string,
  claimId: string,
): Promise<{ fromTables: ClientClaim; fromLog: ClientClaim }> {
  const detail = await getClaim(userId, claimId)
  const fromTables = toClientClaim(detail)
  const { ops } = await pullOps(userId, claimId, 0)

  // The starting point: the claim with everything the log is responsible
  // for taken back off it -- the documents, the ticks, the status, and
  // the checklist lines the family added for themselves. A line that was
  // renamed keeps its current name, because the replay writes that name
  // again from the rename op itself.
  const addedItems = new Set(
    ops.flatMap((op) => (op.body.type === 'add_item' ? [op.body.item.id] : [])),
  )

  const base: ClientClaim = {
    ...fromTables,
    status: 'draft',
    items: fromTables.items
      .filter((item) => !addedItems.has(item.id))
      .map((item) => ({ ...item, markedDone: false, docs: [] })),
  }

  return { fromTables, fromLog: replay(base, ops).claim }
}

/* ------------------------------------------------------------------ *
 * Writing as the server
 * ------------------------------------------------------------------ */

/**
 * Append an op the server itself made, as though it were one more device.
 *
 * Some things are not typed on a phone -- a settlement is transcribed
 * from a letter, and a reminder job may one day want to say something.
 * Those still have to reach the family's phones, and the only way into
 * this claim is the log. Writing the `status` column directly would move
 * the claim for whoever reloaded the page and for nobody else, and would
 * put the tables and the log permanently out of step.
 *
 * So the server mints an op like any other: its own device id, the next
 * Lamport clock, and `after` set to the clock of the value it is writing
 * over, so a phone that changed the same field without seeing this is
 * reported as a conflict rather than silently overwritten.
 */
export async function appendServerOp(
  userId: string,
  claimId: string,
  body: OpBody,
  by: string,
): Promise<PushOutcome> {
  await requireMembership(userId, claimId)

  const rows = await prisma.op.findMany({
    where: { claimId },
    orderBy: { seq: 'asc' },
    select: { opId: true, deviceId: true, clock: true, body: true },
  })

  // One past everything this claim has ever seen, which is what observing
  // the whole log and then ticking amounts to.
  const clock = rows.reduce((max, row) => Math.max(max, row.clock), 0) + 1

  const register = registerOf(body)
  const after =
    register === null
      ? null
      : (rows
          .filter((row) => registerOf(row.body as OpBody) === register)
          .map((row) => ({
            id: row.opId,
            deviceId: row.deviceId,
            clock: row.clock,
          }))
          .sort((a, b) => compareOps(a as Op, b as Op))
          .pop()?.clock ?? null)

  const op: Op = {
    // Unique within the claim because the clock is one past every op in
    // it, and two of these cannot be minted concurrently: the only
    // caller holds the owner's claim for the length of the request.
    id: `server:${clock}`,
    deviceId: 'server',
    by,
    clock,
    at: new Date().toISOString(),
    after,
    body,
  }

  const { results } = await pushOps(userId, claimId, [op])
  return results[0]
}
