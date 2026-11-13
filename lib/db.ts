import 'server-only'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

/**
 * One Prisma client for the process.
 *
 * Next.js reloads modules on every edit in development, and a fresh
 * client each time means a fresh connection pool each time, which ends
 * with Postgres refusing connections after a few dozen saves. Hanging it
 * off globalThis is the standard way out: module state is replaced on a
 * reload, global state is not.
 *
 * Prisma 7 talks to the database through a driver adapter, and which one
 * is right depends on where the database is, so the URL decides:
 *
 *  - Neon, in production. A serverless function is a process that lives
 *    for one request, so a normal TCP pool would be opened and thrown
 *    away thousands of times an hour and the free tier would start
 *    refusing connections. Neon's driver sends queries over HTTP, which
 *    has no pool to exhaust.
 *  - node-postgres, for a local Postgres, which speaks the wire protocol
 *    and nothing else. One long-lived process, so a pool is exactly
 *    right here.
 *
 * `server-only` at the top is not decoration. If a client component ever
 * imports this file by accident the build fails here, rather than
 * shipping a database client -- and the connection string with it -- to
 * a browser.
 */

const connectionString = process.env.DATABASE_URL

if (!connectionString && process.env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL is not set')
}

function createAdapter(url: string) {
  // Neon's own hostnames are the only ones its HTTP driver can reach.
  return /\.neon\.tech|neon\.build/.test(url)
    ? new PrismaNeon({ connectionString: url })
    : new PrismaPg({
        connectionString: url,
        // Small, and quick to let go. This branch is only ever a local
        // Postgres -- in development, `npx prisma dev` -- which falls
        // over regularly, and a pool holding ten sockets to a server
        // that has gone away is ten dead connections handed to the next
        // ten queries.
        //
        // Worth knowing what that failure looks like, because it does
        // not look like a database problem. Auth.js swallows an adapter
        // error and reports no session, so a signed-in person is quietly
        // served the signed-out page -- while the header, whose own
        // query happened to land on a live connection, still shows their
        // name. The fix is always to restart the database; the cost was
        // half an hour of not believing it.
        //
        // Neon in production takes the other branch and has no pool to
        // size: its driver sends each query over HTTP.
        //
        // Three, released after five seconds. `prisma dev` advertises
        // ten, but it is an experimental SQLite-backed server that wedges
        // under churn -- still listening, resetting every connection --
        // and the fewer sockets this holds, the longer it survives. A
        // real Postgres, in CI or self-hosted, is happy with this too.
        max: 3,
        idleTimeoutMillis: 5_000,
      })
}

function createClient(): PrismaClient {
  return new PrismaClient({
    // Empty string rather than undefined so a build with no database --
    // which never runs a query -- still compiles. The first real query
    // is what fails, loudly.
    adapter: createAdapter(connectionString ?? ''),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
