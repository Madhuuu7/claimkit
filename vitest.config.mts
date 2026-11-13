import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Vitest does not read .env, and the integration tests need a
    // connection string.
    setupFiles: ['./test/setup-env.ts'],
    // One file at a time. The integration suites share a single Postgres,
    // and two workers each opening their own pool is enough to exhaust a
    // small local server -- which fails as "server has closed the
    // connection" and looks like a bug in the code under test. The whole
    // suite runs in about a second either way.
    fileParallelism: false,
    // Five seconds is plenty against a Postgres on localhost and not
    // nearly enough against one in Singapore: these suites make dozens
    // of round trips each, and at 60ms a trip the arithmetic stops
    // working. The number is generous on purpose -- a test that is
    // actually hung still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The end-to-end run is Playwright's, and importing its spec here
    // fails on @playwright/test rather than running anything.
    exclude: ['e2e/**', 'node_modules/**', 'lib/generated/**'],
  },
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
})
