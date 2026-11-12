/**
 * The file queue.
 *
 * The op outbox makes an *edit* survive having no signal. This makes the
 * *file* survive it, which is the harder half: a receipt photographed in
 * a ward is a few megabytes of bytes that exist nowhere else, and losing
 * them because the tab closed would be unforgivable in a way that losing
 * a tick is not.
 *
 * So the blob goes into IndexedDB in the same breath as the operation,
 * and the uploader drains it later. IndexedDB can hold a Blob natively,
 * which is the reason this is not localStorage: base64 in a string store
 * would be a third larger and would not fit.
 */

export type QueuedFile = {
  /** The document id the op created. The upload is matched to it. */
  docId: string
  claimId: string
  name: string
  contentType: string
  sizeBytes: number
  blob: Blob
  queuedAt: string
  attempts: number
  lastError?: string
}

const DB_NAME = 'claimkit-files'
const DB_VERSION = 1
const STORE = 'files'

export interface FileQueue {
  put(file: QueuedFile): Promise<void>
  all(claimId: string): Promise<QueuedFile[]>
  get(docId: string): Promise<QueuedFile | null>
  remove(docId: string): Promise<void>
}

class IdbFileQueue implements FileQueue {
  private db: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'docId' })
          // One claim at a time: a phone may have files waiting for two
          // different claims and must not upload them to the wrong one.
          store.createIndex('claimId', 'claimId')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Another ClaimKit tab is upgrading'))
    })
    return this.db
  }

  private async run<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = body(tx.objectStore(STORE))
      let value: T
      request.onsuccess = () => {
        value = request.result
      }
      request.onerror = () => reject(request.error)
      // On commit, not on success: a file is only safe once the
      // transaction is on disk.
      tx.oncomplete = () => resolve(value)
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
  }

  async put(file: QueuedFile): Promise<void> {
    await this.run('readwrite', (store) => store.put(file))
  }

  async all(claimId: string): Promise<QueuedFile[]> {
    const files = await this.run<QueuedFile[]>(
      'readonly',
      (store) => store.index('claimId').getAll(claimId) as IDBRequest<QueuedFile[]>,
    )
    return files.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
  }

  async get(docId: string): Promise<QueuedFile | null> {
    const file = await this.run<QueuedFile | undefined>(
      'readonly',
      (store) => store.get(docId) as IDBRequest<QueuedFile | undefined>,
    )
    return file ?? null
  }

  async remove(docId: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(docId))
  }
}

/** For tests, and for a browser that will not give us storage. */
export class MemoryFileQueue implements FileQueue {
  private files = new Map<string, QueuedFile>()

  async put(file: QueuedFile): Promise<void> {
    this.files.set(file.docId, file)
  }
  async all(claimId: string): Promise<QueuedFile[]> {
    return [...this.files.values()]
      .filter((f) => f.claimId === claimId)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
  }
  async get(docId: string): Promise<QueuedFile | null> {
    return this.files.get(docId) ?? null
  }
  async remove(docId: string): Promise<void> {
    this.files.delete(docId)
  }
}

export function createFileQueue(): { queue: FileQueue; durable: boolean } {
  try {
    if (typeof indexedDB === 'undefined') {
      return { queue: new MemoryFileQueue(), durable: false }
    }
    return { queue: new IdbFileQueue(), durable: true }
  } catch {
    return { queue: new MemoryFileQueue(), durable: false }
  }
}
