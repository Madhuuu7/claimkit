import 'server-only'
import { PrismaNeon } from '@prisma/adapter-neon'
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
 * Prisma 7 talks to the database through a driver adapter, and the one
 * chosen here is Neon's. It matters on the deployment this is going to:
 * a serverless function is a process that lives for one request, so a
 * normal TCP pool would be opened and thrown away thousands of times an
 * hour, and Neon's free tier would start refusing connections. The Neon
 * driver sends queries over HTTP instead, which has no pool to exhaust.
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

function createClient(): PrismaClient {
  return new PrismaClient({
    // Empty string rather than undefined so that a build without a
    // database, which never runs a query, still type-checks and
    // compiles; the first real query is what fails, loudly.
    adapter: new PrismaNeon({ connectionString: connectionString ?? '' }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
