import 'server-only'
import type { Claim as ClientClaim } from './claim'
import { STATUS_FROM_CLIENT, getClaim, requireMembership, toClientClaim } from './claims'
import { prisma } from './db'
import { describeOp, replay, validateOp, type Op } from './ops'

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

  // The starting point: the claim with its documents and ticks stripped
  // back out, which is what the log was recorded against.
  const base: ClientClaim = {
    ...fromTables,
    status: 'draft',
    items: fromTables.items.map((item) => ({ ...item, markedDone: false, docs: [] })),
  }

  return { fromTables, fromLog: replay(base, ops).claim }
}
