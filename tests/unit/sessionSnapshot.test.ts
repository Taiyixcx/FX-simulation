import { describe, expect, it } from 'vitest'
import { closePosition, openPosition } from '../../src/engine/execution'
import { advanceSimulation } from '../../src/engine/simulationSource'
import { validateSessionSnapshot } from '../../src/storage/sessionSnapshot'
import { extendSession, makeSession } from './sessionFixture'

describe('session snapshot validation', () => {
  it('restores decimal strings, closed trades, an open position and the exact next random frame', () => {
    let snapshot = makeSession()
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'trade-1')
    snapshot = extendSession(snapshot, 4)
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot.account = openPosition(closed.account, snapshot.frames.at(-1)!.quote, snapshot.pair, 'short', '500', 'trade-2')
    snapshot.trades = [closed.trade]
    const restored = validateSessionSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown)
    expect(restored).toEqual(snapshot)
    expect(advanceSimulation(restored.sourceState)).toEqual(advanceSimulation(snapshot.sourceState))
    expect(typeof restored.account.position?.quantityBaseUnits).toBe('string')
  })

  it.each([
    ['unsupported version', (snapshot: Record<string, unknown>) => { snapshot.schemaVersion = 2 }],
    ['numeric balance', (snapshot: Record<string, unknown>) => { snapshot.account = { balanceUsd: 10000, position: null } }],
    ['negative equity fabrication', (snapshot: Record<string, unknown>) => { snapshot.account = { balanceUsd: '-1.00', position: null } }],
    ['missing frames', (snapshot: Record<string, unknown>) => { snapshot.frames = [] }],
    ['wrong pair', (snapshot: Record<string, unknown>) => { snapshot.pair = 'GBP/USD' }],
    ['missing trades', (snapshot: Record<string, unknown>) => { snapshot.trades = null }],
    ['invalid revision', (snapshot: Record<string, unknown>) => { snapshot.revision = -1 }],
  ])('rejects %s', (_name, mutate) => {
    const snapshot = structuredClone(makeSession()) as unknown as Record<string, unknown>
    mutate(snapshot)
    expect(() => validateSessionSnapshot(snapshot)).toThrow()
  })

  it('rejects changed OHLC, timestamps, visible progress and random state', () => {
    const snapshot = extendSession(makeSession(), 3)
    for (const mutate of [
      (copy: typeof snapshot) => { copy.frames[1]!.highPrice = '2' },
      (copy: typeof snapshot) => { copy.frames[1]!.quote.timestampMs += 60_000 },
      (copy: typeof snapshot) => { copy.frames.pop() },
      (copy: typeof snapshot) => { copy.sourceState.randomState += 1 },
      (copy: typeof snapshot) => { copy.sourceState.currentBidPrice = '1.23456' },
    ]) {
      const copy = structuredClone(snapshot)
      mutate(copy)
      expect(() => validateSessionSnapshot(copy)).toThrow()
    }
  })

  it('rejects incorrect direction, quantity, fill, PnL, ledger balance and duplicate trade identities', () => {
    let snapshot = makeSession()
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'short', '1000', 'trade-1')
    snapshot = extendSession(snapshot, 3)
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot.account = closed.account
    snapshot.trades = [closed.trade]
    const mutations: Array<(copy: typeof snapshot) => void> = [
      (copy) => { Object.assign(copy.trades[0]!, { direction: 'sideways' }) },
      (copy) => { copy.trades[0]!.quantityBaseUnits = '10' },
      (copy) => { copy.trades[0]!.entryPrice = '2' },
      (copy) => { copy.trades[0]!.exitPrice = '2' },
      (copy) => { copy.trades[0]!.realizedPnlUsd = '999' },
      (copy) => { copy.account.balanceUsd = '1234' },
      (copy) => { copy.trades.push({ ...copy.trades[0]! }) },
      (copy) => { copy.trades[0]!.openedAtMs = copy.frames.at(-1)!.quote.timestampMs + 60_000 },
      (copy) => { copy.trades[0]!.reason = 'equity-depleted' },
    ]
    for (const mutate of mutations) {
      const copy = structuredClone(snapshot)
      mutate(copy)
      expect(() => validateSessionSnapshot(copy)).toThrow()
    }
  })
})
