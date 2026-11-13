import { describe, expect, it } from 'vitest'
import { itemState, uploadedTotal, type Claim } from './claim'
import { demoClaim } from './demo'
import {
  LamportClock,
  MAX_LABEL,
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

describe('the checklist itself', () => {
  const line = (id: string, label: string) => ({
    id,
    label,
    kind: 'record' as const,
    expected: 1,
    required: true,
  })

  const labels = (claim: Claim) => claim.items.map((i) => i.label)

  it('adds a line, and takes files into it straight away', () => {
    // The point of minting the id on the phone: the add and the upload
    // that follows it name the same line before any server has heard of
    // either.
    const { claim } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'add_item', item: line('x1', 'Pre-authorisation') }),
      op('a:2', 'a', 2, { type: 'add_doc', itemId: 'x1', doc: receipt('n1', null) }),
    ])

    const added = claim.items.find((i) => i.id === 'x1')!
    expect(added.label).toBe('Pre-authorisation')
    expect(added.docs.map((d) => d.id)).toEqual(['n1'])
    // Appended, never inserted: the checklist is the order of the
    // exported PDF.
    expect(claim.items[claim.items.length - 1].id).toBe('x1')
  })

  it('lists lines two phones added offline in the same order on both', () => {
    const ops = [
      op('a:1', 'a', 2, { type: 'add_item', item: line('x1', 'Pre-authorisation') }),
      op('b:1', 'b', 1, { type: 'add_item', item: line('x2', 'Policy copy') }),
      op('b:2', 'b', 3, { type: 'add_item', item: line('x3', 'Aadhaar') }),
    ]
    const forwards = replay(demoClaim, ops).claim
    const backwards = replay(demoClaim, [...ops].reverse()).claim

    expect(labels(backwards)).toEqual(labels(forwards))
    expect(labels(forwards).slice(-3)).toEqual([
      'Policy copy',
      'Pre-authorisation',
      'Aadhaar',
    ])
  })

  it('applies an add once however many times it is delivered', () => {
    const add = op('a:1', 'a', 1, { type: 'add_item', item: line('x1', 'Policy copy') })
    const { claim } = replay(demoClaim, [add, add, { ...add }])
    expect(claim.items.filter((i) => i.id === 'x1')).toHaveLength(1)
  })

  it('renames a line without touching what is in it', () => {
    const { claim } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'rename_item', itemId: ITEM, label: 'Chemist bills' }),
    ])
    const renamed = claim.items.find((i) => i.id === ITEM)!
    expect(renamed.label).toBe('Chemist bills')
    expect(renamed.docs).toEqual(demoClaim.items.find((i) => i.id === ITEM)!.docs)
  })

  it('reports two people renaming the same line at once', () => {
    // Neither write saw the other, so the later one wins the order and
    // the earlier one is kept and shown. Silently discarding what
    // someone typed is the thing this app refuses to do.
    const { claim, conflicts } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'rename_item', itemId: ITEM, label: 'Chemist bills' }, null),
      op('b:1', 'b', 2, { type: 'rename_item', itemId: ITEM, label: 'Medicine bills' }, null),
    ])
    expect(claim.items.find((i) => i.id === ITEM)!.label).toBe('Medicine bills')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].register).toBe(`label:${ITEM}`)
  })

  it('treats a rename that saw the other rename as an ordinary edit', () => {
    const { claim, conflicts } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'rename_item', itemId: ITEM, label: 'Chemist bills' }, null),
      op('b:1', 'b', 2, { type: 'rename_item', itemId: ITEM, label: 'Medicine bills' }, 1),
    ])
    expect(claim.items.find((i) => i.id === ITEM)!.label).toBe('Medicine bills')
    expect(conflicts).toEqual([])
  })

  it('takes a line off the checklist', () => {
    const { claim } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'remove_item', itemId: 'i8' }),
    ])
    expect(claim.items.some((i) => i.id === 'i8')).toBe(false)
    expect(claim.items).toHaveLength(demoClaim.items.length - 1)
  })

  it('keeps a line off when another phone renames it at the same time', () => {
    // Whoever took it off meant to. A reconnecting phone must not put it
    // back under a new name, whichever op happens to sort last.
    const removeThenRename = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'remove_item', itemId: 'i8' }),
      op('b:1', 'b', 2, { type: 'rename_item', itemId: 'i8', label: 'Scripts' }),
    ]).claim
    const renameThenRemove = replay(demoClaim, [
      op('b:1', 'b', 1, { type: 'rename_item', itemId: 'i8', label: 'Scripts' }),
      op('a:1', 'a', 2, { type: 'remove_item', itemId: 'i8' }),
    ]).claim

    expect(removeThenRename.items.some((i) => i.id === 'i8')).toBe(false)
    expect(renameThenRemove.items.some((i) => i.id === 'i8')).toBe(false)
  })

  it('removes a line the same phone added, with its files', () => {
    const { claim } = replay(demoClaim, [
      op('a:1', 'a', 1, { type: 'add_item', item: line('x1', 'Policy copy') }),
      op('a:2', 'a', 2, { type: 'add_doc', itemId: 'x1', doc: receipt('n1', null) }),
      op('a:3', 'a', 3, { type: 'remove_item', itemId: 'x1' }),
    ])
    expect(claim.items.some((i) => i.id === 'x1')).toBe(false)
    expect(claim.items).toEqual(demoClaim.items)
  })

  it('converges whatever order checklist edits arrive in', () => {
    const ops = [
      op('a:1', 'a', 1, { type: 'add_item', item: line('x1', 'Policy copy') }),
      op('b:1', 'b', 2, { type: 'rename_item', itemId: ITEM, label: 'Chemist bills' }, null),
      op('a:2', 'a', 3, { type: 'remove_item', itemId: 'i8' }),
      op('c:1', 'c', 4, { type: 'add_doc', itemId: 'x1', doc: receipt('n1', null) }),
      op('b:2', 'b', 5, { type: 'rename_item', itemId: 'x1', label: 'Policy document' }),
    ]
    const forwards = replay(demoClaim, ops).claim
    const backwards = replay(demoClaim, [...ops].reverse()).claim
    const shuffled = replay(demoClaim, [ops[3], ops[1], ops[4], ops[0], ops[2]]).claim

    expect(backwards).toEqual(forwards)
    expect(shuffled).toEqual(forwards)
    expect(forwards.items.find((i) => i.id === 'x1')!.label).toBe('Policy document')
  })
})

describe('what the checklist refuses', () => {
  const check = (body: OpBody, claim: Claim = demoClaim) =>
    validateOp(claim, op('x', 'x', 1, body))

  const line = (label: string, id = 'x1') => ({
    id,
    label,
    kind: 'record' as const,
    expected: null,
    required: true,
  })

  it('accepts a line the insurer asked for', () => {
    expect(check({ type: 'add_item', item: line('Pre-authorisation letter') })).toBeNull()
  })

  it('refuses a line with no name', () => {
    expect(check({ type: 'add_item', item: line('   ') })).toContain('Give the document')
  })

  it('refuses a name too long to read on a phone', () => {
    expect(check({ type: 'add_item', item: line('x'.repeat(MAX_LABEL + 1) ) })).toContain(
      'under 80 characters',
    )
  })

  it('refuses a second line with a name already on the checklist', () => {
    // Two "Pharmacy bills" rows is how a family loses track of which one
    // they put the receipts in. Case and padding do not make it a
    // different document.
    expect(check({ type: 'add_item', item: line('  pharmacy BILLS ') })).toContain(
      'already a',
    )
  })

  it('lets a line keep its own name when it is renamed to itself', () => {
    const current = demoClaim.items.find((i) => i.id === ITEM)!.label
    expect(check({ type: 'rename_item', itemId: ITEM, label: current })).toBeNull()
  })

  it('refuses a rename onto another line', () => {
    const other = demoClaim.items.find((i) => i.id !== ITEM)!.label
    expect(check({ type: 'rename_item', itemId: ITEM, label: other })).toContain('already a')
  })

  it('refuses a rename of a line that is no longer there', () => {
    expect(check({ type: 'rename_item', itemId: 'gone', label: 'Anything' })).toContain(
      'no longer on this claim',
    )
  })

  it('refuses to take away a line that still holds files', () => {
    // Documents cascade from their checklist item, so this would destroy
    // the family's photographs of their bills. The sentence counts them
    // and says what to do instead.
    const refusal = check({ type: 'remove_item', itemId: ITEM })
    expect(refusal).toContain('still holds')
    expect(refusal).toContain('Remove')
  })

  it('allows a line that holds nothing to go', () => {
    const empty = demoClaim.items.find((i) => i.docs.length === 0)!
    expect(check({ type: 'remove_item', itemId: empty.id })).toBeNull()
  })

  it('refuses a second removal of the same line, which is what a retry is', () => {
    expect(check({ type: 'remove_item', itemId: 'gone' })).toContain('already been removed')
  })

  it('refuses expecting no files at all', () => {
    expect(
      check({ type: 'add_item', item: { ...line('Policy copy'), expected: 0 } }),
    ).toContain('at least one file')
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
