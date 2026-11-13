import { randomBytes } from 'node:crypto'
import { config } from 'dotenv'
import { Client } from 'pg'

/**
 * Signing in, without Google.
 *
 * ClaimKit's sessions are database rows rather than JWTs -- the reason
 * is that removing a family member has to take effect immediately -- and
 * that turns out to make this honest. A test does not need a mock
 * provider or a back door in the app: it writes the same row Auth.js
 * would have written and sets the same cookie, so every request after
 * it goes through the real session lookup, the real membership checks
 * and the real 404s.
 *
 * Plain SQL over `pg` rather than the Prisma client, because the
 * generated client is an ES module and Playwright's loader is not, and
 * because a test that reads the tables directly cannot accidentally be
 * reassured by the same query layer it is checking.
 *
 * Nothing here is imported by the application. If this file disappeared
 * the app would not notice.
 */

config({ path: '.env', quiet: true })

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set; the end-to-end run needs a database')
}

/**
 * A connection per query, closed immediately, and retried.
 *
 * The local Postgres this runs against is `npx prisma dev`, which dies
 * often enough that a client held open for the length of a browser run
 * is a client that will be dead by the end of it. Connecting per query
 * costs a few milliseconds and makes the run survive a database that
 * came back on a different socket.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  let last: unknown
  for (let attempt = 0; attempt < 24; attempt++) {
    const client = new Client({ connectionString })
    try {
      await client.connect()
      const result = await client.query(sql, values)
      return result.rows as T[]
    } catch (error) {
      last = error
      await client.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw last
}

/** Auth.js v5 over plain http. The __Secure- prefix is for https only. */
export const SESSION_COOKIE = 'authjs.session-token'

export type TestUser = {
  userId: string
  sessionToken: string
  email: string
}

/** Ids are minted by Prisma, not by Postgres, so the test mints its own. */
function id(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

export async function createSignedInUser(name = 'Playwright'): Promise<TestUser> {
  const userId = id('e2euser')
  const email = `e2e-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`
  await query('INSERT INTO "User" (id, name, email) VALUES ($1, $2, $3)', [
    userId,
    name,
    email,
  ])

  const sessionToken = randomBytes(32).toString('hex')
  await query(
    'INSERT INTO "Session" (id, "sessionToken", "userId", expires) VALUES ($1, $2, $3, $4)',
    [id('e2esess'), sessionToken, userId, new Date(Date.now() + 86_400_000)],
  )

  return { userId, sessionToken, email }
}

/** Everything this user made. Claims cascade; the user goes last. */
export async function deleteUser(userId: string): Promise<void> {
  await query('DELETE FROM "Claim" WHERE "createdById" = $1', [userId])
  await query('DELETE FROM "User" WHERE id = $1', [userId])
}

export function cookieFor(sessionToken: string) {
  return {
    name: SESSION_COOKIE,
    value: sessionToken,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    expires: Math.floor(Date.now() / 1000) + 86_400,
  }
}
