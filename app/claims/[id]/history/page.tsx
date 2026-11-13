import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Account } from '@/components/Account'
import { currentUser } from '@/lib/auth'
import { STATUS_LABEL } from '@/lib/claim'
import { ClaimNotFound, getClaim } from '@/lib/claims'
import { claimHistory, type ActivityEntry, type TimelineEntry } from '@/lib/history'

export const metadata: Metadata = { title: 'History · ClaimKit' }

type Params = { params: Promise<{ id: string }> }

/**
 * Everything that has happened to this claim.
 *
 * Read-only, and the only page in the app that looks backwards. When an
 * insurer asks on the phone when the claim was submitted, or a family
 * member asks who deleted the pharmacy bill, this is the answer -- in
 * the words that were written at the time, because labels get renamed
 * and an old entry should still read correctly.
 */
export default function HistoryPage({ params }: Params) {
  return (
    <main className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-6 text-[0.82rem]">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        <Suspense fallback={<span className="text-ink-faint">&nbsp;</span>}>
          <Account />
        </Suspense>
      </header>

      <Suspense fallback={<p className="py-10 text-ink-faint">Opening the claim</p>}>
        <History params={params} />
      </Suspense>
    </main>
  )
}

async function load(userId: string, claimId: string) {
  try {
    const claim = await getClaim(userId, claimId)
    return { claim, history: await claimHistory(userId, claimId) }
  } catch (error) {
    if (error instanceof ClaimNotFound) return null
    throw error
  }
}

function when(at: Date): string {
  return at.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function day(at: Date): string {
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

async function History({ params }: Params) {
  const { id } = await params
  const user = await currentUser()
  if (!user) notFound()

  const loaded = await load(user.id, id)
  if (!loaded) notFound()

  const { claim, history } = loaded

  return (
    <>
      <nav className="text-[0.85rem]">
        <Link className="text-teal underline decoration-rule" href={`/claims/${id}`}>
          {claim.patientName}
        </Link>
      </nav>

      <h1 className="claim-title mt-3">History</h1>

      <section className="mt-9">
        <h2 className="section-heading mb-5">Where the claim has been</h2>
        <ol className="space-y-0">
          {history.timeline.map((entry, index) => (
            <Step
              key={entry.id}
              entry={entry}
              last={index === history.timeline.length - 1}
            />
          ))}
        </ol>
      </section>

      <section className="mt-12">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="section-heading">Everything that happened</h2>
          <p className="text-[0.85rem] text-ink-faint">newest first</p>
        </div>

        {history.activity.length === 0 ? (
          <p className="text-ink-soft">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-rule-soft border-y border-rule">
            {history.activity.map((entry) => (
              <li key={entry.id} className="py-3">
                <Line entry={entry} />
              </li>
            ))}
          </ul>
        )}

        {history.truncated && (
          <p className="mt-4 text-[0.82rem] text-ink-faint">
            Only the most recent {history.activity.length} are shown.
          </p>
        )}
      </section>
    </>
  )
}

/**
 * One state the claim passed through. The rail is drawn with a border
 * rather than an icon per step: this is a sheet of paper, and a row of
 * coloured badges would be a dashboard.
 */
function Step({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  return (
    <li className="flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={`mt-[0.45rem] h-2 w-2 shrink-0 rounded-full ${
            last ? 'bg-teal' : 'bg-rule'
          }`}
          aria-hidden="true"
        />
        {!last && <span className="w-px flex-1 bg-rule" aria-hidden="true" />}
      </div>
      <div className={last ? 'pb-1' : 'pb-6'}>
        <p className={last ? 'text-ink' : 'text-ink-soft'}>
          {STATUS_LABEL[entry.to]}
          <span className="text-ink-faint"> · {day(entry.at)}</span>
        </p>
        <p className="mt-0.5 text-[0.85rem] text-ink-faint">
          {entry.from === null ? `Started by ${entry.by}` : `Moved by ${entry.by}`}
          {entry.note && ` · ${entry.note}`}
        </p>
      </div>
    </li>
  )
}

function Line({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-0.5">
      <p className="text-[0.95rem]">
        {/* A name rather than a blank even when the account is gone:
            the claim should still be able to say what happened. */}
        <span className="text-ink">{entry.by ?? 'Someone no longer here'}</span>{' '}
        <span className="text-ink-soft">{entry.summary}</span>
      </p>
      <p className="text-[0.8rem] text-ink-faint">{when(entry.at)}</p>
    </div>
  )
}
