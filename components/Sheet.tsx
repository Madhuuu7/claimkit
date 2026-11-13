'use client'

import type { ReactNode } from 'react'
import {
  blockers,
  completeness,
  isClosed,
  settlementNote,
  uploadedTotal,
  unaccounted,
  unexplainedWithholding,
} from '@/lib/claim'
import type { EngineState, SyncEngine } from '@/lib/engine'
import { formatRupees } from '@/lib/money'
import type { Uploads } from '@/lib/uploads-client'
import { AddChecklistItem, AmountField, ItemRow } from './ItemRow'
import { ConflictPanel, RolledBack } from './ConflictPanel'
import { StatusControl } from './StatusControl'

function longDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })
}

/**
 * What the sync state should say in one short line, in the top right.
 *
 * The rule it follows: never claim an edit is safe when it is only on
 * this phone. "All changes saved" is a promise, and this app is built for
 * a family who will close the tab in a corridor and believe it.
 */
function syncLine(state: EngineState): string {
  if (!state.ready) return 'Opening your claim'
  const waiting = state.queued.length
  if (waiting > 0) {
    const edits = `${waiting} ${waiting === 1 ? 'edit' : 'edits'}`
    if (!state.online) return `${edits} waiting for signal`
    if (state.syncing) return `Sending ${edits}`
    return `${edits} waiting to send`
  }
  if (!state.online) return 'Offline. Everything here is saved on this phone'
  if (state.syncing) return 'Saving'
  return 'All changes saved'
}

export function Sheet({
  engine,
  state,
  deviceId,
  deadline,
  account,
  uploads,
}: {
  engine: SyncEngine
  state: EngineState
  deviceId: string
  /** Absent in the demo, which has no bucket behind it. */
  uploads?: Uploads
  /** Rendered on the server: who is signed in, and the way out. */
  account?: ReactNode
  /**
   * Rendered on the server, passed in from the page. The due date comes
   * off the claim and prerenders with the sheet; the countdown is the one
   * part that needs a real request, because a build cannot know what day
   * it is when someone opens this.
   */
  deadline: ReactNode
}) {
  const { claim } = state
  const settlement = claim.settlement ?? null
  const gap = unaccounted(claim)
  const uploaded = uploadedTotal(claim)
  const { done, total } = completeness(claim)
  const problems = blockers(claim)

  return (
    <div className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-6 text-[0.82rem]">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        {account}
        <span className="text-ink-soft" aria-live="polite">
          {syncLine(state)}
          {/* Only once the outbox has been read, because whether storage
              exists is not knowable during the server render, and saying
              so one render early is a hydration mismatch. */}
          {state.ready && !state.durable && (
            <span className="text-ink-faint"> · this browser is not storing anything</span>
          )}
        </span>
      </header>

      {/* Said before the claim itself, not after it. Somebody who
          mistook this for their own admission and submitted it would be
          worse off than somebody who saw nothing at all. */}
      {claim.isSample && (
        <p className="mb-3 rounded-[6px] border border-rule bg-amber-wash px-4 py-2.5 text-[0.85rem] text-ink-soft">
          <span className="text-ink">A sample claim.</span> Invented figures, invented
          documents. Every button on it works; nothing on it is yours. Delete it whenever
          you like.
        </p>
      )}

      {/* The cover sheet: who, where, and the two numbers that decide
          whether this claim gets paid in full. */}
      <section className="sheet px-6 py-7 sm:px-9 sm:py-9">
        <StatusControl claim={claim} engine={engine} />
        <h1 className="claim-title mt-1.5">{claim.patientName}</h1>
        <p className="mt-2.5 text-ink-soft">
          {claim.hospital}. Admitted {longDate(claim.admittedOn)}, discharged{' '}
          {longDate(claim.dischargedOn)}.
        </p>

        <hr className="my-7 border-0 border-t border-rule" />

        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          {/* The one place this design raises its voice -- and what it
              says changes once the insurer has answered. Before then the
              question is which receipts are missing; after, it is how
              much of the shortfall they never explained. */}
          {settlement ? (
            <div>
              <p
                className={`figure text-[clamp(2.6rem,1.6rem+3.4vw,3.6rem)] ${
                  unexplainedWithholding(claim, settlement) === 0 ? 'text-ink' : 'text-amber'
                }`}
                aria-describedby="gap-note"
              >
                {formatRupees(settlement.settledAmountPaise)}
              </p>
              <p id="gap-note" className="mt-2 max-w-[22rem] text-ink-soft">
                {settlementNote(claim, settlement)}
              </p>
            </div>
          ) : (
            <div>
              <p
                className="figure text-amber text-[clamp(2.6rem,1.6rem+3.4vw,3.6rem)]"
                aria-describedby="gap-note"
              >
                {formatRupees(gap)}
              </p>
              <p id="gap-note" className="mt-2 max-w-[22rem] text-ink-soft">
                {gap > 0
                  ? 'of the hospital bill still has no receipt against it'
                  : gap < 0
                    ? 'more in receipts than the hospital billed'
                    : 'every rupee on the bill has a receipt'}
              </p>
            </div>
          )}

          <dl className="shrink-0 text-[0.92rem] sm:text-right">
            <div className="flex items-center justify-between gap-6 sm:justify-end">
              <dt className="text-ink-soft">Final bill</dt>
              <dd>
                <AmountField
                  label="Final hospital bill"
                  value={claim.finalBillPaise}
                  onSubmit={(paise) => paise !== null && void engine.setFinalBill(paise)}
                />
              </dd>
            </div>
            <div className="mt-1.5 flex justify-between gap-6 sm:justify-end">
              <dt className="text-ink-soft">Receipts uploaded</dt>
              <dd className="money w-[7.5rem] sm:text-right">{formatRupees(uploaded)}</dd>
            </div>
          </dl>
        </div>

        <hr className="my-7 border-0 border-t border-rule" />

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p>{deadline}</p>
          <p className="text-[0.88rem] text-ink-soft">
            {claim.members.map((m) => m.name).join(', ')} can add to this claim
          </p>
        </div>
      </section>

      <ConflictPanel
        conflicts={state.conflicts}
        claim={claim}
        engine={engine}
        deviceId={deviceId}
      />
      <RolledBack rejections={state.rejections} claim={claim} engine={engine} />

      {/* The ledger. Documents are rows on paper, not cards. */}
      <section className="mt-12">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="section-heading">Documents</h2>
          <p className="text-[0.88rem] text-ink-soft">
            <span className="tnum">{done}</span> of <span className="tnum">{total}</span>{' '}
            ready
          </p>
        </div>

        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col" className="hidden sm:table-cell">
                Files
              </th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {claim.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                claim={claim}
                engine={engine}
                uploads={uploads}
              />
            ))}
          </tbody>
        </table>

        <AddChecklistItem engine={engine} />
      </section>

      {uploads && (
        <section className="mt-8 flex flex-wrap gap-3">
          <a
            className="btn btn-quiet"
            href={`/api/claims/${claim.id}/export`}
            // One file, index first, documents in checklist order -- what
            // the insurer's portal wants in a single upload.
            download
          >
            Export as one PDF
          </a>
          {/* A plain link, not a tab: recording a settlement happens once,
              from a letter, with signal -- it does not belong on the
              offline sheet. */}
          <a className="btn btn-quiet" href={`/claims/${claim.id}/settlement`}>
            {settlement ? 'Settlement' : 'Record a settlement'}
          </a>
          <a className="btn btn-quiet" href={`/claims/${claim.id}/family`}>
            The family
          </a>
          <a className="btn btn-quiet" href={`/claims/${claim.id}/history`}>
            History
          </a>
        </section>
      )}

      {/* Plain sentences, worst first. No scores, no progress ring.
          Silent once the claim is settled or rejected: a list of things
          to fix before submitting is no longer advice, it is nagging. */}
      {problems.length > 0 && !isClosed(claim.status) && (
        <section className="mt-12">
          <h2 className="section-heading mb-4">Before you submit</h2>
          <ul className="space-y-2.5">
            {problems.map((p, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className={`mt-[0.62rem] h-[3px] w-3.5 shrink-0 rounded-full ${
                    p.kind === 'gap' ? 'bg-amber' : 'bg-rule'
                  }`}
                  aria-hidden="true"
                />
                <span className={p.kind === 'gap' ? 'text-ink' : 'text-ink-soft'}>
                  {p.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
