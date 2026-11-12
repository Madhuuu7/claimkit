import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { acceptInviteAction } from '@/app/actions'
import { currentUser } from '@/lib/auth'

export const metadata: Metadata = { title: 'Join a claim · ClaimKit' }

type Params = { params: Promise<{ token: string }> }

/**
 * The other end of an invite link.
 *
 * Joining is a POST, not the page load. A link that added you to a
 * family just by being fetched could be triggered by anything that
 * follows links -- a chat app's preview fetcher, an antivirus scanner,
 * someone's mail client -- and the first the family would know is a
 * stranger in their member list.
 *
 * Signing in comes first. The link gets you into a family; it does not
 * get you past the front door.
 */
export default function JoinPage({ params }: Params) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[32rem] flex-col justify-center px-5 py-16 sm:px-8">
      <p className="font-serif text-[1.05rem]">ClaimKit</p>
      {/* The token is in the route and the session is in a cookie, so
          both are request-time reads and both belong inside the
          boundary; the frame above comes from the static shell. */}
      <Suspense fallback={<p className="mt-6 text-ink-faint">Checking the link</p>}>
        <Join params={params} />
      </Suspense>
    </main>
  )
}

async function Join({ params }: Params) {
  const { token } = await params
  const user = await currentUser()

  if (!user) {
    // Back here after Google, with the link intact.
    redirect(`/signin?next=${encodeURIComponent(`/join/${token}`)}`)
  }

  return (
    <>
      <h1 className="claim-title mt-6">You have been invited to a claim.</h1>
      <p className="mt-4 text-ink-soft">
        Joining lets you upload documents and tick items off the checklist from your own
        phone. You will be able to see everything the family has added to this claim.
      </p>

      <form
        className="mt-8"
        action={async () => {
          'use server'
          await acceptInviteAction(token)
        }}
      >
        <button className="btn" type="submit">
          Join this claim
        </button>
      </form>

      <p className="mt-6 text-[0.85rem] text-ink-faint">
        Not expecting this?{' '}
        <Link className="text-teal underline decoration-rule" href="/">
          Go to your own claims
        </Link>{' '}
        instead. Nothing happens until you press the button.
      </p>
    </>
  )
}
