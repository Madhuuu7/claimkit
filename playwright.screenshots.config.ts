import base from './playwright.config'

/**
 * The screenshot tour, which the test run ignores.
 *
 * Same server, same browser, same everything -- only the file it runs
 * is different. Kept out of `npm run test:e2e` because it writes into
 * docs/ and proves nothing a test should be asked to prove.
 */
const screenshots = {
  ...base,
  testIgnore: undefined,
  testMatch: '**/tour.spec.ts',
  retries: 0,
}

export default screenshots
