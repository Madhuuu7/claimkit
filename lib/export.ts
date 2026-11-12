import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import {
  blockers,
  dueDate,
  itemState,
  uploadedTotal,
  unaccounted,
  type Claim,
  type ChecklistItem,
} from './claim'
import { formatRupees } from './money'

/**
 * One PDF, in the order an insurer reads.
 *
 * A reimbursement claim is submitted as a stack of paper or a single
 * upload, and the thing that gets it queried is not usually a missing
 * document -- it is a reviewer who cannot tell what they have been sent.
 * So the first page is an index: what the claim is, what the bill was,
 * what the receipts add up to, and where each document starts. Then the
 * documents themselves, in checklist order, with the item they belong to
 * printed above each one.
 *
 * Pure on purpose: it takes bytes, not keys, so it can be tested without
 * a bucket and without a database, and the route stays the part that
 * knows about storage.
 */

export type ExportFile = {
  documentId: string
  bytes: Uint8Array
  contentType: string
}

export type ExportOptions = {
  generatedAt?: Date
  /** Stamped on every page when the claim is the public sample. */
  sample?: boolean
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 54
const INK = rgb(0.07, 0.13, 0.12)
const SOFT = rgb(0.36, 0.42, 0.4)
const RULE = rgb(0.84, 0.84, 0.81)
const ACCENT = rgb(0.66, 0.38, 0.05)

/**
 * Rupees, written for a PDF.
 *
 * The standard PDF fonts are WinAnsi-encoded and have no rupee sign, so
 * drawing the app's own ₹ figures would throw at the first bill.
 * Embedding a font that has the glyph would mean shipping a font file
 * and fontkit for one character, which an insurer's reviewer will not
 * thank anyone for. "Rs" is what the policy documents themselves use.
 */
function money(paise: number): string {
  return formatRupees(paise).replace('₹', 'Rs ')
}

/** Index rows that fit on one page, after the heading block. */
const ROWS_PER_INDEX_PAGE = 24

type Row = {
  item: ChecklistItem
  /** 1-based page where this document's pages begin, if any arrived. */
  startsOnPage: number | null
  files: number
  note: string
}

export async function buildClaimPdf(
  claim: Claim,
  files: readonly ExportFile[],
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  pdf.setTitle(`${claim.patientName} — reimbursement claim`)
  pdf.setProducer('ClaimKit')
  pdf.setCreator('ClaimKit')

  const byId = new Map(files.map((f) => [f.documentId, f]))

  // How many index pages there will be, worked out before any document
  // is added, because every page number printed on the index depends on
  // it.
  const indexPages = Math.max(1, Math.ceil(claim.items.length / ROWS_PER_INDEX_PAGE))

  const rows: Row[] = []

  for (const item of claim.items) {
    const present = item.docs.filter((doc) => byId.has(doc.id))
    const startsOnPage = present.length > 0 ? indexPages + pdf.getPageCount() + 1 : null

    for (const doc of present) {
      const file = byId.get(doc.id)!
      await appendDocument(pdf, { item, name: doc.name, file }, { regular, bold })
    }

    rows.push({
      item,
      startsOnPage,
      files: present.length,
      note: noteFor(item, present.length),
    })
  }

  // The index goes in at the front once the body is laid out, so its page
  // references are facts rather than predictions.
  drawIndex(pdf, claim, rows, indexPages, { regular, bold }, options)

  stampFooters(pdf, { regular }, options)

  return pdf.save()
}

function noteFor(item: ChecklistItem, present: number): string {
  const total = item.docs.length
  const missing = total - present
  const state = itemState(item)

  if (total === 0) {
    if (item.markedDone) return 'ticked by hand, no file'
    return item.required ? 'not provided' : 'not provided (optional)'
  }
  if (missing > 0) {
    // A document registered on a phone whose bytes never made it up. Said
    // plainly, because the alternative is an index that promises a page
    // which is not in the file.
    return `${present} of ${total} files attached, ${missing} still uploading`
  }
  if (state === 'partial' && item.expected !== null) {
    return `${present} of ${item.expected} expected`
  }
  return `${present} ${present === 1 ? 'file' : 'files'}`
}

type Fonts = { regular: PDFFont; bold: PDFFont }

function drawIndex(
  pdf: PDFDocument,
  claim: Claim,
  rows: Row[],
  indexPages: number,
  fonts: Fonts,
  options: ExportOptions,
): void {
  const chunks: Row[][] = []
  for (let i = 0; i < indexPages; i++) {
    chunks.push(rows.slice(i * ROWS_PER_INDEX_PAGE, (i + 1) * ROWS_PER_INDEX_PAGE))
  }

  chunks.forEach((chunk, index) => {
    // Inserted in order at the front, so the first index page is page 1.
    const page = pdf.insertPage(index, [A4.width, A4.height])
    let y = A4.height - MARGIN

    if (index === 0) {
      y = drawHeading(page, claim, fonts, options, y)
      y = drawReconciliation(page, claim, fonts, y)
      y -= 26
      page.drawText('Documents in this claim', {
        x: MARGIN,
        y,
        size: 12,
        font: fonts.bold,
        color: INK,
      })
      y -= 18
    } else {
      page.drawText('Documents in this claim, continued', {
        x: MARGIN,
        y,
        size: 12,
        font: fonts.bold,
        color: INK,
      })
      y -= 18
    }

    const right = A4.width - MARGIN
    page.drawLine({
      start: { x: MARGIN, y: y + 6 },
      end: { x: right, y: y + 6 },
      thickness: 0.75,
      color: RULE,
    })

    for (const row of chunk) {
      y -= 20
      const amount = row.item.docs.reduce((sum, doc) => sum + (doc.amountPaise ?? 0), 0)

      page.drawText(row.item.label, { x: MARGIN, y, size: 10, font: fonts.regular, color: INK })
      page.drawText(row.note, {
        x: MARGIN + 190,
        y,
        size: 9,
        font: fonts.regular,
        color: SOFT,
      })

      if (row.item.kind === 'bill') {
        const text = money(amount)
        page.drawText(text, {
          x: right - 150 - fonts.regular.widthOfTextAtSize(text, 10),
          y,
          size: 10,
          font: fonts.regular,
          color: INK,
        })
      }

      const where = row.startsOnPage === null ? '—' : `page ${row.startsOnPage}`
      page.drawText(where, {
        x: right - fonts.regular.widthOfTextAtSize(where, 9),
        y,
        size: 9,
        font: fonts.regular,
        color: SOFT,
      })

      page.drawLine({
        start: { x: MARGIN, y: y - 7 },
        end: { x: right, y: y - 7 },
        thickness: 0.5,
        color: RULE,
      })
    }

    if (index === chunks.length - 1) {
      drawOutstanding(page, claim, fonts, y - 34)
    }
  })
}

function drawHeading(
  page: PDFPage,
  claim: Claim,
  fonts: Fonts,
  options: ExportOptions,
  top: number,
): number {
  let y = top

  page.drawText('Reimbursement claim', { x: MARGIN, y, size: 9, font: fonts.regular, color: SOFT })
  y -= 26
  page.drawText(claim.patientName, { x: MARGIN, y, size: 20, font: fonts.bold, color: INK })
  y -= 18
  page.drawText(claim.hospital, { x: MARGIN, y, size: 10, font: fonts.regular, color: SOFT })
  y -= 14

  const stay = `Admitted ${pretty(claim.admittedOn)}, discharged ${pretty(claim.dischargedOn)}. Submit by ${pretty(
    dueDate(claim).toISOString().slice(0, 10),
  )} (${claim.submissionWindowDays} days).`
  page.drawText(stay, { x: MARGIN, y, size: 10, font: fonts.regular, color: SOFT })
  y -= 14

  const who = `Assembled by ${claim.members.map((m) => m.name).join(', ')}.`
  page.drawText(who, { x: MARGIN, y, size: 10, font: fonts.regular, color: SOFT })

  if (options.sample) {
    y -= 16
    page.drawText('Sample claim. Invented data, for demonstration only.', {
      x: MARGIN,
      y,
      size: 9,
      font: fonts.bold,
      color: ACCENT,
    })
  }

  return y - 10
}

function drawReconciliation(page: PDFPage, claim: Claim, fonts: Fonts, top: number): number {
  const right = A4.width - MARGIN
  let y = top - 20

  const gap = unaccounted(claim)
  const lines: [string, string, boolean][] = [
    ['Final hospital bill', money(claim.finalBillPaise), false],
    ['Receipts attached', money(uploadedTotal(claim)), false],
    [
      gap > 0 ? 'Not yet accounted for' : gap < 0 ? 'Receipts exceed the bill by' : 'Unaccounted',
      money(Math.abs(gap)),
      gap !== 0,
    ],
  ]

  for (const [label, value, loud] of lines) {
    y -= 16
    page.drawText(label, {
      x: MARGIN,
      y,
      size: 10,
      font: loud ? fonts.bold : fonts.regular,
      color: loud ? ACCENT : SOFT,
    })
    page.drawText(value, {
      x: right - fonts.bold.widthOfTextAtSize(value, 10),
      y,
      size: 10,
      font: loud ? fonts.bold : fonts.regular,
      color: loud ? ACCENT : INK,
    })
  }

  return y
}

/** The same sentences the sheet shows, so the PDF hides nothing. */
function drawOutstanding(page: PDFPage, claim: Claim, fonts: Fonts, top: number): void {
  const problems = blockers(claim)
  if (problems.length === 0 || top < MARGIN + 40) return

  let y = top
  page.drawText('Still outstanding', { x: MARGIN, y, size: 11, font: fonts.bold, color: INK })

  for (const problem of problems.slice(0, 6)) {
    y -= 14
    if (y < MARGIN + 20) return
    page.drawText(`— ${problem.text.replace('₹', 'Rs ')}`, {
      x: MARGIN,
      y,
      size: 9.5,
      font: fonts.regular,
      color: problem.kind === 'gap' ? ACCENT : SOFT,
    })
  }
}

async function appendDocument(
  pdf: PDFDocument,
  entry: { item: ChecklistItem; name: string; file: ExportFile },
  fonts: Fonts,
): Promise<void> {
  const { item, name, file } = entry

  if (file.contentType === 'application/pdf') {
    // Copied page by page rather than rasterised: an itemised bill stays
    // selectable text, which is what a reviewer searching for a line
    // item needs.
    const source = await PDFDocument.load(file.bytes, { ignoreEncryption: true })
    const pages = await pdf.copyPages(source, source.getPageIndices())
    pages.forEach((page, index) => {
      pdf.addPage(page)
      if (index === 0) label(page, `${item.label} — ${name}`, fonts)
    })
    return
  }

  const image =
    file.contentType === 'image/png'
      ? await pdf.embedPng(file.bytes)
      : await pdf.embedJpg(file.bytes)

  const page = pdf.addPage([A4.width, A4.height])
  const top = A4.height - MARGIN - 18
  const area = { width: A4.width - MARGIN * 2, height: top - MARGIN }
  // Fit, never fill: a receipt cropped to the page edge is a receipt
  // with its total missing.
  const scale = Math.min(area.width / image.width, area.height / image.height, 1)
  const width = image.width * scale
  const height = image.height * scale

  page.drawImage(image, {
    x: MARGIN + (area.width - width) / 2,
    y: MARGIN + (area.height - height) / 2,
    width,
    height,
  })

  label(page, `${item.label} — ${name}`, fonts)
}

function label(page: PDFPage, text: string, fonts: Fonts): void {
  const { height } = page.getSize()
  page.drawText(text, {
    x: MARGIN,
    y: height - MARGIN + 6,
    size: 9,
    font: fonts.bold,
    color: SOFT,
    // A long filename on a narrow scan should not run off the paper.
    maxWidth: page.getSize().width - MARGIN * 2,
  })
}

function stampFooters(pdf: PDFDocument, fonts: { regular: PDFFont }, options: ExportOptions): void {
  const pages = pdf.getPages()
  const generated = (options.generatedAt ?? new Date()).toISOString().slice(0, 10)

  pages.forEach((page, index) => {
    const { width } = page.getSize()
    const left = options.sample
      ? `Sample claim — invented data. Assembled with ClaimKit, ${generated}`
      : `Assembled with ClaimKit, ${generated}`
    const right = `${index + 1} of ${pages.length}`

    page.drawText(left, { x: MARGIN, y: 30, size: 8, font: fonts.regular, color: SOFT })
    page.drawText(right, {
      x: width - MARGIN - fonts.regular.widthOfTextAtSize(right, 8),
      y: 30,
      size: 8,
      font: fonts.regular,
      color: SOFT,
    })
  })
}

function pretty(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${d} ${months[m - 1]} ${y}`
}
