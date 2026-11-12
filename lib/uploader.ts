import type { FileQueue, QueuedFile } from './blobs'

/**
 * The thing that gets queued files into the bucket.
 *
 * Kept apart from the sync engine on purpose. They fail differently: an
 * operation is a few hundred bytes that either applies or is refused,
 * while an upload is megabytes that can stall halfway up a hospital
 * wifi. Putting them in one queue would mean a 9 MB PDF blocking a tick,
 * which is the opposite of what the family needs -- so the engine sends
 * the edit immediately and the bytes follow at their own pace.
 *
 * The order between them still matters in one direction: the document
 * row is created by the operation, so an upload offered before its
 * operation has been acknowledged is told "not on this claim yet". That
 * is not an error, it is a wait, and the uploader simply tries again.
 */

export type UploaderState = {
  /** Files still to go up, oldest first. */
  waiting: QueuedFile[]
  /** The one on the wire now, if any. */
  uploading: string | null
  /** Files the server would not take, with the reason to show. */
  refused: { docId: string; name: string; reason: string }[]
  durable: boolean
}

type Transport = {
  begin(file: QueuedFile): Promise<{ url: string } | { refused: string } | 'not-yet'>
  put(url: string, file: QueuedFile): Promise<boolean>
  complete(file: QueuedFile): Promise<boolean>
}

export class HttpUploadTransport implements Transport {
  constructor(private readonly claimId: string) {}

  private get url(): string {
    return `/api/claims/${encodeURIComponent(this.claimId)}/uploads`
  }

  async begin(file: QueuedFile): Promise<{ url: string } | { refused: string } | 'not-yet'> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: file.docId,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      }),
    })

    if (response.ok) return (await response.json()) as { url: string }

    if (response.status === 409) {
      const { error } = (await response.json().catch(() => ({ error: '' }))) as {
        error?: string
      }
      // The operation has not landed yet. Keep the file and wait.
      if (error?.includes('not on this claim yet')) return 'not-yet'
      // Already uploaded: a previous attempt got further than it was
      // able to report. Nothing left to do.
      if (error?.includes('already been uploaded')) return { refused: '' }
      return { refused: error || 'The upload was refused' }
    }

    if (response.status === 401 || response.status === 503) {
      // Needs a session, or the deployment has no bucket. Both are
      // worth waiting on rather than discarding a file for.
      return 'not-yet'
    }

    if (response.status === 404 || response.status === 422) {
      return { refused: 'This claim will not take that file' }
    }

    throw new Error(`Could not start the upload: ${response.status}`)
  }

  async put(url: string, file: QueuedFile): Promise<boolean> {
    const response = await fetch(url, {
      method: 'PUT',
      // Must match what was signed, byte for byte, or R2 refuses it.
      headers: { 'content-type': file.contentType },
      body: file.blob,
    })
    return response.ok
  }

  async complete(file: QueuedFile): Promise<boolean> {
    const response = await fetch(this.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: file.docId, contentType: file.contentType }),
    })
    return response.ok
  }
}

export class Uploader {
  private listeners = new Set<() => void>()
  private cache: UploaderState | null = null
  private waiting: QueuedFile[] = []
  private refused: { docId: string; name: string; reason: string }[] = []
  private uploading: string | null = null
  private running: Promise<void> | null = null
  private online = true

  constructor(
    private readonly claimId: string,
    private readonly queue: FileQueue,
    private readonly transport: Transport,
    private readonly durable = true,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): UploaderState => {
    this.cache ??= {
      waiting: this.waiting,
      uploading: this.uploading,
      refused: this.refused,
      durable: this.durable,
    }
    return this.cache
  }

  private changed(): void {
    this.cache = null
    for (const listener of this.listeners) listener()
  }

  /** Read whatever a previous visit left behind, then get on with it. */
  async start(): Promise<void> {
    this.waiting = await this.queue.all(this.claimId)
    this.changed()
    void this.flush()
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) void this.flush()
  }

  /**
   * Take the file now, before anything is sent. Returns once it is
   * durably queued, so the caller can register the document knowing the
   * bytes cannot be lost.
   */
  async enqueue(file: Omit<QueuedFile, 'queuedAt' | 'attempts'>): Promise<void> {
    const queued: QueuedFile = { ...file, queuedAt: new Date().toISOString(), attempts: 0 }
    await this.queue.put(queued)
    this.waiting = [...this.waiting, queued]
    this.changed()
    void this.flush()
  }

  dismissRefusal(docId: string): void {
    this.refused = this.refused.filter((r) => r.docId !== docId)
    this.changed()
  }

  /** Forget a file whose document was removed before it ever went up. */
  async drop(docId: string): Promise<void> {
    await this.queue.remove(docId)
    this.waiting = this.waiting.filter((f) => f.docId !== docId)
    this.changed()
  }

  flush(): Promise<void> {
    this.running ??= this.drain().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.online) {
      // Re-read the head every time round rather than trusting an index:
      // a document can be removed while its bytes are on the wire, and
      // `drop` will already have taken it out from under us.
      const file = this.waiting[0]
      if (!file) return

      this.uploading = file.docId
      this.changed()

      let done = false
      try {
        done = await this.sendOne(file)
      } catch {
        // Network trouble. The file is still on disk; stop and let the
        // next reconnect pick it up.
        this.uploading = null
        this.changed()
        return
      }

      this.uploading = null

      if (!this.waiting.some((f) => f.docId === file.docId)) {
        // Removed while uploading. Nothing to record, nothing to retry.
        this.changed()
        continue
      }

      if (done) {
        await this.queue.remove(file.docId)
        this.waiting = this.waiting.filter((f) => f.docId !== file.docId)
        this.changed()
        continue
      }

      // Not refused and not finished: it is waiting for its operation to
      // be acknowledged. To the back of the queue, so one waiting file
      // does not hold up the others.
      this.waiting = [
        ...this.waiting.filter((f) => f.docId !== file.docId),
        { ...file, attempts: file.attempts + 1 },
      ]
      this.changed()
      return
    }
  }

  private async sendOne(file: QueuedFile): Promise<boolean> {
    const begun = await this.transport.begin(file)

    if (begun === 'not-yet') return false

    if ('refused' in begun) {
      // Refused for good, or already up there. Either way the bytes have
      // no further purpose on this device -- but a refusal with a reason
      // is something the family has to be told, because the document row
      // is on their checklist with no file behind it.
      if (begun.refused) {
        this.refused = [
          ...this.refused,
          { docId: file.docId, name: file.name, reason: begun.refused },
        ]
      }
      return true
    }

    const put = await this.transport.put(begun.url, file)
    if (!put) return false

    // Only now is the document recorded as uploaded, and the server
    // checks the bucket before believing it.
    return this.transport.complete(file)
  }
}
