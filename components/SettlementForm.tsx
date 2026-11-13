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
 *
 * Every field is controlled, and the fields remount when a save comes
 * back. Both are deliberate, and between them they close a hole that
 * quietly destroyed data: React clears an uncontrolled form once its
 * action settles, so after an in-place correction the deduction rows
 * came back blank, and pressing Update a second time submitted those
 * blanks and wiped the deductions. Holding the text in state means a
 * rejected save keeps what was typed; keying the fields on the saved
 * settlement means an accepted one shows what the server really stored.
 */

type Row = { key: number; amount: string; reason: string }

/** Plain digits, for an input someone is about to edit. Not a display string. */
function rupees(paise: number): string {
  return (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)
}

function rowsFrom(settlement: Settlement | null): Row[] {
  if (!settlement || settlement.deductions.length === 0) {
    return [{ key: 0, amount: '', reason: '' }]
  }
  return settlement.deductions.map((d, i) => ({
    key: i,
    amount: rupees(d.amountPaise),
    reason: d.reason,
  }))
}

/**
 * What the fields were filled from. A different one means the server
 * holds a different letter than the one on screen, so the fields are
 * rebuilt from it. `settledAt` moves on every save, which is what makes
 * a correction that changed no figures still refresh the form.
 */
function fingerprint(settlement: Settlement | null): string {
  if (!settlement) return 'none'
  return [
    settlement.settledAt,
    settlement.settledAmountPaise,
    ...settlement.deductions.map((d) => `${d.id}:${d.amountPaise}:${d.reason}`),
  ].join('|')
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
  // The action state sits outside the keyed fields on purpose: a save
  // both remounts them and produces the message about having done so,
  // and the message has to outlive the remount.
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    recordSettlementAction.bind(null, claimId),
    null,
  )

  return (
    <>
      <SettlementFields
        key={fingerprint(settlement)}
        settlement={settlement}
        finalBillPaise={finalBillPaise}
        submit={submit}
        pending={pending}
        result={result}
      />
      {settlement && <ClearSettlement claimId={claimId} />}
    </>
  )
}

function SettlementFields({
  settlement,
  finalBillPaise,
  submit,
  pending,
  result,
}: {
  settlement: Settlement | null
  finalBillPaise: number
  submit: (formData: FormData) => void
  pending: boolean
  result: ActionResult | null
}) {
  const [settled, setSettled] = useState(() =>
    settlement ? rupees(settlement.settledAmountPaise) : '',
  )
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(settlement))
  const [nextKey, setNextKey] = useState(rows.length)

  const addRow = () => {
    setRows((current) => [...current, { key: nextKey, amount: '', reason: '' }])
    setNextKey((k) => k + 1)
  }

  const editRow = (key: number, field: 'amount' | 'reason', value: string) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )

  const removeRow = (key: number) =>
    setRows((current) =>
      current.length === 1 ? current : current.filter((row) => row.key !== key),
    )

  return (
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
          value={settled}
          onChange={(event) => setSettled(event.target.value)}
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
                value={row.amount}
                onChange={(event) => editRow(row.key, 'amount', event.target.value)}
                aria-label="Amount deducted"
              />
              <input
                className="min-w-[12rem] flex-1 rounded border border-rule bg-sheet px-2.5 py-1.5"
                name="deductionReason"
                placeholder="Non-medical consumables"
                value={row.reason}
                onChange={(event) => editRow(row.key, 'reason', event.target.value)}
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
        {pending
          ? 'Recording'
          : settlement
            ? 'Update the settlement'
            : 'Record the settlement'}
      </button>
    </form>
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
