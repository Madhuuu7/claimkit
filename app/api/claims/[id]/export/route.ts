import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ClaimNotFound, getClaim, toClientClaim } from '@/lib/claims'
import { buildClaimPdf, type ExportFile } from '@/lib/export'
import { readObject, storageConfigured, type AllowedType } from '@/lib/storage'

/**
 * The whole claim as one PDF.
 *
 * Built on demand rather than stored: it is derived from the claim, and
 * a cached copy would be a second truth that goes stale the moment
 * somebody adds a receipt. The documents are pulled from the bucket
 * here, which is why lib/export.ts takes bytes -- it can be tested
 * without any of this.
 *
 * A document whose bytes never made it off a phone is listed in the
 * index as still uploading rather than silently skipped, because an
 * index that promises a page which is not in the file is worse than an
 * honest gap.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first' }, { status: 401 })
  }

  const { id } = await params

  try {
    const detail = await getClaim(session.user.id, id)
    const claim = toClientClaim(detail)

    const files: ExportFile[] = []
    if (storageConfigured()) {
      // Sequentially, not in parallel: a claim can hold thirty scans, and
      // thirty concurrent reads of a few megabytes each is how a small
      // function runs out of memory.
      for (const document of detail.items.flatMap((item) => item.documents)) {
        if (!document.storageKey || !document.contentType) continue
        try {
          files.push({
            documentId: document.id,
            bytes: await readObject(document.storageKey),
            contentType: document.contentType as AllowedType,
          })
        } catch {
          // One unreadable object should not cost the family the other
          // twenty-nine. It shows in the index as not attached.
        }
      }
    }

    const pdf = await buildClaimPdf(claim, files, { sample: detail.isSample })
    const filename = `claim-${slug(claim.patientName)}.pdf`

    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        // Medical records. Not in a shared cache, ever.
        'cache-control': 'no-store, private',
      },
    })
  } catch (error) {
    if (error instanceof ClaimNotFound) {
      return NextResponse.json({ error: 'No such claim' }, { status: 404 })
    }
    throw error
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'claim'
  )
}
