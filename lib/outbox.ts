import type { Claim } from './claim'
import type { Op } from './ops'

/**
 * The outbox: where an edit lives between the tap and the server.
 *
 * It has to be durable, because the realistic failure is not a slow
 * request -- it is a phone with 4% battery in a hospital basement. An edge
 * case in a web app is the normal case here: the tab is closed, the page
 * is reloaded, the browser is killed by the OS, all while three uploads
 * are queued. So every op is written to disk *before* it is sent, and
 * removed only once the server has acknowledged it.
 *
 * IndexedDB rather than localStorage, for three reasons that matter:
 * localStorage is synchronous and blocks the main thread, it holds strings
 * so a photographed receipt would have to be base64'd (a third larger, and
 * past the 5 MB ceiling after two bills), and it has no transactions, so a
 * tab closing mid-write can leave half an op behind.
 */

export type OutboxEntry = {
  op: Op
  /** Sends attempted. Drives the backoff, and the "retried 4 times" line. */
  attempts: number
  /** When the family made this edit, not when it was sent. */
  queuedAt: string
  /** Why the last attempt failed, if it did. */
  lastError?: string
}

/**
 * The last state the server told us about, and how far along its log that
 * was. Persisted so that opening the app offline shows the claim rather
 * than an empty page, and so a reconnect asks for the delta instead of
 * re-downloading everything.
 */
export type Snapshot = {
  /** The claim as the server's log had left it at `seq`. */
  claim: Claim
  /**
   * Server ops after that point. Kept rather than folded in so that an
   * unresolved disagreement between two family members is still on the
   * sheet after a reload -- folding them in would collapse the log to a
   * single value and quietly lose the other figure. The engine folds them
   * once there is nothing left to resolve.
   */
  ops: Op[]
  seq: number
}

export interface ClaimStore {
  loadOutbox(): Promise<OutboxEntry[]>
  /** Write before sending. Idempotent on op id. */
  saveEntry(entry: OutboxEntry): Promise<void>
  /** Only after the server has acknowledged, or after a refusal. */
  removeEntry(opId: string): Promise<void>
  loadSnapshot(): Promise<Snapshot | null>
  saveSnapshot(snapshot: Snapshot): Promise<void>
}

/* ------------------------------------------------------------------ *
 * In memory
 * ------------------------------------------------------------------ */

/** For tests, for the server side of the demo, and for private windows. */
export class MemoryClaimStore implements ClaimStore {
  private entries = new Map<string, OutboxEntry>()
  private snapshot: Snapshot | null = null

  async loadOutbox(): Promise<OutboxEntry[]> {
    return [...this.entries.values()].map(clone).sort((a, b) => a.op.clock - b.op.clock)
  }
  async saveEntry(entry: OutboxEntry): Promise<void> {
    this.entries.set(entry.op.id, clone(entry))
  }
  async removeEntry(opId: string): Promise<void> {
    this.entries.delete(opId)
  }
  async loadSnapshot(): Promise<Snapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null
  }
  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshot = clone(snapshot)
  }
}

/** Stored state must not alias live objects, or a replay could mutate it. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/* ------------------------------------------------------------------ *
 * IndexedDB
 * ------------------------------------------------------------------ */

const DB_NAME = 'claimkit'
const DB_VERSION = 1
const OUTBOX = 'outbox'
const META = 'meta'

/**
 * Hand-rolled rather than pulled from a wrapper library: this is two
 * object stores and four operations, and the IndexedDB request/event
 * dance is the part worth understanding, not hiding.
 */
export class IdbClaimStore implements ClaimStore {
  private db: Promise<IDBDatabase> | null = null

  constructor(private readonly name = DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        // Keyed on the op id, which is also the idempotency key, so
        // saving the same op twice overwrites instead of duplicating.
        if (!db.objectStoreNames.contains(OUTBOX)) {
          db.createObjectStore(OUTBOX, { keyPath: 'op.id' })
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      // Another tab holding an old version open. Rare, and silently
      // hanging would be worse than a clear failure.
      request.onblocked = () => reject(new Error('Another ClaimKit tab is upgrading'))
    })
    return this.db
  }

  private async run<T>(
    store: string,
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const request = body(tx.objectStore(store))
      let value: T
      request.onsuccess = () => {
        value = request.result
      }
      request.onerror = () => reject(request.error)
      // Resolve on the transaction, not on the request: the request
      // succeeding only means the write was accepted, while `complete`
      // means it was committed. Resolving early would let the engine
      // report an edit as safely queued that a crash can still lose.
      tx.oncomplete = () => resolve(value)
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
  }

  async loadOutbox(): Promise<OutboxEntry[]> {
    const entries = await this.run<OutboxEntry[]>(OUTBOX, 'readonly', (s) =>
      s.getAll() as IDBRequest<OutboxEntry[]>,
    )
    // Oldest edit first: the server should see them in the order the
    // family made them.
    return entries.sort((a, b) => a.op.clock - b.op.clock)
  }

  async saveEntry(entry: OutboxEntry): Promise<void> {
    await this.run(OUTBOX, 'readwrite', (s) => s.put(entry))
  }

  async removeEntry(opId: string): Promise<void> {
    await this.run(OUTBOX, 'readwrite', (s) => s.delete(opId))
  }

  async loadSnapshot(): Promise<Snapshot | null> {
    const row = await this.run<{ key: string; value: Snapshot } | undefined>(
      META,
      'readonly',
      (s) => s.get('snapshot') as IDBRequest<{ key: string; value: Snapshot } | undefined>,
    )
    return row?.value ?? null
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await this.run(META, 'readwrite', (s) => s.put({ key: 'snapshot', value: snapshot }))
  }
}

/**
 * IndexedDB is missing or walled off in a few real situations -- a private
 * window in some browsers, a webview with site data blocked, an iframe
 * with third-party storage partitioned off. The app should keep working
 * for the session rather than refuse to open, so the caller falls back to
 * memory and can tell the family their queue will not survive a reload.
 */
export function createStore(name = DB_NAME): { store: ClaimStore; durable: boolean } {
  try {
    if (typeof indexedDB === 'undefined') {
      // Also the server render, where there is no browser storage and the
      // first paint comes from the snapshot in the page.
      return { store: new MemoryClaimStore(), durable: false }
    }
    return { store: new IdbClaimStore(name), durable: true }
  } catch {
    return { store: new MemoryClaimStore(), durable: false }
  }
}
