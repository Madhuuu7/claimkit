/**
 * This browser's identity in the op log.
 *
 * Op ids are `${deviceId}:${counter}`, and that is the idempotency key
 * the server deduplicates on, so the id has to survive a reload: a
 * device that forgot who it was would mint `phone:1` again and the
 * server would swallow a genuine new edit as a duplicate.
 *
 * It is not the user id. One person can have this app open on a phone
 * and a laptop, each with its own outbox and its own clock, and the
 * whole conflict story depends on telling those two apart.
 */

const KEY = 'claimkit.device'

function random(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  }
  return Math.random().toString(36).slice(2, 18)
}

export function deviceId(): string {
  // Server render: a throwaway id, never used to write anything. The
  // engine only mints ops in the browser.
  if (typeof window === 'undefined') return 'server'

  try {
    const stored = window.localStorage.getItem(KEY)
    if (stored) return stored
    const minted = random()
    window.localStorage.setItem(KEY, minted)
    return minted
  } catch {
    // Storage blocked. A fresh id per session means a reload looks like
    // a new device, which costs nothing but a longer log.
    return random()
  }
}
