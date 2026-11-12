import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { demoClaim } from './demo'
import type { Op } from './ops'
import {
  IdbClaimStore,
  MemoryClaimStore,
  type ClaimStore,
  type OutboxEntry,
} from './outbox'

function entry(id: string, clock: number): OutboxEntry {
  const op: Op = {
    id,
    deviceId: id.split(':')[0],
    by: 'Madhura',
    clock,
    at: '2026-11-12T00:00:00Z',
    body: {
      type: 'add_doc',
      itemId: 'i5',
      doc: {
        id: `doc-${id}`,
        name: `${id}.jpg`,
        amountPaise: 1200,
        uploadedBy: 'Madhura',
        uploadedAt: '2026-11-12T00:00:00Z',
      },
    },
  }
  return { op, attempts: 0, queuedAt: op.at }
}

/**
 * Both stores are held to one contract. The in-memory one is what the
 * tests and the demo server use, so a difference between them would mean
 * the tests are not exercising what ships.
 */
const implementations: [string, () => ClaimStore][] = [
  ['MemoryClaimStore', () => new MemoryClaimStore()],
  ['IdbClaimStore', () => new IdbClaimStore(`claimkit-test-${Math.random()}`)],
]

describe.each(implementations)('%s', (_name, create) => {
  let store: ClaimStore

  beforeEach(() => {
    store = create()
  })

  it('starts empty', async () => {
    expect(await store.loadOutbox()).toEqual([])
    expect(await store.loadSnapshot()).toBeNull()
  })

  it('keeps queued edits in the order the family made them', async () => {
    await store.saveEntry(entry('a:3', 3))
    await store.saveEntry(entry('a:1', 1))
    await store.saveEntry(entry('a:2', 2))
    expect((await store.loadOutbox()).map((e) => e.op.id)).toEqual(['a:1', 'a:2', 'a:3'])
  })

  it('overwrites rather than duplicates when the same op is saved again', async () => {
    // Saving on every attempt is how the retry count is persisted, and
    // the op id is the key, so this must not grow the queue.
    await store.saveEntry(entry('a:1', 1))
    await store.saveEntry({ ...entry('a:1', 1), attempts: 3, lastError: 'offline' })
    const all = await store.loadOutbox()
    expect(all).toHaveLength(1)
    expect(all[0].attempts).toBe(3)
    expect(all[0].lastError).toBe('offline')
  })

  it('removes an entry once it has been acknowledged', async () => {
    await store.saveEntry(entry('a:1', 1))
    await store.saveEntry(entry('a:2', 2))
    await store.removeEntry('a:1')
    expect((await store.loadOutbox()).map((e) => e.op.id)).toEqual(['a:2'])
  })

  it('ignores a removal of something already gone', async () => {
    // Which is what a duplicate acknowledgement is.
    await expect(store.removeEntry('nothing')).resolves.toBeUndefined()
  })

  it('round-trips the snapshot it will open offline with', async () => {
    await store.saveSnapshot({ claim: demoClaim, ops: [], seq: 7 })
    const loaded = await store.loadSnapshot()
    expect(loaded?.seq).toBe(7)
    expect(loaded?.claim).toEqual(demoClaim)
  })

  it('keeps one snapshot, not a pile of them', async () => {
    await store.saveSnapshot({ claim: demoClaim, ops: [], seq: 1 })
    await store.saveSnapshot({ claim: demoClaim, ops: [], seq: 2 })
    expect((await store.loadSnapshot())?.seq).toBe(2)
  })

  it('hands back copies, so a replay cannot mutate what is stored', async () => {
    await store.saveSnapshot({ claim: demoClaim, ops: [], seq: 1 })
    const first = await store.loadSnapshot()
    first!.claim.items[0].label = 'scribbled over'
    expect((await store.loadSnapshot())?.claim.items[0].label).toBe('Claim form')
  })
})

describe('IdbClaimStore durability', () => {
  it('still has the queue after the tab is closed and reopened', async () => {
    // The failure this exists for: a phone on 4% battery with three
    // uploads queued. A new store object against the same database is
    // what a reload looks like from here.
    const name = 'claimkit-reload'
    const before = new IdbClaimStore(name)
    await before.saveEntry(entry('a:1', 1))
    await before.saveEntry(entry('a:2', 2))
    await before.saveSnapshot({ claim: demoClaim, ops: [], seq: 4 })

    const after = new IdbClaimStore(name)
    expect((await after.loadOutbox()).map((e) => e.op.id)).toEqual(['a:1', 'a:2'])
    expect((await after.loadSnapshot())?.seq).toBe(4)
  })

  it('keeps each claim database to itself', async () => {
    const a = new IdbClaimStore('claimkit-a')
    const b = new IdbClaimStore('claimkit-b')
    await a.saveEntry(entry('a:1', 1))
    expect(await b.loadOutbox()).toEqual([])
  })
})
