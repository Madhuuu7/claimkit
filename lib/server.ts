import type { Claim } from './claim'
import { LamportClock, replay, validateOp, type Op } from './ops'

/**
 * The authoritative side, and the wire between it and a device.
 *
 * It runs in the browser. That is a deliberate choice, not a shortcut: the
 * interesting half of this app is what the *client* does when the wire is
 * cut, and a real server would make that impossible to demonstrate to
 * anyone -- you cannot ask a visitor to pull a cable. Here the demo can
 * switch the network off mid-upload, drop acknowledgements, and run a
 * second family member's phone in the next pane, all reproducibly.
 *
 * What it is not is a fake: it holds the op log, validates every op
 * against its own state rather than trusting the client's, assigns the
 * sequence numbers clients page through, and is idempotent on op id. The
 * client cannot tell it apart from one that speaks HTTP, which is the
 * property that matters -- swapping in a real endpoint is a change of
 * transport, not a change of design.
 */

export type PushResult =
  | { ok: true; seq: number }
  /**
   * `permanent` is the whole difference between a retry and a rollback.
   * No signal is transient: keep the edit and try again. A refused edit
   * is permanent: retrying it forever would pin a stuck op at the head of
   * the queue and block every edit behind it.
   */
  | { ok: false; permanent: boolean; reason: string }

export type PullResult = { ops: Op[]; seq: number }

export interface Transport {
  push(op: Op): Promise<PushResult>
  pull(since: number): Promise<PullResult>
}

export class DemoServer {
  private log: Op[] = []
  private seqOf = new Map<string, number>()
  private clock = new LamportClock()

  constructor(private readonly base: Claim) {}

  /** What the server believes, derived the same way the client derives it. */
  get claim(): Claim {
    return replay(this.base, this.log).claim
  }

  get seq(): number {
    return this.log.length
  }

  snapshot(): { claim: Claim; base: Claim; ops: Op[]; seq: number } {
    return { claim: this.claim, base: this.base, ops: [...this.log], seq: this.seq }
  }

  /**
   * Accept or refuse one op. Validation runs against the server's state,
   * because the client's was stale the moment it went offline -- the
   * receipt it is adding an amount to may have been deleted since.
   */
  push(op: Op): PushResult {
    const existing = this.seqOf.get(op.id)
    // At-least-once delivery: this is the same edit arriving twice
    // because the acknowledgement was lost, not a second edit.
    if (existing !== undefined) return { ok: true, seq: existing }

    const refusal = validateOp(this.claim, op)
    if (refusal) return { ok: false, permanent: true, reason: refusal }

    this.clock.observe(op.clock)
    this.log.push(op)
    const seq = this.log.length
    this.seqOf.set(op.id, seq)
    return { ok: true, seq }
  }

  /** Everything accepted after `since`. How a reconnecting phone catches up. */
  pull(since: number): PullResult {
    return { ops: this.log.slice(Math.max(0, since)), seq: this.seq }
  }
}

export type NetworkOptions = {
  /** Round trip in ms. Zero in tests, a few hundred in the demo. */
  latencyMs?: number
  /**
   * Fraction of requests that fail *after* the server has applied the op
   * -- a lost acknowledgement rather than a lost request. This is the
   * case that makes idempotency load-bearing, so the demo can force it.
   */
  dropAckRate?: number
  /** Injected so tests are deterministic. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** A network you can unplug. */
export class SimulatedNetwork implements Transport {
  /** The demo switch. Flipped mid-request on purpose. */
  online = true
  /** Also mutable: the demo drops acknowledgements on demand. */
  dropAckRate: number
  private readonly latencyMs: number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly server: DemoServer,
    options: NetworkOptions = {},
  ) {
    this.latencyMs = options.latencyMs ?? 0
    this.dropAckRate = options.dropAckRate ?? 0
    this.random = options.random ?? Math.random
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private async wire(): Promise<void> {
    if (this.latencyMs > 0) await this.sleep(this.latencyMs)
    // Checked after the delay as well as before: switching the network
    // off mid-request has to fail the request that is in flight, which is
    // the whole point of the demo switch.
    if (!this.online) throw new Error('offline')
  }

  async push(op: Op): Promise<PushResult> {
    if (!this.online) return { ok: false, permanent: false, reason: 'No signal' }
    try {
      await this.wire()
    } catch {
      return { ok: false, permanent: false, reason: 'No signal' }
    }
    const result = this.server.push(op)
    if (result.ok && this.random() < this.dropAckRate) {
      // Applied, then the acknowledgement vanished. The client will send
      // it again and the op id has to make that harmless.
      return { ok: false, permanent: false, reason: 'Lost connection while saving' }
    }
    return result
  }

  async pull(since: number): Promise<PullResult> {
    if (!this.online) throw new Error('No signal')
    await this.wire()
    return this.server.pull(since)
  }
}
