import { Suspense } from 'react'
import {
  blockers,
  completeness,
  itemState,
  STATUS_LABEL,
  uploadedTotal,
  unaccounted,
  type Claim,
} from '@/lib/claim'
import { formatRupees } from '@/lib/money'
import { DeadlineCountdown, DeadlineFallback } from './Deadline'

function longDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })
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

export function CoverSheet({ claim }: { claim: Claim }) {
  const gap = unaccounted(claim)
  const uploaded = uploadedTotal(claim)
  const { done, total } = completeness(claim)
  const problems = blockers(claim)
  const pendingUploads = claim.items
    .flatMap((i) => i.docs)
    .filter((d) => d.pending).length

  return (
    <div className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex items-baseline justify-between gap-4 py-6">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        <span className="text-[0.82rem] text-ink-soft">
          {pendingUploads > 0
            ? `${pendingUploads} upload${pendingUploads > 1 ? 's' : ''} waiting for signal`
            : 'All changes saved'}
        </span>
      </header>

      {/* The cover sheet: who, where, and the two numbers that decide
          whether this claim gets paid in full. */}
      <section className="sheet px-6 py-7 sm:px-9 sm:py-9">
        <p className="text-[0.82rem] text-ink-soft">{STATUS_LABEL[claim.status]}</p>
        <h1 className="claim-title mt-1.5">{claim.patientName}</h1>
        <p className="mt-2.5 text-ink-soft">
          {claim.hospital}. Admitted {longDate(claim.admittedOn)}, discharged{' '}
          {longDate(claim.dischargedOn)}.
        </p>

        <hr className="my-7 border-0 border-t border-rule" />

        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          {/* The one place this design raises its voice. */}
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

          <dl className="shrink-0 text-[0.92rem] sm:text-right">
            <div className="flex justify-between gap-6 sm:justify-end">
              <dt className="text-ink-soft">Final bill</dt>
              <dd className="money w-[7.5rem] sm:text-right">
                {formatRupees(claim.finalBillPaise)}
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
          <p>
            <Suspense fallback={<DeadlineFallback claim={claim} />}>
              <DeadlineCountdown claim={claim} />
            </Suspense>
          </p>
          <p className="text-[0.88rem] text-ink-soft">
            {claim.members.map((m) => m.name).join(', ')} can add to this claim
          </p>
        </div>
      </section>

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
            {claim.items.map((item) => {
              const state = itemState(item)
              const amount = item.docs.reduce((a, d) => a + (d.amountPaise ?? 0), 0)
              const pending = item.docs.some((d) => d.pending)
              return (
                <tr key={item.id}>
                  <td>
                    <div className="flex items-start gap-3">
                      <span
                        className={`mark ${
                          state === 'complete'
                            ? 'mark-done'
                            : state === 'partial'
                              ? 'mark-partial'
                              : ''
                        }`}
                        aria-hidden="true"
                      >
                        {state === 'complete' && <Tick />}
                      </span>
                      <span>
                        {item.label}
                        <span className="sr-only">
                          {state === 'complete'
                            ? ', complete'
                            : state === 'partial'
                              ? ', incomplete'
                              : ', nothing uploaded'}
                        </span>
                        {pending && (
                          <span className="ml-2 text-[0.8rem] text-ink-faint">
                            waiting for signal
                          </span>
                        )}
                        <span className="mt-0.5 block text-[0.82rem] text-ink-faint sm:hidden">
                          {describeFiles(item.docs.length, item.expected)}
                        </span>
                      </span>
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
              )
            })}
          </tbody>
        </table>
      </section>

      {/* Plain sentences, worst first. No scores, no progress ring. */}
      {problems.length > 0 && (
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

          <div className="mt-7 flex flex-wrap gap-3">
            <button className="btn" type="button">
              Add documents
            </button>
            <button className="btn btn-quiet" type="button">
              Export as one PDF
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

function describeFiles(count: number, expected: number | null): string {
  if (count === 0) return 'none yet'
  if (expected === null) return `${count} ${count === 1 ? 'file' : 'files'}`
  if (count < expected) return `${count} of ${expected}`
  return `${count} ${count === 1 ? 'file' : 'files'}`
}
