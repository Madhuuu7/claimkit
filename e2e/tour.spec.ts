import { expect, test, type Page } from '@playwright/test'
import { cookieFor, createSignedInUser, query, type TestUser } from './session'

/**
 * The screenshots in the README, taken from the running app.
 *
 * Not part of the test run -- it has its own config, and
 * `npm run screenshots` is what runs it. It drives the real screens
 * with a real database behind them, so a picture here cannot drift from
 * what the app does: if a screen breaks, this fails rather than quietly
 * photographing the broken version.
 *
 * Two tests rather than one, and each builds its own claim, because the
 * local `prisma dev` server wedges after a minute or so of this and a
 * shorter run is a run that finishes. Restart the database between them.
 */

const PDF = Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8')

async function newClaim(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByLabel('Who was admitted').fill("Appa's admission")
  await page.getByLabel('Hospital', { exact: true }).fill('Manipal Hospital, Old Airport Road')
  await page.getByLabel('Admitted on').fill('2026-10-13')
  await page.getByLabel('Discharged on').fill('2026-10-19')
  await page.locator('input[name="finalBill"]').fill('2,80,000')
  await page.locator('input[name="submissionWindowDays"]').fill('30')
  await page.getByRole('button', { name: 'Start this claim' }).click()
  await page.waitForURL(/\/claims\/[a-z0-9]+$/)
  return page.url().split('/').pop()!
}

async function cleanUp(user: TestUser): Promise<void> {
  await query('DELETE FROM "Claim" WHERE "createdById" = $1', [user.userId])
  await query('DELETE FROM "User" WHERE id = $1', [user.userId])
}

test('@tour the sheet and the family', async ({ page, context }) => {
  const user = await createSignedInUser('Madhura')
  await context.addCookies([cookieFor(user.sessionToken)])

  const claimId = await newClaim(page)

  async function addFile(item: string, name: string, amount?: string) {
    const row = page.getByRole('button', { name: new RegExp(`^${item}`) })
    await row.click()
    await page.locator('input[type="file"]').first().setInputFiles({
      name,
      mimeType: 'application/pdf',
      buffer: PDF,
    })
    if (amount) {
      await page.getByLabel(`Amount for the file being added to ${item}`).fill(amount)
    }
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText(name)).toBeVisible()
    // Collapsed again, so the ledger reads as a ledger.
    await row.click()
  }

  await addFile('Final hospital bill', 'final-bill.pdf', '2,41,000')
  await addFile('Payment receipts', 'receipt-admission.pdf', '20,000')
  await addFile('Pharmacy bills', 'pharmacy-19oct.pdf', '12,600')
  await addFile('Claim form', 'claim-form-signed.pdf')

  const tick = page.getByRole('button', { name: 'Mark Discharge summary as done' })
  await tick.click()
  await expect(tick).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('₹6,400').first()).toBeVisible()

  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'docs/claim.png', fullPage: true })

  await page.goto(`/claims/${claimId}/family`)
  await page.getByRole('button', { name: 'Make an invite link' }).click()
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
  await page.screenshot({ path: 'docs/family.png', fullPage: true })

  await cleanUp(user)
})

test('@tour the settlement and the history', async ({ page, context, browser }) => {
  const user = await createSignedInUser('Madhura')
  await context.addCookies([cookieFor(user.sessionToken)])

  const claimId = await newClaim(page)

  // Straight to submitted: this pair of screens is about what happens
  // after the claim has gone, and the uploads are the slow part.
  // Wait for the engine to have caught up with the server before
  // touching anything: a tap made in the first moments after a claim is
  // created is queued against a sheet that is still opening.
  await expect(page.getByText('All changes saved')).toBeVisible()

  await page.getByRole('button', { name: 'Mark as submitted' }).click()

  // Wait for the server to have it, not for the sheet to say it. The
  // sheet says it immediately -- that is the whole design -- and the
  // settlement screen is server-rendered, so navigating on the
  // optimistic state lands on a claim that is still a draft.
  await expect
    .poll(async () => {
      const rows = await query<{ status: string }>(
        'SELECT status FROM "Claim" WHERE id = $1',
        [claimId],
      )
      return rows[0]?.status
    }, { timeout: 20_000 })
    .toBe('SUBMITTED')

  await page.goto(`/claims/${claimId}/settlement`)
  await page.locator('input[name="settledAmount"]').fill('2,62,000')
  await page.getByLabel('Amount deducted').first().fill('12,000')
  await page.getByLabel('Reason given').first().fill('Non-medical consumables')
  await page.getByRole('button', { name: 'Add another deduction' }).click()
  await page.getByLabel('Amount deducted').nth(1).fill('2,000')
  await page.getByLabel('Reason given').nth(1).fill('Room rent above eligibility')
  await page.getByRole('button', { name: /Record the settlement/ }).click()

  await expect(page.getByText('no reason against it').first()).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'docs/settlement.png', fullPage: true })

  await page.goto(`/claims/${claimId}/history`)
  await expect(page.getByText('Where the claim has been')).toBeVisible()
  await page.screenshot({ path: 'docs/history.png', fullPage: true })

  // The phone this app is actually for.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  await phone.addCookies([cookieFor(user.sessionToken)])
  const small = await phone.newPage()
  await small.goto(`/claims/${claimId}`)
  await expect(small.getByText('Documents')).toBeVisible()
  await small.screenshot({ path: 'docs/phone.png' })
  await phone.close()

  await cleanUp(user)
})
