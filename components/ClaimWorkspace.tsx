'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Claim } from '@/lib/claim'
import { deviceId } from '@/lib/device'
import { SyncEngine } from '@/lib/engine'
import { createStore } from '@/lib/outbox'
import { HttpTransport } from '@/lib/transport'
import { useBrowserConnection, useEngineState } from '@/lib/use-engine'
import { Sheet } from './Sheet'

/**
 * A real claim, on this device.
 *
 * The same engine the demo runs, pointed at the server instead of at a
 * simulation. Everything that makes the demo interesting is still true
 * here: a tap lands on the sheet before the network is consulted, the op
 * goes to IndexedDB first, and a refusal rolls it back with a reason.
 *
 * The snapshot comes from the page's server render, so the sheet is on
 * screen with real data before any JavaScript has asked the network
 * anything -- then the engine takes over and catches up from the log.
 *
 * It starts that catch-up from the beginning of the log rather than from
 * the snapshot's position, and that is on purpose. Replaying an op whose
 * effect is already in the snapshot changes nothing -- documents are a
 * set keyed by id, the single-value writes land on the value they
 * already hold, and a status move the machine has passed is refused --
 * while reading the whole log is what lets a device that was never
 * online during a disagreement still see both figures and ask.
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
  const [engine] = useState(() => {
    const id = deviceId()
    // One database per claim: two claims open in two tabs must not share
    // an outbox, or draining one would send the other's edits to the
    // wrong place.
    const { store, durable } = createStore(`claimkit-${snapshot.id}-${id}`)
    return new SyncEngine({
      base: snapshot,
      store,
      transport: new HttpTransport(snapshot.id),
      device: { id, name: deviceName },
      durable,
      // No server push on this transport yet, so an idle tab asks. Long
      // enough not to be chatty, short enough that a family member sees
      // the other phone's upload while they are still looking.
      pollMs: 8_000,
    })
  })

  useEffect(() => {
    void engine.start()
  }, [engine])
  useBrowserConnection(engine)

  const state = useEngineState(engine)

  return (
    <Sheet
      engine={engine}
      state={state}
      deviceId={deviceId()}
      deadline={deadline}
      account={account}
    />
  )
}
