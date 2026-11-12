import { describe, expect, it } from 'vitest'
import { itemState, uploadedTotal, type Claim } from './claim'
import { demoClaim } from './demo'
import {
  LamportClock,
  compareOps,
  replay,
  validateOp,
  type Op,
  type OpBody,
} from './ops'

/** A test op. Everything about ordering is explicit, nothing is implied. */
function op(
  id: string,
  deviceId: string,
  clock: number,
  body: OpBody,
  after?: number | null,
): Op {
  return {
    id,
    deviceId,
    by: deviceId,
    clock,
    at: '2026-11-12T00:00:00Z',
    after,
    body,
  }
}

const receipt = (id: string, amountPaise: number | null = 1000) => ({
  id,
  name: `${id}.jpg`,
  amountPaise,
  uploadedBy: 'Madhura',
  uploadedAt: '2026-11-12T00:00:00Z',
})

/** d2 is a payment receipt in the demo; i5 is the pharmacy bills slot. */
const DOC = 'd2'
const ITEM = 'i5'

describe('replay', () => {
  it('leaves the snapshot alone when there is nothing queued', () => {
    const { claim, conflicts } = replay(demoClaim, [])
    expect(claim).toEqual(demoClaim)
    expect(conflicts).toEqual([])
  })

  it('does not mutate the snapshot it replays over', () => {
    const before = JSON.stringify(demoClaim)
    replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'add_doc', itemId: ITEM, doc: receipt('n1') }),
      op('a:2', 'a', 2, { type: 'remove_doc', itemId: ITEM, docId: 'd6' }),
    ])
    expect(JSON.stringify(demoClaim)).toBe(before)
  })

  it('converges whatever order the ops arrive in', () => {
    // Two phones reconnect at once. Neither device controls the order the
    // log lands in, so the only acceptable outcome is that order cannot
    // matter.
    const ops = [
      op('a:1', 'a', 3, { type: 'add_doc', itemId: ITEM, doc: receipt('n1', 500) }),
      op('b:1', 'b', 1, { type: 'add_doc', itemId: ITEM, doc: receipt('n2', 700) }),
      op('b:2', 'b', 4, { type: 'set_amount', itemId: ITEM, docId: 'n1', amountPaise: 900 }),
      op('a:2', 'a', 2, { type: 'remove_doc', itemId: ITEM, docId: 'd6' }),
      op('c:1', 'c', 5, { type: 'set_item_done', itemId: 'i8', done: true }),
    ]
    const forwards = replay(demoClaim, ops).claim
    const backwards = replay(demoClaim, [...ops].reverse()).claim
    const shuffled = replay(demoClaim, [ops[2], ops[0], ops[4], ops[1], ops[3]]).claim

    expect(backwards).toEqual(forwards)
    expect(shuffled).toEqual(forwards)
  })

  it('applies an op once however many times it is delivered', () => {
    // Delivery is at-least-once: a lost acknowledgement means the client
    // sends the same upload again. Twice must not mean two receipts.
    const add = op('a:1', 'a', 1, {
      type: 'add_doc',
      itemId: ITEM,
      doc: receipt('n1', 500),
    })
    const once = replay(demoClaim, [add]).claim
    const thrice = replay(demoClaim, [add, add, add]).claim
    expect(thrice).toEqual(once)
    expect(uploadedTotal(once)).toBe(uploadedTotal(demoClaim) + 500)
  })

  it('marks documents from queued ops as pending, and only those', () => {
    const ops = [
      op('a:1', 'a', 1, { type: 'add_doc', itemId: ITEM, doc: receipt('n1') }),
      op('a:2', 'a', 2, { type: 'add_doc', itemId: ITEM, doc: receipt('n2') }),
    ]
    const { claim } = replay(demoClaim, ops, { pendingOpIds: new Set(['a:2']) })
    const docs = claim.items.find((i) => i.id === ITEM)!.docs
    expect(docs.find((d) => d.id === 'n1')!.pending).toBeUndefined()
    expect(docs.find((d) => d.id === 'n2')!.pending).toBe(true)
  })

  it('counts an optimistic upload in the gap immediately', () => {
    // The point of the optimism: the family sees the gap close as they
    // photograph receipts in the ward, with no signal at all.
    const { claim } = replay(
      demoClaim,
      [op('a:1', 'a', 1, { type: 'add_doc', itemId: ITEM, doc: receipt('n1', 6_400_00) })],
      { pendingOpIds: new Set(['a:1']) },
    )
    expect(claim.finalBillPaise - uploadedTotal(claim)).toBe(0)
  })

  it('rolls an optimistic upload back by replaying without it', () => {
    // There is no undo path to get wrong: dropping the op from the log is
    // the rollback.
    const add = op('a:1', 'a', 1, {
      type: 'add_doc',
      itemId: ITEM,
      doc: receipt('n1', 500),
    })
    const applied = replay(demoClaim, [add]).claim
    expect(applied).not.toEqual(demoClaim)
    expect(replay(demoClaim, []).claim).toEqual(demoClaim)
  })

  it('keeps a removal even when an add of the same file arrives later', () => {
    // Remove wins: a receipt someone deleted must not come back when a
    // phone that was offline reconnects and re-sends its upload.
    const ops = [
      op('b:1', 'b', 9, { type: 'add_doc', itemId: ITEM, doc: receipt('n1') }),
      op('a:1', 'a', 2, { type: 'remove_doc', itemId: ITEM, docId: 'n1' }),
    ]
    const { claim } = replay(demoClaim, ops)
    expect(claim.items.find((i) => i.id === ITEM)!.docs.some((d) => d.id === 'n1')).toBe(
      false,
    )
  })

  it('refuses a second document with an id already on the claim', () => {
    const { dropped } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'add_doc', itemId: ITEM, doc: receipt(DOC) }),
    ])
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toContain('already exists')
  })
})

describe('two people, one field', () => {
  it('lets the later write win, by clock and not by whose clock is fast', () => {
    const ops = [
      op('a', 'a', 2, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }),
      op('b', 'b', 5, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 222 }),
    ]
    const { claim } = replay(demoClaim, ops)
    expect(claim.items.flatMap((i) => i.docs).find((d) => d.id === DOC)!.amountPaise).toBe(
      222,
    )
  })

  it('breaks an exact tie by device id, the same way on every device', () => {
    const ops = [
      op('a', 'a', 4, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }),
      op('b', 'b', 4, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 222 }),
    ]
    const amount = (list: Op[]) =>
      replay(demoClaim, list)
        .claim.items.flatMap((i) => i.docs)
        .find((d) => d.id === DOC)!.amountPaise

    expect(amount(ops)).toBe(222)
    expect(amount([...ops].reverse())).toBe(222)
  })

  it('calls it an edit, not a conflict, when the write saw what it replaced', () => {
    const ops = [
      op('a', 'a', 2, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }),
      // after: 2 -- this device had Anand's value on screen when it typed.
      op('b', 'b', 3, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 222 }, 2),
    ]
    expect(replay(demoClaim, ops).conflicts).toEqual([])
  })

  it('reports a conflict when neither write saw the other', () => {
    const ops = [
      op('a', 'a', 2, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }, null),
      op('b', 'b', 3, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 222 }, null),
    ]
    const { conflicts, claim } = replay(demoClaim, ops)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].register).toBe(`amount:${DOC}`)
    expect(conflicts[0].winner.id).toBe('b')
    // The losing figure is kept, because it is what a human typed and the
    // app has no way to know which of the two is right.
    expect(conflicts[0].loser.body).toMatchObject({ amountPaise: 111 })
    expect(claim.items.flatMap((i) => i.docs).find((d) => d.id === DOC)!.amountPaise).toBe(
      222,
    )
  })

  it('does not report a conflict when two people type the same figure', () => {
    const ops = [
      op('a', 'a', 2, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }),
      op('b', 'b', 3, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 }),
    ]
    expect(replay(demoClaim, ops).conflicts).toEqual([])
  })

  it('reports a conflict when one member ticks an item and another un-ticks it', () => {
    const ops = [
      op('a', 'a', 1, { type: 'set_item_done', itemId: 'i8', done: true }),
      op('b', 'b', 2, { type: 'set_item_done', itemId: 'i8', done: false }),
    ]
    const { claim, conflicts } = replay(demoClaim, ops)
    expect(conflicts).toHaveLength(1)
    expect(itemState(claim.items.find((i) => i.id === 'i8')!)).toBe('empty')
  })

  it('treats both members ticking the same item as agreement', () => {
    const ops = [
      op('a', 'a', 1, { type: 'set_item_done', itemId: 'i8', done: true }),
      op('b', 'b', 2, { type: 'set_item_done', itemId: 'i8', done: true }),
    ]
    const { claim, conflicts } = replay(demoClaim, ops)
    expect(conflicts).toEqual([])
    // A tick stands in for a document handed over at the desk, with no
    // file to upload.
    expect(itemState(claim.items.find((i) => i.id === 'i8')!)).toBe('complete')
  })

  it('clears a conflict once someone writes a value that saw the winner', () => {
    const a = op('a', 'a', 2, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 })
    const b = op('b', 'b', 3, { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 222 })
    expect(replay(demoClaim, [a, b]).conflicts).toHaveLength(1)

    // Resolving in the UI is an ordinary write based on the value shown.
    const resolve = op(
      'a:2',
      'a',
      4,
      { type: 'set_amount', itemId: ITEM, docId: DOC, amountPaise: 111 },
      3,
    )
    const { claim, conflicts } = replay(demoClaim, [a, b, resolve])
    expect(conflicts).toEqual([])
    expect(claim.items.flatMap((i) => i.docs).find((d) => d.id === DOC)!.amountPaise).toBe(
      111,
    )
  })

  it('finds the conflict however the three writes are ordered on the wire', () => {
    const a = op('a', 'a', 2, { type: 'set_final_bill', amountPaise: 300_000_00 }, null)
    const b = op('b', 'b', 5, { type: 'set_final_bill', amountPaise: 280_000_00 }, null)
    const c = op('c', 'c', 7, { type: 'set_final_bill', amountPaise: 290_000_00 }, null)
    const ids = (list: Op[]) =>
      replay(demoClaim, list).conflicts.map((k) => `${k.winner.id}>${k.loser.id}`)

    expect(ids([a, b, c])).toEqual(['b>a', 'c>b'])
    expect(ids([c, a, b])).toEqual(['b>a', 'c>b'])
  })
})

describe('status', () => {
  it('follows the state machine and drops a move the machine forbids', () => {
    const ops = [
      op('a', 'a', 1, { type: 'set_status', status: 'settled' }),
      op('b', 'b', 2, { type: 'set_status', status: 'submitted' }),
    ]
    const { claim, dropped } = replay(demoClaim, ops)
    expect(claim.status).toBe('submitted')
    expect(dropped[0].reason).toContain('cannot become settled')
  })

  it('reports a conflict when two members move the claim at once', () => {
    const submitted: Claim = { ...demoClaim, status: 'submitted' }
    const ops = [
      op('a', 'a', 1, { type: 'set_status', status: 'settled' }, null),
      op('b', 'b', 2, { type: 'set_status', status: 'rejected' }, null),
    ]
    const { claim, conflicts } = replay(submitted, ops)
    // The first move is legal and lands; the second is then illegal from
    // 'settled', so the machine, not the clock, has the last word.
    expect(claim.status).toBe('settled')
    expect(conflicts).toEqual([])
  })
})

describe('validateOp', () => {
  const add = (body: OpBody) => validateOp(demoClaim, op('x', 'x', 1, body))

  it('accepts an ordinary pharmacy receipt', () => {
    expect(add({ type: 'add_doc', itemId: ITEM, doc: receipt('n1', 5_000_00) })).toBeNull()
  })

  it('refuses an amount on a document that is a record, not a bill', () => {
    // A discharge summary has no rupee value, and letting one carry an
    // amount would quietly corrupt the reconciliation.
    expect(add({ type: 'add_doc', itemId: 'i4', doc: receipt('n1', 100) })).toContain(
      'not a bill',
    )
  })

  it('refuses a receipt larger than the whole hospital bill', () => {
    expect(
      add({ type: 'set_amount', itemId: ITEM, docId: 'd6', amountPaise: 9_00_000_00 }),
    ).toContain('cannot exceed the final bill')
  })

  it('refuses a negative amount', () => {
    expect(add({ type: 'set_amount', itemId: ITEM, docId: 'd6', amountPaise: -1 })).toContain(
      'cannot be negative',
    )
  })

  it('refuses an upload into a slot that is no longer on the claim', () => {
    expect(add({ type: 'add_doc', itemId: 'gone', doc: receipt('n1') })).toContain(
      'no longer on this claim',
    )
  })

  it('refuses a second removal of the same file, which is what a retry is', () => {
    expect(add({ type: 'remove_doc', itemId: ITEM, docId: 'nope' })).toContain(
      'already been removed',
    )
  })

  it('refuses an illegal status move', () => {
    expect(add({ type: 'set_status', status: 'settled' })).toContain('cannot become settled')
  })
})

describe('LamportClock', () => {
  it('sorts a local edit after everything the device has seen', () => {
    const clock = new LamportClock()
    clock.observe(41)
    expect(clock.tick()).toBe(42)
  })

  it('never moves backwards when an older op arrives', () => {
    const clock = new LamportClock(10)
    clock.observe(3)
    expect(clock.now).toBe(10)
  })

  it('orders ops by clock first and device id only to break ties', () => {
    const a = op('a', 'zeta', 1, { type: 'set_final_bill', amountPaise: 1 })
    const b = op('b', 'alpha', 2, { type: 'set_final_bill', amountPaise: 2 })
    expect(compareOps(a, b)).toBeLessThan(0)
    expect(compareOps({ ...b, clock: 1 }, a)).toBeLessThan(0)
  })
})
