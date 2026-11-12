import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { itemState, unaccounted, uploadedTotal, type Claim } from './claim'
import { demoClaim } from './demo'
import { SyncEngine } from './engine'
import { IdbClaimStore, MemoryClaimStore, type ClaimStore } from './outbox'
import { DemoServer, SimulatedNetwork } from './server'

let docCounter = 0

/** i5 is pharmacy bills (a bill slot), d6 a receipt already on it. */
const ITEM = 'i5'
const DOC = 'd6'

type Harness = {
  server: DemoServer
  network: SimulatedNetwork
  engine: SyncEngine
  store: ClaimStore
  /** Runs whatever the engine scheduled as a retry, in order. */
  runRetries: () => Promise<void>
}

async function harness(
  options: {
    device?: { id: string; name: string }
    server?: DemoServer
    store?: ClaimStore
    base?: Claim
    dropAckRate?: number
    /** Start with the radio already off, as a phone in a basement does. */
    offline?: boolean
  } = {},
): Promise<Harness> {
  const base = options.base ?? demoClaim
  const server = options.server ?? new DemoServer(base)
  const network = new SimulatedNetwork(server, {
    dropAckRate: options.dropAckRate ?? 0,
    random: () => 0, // deterministic: every roll is the lowest one
  })
  const store = options.store ?? new MemoryClaimStore()
  const retries: (() => void)[] = []
  const engine = new SyncEngine({
    base,
    store,
    transport: network,
    device: options.device ?? { id: 'phone-a', name: 'Madhura' },
    now: () => new Date('2026-11-12T18:00:00Z'),
    schedule: (fn) => void retries.push(fn),
    // Unique across harnesses, not just within one: a reload gets a
    // fresh engine but the documents its predecessor queued are still
    // there, and a repeated id would be refused as a duplicate file.
    newId: () => `new-doc-${++docCounter}`,
  })
  if (options.offline) {
    network.online = false
    engine.setOnline(false)
  }
  await engine.start()
  return {
    server,
    network,
    engine,
    store,
    runRetries: async () => {
      while (retries.length > 0) {
        retries.shift()!()
        // The retry kicks off a sync; let it settle.
        await engine.sync()
      }
    },
  }
}

const docsOf = (claim: Claim, itemId = ITEM) =>
  claim.items.find((i) => i.id === itemId)!.docs

describe('an edit made with no signal', () => {
  it('shows on the sheet at once, marked as not yet sent', async () => {
    const { engine, network } = await harness()
    network.online = false
    engine.setOnline(false)

    expect(await engine.addDocument(ITEM, { name: 'pharmacy-19oct.jpg', amountPaise: 2_000_00 })).toBeNull()

    const state = engine.getState()
    expect(state.queued).toHaveLength(1)
    const added = docsOf(state.claim).find((d) => d.name === 'pharmacy-19oct.jpg')!
    expect(added.pending).toBe(true)
    // The gap is what the family is watching, and it moves immediately.
    expect(unaccounted(state.claim)).toBe(unaccounted(demoClaim) - 2_000_00)
  })

  it('is still queued after the tab is closed and reopened', async () => {
    const store = new IdbClaimStore(`claimkit-engine-${Math.random()}`)
    const server = new DemoServer(demoClaim)
    const first = await harness({ store, server, offline: true })
    await first.engine.addDocument(ITEM, { name: 'ward-receipt.jpg', amountPaise: 1_000_00 })

    // A second engine on the same storage is what a reload looks like.
    const second = await harness({ store, server, offline: true })
    expect(second.engine.getState().queued).toHaveLength(1)
    expect(docsOf(second.engine.getState().claim).some((d) => d.name === 'ward-receipt.jpg')).toBe(
      true,
    )
  })

  it('reaches the server when the signal comes back', async () => {
    const { engine, network, server } = await harness()
    network.online = false
    engine.setOnline(false)
    await engine.addDocument(ITEM, { name: 'ward-receipt.jpg', amountPaise: 1_000_00 })

    network.online = true
    engine.setOnline(true)
    await engine.sync()

    expect(engine.getState().queued).toEqual([])
    expect(docsOf(server.claim).some((d) => d.name === 'ward-receipt.jpg')).toBe(true)
    // The upload is no longer "waiting for signal".
    expect(
      docsOf(engine.getState().claim).find((d) => d.name === 'ward-receipt.jpg')!.pending,
    ).toBeUndefined()
  })

  it('opens offline on the stored snapshot rather than an empty page', async () => {
    const store = new IdbClaimStore(`claimkit-offline-open-${Math.random()}`)
    const server = new DemoServer(demoClaim)
    const online = await harness({ store, server })
    await online.engine.setItemDone('i8', true)
    await online.engine.sync()

    const offline = await harness({
      store,
      server: new DemoServer(demoClaim),
      base: demoClaim,
    })
    offline.network.online = false
    // The tick someone made last week is on the sheet with no network.
    expect(itemState(offline.engine.getState().claim.items.find((i) => i.id === 'i8')!)).toBe(
      'complete',
    )
  })
})

describe('sending', () => {
  it('sends in the order the edits were made, and stops at the first failure', async () => {
    const { engine, network, server } = await harness()
    network.online = false
    engine.setOnline(false)
    await engine.addDocument(ITEM, { name: 'a.jpg', amountPaise: 100 })
    await engine.addDocument(ITEM, { name: 'b.jpg', amountPaise: 200 })
    // The amount edit depends on the upload before it existing.
    const queuedAdd = engine.getState().queued[0].op
    const docId = queuedAdd.body.type === 'add_doc' ? queuedAdd.body.doc.id : ''
    await engine.setAmount(ITEM, docId, 300)

    network.online = true
    engine.setOnline(true)
    await engine.sync()

    expect(server.pull(0).ops.map((o) => o.body.type)).toEqual([
      'add_doc',
      'add_doc',
      'set_amount',
    ])
    expect(docsOf(server.claim).find((d) => d.name === 'a.jpg')!.amountPaise).toBe(300)
  })

  it('does not lose or duplicate an upload whose acknowledgement goes missing', async () => {
    // The server applied it and the reply never arrived. The client has
    // no way to tell that from a request that never landed, so it sends
    // again -- and the op id has to make the second one a no-op.
    const { engine, server, runRetries, network } = await harness({ dropAckRate: 1 })
    await engine.addDocument(ITEM, { name: 'lost-ack.jpg', amountPaise: 500 })
    await engine.sync()
    expect(engine.getState().queued).toHaveLength(1)
    expect(engine.getState().queued[0].attempts).toBeGreaterThan(0)

    // Second attempt: the acknowledgement gets through this time.
    network.dropAckRate = 0
    await runRetries()

    expect(engine.getState().queued).toEqual([])
    expect(docsOf(server.claim).filter((d) => d.name === 'lost-ack.jpg')).toHaveLength(1)
  })

  it('counts attempts and keeps the edit while the phone has no signal', async () => {
    const { engine, network } = await harness()
    network.online = false
    await engine.addDocument(ITEM, { name: 'basement.jpg', amountPaise: 700 })
    await engine.sync()

    const [entry] = engine.getState().queued
    expect(entry.attempts).toBe(1)
    expect(entry.lastError).toBe('No signal')
  })
})

describe('refusals', () => {
  it('refuses an impossible edit at the tap, without queueing it', async () => {
    const { engine } = await harness()
    const refusal = await engine.setAmount(ITEM, DOC, 9_00_000_00)
    expect(refusal).toContain('cannot exceed the final bill')
    expect(engine.getState().queued).toEqual([])
  })

  it('rolls a stale edit back off the sheet when the server refuses it', async () => {
    // The honest case: this phone was offline and typed an amount for a
    // receipt that another family member has since deleted. Nothing local
    // could have caught it.
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    a.network.online = false
    a.engine.setOnline(false)
    await a.engine.setAmount(ITEM, DOC, 5_000_00)
    expect(docsOf(a.engine.getState().claim).find((d) => d.id === DOC)!.amountPaise).toBe(
      5_000_00,
    )

    await b.engine.removeDocument(ITEM, DOC)
    await b.engine.sync()

    a.network.online = true
    a.engine.setOnline(true)
    await a.engine.sync()

    const state = a.engine.getState()
    expect(state.queued).toEqual([])
    expect(state.rejections).toHaveLength(1)
    expect(state.rejections[0].reason).toContain('no longer on this claim')
    // Rolled back: the edit is gone, and so is the receipt it was about.
    expect(docsOf(state.claim).some((d) => d.id === DOC)).toBe(false)
    expect(uploadedTotal(state.claim)).toBe(uploadedTotal(demoClaim) - 11_200_00)
  })

  it('does not let a refused edit block the edits behind it', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    a.network.online = false
    a.engine.setOnline(false)
    await a.engine.setAmount(ITEM, DOC, 5_000_00)
    await a.engine.addDocument(ITEM, { name: 'good.jpg', amountPaise: 300 })

    await b.engine.removeDocument(ITEM, DOC)
    await b.engine.sync()

    a.network.online = true
    a.engine.setOnline(true)
    await a.engine.sync()

    expect(a.engine.getState().queued).toEqual([])
    expect(docsOf(a.engine.getState().claim).some((d) => d.name === 'good.jpg')).toBe(true)
  })

  it('lets the family dismiss the rollback notice', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })
    a.network.online = false
    a.engine.setOnline(false)
    await a.engine.setAmount(ITEM, DOC, 5_000_00)
    await b.engine.removeDocument(ITEM, DOC)
    await b.engine.sync()
    a.network.online = true
    a.engine.setOnline(true)
    await a.engine.sync()

    const [rejection] = a.engine.getState().rejections
    a.engine.dismissRejection(rejection.op.id)
    expect(a.engine.getState().rejections).toEqual([])
  })
})

describe('two family members, two phones', () => {
  it('converges on the same sheet after both reconnect', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    for (const h of [a, b]) {
      h.network.online = false
      h.engine.setOnline(false)
    }
    await a.engine.addDocument(ITEM, { name: 'madhura.jpg', amountPaise: 1_000_00 })
    await b.engine.addDocument(ITEM, { name: 'anand.jpg', amountPaise: 2_000_00 })

    for (const h of [a, b]) {
      h.network.online = true
      h.engine.setOnline(true)
    }
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()

    expect(a.engine.getState().claim).toEqual(b.engine.getState().claim)
    // Two uploads are two documents. Nothing to resolve.
    expect(a.engine.getState().conflicts).toEqual([])
    expect(uploadedTotal(a.engine.getState().claim)).toBe(
      uploadedTotal(demoClaim) + 3_000_00,
    )
  })

  it('reports it, on both phones, when they tick the same item differently', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    for (const h of [a, b]) {
      h.network.online = false
      h.engine.setOnline(false)
    }
    await a.engine.setItemDone('i8', true)
    await b.engine.setItemDone('i8', false)

    for (const h of [a, b]) {
      h.network.online = true
      h.engine.setOnline(true)
    }
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()

    const [conflictA] = a.engine.getState().conflicts
    const [conflictB] = b.engine.getState().conflicts
    expect(conflictA).toBeDefined()
    expect(conflictA.register).toBe('done:i8')
    // Same winner on both phones: that is the whole point of the ordering.
    expect(conflictB.winner.id).toBe(conflictA.winner.id)
    expect(a.engine.getState().claim).toEqual(b.engine.getState().claim)
  })

  it('clears the disagreement on both phones once one of them chooses', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    for (const h of [a, b]) {
      h.network.online = false
      h.engine.setOnline(false)
    }
    await a.engine.setAmount(ITEM, DOC, 11_200_00)
    await b.engine.setAmount(ITEM, DOC, 11_250_00)
    for (const h of [a, b]) {
      h.network.online = true
      h.engine.setOnline(true)
    }
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()

    const conflict = a.engine.getState().conflicts[0]
    expect(conflict).toBeDefined()
    await a.engine.resolveConflict(conflict, 'mine')
    await a.engine.sync()
    await b.engine.sync()

    expect(a.engine.getState().conflicts).toEqual([])
    expect(b.engine.getState().conflicts).toEqual([])
    const amount = (h: Harness) =>
      docsOf(h.engine.getState().claim).find((d) => d.id === DOC)!.amountPaise
    expect(amount(a)).toBe(11_200_00)
    expect(amount(b)).toBe(11_200_00)
  })

  it('does not call it a conflict when the second edit saw the first', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })

    await a.engine.setAmount(ITEM, DOC, 11_200_00)
    await a.engine.sync()
    await b.engine.sync() // Anand now has Madhura's figure on screen
    await b.engine.setAmount(ITEM, DOC, 11_250_00)
    await b.engine.sync()
    await a.engine.sync()

    expect(a.engine.getState().conflicts).toEqual([])
    expect(docsOf(a.engine.getState().claim).find((d) => d.id === DOC)!.amountPaise).toBe(
      11_250_00,
    )
  })
})

describe('bookkeeping', () => {
  it('tells the subscriber about every change, and nothing else', async () => {
    const { engine } = await harness()
    let notifications = 0
    engine.subscribe(() => notifications++)

    const before = engine.getState()
    expect(engine.getState()).toBe(before) // identity is stable between changes

    await engine.setItemDone('i8', true)
    expect(notifications).toBeGreaterThan(0)
    expect(engine.getState()).not.toBe(before)
  })

  it('keeps numbering this device ops after a reload', async () => {
    // Restarting the counter would mint an id the server has already
    // acknowledged, and the duplicate check would swallow a real edit.
    const store = new IdbClaimStore(`claimkit-counter-${Math.random()}`)
    const server = new DemoServer(demoClaim)
    const first = await harness({ store, server, offline: true })
    await first.engine.addDocument(ITEM, { name: 'one.jpg', amountPaise: 100 })
    await first.engine.addDocument(ITEM, { name: 'two.jpg', amountPaise: 100 })

    const second = await harness({ store, server, offline: true })
    await second.engine.addDocument(ITEM, { name: 'three.jpg', amountPaise: 100 })

    const ids = second.engine.getState().queued.map((e) => e.op.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toContain('phone-a:3')
  })

  it('folds agreed history into the snapshot but keeps a disagreement whole', async () => {
    const server = new DemoServer(demoClaim)
    const a = await harness({ server, device: { id: 'phone-a', name: 'Madhura' } })
    await a.engine.setItemDone('i8', true)
    await a.engine.sync()
    // Nothing in dispute, so the log is compacted away.
    expect((await a.store.loadSnapshot())!.ops).toEqual([])

    const b = await harness({ server, device: { id: 'phone-b', name: 'Anand' } })
    for (const h of [a, b]) {
      h.network.online = false
      h.engine.setOnline(false)
    }
    await a.engine.setAmount(ITEM, DOC, 11_200_00)
    await b.engine.setAmount(ITEM, DOC, 11_250_00)
    for (const h of [a, b]) {
      h.network.online = true
      h.engine.setOnline(true)
    }
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()

    // Both figures are still on disk, because a human has to choose.
    const stored = (await a.store.loadSnapshot())!
    expect(stored.ops.filter((o) => o.body.type === 'set_amount')).toHaveLength(2)
  })
})
