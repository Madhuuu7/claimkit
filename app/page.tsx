import Link from 'next/link'
import { Suspense } from 'react'
import { Account } from '@/components/Account'
import { NewClaimForm } from '@/components/NewClaimForm'
import { AddSampleClaim } from '@/components/SampleClaim'
import { currentUser } from '@/lib/auth'
import { daysRemaining } from '@/lib/claim'
import { listClaims, type ClaimSummary } from '@/lib/claims'
import { formatRupees } from '@/lib/money'

/**
 * The claims this person is in, and a form to start another.
 *
 * Reading the session happens at request time and cannot be prerendered,
 * so the whole list streams in behind a boundary while the page's frame
 * is served from the static shell.
 */
export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-6 text-[0.82rem]">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        <Suspense fallback={<span className="text-ink-faint">&nbsp;</span>}>
          <Account />
        </Suspense>
      </header>

      <Suspense fallback={<Waiting />}>
        <Claims />
      </Suspense>
    </main>
  )
}

function Waiting() {
  return <p className="py-10 text-ink-faint">Looking up your claims</p>
}

async function Claims() {
  const user = await currentUser()

  if (!user) {
    return (
      <section className="py-6">
        <h1 className="claim-title">One claim, the whole family.</h1>
        <p className="mt-4 max-w-[34rem] text-ink-soft">
          The bills are on your father&rsquo;s phone, the discharge summary is on yours, and
          the insurer wants all of it inside the policy&rsquo;s window. ClaimKit is where a
          family puts one complete claim together.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link className="btn" href="/signin">
            Sign in with Google
          </Link>
          <Link className="btn btn-quiet" href="/demo">
            See it work with no signal
          </Link>
        </div>
      </section>
    )
  }

  const claims = await listClaims(user.id)

  return (
    <>
      <section className="py-2">
        <h1 className="claim-title">
          {claims.length === 0 ? 'Start your first claim.' : 'Your claims'}
        </h1>
        {claims.length === 0 && (
          <p className="mt-4 max-w-[34rem] text-ink-soft">
            One claim per hospital stay. Everyone you invite can add to it from their own
            phone, with or without signal.
          </p>
        )}
      </section>

      {claims.length > 0 && (
        <ul className="mt-6 divide-y divide-rule-soft border-y border-rule">
          {claims.map((claim) => (
            <li key={claim.id}>
              <ClaimRow claim={claim} />
            </li>
          ))}
        </ul>
      )}

      <section className="mt-12">
        <h2 className="section-heading">
          {claims.length === 0 ? 'The hospital stay' : 'Another hospital stay'}
        </h2>
        <NewClaimForm />
        {/* Only when they have none. The sample is a way in, not a
            feature to keep offering someone who is mid-claim. */}
        {!claims.some((claim) => claim.isSample) && <AddSampleClaim />}
      </section>

      <p className="mt-10 text-[0.85rem] text-ink-faint">
        Curious how it behaves with no signal?{' '}
        <Link className="text-teal underline decoration-rule" href="/demo">
          The demo
        </Link>{' '}
        runs on invented data and lets you cut the wire yourself.
      </p>
    </>
  )
}

function ClaimRow({ claim }: { claim: ClaimSummary }) {
  const gap = claim.finalBillPaise - claim.uploadedPaise
  // The deadline needs two fields, not a whole claim, which is why
  // daysRemaining takes just those two.
  const days = daysRemaining({
    dischargedOn: claim.dischargedOn.toISOString().slice(0, 10),
    submissionWindowDays: claim.submissionWindowDays,
  })
  const settled = claim.status === 'SETTLED' || claim.status === 'REJECTED'

  return (
    <Link className="block py-4 hover:bg-paper-sunk/60" href={`/claims/${claim.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <span className="font-serif text-[1.15rem]">
          {claim.patientName}
          {claim.isSample && (
            <span className="ml-2 align-middle text-[0.72rem] uppercase tracking-wide text-ink-faint">
              sample
            </span>
          )}
        </span>
        <span className="money text-[0.92rem]">
          {gap > 0 ? (
            <span className="text-amber">{formatRupees(gap)} unaccounted</span>
          ) : (
            <span className="text-ink-soft">every rupee accounted for</span>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[0.85rem] text-ink-soft">
        {claim.hospital}
        <span className="text-ink-faint">
          {' · '}
          {claim.documentCount} {claim.documentCount === 1 ? 'file' : 'files'}
          {' · '}
          {claim.memberCount} {claim.memberCount === 1 ? 'member' : 'members'}
          {!settled && (
            <>
              {' · '}
              {days < 0
                ? `window closed ${-days} ${-days === 1 ? 'day' : 'days'} ago`
                : `${days} ${days === 1 ? 'day' : 'days'} left`}
            </>
          )}
        </span>
      </p>
    </Link>
  )
}
