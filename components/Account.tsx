import Link from 'next/link'
import { currentUser, signOut } from '@/lib/auth'

/**
 * Who is signed in, and the way out.
 *
 * A server component, and an async one: it reads the session cookie, so
 * it cannot be part of the prerendered shell. The page renders it inside
 * a Suspense boundary, which is why the sheet is on screen before this
 * line resolves.
 */
export async function Account() {
  const user = await currentUser()

  if (!user) {
    return (
      <Link className="text-teal underline decoration-rule" href="/signin">
        Sign in
      </Link>
    )
  }

  return (
    <span className="flex items-baseline gap-3">
      <span className="text-ink-soft">{user.name ?? user.email}</span>
      <form
        action={async () => {
          'use server'
          await signOut({ redirectTo: '/signin' })
        }}
      >
        <button className="text-ink-faint underline decoration-rule hover:text-ink" type="submit">
          Sign out
        </button>
      </form>
    </span>
  )
}
