import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ClaimNotFound } from '@/lib/claims'
import { StorageNotConfigured } from '@/lib/storage'
import { UploadRefused, viewUrlFor } from '@/lib/uploads'

/**
 * Looking at one document.
 *
 * A redirect to a URL that expires in two minutes, rather than the file
 * itself: the bytes go browser-to-bucket, and a link that leaks is stale
 * almost immediately. The response is explicitly uncacheable, because a
 * shared cache holding a signed medical-record URL is the whole problem
 * restated.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first' }, { status: 401 })
  }

  const { id } = await params

  try {
    const url = await viewUrlFor(session.user.id, id)
    return NextResponse.redirect(url, {
      status: 307,
      headers: { 'cache-control': 'no-store, private' },
    })
  } catch (error) {
    if (error instanceof ClaimNotFound || error instanceof UploadRefused) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof StorageNotConfigured) {
      return NextResponse.json({ error: 'File storage is not configured' }, { status: 503 })
    }
    throw error
  }
}
