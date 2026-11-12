import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { ClaimNotFound } from '@/lib/claims'
import { ALLOWED_TYPES, StorageNotConfigured } from '@/lib/storage'
import { UploadRefused, beginUpload, completeUpload } from '@/lib/uploads'

/**
 * POST to ask for an upload, PUT to say it finished.
 *
 * Both are thin: authorisation belongs to the data layer, the signature
 * and the bucket check belong to lib/uploads.ts, and the shape of what
 * arrived belongs to Zod. This file maps the three onto status codes.
 */

const beginSchema = z.object({
  documentId: z.string().min(1).max(64),
  contentType: z.enum(ALLOWED_TYPES),
  // Checked again by the signature, which is what makes it binding:
  // R2 itself rejects a PUT whose length does not match.
  sizeBytes: z.coerce.number().int().positive(),
})

const completeSchema = z.object({
  documentId: z.string().min(1).max(64),
  contentType: z.enum(ALLOWED_TYPES),
})

type Params = { params: Promise<{ id: string }> }

async function userId(): Promise<string | null> {
  const session = await auth()
  return session?.user?.id ?? null
}

function failure(error: unknown): NextResponse | null {
  if (error instanceof ClaimNotFound) {
    return NextResponse.json({ error: 'No such claim' }, { status: 404 })
  }
  if (error instanceof StorageNotConfigured) {
    // Nothing the family did, and nothing a retry fixes: the deployment
    // has no bucket configured. Said plainly rather than as a 500.
    return NextResponse.json(
      { error: 'File storage is not configured on this deployment' },
      { status: 503 },
    )
  }
  if (error instanceof UploadRefused) {
    return NextResponse.json({ error: error.message }, { status: 409 })
  }
  return null
}

export async function POST(request: Request, { params }: Params) {
  const id = await userId()
  if (!id) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const { id: claimId } = await params
  const parsed = beginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Only JPEG, PNG and PDF files, up to 10 MB' },
      { status: 422 },
    )
  }

  try {
    return NextResponse.json(await beginUpload(id, claimId, parsed.data))
  } catch (error) {
    const response = failure(error)
    if (response) return response
    throw error
  }
}

export async function PUT(request: Request, { params }: Params) {
  const id = await userId()
  if (!id) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const { id: claimId } = await params
  const parsed = completeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Which document finished?' }, { status: 422 })
  }

  try {
    return NextResponse.json(await completeUpload(id, claimId, parsed.data))
  } catch (error) {
    const response = failure(error)
    if (response) return response
    throw error
  }
}
