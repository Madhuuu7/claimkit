import 'server-only'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ALLOWED_TYPES, MAX_BYTES, type AllowedType } from './storage-types'

export { ALLOWED_TYPES, MAX_BYTES, type AllowedType }

/**
 * Where the files live.
 *
 * These are medical records, so two rules hold throughout and everything
 * else follows from them:
 *
 *  1. **The bucket is private.** Nothing is ever served from it
 *     directly, and no URL that reaches a browser lasts longer than a
 *     few minutes. A public bucket with unguessable keys is still a
 *     public bucket -- keys end up in logs, in chat apps, in the back
 *     button.
 *  2. **The browser uploads straight to the bucket.** A 10 MB photo of a
 *     pharmacy bill does not need to travel through a serverless
 *     function, where it would be billed twice, held in memory, and
 *     capped by the platform's request body limit.
 *
 * The signature does the enforcing. A presigned PUT is minted for one
 * key, one content type and one exact length, so a client that lies
 * about any of them gets a rejection from R2 itself rather than from
 * code it could skip.
 */

/** Minutes, not hours: a leaked view URL should be stale almost at once. */
const VIEW_SECONDS = 120
const UPLOAD_SECONDS = 300

const EXTENSION: Record<AllowedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
}

export class StorageNotConfigured extends Error {
  constructor() {
    super('File storage is not configured')
    this.name = 'StorageNotConfigured'
  }
}

function bucket(): string {
  const name = process.env.R2_BUCKET
  if (!name) throw new StorageNotConfigured()
  return name
}

let client: S3Client | null = null

function s3(): S3Client {
  if (client) return client

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) throw new StorageNotConfigured()

  client = new S3Client({
    // R2 is S3-compatible but has no regions; "auto" is what it expects,
    // and signing with anything else fails.
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return client
}

export function storageConfigured(): boolean {
  return Boolean(
    process.env.R2_BUCKET &&
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
  )
}

/**
 * The key a file gets.
 *
 * Derived, not random, and that is load-bearing: the server can
 * recompute it when the browser reports an upload finished, so the
 * client never gets to name the object it wrote. A client that could
 * choose its own key could claim to have uploaded to someone else's.
 *
 * Scoped by claim, and the document id is already unique per file, so
 * there is nothing to collide with. The family's filename is
 * deliberately absent: it would put a patient's name in a URL that ends
 * up in logs.
 */
export function storageKeyFor(claimId: string, documentId: string, type: AllowedType): string {
  return `claims/${claimId}/${documentId}.${EXTENSION[type]}`
}

/**
 * What is actually in the bucket at that key.
 *
 * Used before a document is marked uploaded. The browser saying "done"
 * is a claim, not evidence -- the request could have failed, been
 * cancelled, or never been made -- and a checklist that ticks itself for
 * a file nobody can open is the one failure this app must not have.
 */
export async function headObject(
  key: string,
): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  try {
    const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return {
      sizeBytes: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
    }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: string }).name
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404
}

/**
 * A URL the browser may PUT one file to, once.
 *
 * `ContentLength` is part of the signature, which is what makes the
 * 10 MB limit real: a client cannot sign its own larger upload, and the
 * check is not something the browser is trusted to perform.
 */
export async function presignUpload(options: {
  key: string
  contentType: AllowedType
  sizeBytes: number
}): Promise<{ url: string; expiresInSeconds: number }> {
  if (options.sizeBytes > MAX_BYTES) throw new Error('That file is larger than 10 MB')

  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: options.key,
      ContentType: options.contentType,
      ContentLength: options.sizeBytes,
    }),
    { expiresIn: UPLOAD_SECONDS },
  )

  return { url, expiresInSeconds: UPLOAD_SECONDS }
}

/** A short-lived URL for looking at one file. */
export async function presignView(key: string, filename?: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      // So a download arrives named as the family knows it, without the
      // name ever being part of the key.
      ResponseContentDisposition: filename
        ? `inline; filename="${filename.replaceAll('"', '')}"`
        : undefined,
    }),
    { expiresIn: VIEW_SECONDS },
  )
}

/** Used when a document is removed, and by nothing else. */
export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

/** The bytes themselves, for the merged PDF export. */
export async function readObject(key: string): Promise<Uint8Array> {
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  if (!result.Body) throw new Error(`Nothing stored at ${key}`)
  return new Uint8Array(await result.Body.transformToByteArray())
}
