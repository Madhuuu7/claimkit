'use client'

import { ALLOWED_TYPES, MAX_BYTES, type AllowedType } from './storage-types'

/**
 * What the sheet needs in order to take a file.
 *
 * Passed down rather than imported, because the same ledger renders in
 * the demo, where there is no bucket and no server to upload to. Where
 * this is absent, the sheet asks for a filename instead of a file.
 */
export type Uploads = {
  /** Queue the bytes, then register the document. Returns a refusal. */
  addFile: (
    itemId: string,
    file: File,
    amountPaise: number | null,
  ) => Promise<string | null>
  /** Where to look at a file whose bytes are in the bucket. */
  viewUrl: (docId: string) => string
  /** Still on this device: queued, or on the wire now. */
  waitingDocIds: ReadonlySet<string>
  uploadingDocId: string | null
}

/**
 * Checked here for a fast, clear answer, and again on the server where
 * it is binding. The browser's copy of a rule is a courtesy; the
 * signature on the upload is the rule.
 */
export function refuseFile(file: File): string | null {
  if (!ALLOWED_TYPES.includes(file.type as AllowedType)) {
    return 'Only JPEG, PNG and PDF files'
  }
  if (file.size === 0) return 'That file is empty'
  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `That file is ${mb} MB. The insurer portal takes 10 MB at most`
  }
  return null
}
