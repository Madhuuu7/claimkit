'use client'

import { useId, useState } from 'react'
import {
  itemState,
  type ChecklistItem,
  type Claim,
  type DocumentKind,
} from '@/lib/claim'
import type { SyncEngine } from '@/lib/engine'
import { MoneyError, formatRupees, parseRupees } from '@/lib/money'
import { MAX_LABEL } from '@/lib/ops'
import { refuseFile, type Uploads } from '@/lib/uploads-client'

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
  uploads,
}: {
  item: ChecklistItem
  claim: Claim
  engine: SyncEngine
  /** Absent in the demo, which has no bucket to upload to. */
  uploads?: Uploads
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
                    {doc.stored && uploads ? (
                      <a
                        className="break-all text-[0.92rem] text-teal underline decoration-rule"
                        href={uploads.viewUrl(doc.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {doc.name}
                      </a>
                    ) : (
                      <span className="break-all text-[0.92rem]">{doc.name}</span>
                    )}
                    <span className="ml-2 text-[0.8rem] text-ink-faint">
                      {doc.uploadedBy}
                      {uploads?.uploadingDocId === doc.id
                        ? ' · sending the file'
                        : uploads?.waitingDocIds.has(doc.id)
                          ? ' · file waiting for signal'
                          : doc.pending
                            ? ' · waiting for signal'
                            : ''}
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

              {uploads ? (
                <PickFile
                  item={item}
                  onPick={(file, amountPaise) =>
                    report(uploads.addFile(item.id, file, amountPaise))
                  }
                />
              ) : (
                <AddFile
                  item={item}
                  onAdd={(name, amountPaise) =>
                    report(engine.addDocument(item.id, { name, amountPaise }))
                  }
                />
              )}

              {error && <p className="text-[0.85rem] text-amber">{error}</p>}
              {item.kind === 'bill' && claim.finalBillPaise > 0 && (
                <p className="text-[0.8rem] text-ink-faint">
                  Amounts here count against the final bill of{' '}
                  {formatRupees(claim.finalBillPaise)}.
                </p>
              )}

              <ItemSettings item={item} engine={engine} onResult={setError} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * What this line of the checklist is called, and whether it belongs on
 * it at all.
 *
 * The template is a starting guess; the real list is the one the
 * family's insurer asked for. Both edits are ops like any other, so a
 * line can be renamed with the radio off -- and a rename is a register,
 * which means two people renaming the same line at once is reported to
 * them instead of one of them quietly winning.
 *
 * Removal is the one edit in the app that can refuse. Documents cascade
 * from their checklist item, so taking a line away that still holds
 * files would destroy them; the engine says so in a sentence, and the
 * sentence says what to do instead.
 */
function ItemSettings({
  item,
  engine,
  onResult,
}: {
  item: ChecklistItem
  engine: SyncEngine
  onResult: (refusal: string | null) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [label, setLabel] = useState(item.label)

  const save = async () => {
    const trimmed = label.trim()
    if (trimmed === item.label) {
      // Re-sending the name it already has would be a write every other
      // phone has to take a view on, for nothing.
      setRenaming(false)
      return
    }
    const refusal = await engine.renameItem(item.id, trimmed)
    onResult(refusal)
    if (!refusal) setRenaming(false)
  }

  if (renaming) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <input
          aria-label={`Rename ${item.label}`}
          className="min-w-0 flex-1 rounded border border-rule bg-sheet px-2 py-1 text-[0.92rem]"
          value={label}
          maxLength={MAX_LABEL}
          autoFocus
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') {
              setLabel(item.label)
              setRenaming(false)
            }
          }}
        />
        <button
          type="button"
          className="btn px-3 py-1 text-[0.88rem]"
          onClick={() => void save()}
        >
          Rename
        </button>
        <button
          type="button"
          className="text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
          onClick={() => {
            setLabel(item.label)
            setRenaming(false)
          }}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3 text-[0.82rem]">
      <button
        type="button"
        className="text-ink-faint underline decoration-rule hover:text-ink"
        onClick={() => {
          setLabel(item.label)
          onResult(null)
          setRenaming(true)
        }}
      >
        Rename this document
      </button>
      <button
        type="button"
        className="text-ink-faint underline decoration-rule hover:text-amber"
        onClick={() => void engine.removeItem(item.id).then(onResult)}
      >
        Take it off the checklist
      </button>
    </div>
  )
}

/**
 * A line the insurer asked for that the template never thought of.
 *
 * Closed until it is wanted, because the checklist is the thing being
 * read on this screen and a form sitting open under it competes with
 * every row above.
 */
export function AddChecklistItem({ engine }: { engine: SyncEngine }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<DocumentKind>('record')
  const [expected, setExpected] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const kindId = useId()

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-quiet mt-5"
        onClick={() => setOpen(true)}
      >
        Add a document to the checklist
      </button>
    )
  }

  const close = () => {
    setLabel('')
    setExpected('')
    setKind('record')
    setProblem(null)
    setOpen(false)
  }

  const submit = async () => {
    let want: number | null = null
    const typed = expected.trim()
    if (typed !== '') {
      const n = Number(typed)
      if (!Number.isInteger(n) || n < 1) {
        setProblem('Expect at least one file, or leave it blank')
        return
      }
      want = n
    }
    const refusal = await engine.addItem({ label, kind, expected: want })
    if (refusal) {
      setProblem(refusal)
      return
    }
    close()
  }

  return (
    <div className="sheet mt-5 px-5 py-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1">
          <span className="block text-[0.82rem] text-ink-soft">
            What the insurer asked for
          </span>
          <input
            className="mt-1 w-full rounded border border-rule bg-sheet px-2 py-1 text-[0.92rem]"
            placeholder="Pre-authorisation letter"
            value={label}
            maxLength={MAX_LABEL}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>

        <label>
          <span className="block text-[0.82rem] text-ink-soft">Kind</span>
          <select
            id={kindId}
            className="mt-1 rounded border border-rule bg-sheet px-2 py-1 text-[0.92rem]"
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
          >
            <option value="record">A record</option>
            <option value="bill">A bill</option>
          </select>
        </label>

        <label className="w-[7rem]">
          <span className="block text-[0.82rem] text-ink-soft">Files</span>
          <input
            className="mt-1 w-full rounded border border-rule bg-sheet px-2 py-1 text-right text-[0.92rem] tnum"
            inputMode="numeric"
            placeholder="any"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
      </div>

      <p className="mt-3 max-w-[34rem] text-[0.8rem] text-ink-faint">
        A bill carries an amount and counts towards the final bill. A record does not --
        a discharge summary has no rupee value. Leave the file count blank when it is
        however many there turn out to be.
      </p>

      {problem && <p className="mt-3 text-[0.85rem] text-amber">{problem}</p>}

      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          className="btn px-3 py-1 text-[0.88rem]"
          onClick={() => void submit()}
        >
          Add it
        </button>
        <button
          type="button"
          className="text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
          onClick={close}
        >
          Cancel
        </button>
      </div>
    </div>
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

/**
 * Pick a file, give it an amount if it is a bill, and the sheet takes it
 * immediately: the bytes go to IndexedDB, the document appears on the
 * checklist, and the upload happens when there is signal. Nothing here
 * waits for the network, which is the entire point of the app.
 */
function PickFile({
  item,
  onPick,
}: {
  item: ChecklistItem
  onPick: (file: File, amountPaise: number | null) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [amount, setAmount] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const inputId = useId()

  const submit = () => {
    if (!file) {
      setProblem('Choose a photograph or a PDF')
      return
    }
    const refusal = refuseFile(file)
    if (refusal) {
      setProblem(refusal)
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
    setFile(null)
    setAmount('')
    onPick(file, paise)
  }

  return (
    <div className="flex flex-wrap items-start gap-2 pt-1">
      <label
        className="btn btn-quiet cursor-pointer px-3 py-1 text-[0.88rem]"
        htmlFor={inputId}
      >
        {file ? file.name : 'Choose a file'}
      </label>
      <input
        id={inputId}
        type="file"
        className="sr-only"
        accept="image/jpeg,image/png,application/pdf"
        onChange={(e) => {
          const picked = e.target.files?.[0] ?? null
          setFile(picked)
          setProblem(picked ? refuseFile(picked) : null)
        }}
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
      <button type="button" className="btn px-3 py-1 text-[0.88rem]" onClick={submit}>
        Add
      </button>
      {problem && <p className="w-full text-[0.85rem] text-amber">{problem}</p>}
    </div>
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
