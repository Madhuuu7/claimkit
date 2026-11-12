'use client'

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Claim } from '@/lib/claim'
import { createFileQueue } from '@/lib/blobs'
import { deviceId } from '@/lib/device'
import { SyncEngine } from '@/lib/engine'
import { createStore } from '@/lib/outbox'
import { HttpTransport } from '@/lib/transport'
import { HttpUploadTransport, Uploader } from '@/lib/uploader'
import { refuseFile, type Uploads } from '@/lib/uploads-client'
import { useEngineState } from '@/lib/use-engine'
import { Sheet } from './Sheet'

/**
 * A real claim, on this device.
 *
 * The same engine the demo runs, pointed at the server instead of at a
 * simulation. Everything that makes the demo interesting is still true
 * here: a tap lands on the sheet before the network is consulted, the op
 * goes to IndexedDB first, and a refusal rolls it back with a reason.
 *
 * Two queues, deliberately separate. Operations are small and either
 * apply or are refused; files are megabytes that can stall halfway up a
 * hospital wifi. One queue would mean a 9 MB PDF holding up a tick.
 *
 * The snapshot comes from the page's server render, so the sheet is on
 * screen with real data before any JavaScript has asked the network
 * anything -- then the engine takes over and catches up from the log. It
 * starts that catch-up from the beginning of the log rather than from
 * the snapshot's position, on purpose: replaying an op whose effect is
 * already in the snapshot changes nothing, while reading the whole log
 * is what lets a device that was never online during a disagreement
 * still see both figures and ask.
 */
export function ClaimWorkspace({
  snapshot,
  deviceName,
  deadline,
  account,
}: {
  snapshot: Claim
  deviceName: string
  deadline: ReactNode
  account?: ReactNode
}) {
  const [{ engine, uploader }] = useState(() => {
    const id = deviceId()
    // One database per claim and device: two claims open in two tabs
    // must not share an outbox, or draining one would send the other's
    // edits to the wrong place.
    const { store, durable } = createStore(`claimkit-${snapshot.id}-${id}`)
    const { queue } = createFileQueue()

    return {
      engine: new SyncEngine({
        base: snapshot,
        store,
        transport: new HttpTransport(snapshot.id),
        device: { id, name: deviceName },
        durable,
        // No server push on this transport yet, so an idle tab asks.
        // Long enough not to be chatty, short enough that a family
        // member sees the other phone's upload while still looking.
        pollMs: 8_000,
      }),
      uploader: new Uploader(
        snapshot.id,
        queue,
        new HttpUploadTransport(snapshot.id),
        durable,
      ),
    }
  })

  useEffect(() => {
    void engine.start()
    void uploader.start()
  }, [engine, uploader])

  // One listener for both queues. navigator.onLine reports a usable
  // interface rather than a reachable server, so it is a hint that saves
  // pointless radio; a failed request is the real evidence.
  useEffect(() => {
    const update = () => {
      engine.setOnline(navigator.onLine)
      uploader.setOnline(navigator.onLine)
    }
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [engine, uploader])

  const state = useEngineState(engine)
  const files = useSyncExternalStore(
    uploader.subscribe,
    uploader.getState,
    uploader.getState,
  )

  // An upload cannot be recorded until its operation has been
  // acknowledged, and the operation is what creates the document row --
  // so every time the outbox drains, the file queue is worth another go.
  const queuedOps = state.queued.length
  useEffect(() => {
    if (queuedOps === 0) void uploader.flush()
  }, [queuedOps, uploader])

  const uploads: Uploads = useMemo(
    () => ({
      waitingDocIds: new Set(files.waiting.map((f) => f.docId)),
      uploadingDocId: files.uploading,
      viewUrl: (docId) => `/api/documents/${encodeURIComponent(docId)}/view`,
      addFile: async (itemId, file, amountPaise) => {
        const refusal = refuseFile(file)
        if (refusal) return refusal

        // One id for the bytes and for the document row: the uploader and
        // the op log have to be talking about the same file.
        const docId = crypto.randomUUID()

        // Bytes first. They exist nowhere else -- if the tab closes
        // between these two lines, the file is still recoverable, while
        // the other order would lose the only copy.
        await uploader.enqueue({
          docId,
          claimId: snapshot.id,
          name: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          blob: file,
        })

        const problem = await engine.addDocument(itemId, {
          id: docId,
          name: file.name,
          amountPaise,
        })

        // The claim would not take it -- an amount on a record, say. No
        // document row will ever exist, so the bytes have nothing to
        // belong to.
        if (problem) await uploader.drop(docId)

        return problem
      },
    }),
    [engine, uploader, files.waiting, files.uploading, snapshot.id],
  )

  return (
    <>
      <Sheet
        engine={engine}
        state={state}
        deviceId={deviceId()}
        deadline={deadline}
        account={account}
        uploads={uploads}
      />

      {files.refused.length > 0 && (
        <div className="mx-auto w-full max-w-[52rem] px-5 pb-10 sm:px-8">
          <section className="rounded-[6px] border border-rule bg-sheet px-5 py-4">
            <h2 className="section-heading">Files that could not be sent</h2>
            <ul className="mt-3 space-y-2">
              {files.refused.map((refusal) => (
                <li
                  key={refusal.docId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                >
                  <span className="text-[0.92rem]">{refusal.name}</span>
                  <span className="text-[0.88rem] text-amber">{refusal.reason}</span>
                  <button
                    type="button"
                    className="ml-auto text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
                    onClick={() => uploader.dismissRefusal(refusal.docId)}
                  >
                    Dismiss
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[0.82rem] text-ink-faint">
              The document is still on the checklist with nothing behind it. Remove it, or
              add the file again.
            </p>
          </section>
        </div>
      )}
    </>
  )
}
