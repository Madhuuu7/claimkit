import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

/**
 * The screenshots in the README.
 *
 * Taken from the demo, which is the real sheet running against an
 * in-browser simulation of the server -- so these are photographs of
 * the actual UI, not mock-ups, and they need no database, no bucket and
 * no Google client to produce.
 *
 * Usage: start the app (npm run build && npm start), then
 *   node scripts/screenshots.mjs http://localhost:3000
 */
const base = process.argv[2] ?? 'http://localhost:3000'

const shots = [
  { path: '/demo', file: 'docs/sheet.png', wait: 'Documents' },
  { path: '/', file: 'docs/home.png', wait: 'One claim, the whole family' },
]

await mkdir('docs', { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 2,
})

for (const shot of shots) {
  await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle' })
  try {
    await page.getByText(shot.wait, { exact: false }).first().waitFor({ timeout: 15_000 })
  } catch {
    console.warn(`! ${shot.path}: never showed "${shot.wait}"; shooting anyway`)
  }
  await page.screenshot({ path: shot.file, fullPage: false })
  console.log(`${shot.path} -> ${shot.file}`)
}

await browser.close()
