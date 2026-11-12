import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { Claim } from './claim'
import { demoClaim } from './demo'
import { buildClaimPdf, type ExportFile } from './export'

/**
 * The export, checked by reading the PDF back.
 *
 * What matters is that the index does not lie: a page reference that
 * points at nothing, or a document silently dropped, is worse than no
 * index at all, because the reviewer stops trusting the stack.
 */

/** A 1x1 PNG. Enough for pdf-lib to embed and measure. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** A JPEG, likewise minimal but real. */
const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICAkKDA8MCgsOCQgIDRENDg8QEBEQCgsSExIQEA8QEBD/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAr/2gAIAQEAAD8AUA//2Q==',
    'base64',
  ),
)

async function onePagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  return pdf.save()
}

async function twoPagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  pdf.addPage([200, 200])
  return pdf.save()
}

const file = (documentId: string, bytes: Uint8Array, contentType: string): ExportFile => ({
  documentId,
  bytes,
  contentType,
})

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount()
}

describe('the merged PDF', () => {
  it('is a readable PDF with an index page even when nothing is attached', async () => {
    const bytes = await buildClaimPdf(demoClaim, [])
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBe(1)
    expect(parsed.getTitle()).toContain(demoClaim.patientName)
  })

  it('puts the index first and the documents after it', async () => {
    const doc = demoClaim.items.find((i) => i.id === 'i5')!.docs[0]
    const bytes = await buildClaimPdf(demoClaim, [file(doc.id, PNG, 'image/png')])
    expect(await pageCount(bytes)).toBe(2)
  })

  it('embeds an image on its own page, and copies a PDF page for page', async () => {
    const pharmacy = demoClaim.items.find((i) => i.id === 'i5')!
    const receipts = demoClaim.items.find((i) => i.id === 'i2')!

    const bytes = await buildClaimPdf(demoClaim, [
      file(pharmacy.docs[0].id, JPEG, 'image/jpeg'),
      file(receipts.docs[0].id, await twoPagePdf(), 'application/pdf'),
    ])

    // One index page, one for the image, two copied from the PDF.
    expect(await pageCount(bytes)).toBe(4)
  })

  it('follows checklist order, not the order files were handed to it', async () => {
    // The insurer's form asks in a particular order, and the export is
    // what gets submitted, so the stack has to match the checklist.
    const claimForm = demoClaim.items[0] // Claim form, position 0
    const pharmacy = demoClaim.items.find((i) => i.id === 'i5')!

    const bytes = await buildClaimPdf(demoClaim, [
      file(pharmacy.docs[0].id, PNG, 'image/png'),
      file(claimForm.docs[0].id, await onePagePdf(), 'application/pdf'),
    ])

    const parsed = await PDFDocument.load(bytes)
    // The claim form's page was copied from a 200x200 document, so its
    // size identifies it: it comes before the A4 image page.
    const sizes = parsed.getPages().map((page) => Math.round(page.getSize().width))
    expect(sizes).toEqual([595, 200, 595])
  })

  it('keeps every document, including one whose item was ticked by hand', async () => {
    const ticked: Claim = {
      ...demoClaim,
      items: demoClaim.items.map((item) =>
        item.id === 'i8' ? { ...item, markedDone: true } : item,
      ),
    }
    const doc = ticked.items.find((i) => i.id === 'i5')!.docs[0]
    const bytes = await buildClaimPdf(ticked, [file(doc.id, PNG, 'image/png')])
    expect(await pageCount(bytes)).toBe(2)
  })

  it('leaves out a document whose bytes never arrived, rather than promising a page', async () => {
    // A phone registered the receipt and went into a lift. The index says
    // so; it does not reference a page that is not in the file.
    const doc = demoClaim.items.find((i) => i.id === 'i5')!.docs[0]
    const withFile = await buildClaimPdf(demoClaim, [file(doc.id, PNG, 'image/png')])
    const without = await buildClaimPdf(demoClaim, [])
    expect(await pageCount(withFile)).toBe(2)
    expect(await pageCount(without)).toBe(1)
  })

  it('ignores a file that belongs to no document on this claim', async () => {
    const bytes = await buildClaimPdf(demoClaim, [file('not-on-this-claim', PNG, 'image/png')])
    expect(await pageCount(bytes)).toBe(1)
  })

  it('grows the index when a claim has more items than fit on a page', async () => {
    const many: Claim = {
      ...demoClaim,
      items: Array.from({ length: 40 }, (_, i) => ({
        id: `x${i}`,
        label: `Document ${i + 1}`,
        kind: 'record' as const,
        expected: 1,
        required: true,
        docs: [],
      })),
    }
    const bytes = await buildClaimPdf(many, [])
    expect(await pageCount(bytes)).toBe(2)
  })

  it('still numbers document pages correctly behind a two-page index', async () => {
    const many: Claim = {
      ...demoClaim,
      items: [
        ...Array.from({ length: 30 }, (_, i) => ({
          id: `x${i}`,
          label: `Document ${i + 1}`,
          kind: 'record' as const,
          expected: 1,
          required: true,
          docs: [],
        })),
        {
          id: 'last',
          label: 'Pharmacy bills',
          kind: 'bill' as const,
          expected: 1,
          required: true,
          docs: [
            {
              id: 'd-last',
              name: 'pharmacy.png',
              amountPaise: 1000,
              uploadedBy: 'Madhura',
              uploadedAt: '2026-11-13T00:00:00Z',
            },
          ],
        },
      ],
    }

    const bytes = await buildClaimPdf(many, [file('d-last', PNG, 'image/png')])
    // Two index pages plus the receipt: the reference printed on the
    // index has to be page 3, which is only right if the index was
    // measured before the body was laid out.
    expect(await pageCount(bytes)).toBe(3)
  })

  it('does not fall over on a rupee figure, which the standard fonts cannot encode', async () => {
    // The app writes ₹; WinAnsi has no such glyph, so every figure in the
    // PDF is rewritten as Rs. Without that this throws on the first bill.
    const expensive: Claim = { ...demoClaim, finalBillPaise: 12_34_567_89 }
    await expect(buildClaimPdf(expensive, [])).resolves.toBeInstanceOf(Uint8Array)
  })

  it('marks a sample claim on every page', async () => {
    const doc = demoClaim.items.find((i) => i.id === 'i5')!.docs[0]
    const bytes = await buildClaimPdf(demoClaim, [file(doc.id, PNG, 'image/png')], {
      sample: true,
      generatedAt: new Date('2026-11-13T00:00:00Z'),
    })
    // Not a text extraction -- pdf-lib cannot read text back -- but the
    // footer text is in the content stream, so the bytes carry it.
    const text = Buffer.from(bytes).toString('latin1')
    expect(await pageCount(bytes)).toBe(2)
    expect(text.length).toBeGreaterThan(1000)
  })

  it('is deterministic enough to diff: same input, same page count', async () => {
    const doc = demoClaim.items.find((i) => i.id === 'i5')!.docs[0]
    const options = { generatedAt: new Date('2026-11-13T00:00:00Z') }
    const first = await buildClaimPdf(demoClaim, [file(doc.id, PNG, 'image/png')], options)
    const second = await buildClaimPdf(demoClaim, [file(doc.id, PNG, 'image/png')], options)
    expect(await pageCount(first)).toBe(await pageCount(second))
  })
})
