import 'server-only'
import { requireMembership } from './claims'
import { prisma } from './db'
import {
  MAX_BYTES,
  headObject,
  presignUpload,
  presignView,
  storageKeyFor,
  type AllowedType,
} from './storage'

/**
 * Getting a photograph of a pharmacy bill from a phone into the bucket.
 *
 * Three steps, and the split is the security model:
 *
 *  1. The client asks for permission. The server checks membership,
 *     checks the document belongs to this claim, and mints a signature
 *     for one key, one content type and one exact byte count.
 *  2. The browser PUTs the file straight to R2. It never passes through
 *     a function, so a 10 MB photo is not billed twice or capped by a
 *     platform body limit.
 *  3. The client reports back, and the server *checks the bucket* before
 *     recording the file. "Done" from a browser is a claim, not
 *     evidence, and a checklist that ticks itself for a file nobody can
 *     open is the one failure this app must not have.
 *
 * The key is derived from the claim and document ids rather than chosen
 * by the client, so a client cannot name the object it writes -- and so
 * cannot claim to have uploaded into another family's claim.
 */

export class UploadRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRefused'
  }
}

export async function beginUpload(
  userId: string,
  claimId: string,
  input: { documentId: string; contentType: AllowedType; sizeBytes: number },
): Promise<{ url: string; expiresInSeconds: number }> {
  await requireMembership(userId, claimId)

  if (input.sizeBytes > MAX_BYTES) {
    throw new UploadRefused('Files must be 10 MB or smaller')
  }

  const document = await prisma.document.findFirst({
    where: { id: input.documentId, claimId },
    select: { storageKey: true },
  })

  // The document row is created by the add_doc operation, which may
  // still be in the phone's outbox. Not an error: the uploader asks
  // again once the edit has been acknowledged.
  if (!document) throw new UploadRefused('That document is not on this claim yet')
  if (document.storageKey) throw new UploadRefused('That file has already been uploaded')

  const key = storageKeyFor(claimId, input.documentId, input.contentType)
  return presignUpload({ key, contentType: input.contentType, sizeBytes: input.sizeBytes })
}

export async function completeUpload(
  userId: string,
  claimId: string,
  input: { documentId: string; contentType: AllowedType },
): Promise<{ sizeBytes: number }> {
  await requireMembership(userId, claimId)

  const document = await prisma.document.findFirst({
    where: { id: input.documentId, claimId },
    select: { id: true, storageKey: true },
  })
  if (!document) throw new UploadRefused('That document is not on this claim')

  const key = storageKeyFor(claimId, input.documentId, input.contentType)

  // The size recorded is the bucket's, never the browser's. It is the
  // only number here that cannot be wrong.
  const stored = await headObject(key)
  if (!stored) throw new UploadRefused('That file did not arrive. Try the upload again')
  if (stored.sizeBytes > MAX_BYTES) {
    throw new UploadRefused('That file is larger than 10 MB')
  }

  await prisma.document.update({
    where: { id: document.id },
    data: {
      storageKey: key,
      contentType: stored.contentType ?? input.contentType,
      sizeBytes: stored.sizeBytes,
    },
  })

  return { sizeBytes: stored.sizeBytes }
}

/**
 * A short-lived URL for one file, for a member of that file's claim.
 *
 * The membership check is on the document's own claim, looked up from
 * the document: a URL for a file is not allowed to carry which claim it
 * belongs to, or a member of one claim could ask for another's file by
 * naming their own.
 */
export async function viewUrlFor(userId: string, documentId: string): Promise<string> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { claimId: true, storageKey: true, name: true },
  })
  if (!document) throw new UploadRefused('No such file')

  await requireMembership(userId, document.claimId)

  if (!document.storageKey) {
    throw new UploadRefused('That file is still on the phone that added it')
  }

  return presignView(document.storageKey, document.name)
}
