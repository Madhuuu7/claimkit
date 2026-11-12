'use client'

import { useState, type ReactNode } from 'react'
import type { Claim } from '@/lib/claim'
import { useBrowserConnection, useEngineStart, useEngineState } from '@/lib/use-engine'
import { createWorld, type Device } from '@/lib/world'
import { Sheet } from './Sheet'

/**
 * The claim, on a phone, with a switch for the signal.
 *
 * The switch is not a toy. Everything below this line is built for the
 * case where it is off -- the edit lands on the sheet, goes to IndexedDB,
 * and waits -- and there is no way to show that to anyone without letting
 * them turn the radio off themselves, mid-upload, and watch what happens.
 */
export function Workspace({ base, deadline }: { base: Claim; deadline: ReactNode }) {
  const [world] = useState(() =>
    createWorld(base, [{ id: 'phone-madhura', name: 'Madhura' }]),
  )
  const device = world.devices[0]
  const [hasSignal, setHasSignal] = useState(true)

  useEngineStart(device.engine)
  // While the demo says there is signal, the browser's own view of the
  // network is in charge. While it says there is none, nothing overrides
  // it.
  useBrowserConnection(device.engine, hasSignal)
  const state = useEngineState(device.engine)

  const toggle = (on: boolean) => {
    setHasSignal(on)
    device.network.setOnline(on)
    device.engine.setOnline(on)
  }

  return (
    <>
      <Sheet
        engine={device.engine}
        state={state}
        deviceId={device.id}
        deadline={deadline}
      />
      <DemoBar
        device={device}
        hasSignal={hasSignal}
        onToggle={toggle}
        queued={state.queued.length}
        storageMissing={state.ready && !state.durable}
      />
    </>
  )
}

function DemoBar({
  device,
  hasSignal,
  onToggle,
  queued,
  storageMissing,
}: {
  device: Device
  hasSignal: boolean
  onToggle: (on: boolean) => void
  queued: number
  storageMissing: boolean
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-rule bg-sheet/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[52rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
        <p className="text-[0.82rem] text-ink-soft">
          <span className="text-ink">{device.name}&rsquo;s phone</span>
          {queued > 0 && (
            <span className="text-ink-faint">
              {' '}
              · {queued} {queued === 1 ? 'edit' : 'edits'} in the outbox
            </span>
          )}
          {storageMissing && (
            <span className="text-ink-faint"> · storage unavailable in this browser</span>
          )}
        </p>

        <label className="flex cursor-pointer items-center gap-2.5 text-[0.85rem]">
          <span className={hasSignal ? 'text-ink-soft' : 'text-amber'}>
            {hasSignal ? 'Signal' : 'No signal'}
          </span>
          <input
            type="checkbox"
            className="sr-only"
            checked={hasSignal}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span
            aria-hidden="true"
            className={`relative h-5 w-9 rounded-full border transition-colors ${
              hasSignal ? 'border-teal bg-teal' : 'border-rule bg-paper-sunk'
            }`}
          >
            <span
              className={`absolute top-[0.1rem] h-[0.95rem] w-[0.95rem] rounded-full bg-sheet shadow-sm transition-all ${
                hasSignal ? 'left-[1.05rem]' : 'left-[0.1rem]'
              }`}
            />
          </span>
        </label>
      </div>
    </div>
  )
}
