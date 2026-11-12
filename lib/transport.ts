import type { Op } from './ops'
import type { PullResult, PushResult, Transport } from './server'

/**
 * The real wire.
 *
 * The engine was written against an interface, and the in-browser demo
 * server implements the same one, so this class is the entire difference
 * between the demonstration and the deployed app. Nothing in the outbox,
 * the replay or the conflict rules changes.
 *
 * The only judgement here is which failures are permanent. That decision
 * is the difference between keeping someone's edit and throwing it away,
 * so it is made deliberately, per status code, and not by a default.
 */
export class HttpTransport implements Transport {
  constructor(private readonly claimId: string) {}

  private get url(): string {
    return `/api/claims/${encodeURIComponent(this.claimId)}/sync`
  }

  async push(op: Op): Promise<PushResult> {
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [op] }),
      })
    } catch {
      // No network, DNS, a dead tunnel: the edit is untouched and worth
      // another try.
      return { ok: false, permanent: false, reason: 'No signal' }
    }

    // Signed out, or the session expired while the phone was in a
    // pocket. Transient on purpose: the edit is perfectly good, it just
    // needs a session, and rolling it back would throw away work for a
    // reason the family cannot see.
    if (response.status === 401) {
      return { ok: false, permanent: false, reason: 'Sign in again to send this' }
    }

    // The claim is gone, or this person is no longer in the family.
    // Retrying forever would pin a dead op at the head of the queue, so
    // it is reported as a rollback with a reason.
    if (response.status === 404) {
      return {
        ok: false,
        permanent: true,
        reason: 'This claim is no longer shared with you',
      }
    }

    // Zod refused the shape. A retry cannot fix a malformed op.
    if (response.status === 422) {
      return { ok: false, permanent: true, reason: 'That edit is not one this claim takes' }
    }

    if (!response.ok) {
      return { ok: false, permanent: false, reason: 'The server could not be reached' }
    }

    const body = (await response.json()) as {
      results?: { opId: string; ok: boolean; seq?: number; reason?: string }[]
    }
    const result = body.results?.find((r) => r.opId === op.id)

    if (!result) {
      // A 200 that says nothing about the op we sent. Treated as
      // unknown rather than accepted: at-least-once delivery means
      // sending it again is safe, and dropping it is not.
      return { ok: false, permanent: false, reason: 'No answer for that edit' }
    }

    if (result.ok) return { ok: true, seq: result.seq ?? 0 }

    return {
      ok: false,
      permanent: true,
      reason: result.reason ?? 'The claim would not take that edit',
    }
  }

  async pull(since: number): Promise<PullResult> {
    const response = await fetch(`${this.url}?since=${since}`, {
      // Never a cached log: a stale page of ops would leave this device
      // convinced it had caught up.
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Pull failed: ${response.status}`)
    return (await response.json()) as PullResult
  }
}
