import { advanceSimulation, createSimulation } from '../../src/engine/simulationSource'
import type { CurrencyPair } from '../../src/engine/types'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'

export function makeSession(pair: CurrencyPair = 'EUR/USD', maxFrames = 30): SessionSnapshot {
  const simulation = createSimulation(pair, 7654321, { maxFrames })
  return {
    schemaVersion: 1,
    id: 'session-test',
    revision: 0,
    pair,
    sourceState: simulation.state,
    frames: [simulation.frame],
    account: { balanceUsd: '10000.00', position: null },
    trades: [],
  }
}

export function extendSession(snapshot: SessionSnapshot, count = 1): SessionSnapshot {
  let state = snapshot.sourceState
  const frames = [...snapshot.frames]
  for (let index = 0; index < count; index += 1) {
    const next = advanceSimulation(state)
    if (!next) throw new Error('fixture exhausted')
    state = next.state
    frames.push(next.frame)
  }
  return { ...snapshot, revision: snapshot.revision + 1, sourceState: state, frames }
}
