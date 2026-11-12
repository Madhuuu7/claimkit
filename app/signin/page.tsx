import type { Metadata } from 'next'
import { signIn } from '@/lib/auth'

export const metadata: Metadata = { title: 'Sign in · ClaimKit' }

/**
 * Deliberately reads nothing about the current user.
 *
 * A session read happens at request time and cannot be prerendered, so
 * checking here would make the one page an unauthenticated visitor is
 * guaranteed to land on the slowest page in the app. Auth.js sends
 * someone who is already signed in onwards after the redirect anyway.
 */
export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[32rem] flex-col justify-center px-5 py-16 sm:px-8">
      <p className="font-serif text-[1.05rem]">ClaimKit</p>

      <h1 className="claim-title mt-6">One claim, the whole family.</h1>
      <p className="mt-4 text-ink-soft">
        The bills are on your father&rsquo;s phone, the discharge summary is on yours, and
        the insurer wants all of it inside the policy&rsquo;s window. Sign in to put one
        complete claim together.
      </p>

      <form
        className="mt-9"
        action={async () => {
          'use server'
          await signIn('google', { redirectTo: '/' })
        }}
      >
        <button className="btn" type="submit">
          Continue with Google
        </button>
      </form>

      <p className="mt-6 text-[0.85rem] text-ink-faint">
        Google is the only way in. Everyone who needs this already has an account on the
        phone the receipts are on, and a password this app could leak is a password it
        should never have held.
      </p>
    </main>
  )
}
