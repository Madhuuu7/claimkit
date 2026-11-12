'use client'

import type { Claim } from '@/lib/claim'
import type { Rejection, SyncEngine } from '@/lib/engine'
import { describeConflictSubject, describeOp, describeValue, type Conflict } from '@/lib/ops'

/**
 * Where two family members disagreed.
 *
 * The log has already converged -- every phone shows the later write --
 * so this panel is not here to make the app work. It is here because the
 * app is wrong to be confident: one of these two figures is what the
 * hospital actually charged, and software has no way to know which.
 * Nothing is auto-merged away, and nothing is lost; a person chooses.
 */
export function ConflictPanel({
  conflicts,
  claim,
  engine,
  deviceId,
}: {
  conflicts: Conflict[]
  claim: Claim
  engine: SyncEngine
  deviceId: string
}) {
  if (conflicts.length === 0) return null

  return (
    <section className="mt-8 rounded-[6px] border border-amber/35 bg-amber-wash px-5 py-5 sm:px-7">
      <h2 className="section-heading">
        {conflicts.length === 1
          ? 'Two of you entered different things'
          : `${conflicts.length} things two of you entered differently`}
      </h2>
      <p className="mt-1.5 text-[0.9rem] text-ink-soft">
        Both edits were made without seeing the other. Nothing has been thrown away --
        choose which one goes to the insurer.
      </p>

      <ul className="mt-5 space-y-5">
        {conflicts.map((conflict) => {
          const subject = describeConflictSubject(conflict, claim)
          const sides = [conflict.winner, conflict.loser]
          return (
            <li key={`${conflict.register}:${conflict.winner.id}`}>
              <p className="text-[0.92rem]">{subject}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sides.map((side) => (
                  <button
                    key={side.id}
                    type="button"
                    className="btn btn-quiet border-amber/40 bg-sheet px-3 py-1.5 text-[0.9rem] text-ink hover:bg-paper-sunk"
                    onClick={() => void engine.resolveConflict(conflict, side)}
                  >
                    <span className="money font-medium">{describeValue(side, claim)}</span>
                    <span className="text-ink-soft">
                      {side.deviceId === deviceId ? 'you' : side.by}
                      {side === conflict.winner && ' · showing now'}
                    </span>
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Edits the server refused. They have already been taken back off the
 * sheet, which is the part that must not be silent: the family needs to
 * know the figure they typed in the ward is not on the claim any more,
 * and why.
 */
export function RolledBack({
  rejections,
  claim,
  engine,
}: {
  rejections: Rejection[]
  claim: Claim
  engine: SyncEngine
}) {
  if (rejections.length === 0) return null

  return (
    <section className="mt-8 rounded-[6px] border border-rule bg-sheet px-5 py-4 sm:px-7">
      <h2 className="section-heading">Taken back off the claim</h2>
      <ul className="mt-3 space-y-3">
        {rejections.map((rejection) => (
          <li key={rejection.op.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[0.92rem]">
              {rejection.op.by} {describeOp(rejection.op, claim)}
            </span>
            <span className="text-[0.88rem] text-amber">{rejection.reason}</span>
            <button
              type="button"
              className="ml-auto text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
              onClick={() => engine.dismissRejection(rejection.op.id)}
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
