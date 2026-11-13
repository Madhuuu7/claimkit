'use client'

import { useState } from 'react'
import { ALLOWED_TRANSITIONS, STATUS_LABEL, type Claim, type ClaimStatus } from '@/lib/claim'
import type { SyncEngine } from '@/lib/engine'

/**
 * Moving the claim along.
 *
 * Through the engine, like every other edit, so it works in a corridor
 * with the radio off: the sheet says "Submitted" the moment it is
 * tapped and the op waits in the outbox. It is also a register, so if
 * someone else moved the claim meanwhile the conflict panel asks rather
 * than one phone quietly winning.
 *
 * Settled is deliberately missing from the buttons. It is the only
 * state that carries figures with it -- an amount and a list of
 * deductions off the insurer's letter -- and a status with no letter
 * behind it would be a claim that says it was paid without saying what
 * was paid. It is recorded on the settlement screen instead.
 */
const HIDDEN: ClaimStatus[] = ['settled']

const VERB: Partial<Record<ClaimStatus, string>> = {
  submitted: 'Mark as submitted',
  query_raised: 'The insurer raised a query',
  query_resolved: 'We answered the query',
  rejected: 'The claim was rejected',
}

export function StatusControl({ claim, engine }: { claim: Claim; engine: SyncEngine }) {
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ClaimStatus | null>(null)

  const moves = ALLOWED_TRANSITIONS[claim.status].filter((to) => !HIDDEN.includes(to))

  async function move(to: ClaimStatus) {
    setConfirming(null)
    setError(await engine.setStatus(to))
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.82rem]">
      <span className="text-ink-soft">{STATUS_LABEL[claim.status]}</span>

      {moves.map((to) =>
        // Rejected is the one move nobody makes by accident and nobody
        // can take back, so it asks first. The rest are ordinary.
        to === 'rejected' && confirming !== to ? (
          <button
            key={to}
            type="button"
            className="text-ink-faint underline decoration-rule hover:text-ink"
            onClick={() => setConfirming(to)}
          >
            {VERB[to]}
          </button>
        ) : to === 'rejected' ? (
          <span key={to} className="inline-flex gap-3">
            <span className="text-ink-soft">A rejected claim cannot be reopened.</span>
            <button type="button" className="text-amber underline" onClick={() => void move(to)}>
              Record the rejection
            </button>
            <button
              type="button"
              className="text-ink-faint underline decoration-rule"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            key={to}
            type="button"
            className="text-teal underline decoration-rule hover:text-teal-deep"
            onClick={() => void move(to)}
          >
            {VERB[to] ?? STATUS_LABEL[to]}
          </button>
        ),
      )}

      {error && <span className="text-amber">{error}</span>}
    </div>
  )
}
