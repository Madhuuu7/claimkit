'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Claim } from '@/lib/claim'
import { useBrowserConnection, useEngineState } from '@/lib/use-engine'
import { createWorld } from '@/lib/world'
import { OtherPhone } from './OtherPhone'
import { Sheet } from './Sheet'
import { SignalSwitch } from './SignalSwitch'

const MEMBERS = [
  { id: 'phone-madhura', name: 'Madhura' },
  { id: 'phone-anand', name: 'Anand' },
]

/**
 * The claim, on two phones, with a switch on each wire.
 *
 * Everything in this app is built for the case where a switch is off --
 * the edit lands on the sheet, goes to IndexedDB, and waits -- and there
 * is no way to show that to anyone without letting them cut the wire
 * themselves, mid-upload, and watch what happens. The second phone is a
 * real second device on the same server, so a disagreement between two
 * family members can be created rather than described.
 */
export function Workspace({ base, deadline }: { base: Claim; deadline: ReactNode }) {
  const [world] = useState(() => createWorld(base, MEMBERS))
  const [signal, setSignal] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MEMBERS.map((m) => [m.id, true])),
  )
  const [showOther, setShowOther] = useState(false)
  const [losingReplies, setLosingReplies] = useState(false)

  // Restore the server's log, then read each outbox off disk. In that
  // order: a phone that synced first would pull an empty log and be told
  // its own history was new.
  useEffect(() => {
    void world.open()
  }, [world])

  const [mine, theirs] = world.devices
  useBrowserConnection(mine.engine, signal[mine.id])
  const state = useEngineState(mine.engine)

  const toggle = (deviceId: string, on: boolean) => {
    setSignal((previous) => ({ ...previous, [deviceId]: on }))
    const device = world.devices.find((d) => d.id === deviceId)
    device?.network.setOnline(on)
    device?.engine.setOnline(on)
  }

  const toggleReplies = (losing: boolean) => {
    setLosingReplies(losing)
    // The reply is dropped after the server has applied the op, so the
    // work happens and the client never hears about it. Its retry is then
    // a duplicate, and the op id is the only thing standing between that
    // and a second receipt on the claim.
    for (const device of world.devices) device.network.setDropAckRate(losing ? 1 : 0)
  }

  return (
    <>
      <Sheet engine={mine.engine} state={state} deviceId={mine.id} deadline={deadline} />

      <div className="fixed inset-x-0 bottom-0">
        {showOther && (
          <OtherPhone
            device={theirs}
            hasSignal={signal[theirs.id]}
            onToggle={(on) => toggle(theirs.id, on)}
          />
        )}

        <div className="border-t border-rule bg-sheet/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[52rem] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
            <p className="text-[0.82rem] text-ink-soft">
              <span className="text-ink">{mine.name}&rsquo;s phone</span>
              {state.queued.length > 0 && (
                <span className="text-ink-faint">
                  {' '}
                  · {state.queued.length}{' '}
                  {state.queued.length === 1 ? 'edit' : 'edits'} in the outbox
                </span>
              )}
              {state.ready && !state.durable && (
                <span className="text-ink-faint"> · storage unavailable here</span>
              )}
            </p>

            <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-[0.82rem] text-ink-soft">
                <input
                  type="checkbox"
                  checked={losingReplies}
                  onChange={(e) => toggleReplies(e.target.checked)}
                />
                Lose the server&rsquo;s replies
              </label>

              <button
                type="button"
                className="text-[0.82rem] text-teal underline decoration-rule"
                aria-expanded={showOther}
                onClick={() => setShowOther((v) => !v)}
              >
                {showOther ? `Hide ${theirs.name}’s phone` : `${theirs.name}’s phone`}
              </button>

              <button
                type="button"
                className="text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
                onClick={async () => {
                  await world.reset()
                  window.location.reload()
                }}
              >
                Start over
              </button>

              <SignalSwitch on={signal[mine.id]} onChange={(on) => toggle(mine.id, on)} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
