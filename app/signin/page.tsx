import type { Metadata } from 'next'
import { Suspense } from 'react'
import { signIn } from '@/lib/auth'

export const metadata: Metadata = { title: 'Sign in · ClaimKit' }

type Props = { searchParams: Promise<{ next?: string }> }

/**
 * Deliberately reads nothing about the current user.
 *
 * A session read happens at request time and cannot be prerendered, so
 * checking here would make the one page an unauthenticated visitor is
 * guaranteed to land on the slowest page in the app. Auth.js sends
 * someone who is already signed in onwards after the redirect anyway.
 *
 * Only the button needs the request, because an invite link arrives as
 * `?next=`, so that is the one part behind a boundary.
 */
export default function SignInPage({ searchParams }: Props) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[32rem] flex-col justify-center px-5 py-16 sm:px-8">
      <p className="font-serif text-[1.05rem]">ClaimKit</p>

      <h1 className="claim-title mt-6">One claim, the whole family.</h1>
      <p className="mt-4 text-ink-soft">
        The bills are on your father&rsquo;s phone, the discharge summary is on yours, and
        the insurer wants all of it inside the policy&rsquo;s window. Sign in to put one
        complete claim together.
      </p>

      <Suspense fallback={<GoogleButton next="/" />}>
        <Continue searchParams={searchParams} />
      </Suspense>

      <p className="mt-6 text-[0.85rem] text-ink-faint">
        Google is the only way in. Everyone who needs this already has an account on the
        phone the receipts are on, and a password this app could leak is a password it
        should never have held.
      </p>
    </main>
  )
}

async function Continue({ searchParams }: Props) {
  const { next } = await searchParams
  // Only this app's own paths. An open redirect here would let a
  // phishing link borrow a real Google sign-in and land the family
  // somewhere else entirely.
  const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return <GoogleButton next={safe} />
}

function GoogleButton({ next }: { next: string }) {
  return (
    <form
      className="mt-9"
      action={async () => {
        'use server'
        await signIn('google', { redirectTo: next })
      }}
    >
      <button className="btn" type="submit">
        Continue with Google
      </button>
    </form>
  )
}
