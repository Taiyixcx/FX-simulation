import { advanceSimulation, createSimulation } from '../../src/engine/simulationSource'
import type { AccountState, CurrencyPair, MarketFrame, SimulationScenario, TradeRecord } from '../../src/engine/types'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'
import { createSimulationConfig, SESSION_FRAME_WINDOW_SIZE } from '../../src/storage/sessionSnapshot'

export function makeSession(pair: CurrencyPair = 'EUR/USD', maxFrames: number | null = 30, scenario: SimulationScenario = 'standard', startTimestampMs?: number): SessionSnapshot {
  const simulation = createSimulation(pair, 7654321, { maxFrames, scenario, startTimestampMs })
  return {
    schemaVersion: 3,
    id: 'session-test',
    revision: 0,
    pair,
    simulationConfig: createSimulationConfig(simulation.state),
    retainedPrefixKind: null,
    sourceState: simulation.state,
    frameStartIndex: 0,
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
  const recent = frames.slice(-SESSION_FRAME_WINDOW_SIZE)
  return { ...snapshot, revision: snapshot.revision + 1, sourceState: state, frameStartIndex: state.frameIndex + 1 - recent.length, frames: recent }
}

/** A fixed saved version-1 practice; no obsolete generator is retained in tests. */
export function makeLegacySession() {
  const frames: MarketFrame[] = [
    { quote: { timestampMs: 1709510460000, bidPrice: '1.08509', askPrice: '1.08519', askSource: 'training' }, openPrice: '1.085', highPrice: '1.08509', lowPrice: '1.085', closePrice: '1.08509' },
    { quote: { timestampMs: 1709510520000, bidPrice: '1.08519', askPrice: '1.08529', askSource: 'training' }, openPrice: '1.08509', highPrice: '1.08521', lowPrice: '1.08509', closePrice: '1.08519' },
    { quote: { timestampMs: 1709510580000, bidPrice: '1.08525', askPrice: '1.08535', askSource: 'training' }, openPrice: '1.08519', highPrice: '1.08525', lowPrice: '1.08519', closePrice: '1.08525' },
    { quote: { timestampMs: 1709510640000, bidPrice: '1.08532', askPrice: '1.08542', askSource: 'training' }, openPrice: '1.08525', highPrice: '1.08532', lowPrice: '1.08525', closePrice: '1.08532' },
  ]
  const account: AccountState = {
    balanceUsd: '10000.06',
    position: {
      id: 'legacy-open', pair: 'EUR/USD', direction: 'short', notionalUsd: '500',
      quantityBaseUnits: '460.6936203147458813990343861718202926326',
      entryPrice: '1.08532', openedAtMs: 1709510640000,
    },
  }
  const trades: TradeRecord[] = [{
    id: 'legacy-closed', pair: 'EUR/USD', direction: 'long', notionalUsd: '1000',
    quantityBaseUnits: '921.4976179286576544199633243948064394254',
    entryPrice: '1.08519', openedAtMs: 1709510460000,
    closedAtMs: 1709510580000, exitPrice: '1.08525', realizedPnlUsd: '0.06', reason: 'manual',
  }]
  return {
    schemaVersion: 1 as const,
    id: 'legacy-session', revision: 6, pair: 'EUR/USD' as const,
    sourceState: {
      version: 1 as const, pair: 'EUR/USD' as const, seed: 7, randomState: 3518474805,
      frameIndex: 3, startTimestampMs: 1709510460000, maxFrames: 30, currentBidPrice: '1.08532',
    },
    frames, account, trades,
  }
}
