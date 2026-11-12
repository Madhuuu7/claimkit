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
 */

export type Device = {
  id: string
  name: string
  engine: SyncEngine
  network: SimulatedNetwork
  durable: boolean
}

export type World = { server: DemoServer; devices: Device[] }

export function createWorld(
  base: Claim,
  members: readonly { id: string; name: string }[],
  options: { latencyMs?: number } = {},
): World {
  const server = new DemoServer(base)

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
    })
    return { id, name, engine, network, durable }
  })

  return { server, devices }
}
