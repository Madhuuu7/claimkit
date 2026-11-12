import {
  canTransition,
  type ChecklistItem,
  type Claim,
  type ClaimStatus,
  type UploadedDoc,
} from './claim'
import { formatRupees, type Paise } from './money'

/**
 * The sync model.
 *
 * ClaimKit is edited by a family, on phones, in a hospital corridor where
 * there is no signal. So the client never sends "the new claim" -- it
 * sends *operations*, keeps them in a durable outbox, and derives what it
 * shows by replaying the log over the last snapshot it had from the
 * server. Three things fall out of that:
 *
 *  - An edit made offline is a queued op, not a lost tap.
 *  - An optimistic edit is just an op that has not been acknowledged yet,
 *    so rolling it back is dropping it from the log and replaying again.
 *    There is no undo code to get wrong.
 *  - Two people editing the same thing on two phones converge, because
 *    the log is ordered the same way on every device.
 *
 * This file is pure: no React, no IndexedDB, no network. The sync engine
 * and the simulated server both sit on top of it.
 */

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export type OpBody =
  | { type: 'add_doc'; itemId: string; doc: UploadedDoc }
  | { type: 'remove_doc'; itemId: string; docId: string }
  | { type: 'set_amount'; itemId: string; docId: string; amountPaise: Paise | null }
  | { type: 'set_item_done'; itemId: string; done: boolean }
  | { type: 'set_final_bill'; amountPaise: Paise }
  | { type: 'set_status'; status: ClaimStatus }

export type Op = {
  /**
   * `${deviceId}:${counter}`. Also the idempotency key: delivery is
   * at-least-once, so the server sees the same op twice whenever an
   * acknowledgement is the thing that got lost, and applying it twice
   * must not add the receipt twice.
   */
  id: string
  deviceId: string
  /** Who to name in the UI. Display only. */
  by: string
  /**
   * Lamport clock, not wall time. Phone clocks disagree by minutes, and
   * a family member whose clock ran fast would otherwise win every
   * conflict forever.
   */
  clock: number
  /** Wall time, for "uploaded at" lines. Never used for ordering. */
  at: string
  /**
   * For a write to a single-value field: the clock of the value this
   * write was based on -- the same idea as an ETag in `If-Match`. It is
   * what tells "I changed the amount after seeing yours" apart from "we
   * both changed it without seeing each other", which is the difference
   * between an edit and a conflict.
   */
  after?: number | null
  body: OpBody
}

/**
 * Lamport clock. `tick` for a local edit, `observe` for every op that
 * arrives from anywhere else, so this device's next edit sorts after
 * everything it has already seen.
 */
export class LamportClock {
  constructor(private value = 0) {}
  get now(): number {
    return this.value
  }
  observe(clock: number): void {
    this.value = Math.max(this.value, clock)
  }
  tick(): number {
    return ++this.value
  }
}

/**
 * The fields where two people can disagree. Adding documents cannot
 * conflict -- two uploads are two documents -- but there is only one
 * amount on a receipt and one final bill.
 */
export function registerOf(body: OpBody): string | null {
  switch (body.type) {
    case 'set_amount':
      return `amount:${body.docId}`
    case 'set_item_done':
      return `done:${body.itemId}`
    case 'set_final_bill':
      return 'finalBill'
    case 'set_status':
      return 'status'
    default:
      return null
  }
}

/**
 * The one total order every device agrees on. The clock carries
 * causality; the device id breaks the remaining ties arbitrarily but
 * *consistently*, which is all convergence needs.
 */
export function compareOps(a: Op, b: Op): number {
  if (a.clock !== b.clock) return a.clock - b.clock
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function registerValue(body: OpBody): unknown {
  switch (body.type) {
    case 'set_amount':
      return body.amountPaise
    case 'set_item_done':
      return body.done
    case 'set_final_bill':
      return body.amountPaise
    case 'set_status':
      return body.status
    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

/**
 * Two edits to the same field, neither of which saw the other. The log
 * still converges -- the later op in the total order wins on every device
 * -- but silently discarding what someone typed is how a family ends up
 * posting the wrong figure to an insurer. So the loser is kept and
 * reported, and the UI asks a human.
 */
export type Conflict = {
  register: string
  winner: Op
  loser: Op
}

export type ReplayResult = {
  claim: Claim
  conflicts: Conflict[]
  /** Ops the replay refused to apply, with the reason. */
  dropped: { op: Op; reason: string }[]
  /**
   * The winning write per single-value field. A device reads its clock
   * out of here to fill in `after` on its next edit -- the read-then-write
   * that makes conflict detection possible at all.
   */
  winners: Map<string, Op>
}

export type ReplayOptions = {
  /**
   * Ops still sitting in the outbox. Documents they added are marked
   * pending, so the sheet can say "waiting for signal" instead of
   * pretending the upload is safe on a server somewhere.
   */
  pendingOpIds?: ReadonlySet<string>
}

/**
 * Replay a log over a snapshot. Deterministic: the same snapshot and the
 * same set of ops give the same claim, whatever order they arrived in.
 */
export function replay(
  base: Claim,
  ops: readonly Op[],
  options: ReplayOptions = {},
): ReplayResult {
  const pending = options.pendingOpIds ?? new Set<string>()
  const ordered = dedupe(ops).sort(compareOps)

  // Additive state: documents are a set with tombstones.
  const added = new Map<string, { itemId: string; doc: UploadedDoc }>()
  const removed = new Set<string>()

  // Register state: the winning write per field, plus the losers.
  const winners = new Map<string, Op>()
  let conflicts: Conflict[] = []
  const dropped: { op: Op; reason: string }[] = []

  // Status is a register too, but a guarded one: the state machine
  // decides what is even legal, so it is folded in order.
  let status = base.status

  for (const op of ordered) {
    const register = registerOf(op.body)

    if (register === null) {
      if (op.body.type === 'add_doc') {
        const { itemId, doc } = op.body
        if (findDoc(base, doc.id) || added.has(doc.id)) {
          dropped.push({ op, reason: 'A document with that id already exists' })
          continue
        }
        added.set(doc.id, {
          itemId,
          doc: pending.has(op.id) ? { ...doc, pending: true } : doc,
        })
      } else if (op.body.type === 'remove_doc') {
        // Remove wins over a concurrent add of the same document: a
        // receipt someone deleted must not come back when a phone
        // reconnects.
        removed.add(op.body.docId)
      }
      continue
    }

    if (op.body.type === 'set_status') {
      if (!canTransition(status, op.body.status)) {
        dropped.push({
          op,
          reason: `A ${status} claim cannot become ${op.body.status}`,
        })
        continue
      }
      status = op.body.status
    }

    const current = winners.get(register)
    winners.set(register, op)

    if (!current) continue

    if (op.after === current.clock) {
      // This write saw the value it replaced. An ordinary edit -- and it
      // supersedes any earlier disagreement about this field, which is
      // exactly what resolving a conflict in the UI does.
      conflicts = conflicts.filter(
        (c) => c.register !== register || c.winner.clock > op.clock,
      )
      continue
    }

    // Neither write saw the other. Equal values are two people agreeing,
    // not a conflict.
    if (registerValue(op.body) !== registerValue(current.body)) {
      conflicts.push({ register, winner: op, loser: current })
    }
  }

  const amountOf = (docId: string, fallback: Paise | null): Paise | null => {
    const w = winners.get(`amount:${docId}`)
    return w && w.body.type === 'set_amount' ? w.body.amountPaise : fallback
  }

  const items: ChecklistItem[] = base.items.map((item) => {
    const docs = item.docs
      .filter((d) => !removed.has(d.id))
      .concat(
        [...added.values()]
          .filter((a) => a.itemId === item.id && !removed.has(a.doc.id))
          .map((a) => a.doc),
      )
      .map((d) => ({ ...d, amountPaise: amountOf(d.id, d.amountPaise) }))

    const doneWrite = winners.get(`done:${item.id}`)
    const markedDone =
      doneWrite && doneWrite.body.type === 'set_item_done'
        ? doneWrite.body.done
        : item.markedDone

    return { ...item, markedDone, docs }
  })

  const billWrite = winners.get('finalBill')

  return {
    claim: {
      ...base,
      status,
      finalBillPaise:
        billWrite && billWrite.body.type === 'set_final_bill'
          ? billWrite.body.amountPaise
          : base.finalBillPaise,
      items,
    },
    conflicts,
    dropped,
    winners,
  }
}

/** At-least-once delivery means duplicates. The op id settles them. */
function dedupe(ops: readonly Op[]): Op[] {
  const seen = new Map<string, Op>()
  for (const op of ops) if (!seen.has(op.id)) seen.set(op.id, op)
  return [...seen.values()]
}

export function findDoc(
  claim: Claim,
  docId: string,
): { item: ChecklistItem; doc: UploadedDoc } | null {
  for (const item of claim.items) {
    const doc = item.docs.find((d) => d.id === docId)
    if (doc) return { item, doc }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * What the server will refuse. The client runs the same function before
 * queueing, so an impossible edit is caught in the corridor rather than
 * three hours later when the signal comes back -- but the server runs it
 * again, against its own snapshot, because the client's was stale.
 *
 * Returns the sentence to show a person, or null if the op is fine.
 */
export function validateOp(claim: Claim, op: Op): string | null {
  const body = op.body

  switch (body.type) {
    case 'add_doc': {
      const item = claim.items.find((i) => i.id === body.itemId)
      if (!item) return 'That document slot is no longer on this claim'
      if (findDoc(claim, body.doc.id)) return 'That file has already been added'
      if (item.kind === 'record' && body.doc.amountPaise !== null) {
        return `${item.label} is a record, not a bill, so it carries no amount`
      }
      if (body.doc.amountPaise !== null && body.doc.amountPaise < 0) {
        return 'An amount cannot be negative'
      }
      if (body.doc.amountPaise !== null && body.doc.amountPaise > claim.finalBillPaise) {
        return `That is more than the final bill of ${formatRupees(claim.finalBillPaise)}`
      }
      return null
    }
    case 'remove_doc': {
      const found = findDoc(claim, body.docId)
      if (!found) return 'That file has already been removed'
      if (found.item.id !== body.itemId) return 'That file belongs to another document'
      return null
    }
    case 'set_amount': {
      const found = findDoc(claim, body.docId)
      if (!found) return 'That file is no longer on this claim'
      if (found.item.kind === 'record') {
        return `${found.item.label} is a record, not a bill, so it carries no amount`
      }
      if (body.amountPaise !== null && body.amountPaise < 0) {
        return 'An amount cannot be negative'
      }
      if (body.amountPaise !== null && body.amountPaise > claim.finalBillPaise) {
        return `A single receipt cannot exceed the final bill of ${formatRupees(
          claim.finalBillPaise,
        )}`
      }
      return null
    }
    case 'set_item_done': {
      if (!claim.items.some((i) => i.id === body.itemId)) {
        return 'That document slot is no longer on this claim'
      }
      return null
    }
    case 'set_final_bill': {
      if (body.amountPaise <= 0) return 'Enter the final bill amount'
      return null
    }
    case 'set_status': {
      if (!canTransition(claim.status, body.status)) {
        return `A ${claim.status} claim cannot become ${body.status}`
      }
      return null
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sentences
 * ------------------------------------------------------------------ */

/** What an op did, in the app's voice, for the activity line and toasts. */
export function describeOp(op: Op, claim: Claim): string {
  const body = op.body
  const label = (itemId: string) =>
    claim.items.find((i) => i.id === itemId)?.label ?? 'a document'

  switch (body.type) {
    case 'add_doc':
      return `added ${body.doc.name} to ${label(body.itemId)}`
    case 'remove_doc':
      return `removed a file from ${label(body.itemId)}`
    case 'set_amount':
      return body.amountPaise === null
        ? `cleared the amount on a ${label(body.itemId)} receipt`
        : `set a ${label(body.itemId)} receipt to ${formatRupees(body.amountPaise)}`
    case 'set_item_done':
      return body.done
        ? `ticked ${label(body.itemId)} as done`
        : `un-ticked ${label(body.itemId)}`
    case 'set_final_bill':
      return `set the final bill to ${formatRupees(body.amountPaise)}`
    case 'set_status':
      return `moved the claim to ${body.status.replace('_', ' ')}`
  }
}

/** The value a write put in a field, on its own, for the conflict panel. */
export function describeValue(op: Op, claim: Claim): string {
  const body = op.body
  switch (body.type) {
    case 'set_amount':
      return body.amountPaise === null ? 'no amount' : formatRupees(body.amountPaise)
    case 'set_item_done':
      return body.done ? 'done' : 'not done'
    case 'set_final_bill':
      return formatRupees(body.amountPaise)
    case 'set_status':
      return body.status.replace('_', ' ')
    default:
      return describeOp(op, claim)
  }
}

/** What the two of them disagreed about. */
export function describeConflictSubject(conflict: Conflict, claim: Claim): string {
  const body = conflict.winner.body
  switch (body.type) {
    case 'set_amount': {
      const found = findDoc(claim, body.docId)
      return found ? found.doc.name : 'a receipt'
    }
    case 'set_item_done':
      return claim.items.find((i) => i.id === body.itemId)?.label ?? 'a document'
    case 'set_final_bill':
      return 'the final bill'
    case 'set_status':
      return 'the claim status'
    default:
      return 'this claim'
  }
}
