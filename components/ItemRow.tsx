'use client'

import { useId, useState } from 'react'
import { itemState, type ChecklistItem, type Claim } from '@/lib/claim'
import type { SyncEngine } from '@/lib/engine'
import { MoneyError, formatRupees, parseRupees } from '@/lib/money'

export function describeFiles(count: number, expected: number | null): string {
  if (count === 0) return 'none yet'
  if (expected === null) return `${count} ${count === 1 ? 'file' : 'files'}`
  if (count < expected) return `${count} of ${expected}`
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

function Tick() {
  return (
    <svg viewBox="0 0 14 14" width="9" height="9" aria-hidden="true">
      <path
        d="M2 7.4 5.3 10.6 12 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * One line of the ledger, which opens to show its files.
 *
 * Every control here goes through the engine, so every one of them works
 * with the radio off: the tap lands on the sheet immediately and the op
 * waits in the outbox. The only thing that can come back later is a
 * refusal, and that is reported as a rollback rather than hidden.
 */
export function ItemRow({
  item,
  claim,
  engine,
}: {
  item: ChecklistItem
  claim: Claim
  engine: SyncEngine
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelId = useId()
  const state = itemState(item)
  const amount = item.docs.reduce((a, d) => a + (d.amountPaise ?? 0), 0)
  const waiting = item.docs.some((d) => d.pending)

  const report = async (action: Promise<string | null>) => {
    setError(await action)
  }

  return (
    <>
      <tr>
        <td>
          <div className="flex items-start gap-3">
            <button
              type="button"
              className={`mark ${
                state === 'complete' ? 'mark-done' : state === 'partial' ? 'mark-partial' : ''
              }`}
              aria-pressed={Boolean(item.markedDone)}
              aria-label={`Mark ${item.label} as done`}
              onClick={() => void report(engine.setItemDone(item.id, !item.markedDone))}
            >
              {state === 'complete' && <Tick />}
            </button>

            <div>
              <button
                type="button"
                className="text-left hover:text-teal"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((v) => !v)}
              >
                {item.label}
                <span className="sr-only">
                  {state === 'complete'
                    ? ', complete'
                    : state === 'partial'
                      ? ', incomplete'
                      : ', nothing uploaded'}
                </span>
              </button>
              {item.markedDone && (
                <span className="ml-2 text-[0.8rem] text-ink-faint">ticked by hand</span>
              )}
              {waiting && (
                <span className="ml-2 text-[0.8rem] text-ink-faint">waiting for signal</span>
              )}
              <span className="mt-0.5 block text-[0.82rem] text-ink-faint sm:hidden">
                {describeFiles(item.docs.length, item.expected)}
              </span>
            </div>
          </div>
        </td>
        <td className="hidden text-[0.88rem] text-ink-soft sm:table-cell">
          {describeFiles(item.docs.length, item.expected)}
        </td>
        <td className="num">
          {item.kind === 'bill' ? (
            formatRupees(amount)
          ) : (
            <span className="text-ink-faint">&mdash;</span>
          )}
        </td>
      </tr>

      {open && (
        <tr id={panelId}>
          <td colSpan={3} className="bg-paper-sunk/60">
            <div className="space-y-3 py-1 pl-[1.95rem]">
              {item.docs.length === 0 && (
                <p className="text-[0.88rem] text-ink-soft">
                  Nothing here yet. Add the file, or tick the circle if this one was handed
                  over at the desk.
                </p>
              )}

              {item.docs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                >
                  <div className="min-w-0">
                    <span className="break-all text-[0.92rem]">{doc.name}</span>
                    <span className="ml-2 text-[0.8rem] text-ink-faint">
                      {doc.uploadedBy}
                      {doc.pending && ' · waiting for signal'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {item.kind === 'bill' && (
                      <AmountField
                        label={`Amount on ${doc.name}`}
                        value={doc.amountPaise}
                        onSubmit={(paise) =>
                          report(engine.setAmount(item.id, doc.id, paise))
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="text-[0.82rem] text-ink-faint underline decoration-rule hover:text-amber"
                      onClick={() => void report(engine.removeDocument(item.id, doc.id))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}

              <AddFile
                item={item}
                onAdd={(name, amountPaise) =>
                  report(engine.addDocument(item.id, { name, amountPaise }))
                }
              />

              {error && <p className="text-[0.85rem] text-amber">{error}</p>}
              {item.kind === 'bill' && claim.finalBillPaise > 0 && (
                <p className="text-[0.8rem] text-ink-faint">
                  Amounts here count against the final bill of{' '}
                  {formatRupees(claim.finalBillPaise)}.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * An amount, editable in place. Submits on Enter or blur, and only when
 * the figure actually changed -- re-sending the same value would be a
 * write that other devices have to resolve for no reason.
 */
export function AmountField({
  label,
  value,
  onSubmit,
}: {
  label: string
  value: number | null
  onSubmit: (paise: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const text = draft ?? (value === null ? '' : (value / 100).toFixed(2))

  const commit = () => {
    if (draft === null) return
    setDraft(null)
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (value !== null) onSubmit(null)
      return
    }
    try {
      const paise = parseRupees(trimmed)
      setProblem(null)
      if (paise !== value) onSubmit(paise)
    } catch (e) {
      setProblem(e instanceof MoneyError ? e.message : 'That is not an amount')
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        aria-label={label}
        inputMode="decimal"
        className="w-[7.5rem] rounded border border-rule bg-sheet px-2 py-1 text-right text-[0.92rem] tnum"
        value={text}
        placeholder="0.00"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
            setProblem(null)
          }
        }}
      />
      {problem && <span className="mt-0.5 text-[0.78rem] text-amber">{problem}</span>}
    </span>
  )
}

function AddFile({
  item,
  onAdd,
}: {
  item: ChecklistItem
  onAdd: (name: string, amountPaise: number | null) => void
}) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setProblem('Name the file you are adding')
      return
    }
    let paise: number | null = null
    if (item.kind === 'bill') {
      try {
        paise = parseRupees(amount)
      } catch (e) {
        setProblem(e instanceof MoneyError ? e.message : 'That is not an amount')
        return
      }
    }
    setProblem(null)
    setName('')
    setAmount('')
    onAdd(trimmed, paise)
  }

  return (
    <div className="flex flex-wrap items-start gap-2 pt-1">
      <input
        aria-label={`File to add to ${item.label}`}
        className="min-w-0 flex-1 rounded border border-rule bg-sheet px-2 py-1 text-[0.92rem]"
        placeholder="pharmacy-19oct.jpg"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {item.kind === 'bill' && (
        <input
          aria-label={`Amount for the file being added to ${item.label}`}
          inputMode="decimal"
          className="w-[7.5rem] rounded border border-rule bg-sheet px-2 py-1 text-right text-[0.92rem] tnum"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
      <button type="button" className="btn btn-quiet px-3 py-1 text-[0.88rem]" onClick={submit}>
        Add
      </button>
      {problem && <p className="w-full text-[0.85rem] text-amber">{problem}</p>}
    </div>
  )
}
