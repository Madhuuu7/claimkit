'use client'

import { useActionState, useState } from 'react'
import {
  clearSettlementAction,
  recordSettlementAction,
  type ActionResult,
} from '@/app/actions'
import type { Settlement } from '@/lib/claim'
import { formatRupees } from '@/lib/money'

/**
 * The insurer's letter, typed in.
 *
 * It is a transcription, so the form is shaped like the letter: one
 * settled figure, then a line per deduction with the insurer's own
 * wording beside it. Nothing is computed here -- what the family is
 * owed an explanation for is worked out on the server, from the figures
 * they entered, and shown back to them on the claim.
 *
 * Amounts are typed in rupees and parsed to paise at the edge, by the
 * same parser the rest of the app uses, so "12,000" and "12000.50" both
 * mean what they look like.
 */

type Row = { key: number; amount: string; reason: string }

function rowsFrom(settlement: Settlement | null): Row[] {
  if (!settlement || settlement.deductions.length === 0) {
    return [{ key: 0, amount: '', reason: '' }]
  }
  return settlement.deductions.map((d, i) => ({
    key: i,
    // Plain digits, not the grouped display string: this is going back
    // into an input the person will edit.
    amount: (d.amountPaise / 100).toFixed(d.amountPaise % 100 === 0 ? 0 : 2),
    reason: d.reason,
  }))
}

export function SettlementForm({
  claimId,
  settlement,
  finalBillPaise,
}: {
  claimId: string
  settlement: Settlement | null
  finalBillPaise: number
}) {
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    recordSettlementAction.bind(null, claimId),
    null,
  )

  const [rows, setRows] = useState<Row[]>(() => rowsFrom(settlement))
  const [nextKey, setNextKey] = useState(rows.length)

  const addRow = () => {
    setRows((current) => [...current, { key: nextKey, amount: '', reason: '' }])
    setNextKey((k) => k + 1)
  }

  const removeRow = (key: number) =>
    setRows((current) =>
      current.length === 1 ? current : current.filter((row) => row.key !== key),
    )

  return (
    <>
      <form action={submit} className="sheet mt-5 px-5 py-6 sm:px-7">
        <label className="block max-w-[18rem]">
          <span className="block text-[0.82rem] text-ink-soft">
            Amount the insurer settled
          </span>
          <input
            className="money mt-1 w-full rounded border border-rule bg-sheet px-2.5 py-1.5"
            name="settledAmount"
            inputMode="decimal"
            placeholder="2,62,000"
            defaultValue={
              settlement ? String(settlement.settledAmountPaise / 100) : undefined
            }
            required
          />
          <span className="mt-1 block text-[0.78rem] text-ink-faint">
            The final bill was {formatRupees(finalBillPaise)}.
          </span>
        </label>

        <hr className="my-6 border-0 border-t border-rule" />

        <fieldset>
          <legend className="text-[0.82rem] text-ink-soft">
            What the letter says was deducted
          </legend>
          <p className="mt-1 max-w-[32rem] text-[0.82rem] text-ink-faint">
            One line per deduction, in the insurer&rsquo;s own words. Anything they kept
            without naming a reason is what you can go back to them about.
          </p>

          <ul className="mt-4 space-y-3">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-start gap-3">
                <input
                  className="money w-[8rem] rounded border border-rule bg-sheet px-2.5 py-1.5"
                  name="deductionAmount"
                  inputMode="decimal"
                  placeholder="12,000"
                  defaultValue={row.amount}
                  aria-label="Amount deducted"
                />
                <input
                  className="min-w-[12rem] flex-1 rounded border border-rule bg-sheet px-2.5 py-1.5"
                  name="deductionReason"
                  placeholder="Non-medical consumables"
                  defaultValue={row.reason}
                  aria-label="Reason given"
                />
                <button
                  type="button"
                  className="mt-1.5 text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink disabled:no-underline disabled:opacity-40"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <button type="button" className="btn btn-quiet mt-4" onClick={addRow}>
            Add another deduction
          </button>
        </fieldset>

        {result && 'error' in result && (
          <p className="mt-5 text-[0.88rem] text-amber">{result.error}</p>
        )}
        {result && 'ok' in result && (
          <p className="mt-5 text-[0.88rem] text-ink-soft">Saved.</p>
        )}

        <button className="btn mt-6" type="submit" disabled={pending}>
          {pending ? 'Recording' : settlement ? 'Update the settlement' : 'Record the settlement'}
        </button>
      </form>

      {settlement && <ClearSettlement claimId={claimId} />}
    </>
  )
}

/**
 * For a settlement typed against the wrong claim. It clears the figures
 * and leaves the status alone, because a settled claim is settled
 * whatever the family mistyped about it.
 */
function ClearSettlement({ claimId }: { claimId: string }) {
  const [result, clear, pending] = useActionState<ActionResult | null, FormData>(
    async () => clearSettlementAction(claimId),
    null,
  )
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <p className="mt-5 text-[0.82rem] text-ink-faint">
        Recorded against the wrong claim?{' '}
        <button
          type="button"
          className="underline decoration-rule hover:text-ink"
          onClick={() => setConfirming(true)}
        >
          Clear these figures
        </button>
      </p>
    )
  }

  return (
    <form action={clear} className="mt-5 text-[0.82rem] text-ink-soft">
      <span>
        This removes the settled amount and every deduction. The claim stays settled.
      </span>
      <span className="ml-3 inline-flex gap-3">
        <button type="submit" className="text-amber underline" disabled={pending}>
          {pending ? 'Clearing' : 'Clear them'}
        </button>
        <button
          type="button"
          className="underline decoration-rule"
          onClick={() => setConfirming(false)}
        >
          Keep them
        </button>
      </span>
      {result && 'error' in result && <p className="mt-2 text-amber">{result.error}</p>}
    </form>
  )
}
