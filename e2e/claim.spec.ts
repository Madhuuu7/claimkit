import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { cookieFor, createSignedInUser, deleteUser, query, type TestUser } from './session'

/**
 * One claim, the whole way through.
 *
 * Create it in the form, choose a file from the disk, tick something
 * off, and get a PDF back. The unit suites already prove the rules, the
 * conflict resolution and the queries; this proves the wiring -- that
 * the form reaches the database, that a tick made in the browser
 * survives a reload because it was synced rather than kept in React
 * state, and that the export route returns a real PDF.
 */

let user: TestUser

test.beforeAll(async () => {
  user = await createSignedInUser()
})

test.afterAll(async () => {
  await deleteUser(user.userId)
})

test.beforeEach(async ({ context }) => {
  await context.addCookies([cookieFor(user.sessionToken)])
})

/** A real PDF, small enough to live in the test. */
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
)

test('a family puts a claim together and exports it', async ({ page }) => {
  await page.goto('/')

  // --- create -----------------------------------------------------
  await page.getByLabel('Who was admitted').fill('Appa, October')
  await page.getByLabel('Hospital', { exact: true }).fill('Manipal Hospital, Old Airport Road')
  await page.getByLabel('Admitted on').fill('2026-10-13')
  await page.getByLabel('Discharged on').fill('2026-10-19')
  await page.locator('input[name="finalBill"]').fill('2,80,000')
  await page.locator('input[name="submissionWindowDays"]').fill('30')
  await page.getByRole('button', { name: 'Start this claim' }).click()

  await page.waitForURL(/\/claims\/[a-z0-9]+$/)
  await expect(page.getByRole('heading', { name: 'Appa, October' })).toBeVisible()

  // Nothing uploaded yet, so the whole bill is unaccounted for. This is
  // the figure the app exists to say out loud.
  await expect(page.getByText('₹2,80,000').first()).toBeVisible()

  const claimId = page.url().split('/').pop()!

  // --- upload a file ----------------------------------------------
  await page.getByRole('button', { name: /^Pharmacy bills/ }).click()

  const amountField = page.getByLabel('Amount for the file being added to Pharmacy bills')
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'pharmacy-19oct.pdf',
    mimeType: 'application/pdf',
    buffer: PDF_BYTES,
  })
  await amountField.fill('11,200')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(page.getByText('pharmacy-19oct.pdf')).toBeVisible()
  // The receipt counts against the bill at once, before anything has
  // reached a server: that is the offline-first claim this app makes.
  await expect(page.getByText('₹2,68,800').first()).toBeVisible()

  // --- tick an item off --------------------------------------------
  const tick = page.getByRole('button', { name: 'Mark Discharge summary as done' })
  await tick.click()
  await expect(tick).toHaveAttribute('aria-pressed', 'true')

  // The tick has to have reached the database, not just React state.
  // Asked of Postgres rather than of the sync line, because the sync
  // line is this app's own opinion of itself and the whole question
  // here is whether that opinion is true.
  await expect
    .poll(
      async () => {
        const rows = await query<{ markedDone: boolean }>(
          'SELECT "markedDone" FROM "ChecklistItem" WHERE "claimId" = $1 AND label = $2',
          [claimId, 'Discharge summary'],
        )
        return rows[0]?.markedDone ?? false
      },
      { timeout: 20_000, message: 'the tick never reached the database' },
    )
    .toBe(true)

  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Mark Discharge summary as done' }),
  ).toHaveAttribute('aria-pressed', 'true')
  // The ledger comes back collapsed, so the file is one tap in -- and
  // it is there, which means the document row was written on the server
  // and came back in the snapshot rather than being replayed out of
  // this browser's outbox.
  await page.getByRole('button', { name: /^Pharmacy bills/ }).click()
  await expect(page.getByText('pharmacy-19oct.pdf')).toBeVisible()

  // --- export -------------------------------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export as one PDF' }).click(),
  ])

  expect(download.suggestedFilename()).toBe('claim-appa-october.pdf')

  const path = await download.path()
  const bytes = await readFile(path)
  // A PDF, not an error page saved under a .pdf name.
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(bytes.byteLength).toBeGreaterThan(1000)

  // And what it exported is what is in the database.
  const documents = await query<{ amountPaise: number; name: string }>(
    'SELECT name, "amountPaise" FROM "Document" WHERE "claimId" = $1',
    [claimId],
  )
  expect(documents).toHaveLength(1)
  expect(documents[0].name).toBe('pharmacy-19oct.pdf')
  expect(documents[0].amountPaise).toBe(11_200_00)

  const ticked = await query(
    'SELECT id FROM "ChecklistItem" WHERE "claimId" = $1 AND "markedDone"',
    [claimId],
  )
  expect(ticked).toHaveLength(1)
})

test('a stranger is not told the claim exists', async ({ browser }) => {
  const [claim] = await query<{ id: string }>(
    'SELECT id FROM "Claim" WHERE "createdById" = $1 LIMIT 1',
    [user.userId],
  )
  const stranger = await createSignedInUser('Stranger')

  const context = await browser.newContext()
  await context.addCookies([cookieFor(stranger.sessionToken)])
  const page = await context.newPage()

  // Not found, never forbidden: confirming the id is real would itself
  // be a leak -- it would turn a stolen link into proof that someone in
  // that family is making a claim. The export route is the crisp place
  // to read that answer, because a page under partial prerendering
  // replies 200 with its shell before the membership check has run.
  const refused = await page.request.get(`/api/claims/${claim.id}/export`)
  expect(refused.status()).toBe(404)
  expect(await refused.text()).not.toContain('Appa')

  // And the claim itself shows them nothing.
  await page.goto(`/claims/${claim.id}`)
  await expect(page.getByText('Appa, October')).toHaveCount(0)
  await expect(page.getByText('Manipal Hospital')).toHaveCount(0)

  await context.close()
  await deleteUser(stranger.userId)
})
