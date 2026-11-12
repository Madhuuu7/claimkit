import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { MemoryFileQueue, createFileQueue, type FileQueue, type QueuedFile } from './blobs'
import { Uploader } from './uploader'

/**
 * The file queue and the uploader, with the network faked.
 *
 * What matters here is what happens to the *bytes* when things go wrong:
 * a file must never be dropped because a request failed, must not be
 * uploaded twice, and must not sit at the head of the queue blocking
 * every file behind it while it waits for its operation to land.
 */

function file(docId: string, options: Partial<QueuedFile> = {}): Omit<QueuedFile, 'queuedAt' | 'attempts'> {
  return {
    docId,
    claimId: 'claim-1',
    name: `${docId}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 2048,
    blob: new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }),
    ...options,
  }
}

type Script = {
  begin?: (f: QueuedFile) => Promise<{ url: string } | { refused: string } | 'not-yet'>
  put?: () => Promise<boolean>
  complete?: () => Promise<boolean>
}

function fakeTransport(script: Script = {}) {
  const calls = { begin: [] as string[], put: [] as string[], complete: [] as string[] }
  return {
    calls,
    transport: {
      async begin(f: QueuedFile) {
        calls.begin.push(f.docId)
        return script.begin ? script.begin(f) : { url: `https://bucket.test/${f.docId}` }
      },
      async put(_url: string, f: QueuedFile) {
        calls.put.push(f.docId)
        return script.put ? script.put() : true
      },
      async complete(f: QueuedFile) {
        calls.complete.push(f.docId)
        return script.complete ? script.complete() : true
      },
    },
  }
}

function uploader(script: Script = {}, queue: FileQueue = new MemoryFileQueue()) {
  const { transport, calls } = fakeTransport(script)
  return { uploader: new Uploader('claim-1', queue, transport), calls, queue }
}

describe('the file queue', () => {
  it('holds the bytes before anything is sent', async () => {
    const { uploader: up, queue } = uploader({ begin: async () => 'not-yet' })
    await up.enqueue(file('doc-1'))
    // Queued and durable even though the upload has not started.
    expect(await queue.get('doc-1')).toMatchObject({ name: 'doc-1.jpg', attempts: 0 })
  })

  it('keeps each claim files to itself', async () => {
    const { queue } = createFileQueue()
    await queue.put({ ...file('a'), queuedAt: '2026-11-13T00:00:00Z', attempts: 0 })
    await queue.put({
      ...file('b', { claimId: 'claim-2' }),
      queuedAt: '2026-11-13T00:00:01Z',
      attempts: 0,
    })
    expect((await queue.all('claim-1')).map((f) => f.docId)).toEqual(['a'])
    expect((await queue.all('claim-2')).map((f) => f.docId)).toEqual(['b'])
  })

  it('survives the tab closing', async () => {
    // A new queue object against the same database is what a reload
    // looks like from here, and the bytes are what a reload must not
    // lose: they exist nowhere else.
    const first = createFileQueue().queue
    await first.put({ ...file('ward-photo'), queuedAt: '2026-11-13T00:00:00Z', attempts: 0 })

    const second = createFileQueue().queue
    const recovered = await second.all('claim-1')
    expect(recovered.map((f) => f.docId)).toContain('ward-photo')
    expect(recovered.find((f) => f.docId === 'ward-photo')!.sizeBytes).toBe(2048)
  })
})

describe('uploading', () => {
  it('asks, puts, then reports, in that order', async () => {
    const { uploader: up, calls } = uploader()
    await up.enqueue(file('doc-1'))
    await up.flush()

    expect(calls.begin).toEqual(['doc-1'])
    expect(calls.put).toEqual(['doc-1'])
    // The document is only recorded as uploaded after the bytes are up,
    // and the server checks the bucket before believing even that.
    expect(calls.complete).toEqual(['doc-1'])
    expect(up.getState().waiting).toEqual([])
  })

  it('forgets the bytes only once the server has them', async () => {
    const { uploader: up, queue } = uploader()
    await up.enqueue(file('doc-1'))
    await up.flush()
    expect(await queue.get('doc-1')).toBeNull()
  })

  it('keeps the file when the upload itself fails', async () => {
    const { uploader: up, queue, calls } = uploader({ put: async () => false })
    await up.enqueue(file('doc-1'))
    await up.flush()

    expect(calls.complete).toEqual([])
    expect(await queue.get('doc-1')).not.toBeNull()
  })

  it('keeps the file when the network throws', async () => {
    const { uploader: up, queue } = uploader({
      begin: async () => {
        throw new Error('offline')
      },
    })
    await up.enqueue(file('doc-1'))
    await up.flush()
    expect(await queue.get('doc-1')).not.toBeNull()
    expect(up.getState().uploading).toBeNull()
  })

  it('does nothing at all while there is no signal', async () => {
    const { uploader: up, calls } = uploader()
    up.setOnline(false)
    await up.enqueue(file('doc-1'))
    await up.flush()
    expect(calls.begin).toEqual([])
  })

  it('goes as soon as the signal comes back', async () => {
    const { uploader: up, calls } = uploader()
    up.setOnline(false)
    await up.enqueue(file('doc-1'))
    up.setOnline(true)
    await up.flush()
    expect(calls.complete).toEqual(['doc-1'])
  })

  it('waits for the operation to land rather than discarding the file', async () => {
    // The document row is created by the add_doc operation, which may
    // still be in the outbox. "Not on this claim yet" is a wait.
    let acknowledged = false
    const { uploader: up, calls, queue } = uploader({
      begin: async (f) =>
        acknowledged ? { url: `https://bucket.test/${f.docId}` } : 'not-yet',
    })

    await up.enqueue(file('doc-1'))
    await up.flush()
    expect(calls.put).toEqual([])
    expect(await queue.get('doc-1')).not.toBeNull()

    acknowledged = true
    await up.flush()
    expect(calls.complete).toEqual(['doc-1'])
  })

  it('does not let a waiting file block the ones behind it', async () => {
    const { uploader: up, calls } = uploader({
      begin: async (f) =>
        f.docId === 'slow' ? 'not-yet' : { url: `https://bucket.test/${f.docId}` },
    })

    await up.enqueue(file('slow'))
    await up.enqueue(file('quick'))
    await up.flush() // slow waits, and goes to the back
    await up.flush() // quick goes up

    expect(calls.complete).toEqual(['quick'])
    expect(up.getState().waiting.map((f) => f.docId)).toEqual(['slow'])
  })

  it('tells the family when a file is refused for good', async () => {
    // The document row is on their checklist with nothing behind it, so
    // silence here would be a tick that means nothing.
    const { uploader: up, queue } = uploader({
      begin: async () => ({ refused: 'Files must be 10 MB or smaller' }),
    })
    await up.enqueue(file('too-big'))
    await up.flush()

    expect(up.getState().refused).toEqual([
      { docId: 'too-big', name: 'too-big.jpg', reason: 'Files must be 10 MB or smaller' },
    ])
    // No point holding bytes the server will never take.
    expect(await queue.get('too-big')).toBeNull()
  })

  it('says nothing when the file was already up there', async () => {
    // A previous attempt got further than it managed to report. Not a
    // failure, and not worth a notice.
    const { uploader: up } = uploader({ begin: async () => ({ refused: '' }) })
    await up.enqueue(file('doc-1'))
    await up.flush()
    expect(up.getState().refused).toEqual([])
    expect(up.getState().waiting).toEqual([])
  })

  it('lets a refusal be dismissed', async () => {
    const { uploader: up } = uploader({ begin: async () => ({ refused: 'No' }) })
    await up.enqueue(file('doc-1'))
    await up.flush()
    up.dismissRefusal('doc-1')
    expect(up.getState().refused).toEqual([])
  })

  it('drops the bytes when the document is removed before they go up', async () => {
    const { uploader: up, queue } = uploader({ begin: async () => 'not-yet' })
    await up.enqueue(file('doc-1'))
    await up.drop('doc-1')
    expect(await queue.get('doc-1')).toBeNull()
    expect(up.getState().waiting).toEqual([])
  })

  it('picks up what a previous visit left queued', async () => {
    const queue = new MemoryFileQueue()
    await queue.put({ ...file('from-yesterday'), queuedAt: '2026-11-12T20:00:00Z', attempts: 2 })

    const { uploader: up, calls } = uploader({}, queue)
    await up.start()
    await up.flush()

    expect(calls.complete).toEqual(['from-yesterday'])
  })

  it('uploads in the order the receipts were photographed', async () => {
    const queue = new MemoryFileQueue()
    await queue.put({ ...file('second'), queuedAt: '2026-11-13T00:00:02Z', attempts: 0 })
    await queue.put({ ...file('first'), queuedAt: '2026-11-13T00:00:01Z', attempts: 0 })

    const { uploader: up, calls } = uploader({}, queue)
    await up.start()
    await up.flush()

    expect(calls.begin).toEqual(['first', 'second'])
  })
})
