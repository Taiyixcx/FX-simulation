import { describe, expect, it } from 'vitest'
import { closePosition, openPosition } from '../../src/engine/execution'
import { advanceSimulation } from '../../src/engine/simulationSource'
import { validateSessionSnapshot } from '../../src/storage/sessionSnapshot'
import { extendSession, makeLegacySession, makeSession } from './sessionFixture'

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
    ['unsupported version', (snapshot: Record<string, unknown>) => { snapshot.schemaVersion = 3 }],
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

  it('migrates a fixed old history and ledger without generating or rewriting any retained minute', () => {
    const legacy = makeLegacySession()
    const original = structuredClone(legacy)
    const migrated = validateSessionSnapshot(legacy)
    expect(legacy).toEqual(original)
    expect(migrated).toMatchObject({ schemaVersion: 2, id: legacy.id, revision: legacy.revision, frames: legacy.frames, account: legacy.account, trades: legacy.trades })
    expect(migrated.sourceState).toMatchObject({ version: 2, scenario: 'standard', originFrameIndex: 4, frameIndex: 3, initialBidPrice: '1.08532', initialAskPrice: '1.08542', initialTimestampMs: 1709510640000 })
    const advanced = extendSession(migrated, 3)
    const restored = validateSessionSnapshot(JSON.parse(JSON.stringify(advanced)) as unknown)
    expect(restored).toEqual(advanced)
    expect(restored.frames.slice(0, 4)).toEqual(legacy.frames)
    expect(advanceSimulation(restored.sourceState)).toEqual(advanceSimulation(advanced.sourceState))
  })

  it('preserves a completed old history with no additional frame available', () => {
    const legacy = makeLegacySession()
    legacy.sourceState.maxFrames = legacy.frames.length
    const migrated = validateSessionSnapshot(legacy)
    expect(migrated.frames).toEqual(legacy.frames)
    expect(migrated.sourceState.originFrameIndex).toBe(4)
    expect(advanceSimulation(migrated.sourceState)).toBeNull()
    expect(validateSessionSnapshot(migrated)).toEqual(migrated)
  })

  it('rejects damaged old history, quotes, source progress and ledger before migration', () => {
    const original = makeLegacySession()
    for (const mutate of [
      (copy: typeof original) => { copy.frames[1]!.quote.timestampMs += 60_000 },
      (copy: typeof original) => { copy.frames[1]!.lowPrice = '2' },
      (copy: typeof original) => { copy.frames[1]!.openPrice = '1.08' },
      (copy: typeof original) => { copy.frames[1]!.quote.askPrice = copy.frames[1]!.quote.bidPrice },
      (copy: typeof original) => { copy.sourceState.randomState = 0 },
      (copy: typeof original) => { copy.sourceState.currentBidPrice = '1.2' },
      (copy: typeof original) => { copy.sourceState.frameIndex = 4 },
      (copy: typeof original) => { copy.account.balanceUsd = '9999' },
      (copy: typeof original) => { copy.trades[0]!.realizedPnlUsd = '1' },
    ]) {
      const damaged = structuredClone(original)
      mutate(damaged)
      expect(() => validateSessionSnapshot(damaged)).toThrow()
    }
    expect(original).toEqual(makeLegacySession())
  })

  it('rejects every changed V2 factor, configuration, anchor, future schedule and published event', () => {
    let snapshot = makeSession('EUR/USD', 1440, 'eventful', Date.UTC(2024, 2, 4, 7, 55))
    while (!snapshot.sourceState.lastEvent || !snapshot.sourceState.upcomingScheduledEvent) {
      if (!advanceSimulation(snapshot.sourceState)) throw new Error('eventful fixture did not produce a published event and future schedule')
      snapshot = extendSession(snapshot)
    }
    const numericFields = [
      'randomState', 'eventRandomState', 'scheduleRandomState', 'slowLogVariance', 'fastLogVariance',
      'liquidityPressure', 'eventVariance', 'temporaryDislocationLog', 'economicContext', 'policySensitivity',
      'originFrameIndex', 'initialTimestampMs', 'currentTimestampMs', 'seed', 'maxFrames', 'startTimestampMs',
    ] as const
    for (const field of numericFields) {
      const copy = structuredClone(snapshot)
      copy.sourceState[field] += field.includes('TimestampMs') ? 60_000 : 1
      expect(() => validateSessionSnapshot(copy), field).toThrow()
    }
    const mutations: Array<(copy: typeof snapshot) => void> = [
      (copy) => { copy.sourceState.scenario = 'standard' },
      (copy) => { copy.sourceState.initialBidPrice = '1.2' },
      (copy) => { copy.sourceState.initialAskPrice = '1.2001' },
      (copy) => { copy.sourceState.lastEvent!.detail += '篡改' },
      (copy) => { copy.sourceState.lastEvent!.surprise += 0.1 },
      (copy) => { copy.sourceState.lastEvent = null },
      (copy) => { copy.sourceState.upcomingScheduledEvent = null },
      (copy) => { copy.sourceState.upcomingScheduledEvent!.label += '篡改' },
      (copy) => { copy.sourceState.upcomingScheduledEvent!.expected += '篡改' },
      (copy) => { copy.simulationConfig.maxFrames += 1 },
      (copy) => { copy.simulationConfig.scenario = 'standard' },
      (copy) => { Object.assign(copy.sourceState, { parameterVersion: 2 }) },
      (copy) => { Object.assign(copy.sourceState, { futureOutcome: 'fake' }) },
    ]
    for (const mutate of mutations) {
      const copy = structuredClone(snapshot)
      mutate(copy)
      expect(() => validateSessionSnapshot(copy)).toThrow()
    }
  })
})
