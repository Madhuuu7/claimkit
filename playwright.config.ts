import { defineConfig, devices } from '@playwright/test'

/**
 * The end-to-end run.
 *
 * One browser, Chromium, because what is being tested here is not
 * rendering -- the unit suites cover the rules and the sync engine
 * against a real Postgres. This is the one check that the whole thing
 * is wired together: a claim created in a form, a file chosen from a
 * disk, a tick that survives a reload because it reached the database,
 * and a PDF that actually comes back down the wire.
 *
 * It runs against `next dev` on its own port, so a dev server already
 * open on 3000 is left alone.
 */
const PORT = 3100

export default defineConfig({
  testDir: './e2e',
  // These tests share one database and one claim each; running them in
  // parallel is possible but buys a second and costs the ability to
  // read the trace in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // The browser Windows already trusts. The Chromium that
  // `playwright install` downloads is refused outright by Smart App
  // Control on this machine, and it fails as "spawn UNKNOWN", which
  // looks like anything except a code-signing policy.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    // A production build, not `next dev`. It is the code that actually
    // ships, it renders each page once instead of recompiling it on
    // demand, and -- the practical reason -- it opens a fraction of the
    // database connections, which the local `prisma dev` server can
    // survive where it cannot survive the dev server.
    command: `npm run build && npm start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
})
