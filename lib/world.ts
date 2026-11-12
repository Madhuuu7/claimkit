import type { Claim } from './claim'
import { SyncEngine } from './engine'
import { createStore } from './outbox'
import { DemoServer, SimulatedNetwork } from './server'

/**
 * Wires up one claim, one server and a phone per family member.
 *
 * Each phone gets its own IndexedDB database and its own network, because
 * that is what makes the demonstration honest: switching Madhura's signal
 * off has to leave Anand's phone working, and reloading the page has to
 * find each queue where its own device left it.
 *
 * The server's log is stored too. It is the one piece that does not exist
 * on a phone, and without it a reload would hand the family a fresh
 * server while their devices still held everything they had done -- two
 * halves of a shared claim disagreeing about what happened.
 */

export type Device = {
  id: string
  name: string
  engine: SyncEngine
  network: SimulatedNetwork
  durable: boolean
}

export type World = {
  server: DemoServer
  devices: Device[]
  /** Restore the server, then read each outbox off disk. */
  open: () => Promise<void>
  /** Throw the whole demonstration away and start from the fixture. */
  reset: () => Promise<void>
}

const SERVER_DB = 'claimkit-server'

export function createWorld(
  base: Claim,
  members: readonly { id: string; name: string }[],
  options: { latencyMs?: number; pollMs?: number } = {},
): World {
  const { store: serverStore } = createStore(SERVER_DB)
  // Written on every accepted op. Fire and forget: losing the last write
  // of the demonstration server is not worth blocking a request on, and
  // the phones' own queues are the durable half.
  const server = new DemoServer(base, (ops) => {
    void serverStore.saveSnapshot({ claim: base, ops: [...ops], seq: ops.length })
  })

  const devices = members.map(({ id, name }) => {
    // A realistic round trip. Instant sync would hide the whole point:
    // the sheet updates on the tap, not when the server answers.
    const network = new SimulatedNetwork(server, { latencyMs: options.latencyMs ?? 450 })
    const { store, durable } = createStore(`claimkit-${id}`)
    const engine = new SyncEngine({
      base,
      store,
      transport: network,
      device: { id, name },
      durable,
      // Short, because a visitor flipping switches should see the other
      // phone catch up while they watch.
      pollMs: options.pollMs ?? 2_500,
    })
    return { id, name, engine, network, durable }
  })

  return {
    server,
    devices,
    open: async () => {
      const stored = await serverStore.loadSnapshot()
      // Before any client syncs, or a phone would pull an empty log and
      // then be told its own history is new.
      if (stored) server.restore(stored.ops)
      await Promise.all(devices.map((d) => d.engine.start()))
    },
    reset: async () => {
      await Promise.all(
        [SERVER_DB, ...members.map((m) => `claimkit-${m.id}`)].map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name)
              request.onsuccess = () => resolve()
              // A database another tab still holds open cannot be
              // deleted. Reloading is what the caller does next anyway.
              request.onerror = () => resolve()
              request.onblocked = () => resolve()
            }),
        ),
      )
    },
  }
}
