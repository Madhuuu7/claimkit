import 'server-only'
import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from './db'
import { ensureSampleClaim } from './sample'

/**
 * Who is asking.
 *
 * Google is the only provider, because every user of this app already
 * has a Google account on the phone they are photographing receipts
 * with, and because a password reset flow is a liability nobody is
 * paying us to maintain.
 *
 * Sessions are kept in the database rather than in a JWT. A JWT is
 * cheaper -- no query per request -- but it stays valid until it
 * expires, and this app has one authorisation decision that has to take
 * effect immediately: an owner removing a family member. With database
 * sessions, revoking access is a delete.
 */

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [Google],
  session: { strategy: 'database' },
  pages: { signIn: '/signin' },
  events: {
    // A new account with nothing in it explains nothing. The sample
    // claim is created here, once, at the moment the adapter writes the
    // user row -- so the first page they see has a worked example on
    // it rather than an empty list and a form.
    //
    // Failing to seed it must never fail the sign-in: a person who
    // cannot get in has a much worse problem than one with an empty
    // list, and the claims page offers the sample again anyway.
    async createUser({ user }) {
      if (!user.id) return
      try {
        await ensureSampleClaim(user.id)
      } catch {
        // Swallowed on purpose. See above.
      }
    },
  },
  callbacks: {
    session({ session, user }) {
      // The adapter hands us the user row; the id is what every
      // membership check below is about, so it goes on the session
      // rather than being looked up again by email.
      session.user.id = user.id
      return session
    },
  },
})

export type CurrentUser = { id: string; name: string | null; email: string | null; image: string | null }

/** The signed-in user, or null. Never throws, for pages that allow both. */
export async function currentUser(): Promise<CurrentUser | null> {
  const session = await auth()
  if (!session?.user?.id) return null
  const { id, name = null, email = null, image = null } = session.user
  return { id, name: name ?? null, email: email ?? null, image: image ?? null }
}
