// Vitest does not read .env, and the integration tests need a database
// connection string. Loaded here rather than in each test file so a test
// that forgets fails loudly instead of quietly running against nothing.
import 'dotenv/config'
import { afterAll } from 'vitest'

afterAll(async () => {
  // Hand the connections back. Without this the pool stays open until
  // the worker is torn down, and the next file can find the database
  // refusing new connections.
  if (!process.env.DATABASE_URL) return
  const { prisma } = await import('../lib/db')
  await prisma.$disconnect()
})
