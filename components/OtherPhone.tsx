'use client'

import { unaccounted, uploadedTotal } from '@/lib/claim'
import { formatRupees } from '@/lib/money'
import { useEngineState } from '@/lib/use-engine'
import type { Device } from '@/lib/world'
import { ConflictPanel, RolledBack } from './ConflictPanel'
import { ItemRow } from './ItemRow'
import { SignalSwitch } from './SignalSwitch'

/**
 * Another family member's phone, in a drawer under the sheet.
 *
 * It is the same engine, the same ledger and the same storage as the
 * sheet above -- a second device, not a preview of one. That is what
 * makes the conflict real rather than staged: take this phone offline,
 * tick an item here and un-tick it up there, bring both back, and two
 * devices have to agree about something neither of them saw.
 */
export function OtherPhone({
  device,
  hasSignal,
  onToggle,
}: {
  device: Device
  hasSignal: boolean
  onToggle: (on: boolean) => void
}) {
  const state = useEngineState(device.engine)
  const { claim } = state
  const waiting = state.queued.length

  return (
    <div className="border-t border-rule bg-paper-sunk">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6 sm:px-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <h2 className="section-heading">{device.name}&rsquo;s phone</h2>
            <p className="text-[0.84rem] text-ink-soft">
              {waiting > 0
                ? `${waiting} ${waiting === 1 ? 'edit' : 'edits'} ${
                    hasSignal ? 'waiting to send' : 'waiting for signal'
                  }`
                : hasSignal
                  ? 'Up to date with the server'
                  : 'Offline, nothing waiting'}
            </p>
          </div>

          <div className="flex items-center gap-5">
            <p className="text-[0.84rem] text-ink-soft">
              gap{' '}
              <span className="money text-ink">{formatRupees(unaccounted(claim))}</span>
              <span className="text-ink-faint">
                {' '}
                · {formatRupees(uploadedTotal(claim))} uploaded
              </span>
            </p>
            <SignalSwitch on={hasSignal} onChange={onToggle} />
          </div>
        </div>

        <ConflictPanel
          conflicts={state.conflicts}
          claim={claim}
          engine={device.engine}
          deviceId={device.id}
        />
        <RolledBack rejections={state.rejections} claim={claim} engine={device.engine} />

        <div className="mt-5 max-h-[18rem] overflow-y-auto rounded-[6px] border border-rule bg-sheet px-4 py-2 sm:px-5">
          <table className="ledger">
            <tbody>
              {claim.items.map((item) => (
                <ItemRow key={item.id} item={item} claim={claim} engine={device.engine} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
