import type { Claim, ClaimStatus, UploadedDoc } from './claim'
import type { Paise } from './money'
import {
  LamportClock,
  replay,
  registerOf,
  validateOp,
  type Conflict,
  type Op,
  type OpBody,
} from './ops'
import type { ClaimStore, OutboxEntry, Snapshot } from './outbox'
import type { Transport } from './server'

/**
 * The sync engine: the thing between a tap and the server.
 *
 * It owns one invariant. What the family sees is always
 *
 *     replay(last snapshot from the server, server ops + my outbox)
 *
 * which means an optimistic edit is not a copy of the state with the
 * change painted on -- it is an op in the log. Rolling one back is
 * removing it and replaying, so there is no second code path that has to
 * remember how to undo a half-finished upload. Every edit goes to disk
 * before it goes to the network.
 *
 * Deliberately free of React: it is a store with a subscribe function, so
 * the rules can be tested against a simulated network without rendering
 * anything, and the component layer is a thin `useSyncExternalStore`.
 */

export type Rejection = { op: Op; reason: string; at: string }

export type EngineState = {
  /** Snapshot plus outbox, replayed. The only thing the UI renders. */
  claim: Claim
  conflicts: Conflict[]
  /** Edits not yet acknowledged, oldest first. */
  queued: OutboxEntry[]
  online: boolean
  syncing: boolean
  lastSyncedAt: string | null
  /** Edits the server refused, which have been rolled back off the sheet. */
  rejections: Rejection[]
  /** False when the browser denied us storage: the queue is session-only. */
  durable: boolean
  /** The outbox has been read off disk. Before this, the sheet is a guess. */
  ready: boolean
}

export type EngineOptions = {
  /** Used only if the device has never synced and has nothing stored. */
  base: Claim
  store: ClaimStore
  transport: Transport
  device: { id: string; name: string }
  durable?: boolean
  now?: () => Date
  /** Injected so tests do not wait on real timers. */
  schedule?: (fn: () => void, ms: number) => void
  /** Injected so document ids are reproducible in tests. */
  newId?: () => string
  /**
   * How often to ask the server what else has happened, while online and
   * idle. Without it a phone that is just sitting on the kitchen table
   * never hears that someone else resolved a disagreement, because this
   * transport has no way for the server to speak first. A real
   * deployment would swap the polling for an event stream; the engine
   * does not care which, it only cares that `pull` gets called.
   */
  pollMs?: number
}

const MAX_BACKOFF_MS = 30_000

export class SyncEngine {
  private snapshot: Snapshot
  private queue: OutboxEntry[] = []
  private clock = new LamportClock()
  private counter = 0
  private rejections: Rejection[] = []
  private listeners = new Set<() => void>()
  private cache: EngineState | null = null
  private flushing: Promise<void> | null = null
  private retryQueued = false

  private readonly pollMs: number | null
  private pollQueued = false
  private online = true
  private syncing = false
  private ready = false
  private lastSyncedAt: string | null = null

  private readonly store: ClaimStore
  private readonly transport: Transport
  private readonly device: { id: string; name: string }
  private readonly durable: boolean
  private readonly now: () => Date
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly newId: () => string

  constructor(options: EngineOptions) {
    this.snapshot = { claim: options.base, ops: [], seq: 0 }
    this.store = options.store
    this.transport = options.transport
    this.device = options.device
    this.durable = options.durable ?? true
    this.now = options.now ?? (() => new Date())
    this.schedule =
      options.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
    this.pollMs = options.pollMs ?? null
    this.newId =
      options.newId ??
      (() =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2))
  }

  /* ---------------------------------------------------------------- *
   * Store plumbing
   * ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Returns the same object until something actually changes.
   * `useSyncExternalStore` compares by identity and would otherwise
   * re-render on every tick of the queue.
   */
  getState = (): EngineState => {
    if (this.cache) return this.cache

    const pendingOpIds = new Set(this.queue.map((e) => e.op.id))
    const ops = [...this.snapshot.ops, ...this.queue.map((e) => e.op)]
    const { claim, conflicts } = replay(this.snapshot.claim, ops, { pendingOpIds })

    this.cache = {
      claim,
      conflicts,
      queued: this.queue,
      online: this.online,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      rejections: this.rejections,
      durable: this.durable,
      ready: this.ready,
    }
    return this.cache
  }

  private changed(): void {
    this.cache = null
    for (const listener of this.listeners) listener()
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Read the outbox and the last snapshot off disk, then catch up. The
   * order matters: the queue is loaded before the first paint so a reload
   * with three uploads waiting shows those uploads, not a sheet that has
   * forgotten them.
   */
  async start(): Promise<void> {
    const [stored, queued] = await Promise.all([
      this.store.loadSnapshot(),
      this.store.loadOutbox(),
    ])
    if (stored) this.snapshot = stored
    this.queue = queued
    this.ready = true

    for (const op of [...this.snapshot.ops, ...this.queue.map((e) => e.op)]) {
      this.clock.observe(op.clock)
    }
    // Continue this device's op numbering rather than restarting it, or a
    // reload would mint ids the server has already seen and the duplicate
    // check would swallow genuine new edits.
    for (const entry of this.queue) {
      if (entry.op.deviceId !== this.device.id) continue
      const n = Number(entry.op.id.split(':')[1])
      if (Number.isFinite(n)) this.counter = Math.max(this.counter, n)
    }

    this.changed()
    if (this.online) await this.sync()
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    this.changed()
    // Reconnecting is the moment the queue drains.
    if (online) void this.sync()
  }

  dismissRejection(opId: string): void {
    this.rejections = this.rejections.filter((r) => r.op.id !== opId)
    this.changed()
  }

  /* ---------------------------------------------------------------- *
   * Edits
   * ---------------------------------------------------------------- */

  /**
   * Queue one op. Returns the refusal to show the person, or null if the
   * edit was accepted locally.
   *
   * Validated here as well as on the server, so an impossible edit is
   * caught at the tap instead of being queued for three hours and then
   * rolled back off the sheet when the signal returns.
   */
  private async commit(body: OpBody): Promise<string | null> {
    const state = this.getState()
    const register = registerOf(body)
    const op: Op = {
      id: `${this.device.id}:${++this.counter}`,
      deviceId: this.device.id,
      by: this.device.name,
      clock: this.clock.tick(),
      at: this.now().toISOString(),
      // The value this edit was typed over, so the server and the other
      // phones can tell this apart from a blind overwrite.
      after: register ? (this.winners().get(register)?.clock ?? null) : undefined,
      body,
    }

    const refusal = validateOp(state.claim, op)
    if (refusal) {
      this.counter--
      return refusal
    }

    const entry: OutboxEntry = { op, attempts: 0, queuedAt: op.at }
    // Disk first. If the tab dies on the next line the edit is still
    // there; if this were the other way round it would be gone.
    await this.store.saveEntry(entry)
    this.queue = [...this.queue, entry]
    this.changed()

    if (this.online) void this.sync()
    return null
  }

  private winners(): Map<string, Op> {
    return replay(this.snapshot.claim, [
      ...this.snapshot.ops,
      ...this.queue.map((e) => e.op),
    ]).winners
  }

  addDocument(
    itemId: string,
    doc: { name: string; amountPaise: Paise | null; id?: string },
  ): Promise<string | null> {
    const uploaded: UploadedDoc = {
      // The caller supplies the id when a file has already been queued
      // under it: the bytes on this phone and the row on the server have
      // to be talking about the same document.
      id: doc.id ?? this.newId(),
      name: doc.name,
      amountPaise: doc.amountPaise,
      uploadedBy: this.device.name,
      uploadedAt: this.now().toISOString(),
    }
    return this.commit({ type: 'add_doc', itemId, doc: uploaded })
  }

  removeDocument(itemId: string, docId: string): Promise<string | null> {
    return this.commit({ type: 'remove_doc', itemId, docId })
  }

  setAmount(itemId: string, docId: string, amountPaise: Paise | null): Promise<string | null> {
    return this.commit({ type: 'set_amount', itemId, docId, amountPaise })
  }

  setItemDone(itemId: string, done: boolean): Promise<string | null> {
    return this.commit({ type: 'set_item_done', itemId, done })
  }

  setFinalBill(amountPaise: Paise): Promise<string | null> {
    return this.commit({ type: 'set_final_bill', amountPaise })
  }

  setStatus(status: ClaimStatus): Promise<string | null> {
    return this.commit({ type: 'set_status', status })
  }

  /**
   * Settle a disagreement by writing the chosen value again. Because the
   * new write is based on the value currently winning, it causally
   * dominates both sides and the conflict is gone on every device -- no
   * special "resolved" flag to replicate, and no way for one phone to
   * think it is settled while another still shows it.
   */
  resolveConflict(conflict: Conflict, keep: 'mine' | 'theirs' | Op): Promise<string | null> {
    const chosen =
      keep === 'mine'
        ? (conflict.winner.deviceId === this.device.id ? conflict.winner : conflict.loser)
        : keep === 'theirs'
          ? (conflict.winner.deviceId === this.device.id ? conflict.loser : conflict.winner)
          : keep
    return this.commit(chosen.body)
  }

  /* ---------------------------------------------------------------- *
   * Sync
   * ---------------------------------------------------------------- */

  /** Drain the outbox, then catch up on what everyone else did. */
  sync(): Promise<void> {
    // One flush at a time. Two concurrent drains would send the head of
    // the queue twice, and while the op id makes that harmless on the
    // server, it is wasted radio on a phone.
    this.flushing ??= this.runSync().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async runSync(): Promise<void> {
    this.syncing = true
    this.changed()
    try {
      await this.drain()
      await this.pull()
      this.lastSyncedAt = this.now().toISOString()
      this.schedulePoll()
    } catch {
      // Offline, or the request failed. The queue is on disk; the retry
      // is already scheduled by drain().
    } finally {
      this.syncing = false
      this.changed()
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.online) {
      const entry = this.queue[0]
      // Strictly in order: a later edit can depend on an earlier one, so
      // sending the second while the first is stuck would have the server
      // refuse an amount for a receipt it has not been given yet.
      const result = await this.transport.push(entry.op)

      if (result.ok) {
        await this.store.removeEntry(entry.op.id)
        this.queue = this.queue.slice(1)
        this.changed()
        continue
      }

      if (result.permanent) {
        // The server refused it. Dropping it from the log *is* the
        // rollback: the next replay no longer contains the edit.
        await this.store.removeEntry(entry.op.id)
        this.queue = this.queue.slice(1)
        this.rejections = [
          ...this.rejections,
          { op: entry.op, reason: result.reason, at: this.now().toISOString() },
        ]
        this.changed()
        continue
      }

      // Transient. Keep the edit, record the attempt, back off.
      const updated: OutboxEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        lastError: result.reason,
      }
      await this.store.saveEntry(updated)
      this.queue = [updated, ...this.queue.slice(1)]
      this.changed()
      this.scheduleRetry(updated.attempts)
      return
    }
  }

  private schedulePoll(): void {
    if (this.pollMs === null || this.pollQueued || !this.online) return
    this.pollQueued = true
    this.schedule(() => {
      this.pollQueued = false
      if (this.online) void this.sync()
    }, this.pollMs)
  }

  private scheduleRetry(attempts: number): void {
    if (this.retryQueued) return
    this.retryQueued = true
    // Exponential, capped: a phone that has been out of signal for an
    // hour should not be waking the radio every half second.
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempts, 6))
    this.schedule(() => {
      this.retryQueued = false
      if (this.online) void this.sync()
    }, delay)
  }

  /** Catch up on everything accepted since this device last looked. */
  async pull(): Promise<void> {
    const { ops, seq } = await this.transport.pull(this.snapshot.seq)

    const known = new Set(this.snapshot.ops.map((o) => o.id))
    const merged = [...this.snapshot.ops]
    for (const op of ops) {
      if (known.has(op.id)) continue
      known.add(op.id)
      merged.push(op)
      // Anything this device now knows about must sort before its next
      // edit, or that edit would look like it had not seen this one.
      this.clock.observe(op.clock)
    }

    this.snapshot = compact({ claim: this.snapshot.claim, ops: merged, seq })
    await this.store.saveSnapshot(this.snapshot)
    this.changed()
  }
}

/**
 * Fold agreed history into the snapshot so the stored log does not grow
 * forever. Only safe while nothing is in dispute: folding collapses a
 * field to its winning value, which would throw away the figure the other
 * family member typed before anyone had chosen between them.
 */
function compact(snapshot: Snapshot): Snapshot {
  const { claim, conflicts } = replay(snapshot.claim, snapshot.ops)
  if (conflicts.length > 0) return snapshot
  return { claim, ops: [], seq: snapshot.seq }
}
