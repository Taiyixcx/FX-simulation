import { describe, expect, it, vi } from 'vitest'
import { closePosition, openPosition, settleDepletedAccount } from '../../src/engine/execution'
import { advanceSimulation, createSimulation } from '../../src/engine/simulationSource'
import * as simulationSource from '../../src/engine/simulationSource'
import { createSimulationConfig, createSessionHistoryValidator, validateSessionSnapshot, validateSessionTransition } from '../../src/storage/sessionSnapshot'
import { extendSession, makeLegacySession, makeSession } from './sessionFixture'

function makeDepletedLegacySession() {
  const legacy = makeLegacySession()
  const startTimestampMs = legacy.sourceState.startTimestampMs
  legacy.frames = ['1', '2.1'].map((closePrice, index) => ({
    quote: { timestampMs: startTimestampMs + index * 60_000, bidPrice: closePrice, askPrice: index === 0 ? '1.0001' : '2.1001', askSource: 'training' as const },
    openPrice: '1', highPrice: closePrice, lowPrice: '1', closePrice,
  }))
  const opened = openPosition({ balanceUsd: '10000', position: null }, legacy.frames[0]!.quote, legacy.pair, 'short', '10000', 'depleted-trade')
  const closed = settleDepletedAccount(opened, legacy.frames[1]!.quote)!
  legacy.account = closed.account
  legacy.trades = [closed.trade]
  legacy.sourceState.frameIndex = 1
  legacy.sourceState.currentBidPrice = '2.1'
  return legacy
}

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
    ['unsupported version', (snapshot: Record<string, unknown>) => { snapshot.schemaVersion = 99 }],
    ['numeric balance', (snapshot: Record<string, unknown>) => { snapshot.account = { balanceUsd: 10000, position: null } }],
    ['negative equity fabrication', (snapshot: Record<string, unknown>) => { snapshot.account = { balanceUsd: '-1.00', position: null } }],
    ['missing frames', (snapshot: Record<string, unknown>) => { snapshot.frames = [] }],
    ['wrong pair', (snapshot: Record<string, unknown>) => { snapshot.pair = 'GBP/USD' }],
    ['missing trades', (snapshot: Record<string, unknown>) => { snapshot.trades = null }],
    ['invalid revision', (snapshot: Record<string, unknown>) => { snapshot.revision = -1 }],
    ['missing retained prefix kind', (snapshot: Record<string, unknown>) => { delete snapshot.retainedPrefixKind }],
    ['unknown retained prefix kind', (snapshot: Record<string, unknown>) => { snapshot.retainedPrefixKind = 'unknown' }],
    ['prefix kind without retained history', (snapshot: Record<string, unknown>) => { snapshot.retainedPrefixKind = 'legacy-v1' }],
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
    expect(migrated).toMatchObject({ schemaVersion: 3, retainedPrefixKind: 'legacy-v1', id: legacy.id, revision: legacy.revision, frames: legacy.frames, account: legacy.account, trades: legacy.trades })
    expect(migrated.sourceState).toMatchObject({ version: 2, scenario: 'standard', originFrameIndex: 4, frameIndex: 3, initialBidPrice: '1.08532', initialAskPrice: '1.08542', initialTimestampMs: 1709510640000 })
    const advanced = extendSession(migrated, 3)
    const restored = validateSessionSnapshot(JSON.parse(JSON.stringify(advanced)) as unknown)
    expect(restored).toEqual(advanced)
    expect(restored.frames.slice(0, 4)).toEqual(legacy.frames)
    expect(advanceSimulation(restored.sourceState)).toEqual(advanceSimulation(advanced.sourceState))
  })

  it('preserves a completed old history and continues with the current model', () => {
    const legacy = makeLegacySession()
    legacy.sourceState.maxFrames = legacy.frames.length
    const migrated = validateSessionSnapshot(legacy)
    expect(migrated.frames).toEqual(legacy.frames)
    expect(migrated.sourceState.originFrameIndex).toBe(4)
    expect(advanceSimulation(migrated.sourceState)).not.toBeNull()
    expect(validateSessionSnapshot(migrated)).toEqual(migrated)
  })

  it('keeps V1 prefix time, spread and opening continuity checks after migration and rejects changing its kind', () => {
    const legacy = makeLegacySession()
    legacy.account = { balanceUsd: '10000', position: null }
    legacy.trades = []
    const migrated = validateSessionSnapshot(legacy)
    const advanced = extendSession(migrated, 2)
    for (const mutate of [
      (copy: typeof advanced) => { copy.frames[0]!.quote.timestampMs -= 60_000 },
      (copy: typeof advanced) => { copy.frames[1]!.quote.askPrice = '1.08539' },
      (copy: typeof advanced) => { copy.frames[1]!.openPrice = '1.08490'; copy.frames[1]!.lowPrice = '1.08490' },
      (copy: typeof advanced) => { copy.retainedPrefixKind = null },
    ]) {
      const copy = structuredClone(advanced)
      mutate(copy)
      expect(() => validateSessionSnapshot(copy)).toThrow()
    }
    const changedKind = { ...advanced, retainedPrefixKind: 'legacy-v2' as const }
    expect(() => validateSessionTransition(migrated, changedKind)).toThrow('不可原地改变')
    expect(validateSessionSnapshot(advanced)).toEqual(advanced)
  })

  it('validates archived V1 prefix continuity after the prefix leaves the rolling window', () => {
    let snapshot = validateSessionSnapshot(makeLegacySession())
    const history = [...snapshot.frames]
    for (let index = 0; index < 1440; index += 1) {
      snapshot = extendSession(snapshot)
      history.push(snapshot.frames.at(-1)!)
    }
    expect(snapshot.frameStartIndex).toBe(4)
    const validator = createSessionHistoryValidator(snapshot)
    history.forEach(frame => validator.pushFrame(frame))
    expect(validator.finish()).toEqual(snapshot)
    const corrupted = createSessionHistoryValidator(snapshot)
    corrupted.pushFrame(history[0])
    const broken = structuredClone(history[1]!)
    broken.openPrice = '1.08490'
    broken.lowPrice = '1.08490'
    expect(() => corrupted.pushFrame(broken)).toThrow('保留行情开盘价')
  })

  it('labels a prior V2 history separately and resumes it from the saved quote', () => {
    const old = extendSession(makeSession(), 2)
    const migrated = validateSessionSnapshot({ ...old, schemaVersion: 2 })
    expect(migrated.retainedPrefixKind).toBe('legacy-v2')
    expect(migrated.frames).toEqual(old.frames)
    expect(migrated.sourceState.originFrameIndex).toBe(old.frames.length)
    expect(validateSessionSnapshot(migrated)).toEqual(migrated)
  })

  it('accepts the exact depletion stop and rejects later history or a later incremental quote', () => {
    const legacy = makeDepletedLegacySession()
    const migrated = validateSessionSnapshot(legacy)
    expect(migrated.account.balanceUsd).toBe('-1001.00')
    expect(migrated.trades[0]!.reason).toBe('equity-depleted')
    expect(validateSessionSnapshot(migrated)).toEqual(migrated)
    expect(validateSessionTransition(migrated, { ...migrated, revision: migrated.revision + 1 })).toMatchObject({ account: migrated.account })
    const next = extendSession(migrated)
    expect(() => validateSessionSnapshot(next)).toThrow('资金耗尽后不可继续推进行情')
    expect(() => validateSessionTransition(migrated, next)).toThrow('资金耗尽后不可继续推进行情')
    const continuedLegacy = structuredClone(legacy)
    continuedLegacy.frames.push({ ...continuedLegacy.frames[1]!, quote: { ...continuedLegacy.frames[1]!.quote, timestampMs: continuedLegacy.frames[1]!.quote.timestampMs + 60_000 }, openPrice: '2.1', lowPrice: '2.1' })
    continuedLegacy.sourceState.frameIndex += 1
    expect(() => validateSessionSnapshot(continuedLegacy)).toThrow('资金耗尽后不可继续推进行情')
  })

  it('stops after a manual close with depleted funds at the current checkpoint', () => {
    const old = makeSession()
    old.frames[0]!.quote.askPrice = '2.3'
    old.sourceState.currentAskPrice = '2.3'
    old.account = openPosition(old.account, old.frames[0]!.quote, old.pair, 'short', '10000', 'manual-depleted')
    const previous = validateSessionSnapshot({ ...old, schemaVersion: 2 })
    const closed = closePosition(previous.account, previous.frames.at(-1)!.quote)
    expect(Number(closed.account.balanceUsd)).toBeLessThan(0)
    const stopped = { ...previous, revision: previous.revision + 1, account: closed.account, trades: [closed.trade] }
    expect(validateSessionTransition(previous, stopped)).toEqual(stopped)
    expect(validateSessionSnapshot(stopped)).toEqual(stopped)
    const continued = extendSession(stopped)
    expect(() => validateSessionTransition(previous, { ...continued, revision: previous.revision + 1 })).toThrow('资金耗尽后不可继续推进行情')
    expect(() => validateSessionTransition(stopped, continued)).toThrow('资金耗尽后不可继续推进行情')
    expect(() => validateSessionSnapshot(continued)).toThrow('资金耗尽后不可继续推进行情')
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
      (copy) => { copy.simulationConfig.maxFrames = (copy.simulationConfig.maxFrames ?? 0) + 1 },
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

  it('reuses generated steps across growing and shorter prefixes while checking all supplied history and state', () => {
    const shorter = extendSession(makeSession('EUR/USD', 60, 'standard', Date.UTC(2024, 2, 5, 0, 1)), 4)
    const longer = extendSession(shorter, 8)
    const advance = vi.spyOn(simulationSource, 'advanceSimulation')
    expect(validateSessionSnapshot(shorter)).toEqual(shorter)
    expect(advance).toHaveBeenCalledTimes(shorter.frames.length)
    advance.mockClear()
    expect(validateSessionSnapshot(longer)).toEqual(longer)
    expect(advance).toHaveBeenCalledTimes(longer.frames.length - shorter.frames.length)
    advance.mockClear()
    expect(validateSessionSnapshot(shorter)).toEqual(shorter)
    expect(validateSessionSnapshot(longer)).toEqual(longer)
    const changedHistory = structuredClone(longer)
    changedHistory.frames[1]!.highPrice = '2'
    expect(() => validateSessionSnapshot(changedHistory)).toThrow()
    const changedState = structuredClone(longer)
    changedState.sourceState.fastLogVariance += 0.1
    expect(() => validateSessionSnapshot(changedState)).toThrow()
    expect(advance).not.toHaveBeenCalled()
  })

  it('isolates cached generation from mutations of both input and returned state, events, config and frames', () => {
    let original = makeSession('EUR/USD', 1440, 'eventful', Date.UTC(2024, 2, 6, 7, 55))
    while (!original.sourceState.lastEvent || !original.sourceState.upcomingScheduledEvent) {
      if (!advanceSimulation(original.sourceState)) throw new Error('eventful fixture did not produce a published event and future schedule')
      original = extendSession(original)
    }
    const input = structuredClone(original)
    const restored = validateSessionSnapshot(input)
    restored.sourceState.randomState = 1
    restored.sourceState.lastEvent!.detail = 'changed returned event'
    restored.sourceState.upcomingScheduledEvent!.expected = 'changed returned schedule'
    restored.simulationConfig.initialBidPrice = '2'
    restored.frames[0]!.highPrice = '2'
    input.sourceState.lastEvent!.label = 'changed caller event'
    input.sourceState.upcomingScheduledEvent!.label = 'changed caller schedule'
    expect(() => validateSessionSnapshot(input)).toThrow()
    expect(validateSessionSnapshot(original)).toEqual(original)
    expect(advanceSimulation(validateSessionSnapshot(original).sourceState)).toEqual(advanceSimulation(original.sourceState))
  })

  it('streams a rolling history, verifies archived prices and rejects an incomplete head', () => {
    let snapshot = makeSession('EUR/USD', null)
    const history = [...snapshot.frames]
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'old-position')
    for (let index = 1; index < 3000; index += 1) {
      snapshot = extendSession(snapshot)
      history.push(snapshot.frames.at(-1)!)
    }
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot.account = closed.account
    snapshot.trades = [closed.trade]
    expect(snapshot.frames).toHaveLength(1440)
    expect(snapshot.frameStartIndex).toBe(1560)
    expect(() => validateSessionSnapshot(snapshot)).toThrow('归档')
    const validator = createSessionHistoryValidator(snapshot)
    history.forEach(frame => validator.pushFrame(frame))
    expect(validator.finish()).toEqual(snapshot)
    const altered = createSessionHistoryValidator(snapshot)
    const broken = structuredClone(history[0]!)
    broken.highPrice = '2'
    expect(() => altered.pushFrame(broken)).toThrow()
    const missing = createSessionHistoryValidator(snapshot)
    history.slice(0, -1).forEach(frame => missing.pushFrame(frame))
    expect(() => missing.finish()).toThrow()
  })

  it('validates rolling transitions without rewriting prior prices or source state', () => {
    const previous = extendSession(makeSession('GBP/USD', null), 1439)
    const next = extendSession(previous, 10)
    expect(validateSessionTransition(previous, next)).toEqual(next)
    for (const mutate of [
      (copy: typeof next) => { copy.frames[0]!.highPrice = '2' },
      (copy: typeof next) => { copy.sourceState.randomState += 1 },
      (copy: typeof next) => { copy.account.balanceUsd = '999' },
      (copy: typeof next) => { copy.frameStartIndex += 1 },
    ]) {
      const copy = structuredClone(next)
      mutate(copy)
      expect(() => validateSessionTransition(previous, copy)).toThrow()
    }
    const returned = validateSessionTransition(previous, next)
    returned.frames[0]!.highPrice = '2'
    expect(validateSessionTransition(previous, next)).toEqual(next)
  })

  it('keeps different currency pairs separate even when their entire replay configuration matches', () => {
    const eur = makeSession('EUR/USD', 30, 'standard', Date.UTC(2024, 2, 8, 0, 1))
    const simulation = createSimulation('GBP/USD', eur.sourceState.seed, {
      startTimestampMs: eur.sourceState.startTimestampMs,
      maxFrames: eur.sourceState.maxFrames,
      scenario: eur.sourceState.scenario,
      initialBidPrice: eur.sourceState.initialBidPrice,
      initialAskPrice: eur.sourceState.initialAskPrice,
    })
    const gbp = { ...eur, pair: 'GBP/USD' as const, sourceState: simulation.state, simulationConfig: createSimulationConfig(simulation.state), frames: [simulation.frame] }
    expect(gbp.simulationConfig).toEqual(eur.simulationConfig)
    expect(validateSessionSnapshot(eur)).toEqual(eur)
    expect(validateSessionSnapshot(gbp)).toEqual(gbp)
    expect(validateSessionSnapshot(eur)).toEqual(eur)
  })
})
