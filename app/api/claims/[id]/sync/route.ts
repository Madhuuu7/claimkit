import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ClaimNotFound } from '@/lib/claims'
import { pullSchema, pushSchema } from '@/lib/schemas'
import { pullOps, pushOps } from '@/lib/sync'

/**
 * The wire the offline engine already speaks.
 *
 * GET pages forward through the op log; POST offers a batch of edits.
 * Both answer 404 rather than 403 to anyone who is not in the family,
 * because confirming that a claim id is real is itself a leak.
 *
 * Nothing here decides anything. Authorisation is the data layer's,
 * validation is the pure domain's, and the shape of what arrived is
 * Zod's -- this file is the three of them in order.
 */

type Params = { params: Promise<{ id: string }> }

async function requireSession() {
  const session = await auth()
  if (!session?.user?.id) return null
  return session.user
}

export async function GET(request: Request, { params }: Params) {
  const user = await requireSession()
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const { id } = await params
  const parsed = pullSchema.safeParse({
    since: new URL(request.url).searchParams.get('since') ?? 0,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad cursor' }, { status: 400 })
  }

  try {
    const { ops, seq } = await pullOps(user.id, id, parsed.data.since)
    return NextResponse.json({ ops, seq })
  } catch (error) {
    if (error instanceof ClaimNotFound) {
      return NextResponse.json({ error: 'No such claim' }, { status: 404 })
    }
    throw error
  }
}

export async function POST(request: Request, { params }: Params) {
  const user = await requireSession()
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const { id } = await params

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400 })
  }

  const parsed = pushSchema.safeParse(payload)
  if (!parsed.success) {
    // A malformed op is a bug in a client, not something a retry fixes,
    // so it is reported as a refusal the device can roll back rather
    // than an error it will keep trying.
    return NextResponse.json(
      { error: 'That edit is not something this claim understands' },
      { status: 422 },
    )
  }

  try {
    const { results, seq } = await pushOps(user.id, id, parsed.data.ops)
    return NextResponse.json({ results, seq })
  } catch (error) {
    if (error instanceof ClaimNotFound) {
      return NextResponse.json({ error: 'No such claim' }, { status: 404 })
    }
    throw error
  }
}
