import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { emailConfigured } from '@/lib/email'
import { sendReminders } from '@/lib/reminders'

/**
 * The daily reminder sweep.
 *
 * Runs on a schedule (see vercel.json), which means it has no session
 * behind it and cannot use the membership checks the rest of the app
 * leans on. Its door is a shared secret in the Authorization header
 * instead -- the same one Vercel Cron sends -- compared in constant
 * time, because comparing it with === leaks its length and then its
 * contents to anyone patient enough to measure.
 *
 * Nothing here is a GET anyone can stumble on: without the secret it is
 * a 401 with no hint of what it guards, and with the wrong one it looks
 * exactly the same.
 */

/** A sweep sends one email per member per due claim; give it room. */
export const maxDuration = 60

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET

  if (!secret) {
    // Unset is fine on a laptop, where the point is to be able to run
    // the job by hand, and refused anywhere else -- an open endpoint
    // that emails a family is not a thing to ship by omission.
    return process.env.NODE_ENV !== 'production'
  }

  const offered = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which is itself the
  // leak it exists to prevent, so the lengths are equalised first.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 401 })
  }

  const run = await sendReminders()

  return NextResponse.json(
    {
      considered: run.considered,
      reminded: run.sent.length,
      alreadySent: run.alreadySent,
      emailsSent: run.sent.reduce((total, outcome) => total + outcome.recipients, 0),
      failures: run.sent.flatMap((outcome) => outcome.failures),
      emailConfigured: emailConfigured(),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
