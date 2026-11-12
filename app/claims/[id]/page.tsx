import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Account } from '@/components/Account'
import { ClaimWorkspace } from '@/components/ClaimWorkspace'
import { DeadlineCountdown, DeadlineFallback } from '@/components/Deadline'
import { currentUser } from '@/lib/auth'
import { ClaimNotFound } from '@/lib/claims'
import { snapshotFor, type Snapshot } from '@/lib/sync'

export const metadata: Metadata = { title: 'Claim · ClaimKit' }

type Params = { params: Promise<{ id: string }> }

/**
 * One claim.
 *
 * The page's job is to get the snapshot on screen: the server reads the
 * claim, hands it to the client engine as a starting point, and the
 * engine takes over from there. So the first paint is real data rather
 * than a spinner, and from that moment every edit is local-first.
 *
 * Both the route's own id and the session are request-time reads, so all
 * of it sits behind one boundary and the page frame still comes from the
 * static shell.
 *
 * Anyone who is not in the family gets a 404 -- the same answer as for a
 * claim that was never created, because confirming the id is real is
 * itself a leak.
 */
export default function ClaimPage({ params }: Params) {
  return (
    <Suspense fallback={<Opening />}>
      <Claim params={params} />
    </Suspense>
  )
}

function Opening() {
  return (
    <main className="mx-auto w-full max-w-[52rem] px-5 py-10 sm:px-8">
      <p className="text-ink-faint">Opening the claim</p>
    </main>
  )
}

/**
 * Kept apart from the component so the refusal is handled where no JSX
 * is being built: a try/catch around a render is how a thrown redirect
 * or notFound gets swallowed by accident.
 */
async function load(userId: string, claimId: string): Promise<Snapshot | null> {
  try {
    return await snapshotFor(userId, claimId)
  } catch (error) {
    if (error instanceof ClaimNotFound) return null
    throw error
  }
}

async function Claim({ params }: Params) {
  const { id } = await params
  const user = await currentUser()
  if (!user) notFound()

  const snapshot = await load(user.id, id)
  if (!snapshot) notFound()

  return (
    <ClaimWorkspace
      snapshot={snapshot.claim}
      deviceName={user.name ?? user.email ?? 'This phone'}
      deadline={
        <Suspense fallback={<DeadlineFallback claim={snapshot.claim} />}>
          <DeadlineCountdown claim={snapshot.claim} />
        </Suspense>
      }
      account={
        <Suspense fallback={<span className="text-ink-faint">&nbsp;</span>}>
          <Account />
        </Suspense>
      }
    />
  )
}
