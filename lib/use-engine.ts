'use client'

import { useEffect, useSyncExternalStore } from 'react'
import type { EngineState, SyncEngine } from './engine'

/**
 * The entire React binding: the engine is already a store, so there is no
 * reducer, no context-held copy of the claim, and no effect that syncs
 * state into state. `getState` returns the same object until something
 * really changes, which is what keeps this from re-rendering on every
 * poll.
 */
export function useEngineState(engine: SyncEngine): EngineState {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState)
}

/**
 * Tell the engine what the browser thinks of the network.
 *
 * `navigator.onLine` is weaker than it looks -- it reports a usable
 * interface, not a reachable server, so it is a hint that saves pointless
 * radio rather than the source of truth. A failed request is the real
 * signal, and the engine treats it that way.
 */
export function useBrowserConnection(engine: SyncEngine, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const update = () => engine.setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [engine, enabled])
}
