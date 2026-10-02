import { describe, expect, it } from 'vitest'
import { MoneyDecimal } from '../../src/engine/decimal'
import {
  advanceSimulation, createSimulation, createSimulationFromQuote,
  initializeSimulation, validateSimulationState,
} from '../../src/engine/simulationSource'
import {
  getLondonOffsetMinutes, getNewYorkOffsetMinutes, getSimulationSeasonality,
  isSimulationMarketOpen, nextSimulationTimestamp,
} from '../../src/engine/simulationParameters'
import type { CurrencyPair, SimulationState } from '../../src/engine/types'

function restoreState(state: SimulationState): SimulationState {
  return JSON.parse(JSON.stringify(state)) as SimulationState
}

describe('version-2 completed-minute simulation', () => {
  it('initializes without generating a frame and supports a finished continuation anchor', () => {
    const initial = initializeSimulation('EUR/USD', 7)
    expect(initial).toMatchObject({
      version: 2, parameterVersion: 1, scenario: 'standard', frameIndex: -1,
      originFrameIndex: 0, currentBidPrice: initial.initialBidPrice,
      currentAskPrice: initial.initialAskPrice, lastEvent: null,
    })
    expect(advanceSimulation(initial)).toEqual(createSimulation('EUR/USD', 7))
    const finished = createSimulationFromQuote('EUR/USD', 7, { maxFrames: 4 }, {
      frameIndex: 3, bidPrice: '1.08', askPrice: '1.0801',
    })
    expect(finished.frameIndex).toBe(3)
    expect(finished.originFrameIndex).toBe(4)
    expect(advanceSimulation(finished)).toBeNull()
  })

  it.each(['EUR/USD', 'GBP/USD'] as CurrencyPair[])('exactly resumes %s prices, factors, schedules and events after JSON persistence', (pair) => {
    let state = initializeSimulation(pair, 7, { scenario: 'eventful', startTimestampMs: Date.UTC(2024, 2, 4, 7, 55), maxFrames: 500 })
    const uninterrupted = initializeSimulation(pair, 7, { scenario: 'eventful', startTimestampMs: Date.UTC(2024, 2, 4, 7, 55), maxFrames: 500 })
    let replayedState = uninterrupted
    for (let index = 0; index < 160; index += 1) {
      const next = advanceSimulation(restoreState(state))!
      const replayed = advanceSimulation(replayedState)!
      expect(next).toEqual(replayed)
      state = next.state
      replayedState = replayed.state
    }
    expect(state.lastEvent).not.toBeNull()
    expect(createSimulation(pair, 8)).not.toEqual(createSimulation(pair, 7))
  })

  it.each(['EUR/USD', 'GBP/USD'] as CurrencyPair[])('produces coherent %s Bid OHLC and simultaneous dynamic Ask', (pair) => {
    let step = createSimulation(pair, 42, { maxFrames: 120 })
    const spreads = new Set<string>()
    for (let index = 0; index < 120; index += 1) {
      const { frame } = step
      expect(frame.quote.askSource).toBe('training')
      expect(frame.quote.bidPrice).toBe(frame.closePrice)
      expect(frame.quote.askPrice).toBe(step.state.currentAskPrice)
      expect(new MoneyDecimal(frame.lowPrice).lte(frame.openPrice)).toBe(true)
      expect(new MoneyDecimal(frame.lowPrice).lte(frame.closePrice)).toBe(true)
      expect(new MoneyDecimal(frame.highPrice).gte(frame.openPrice)).toBe(true)
      expect(new MoneyDecimal(frame.highPrice).gte(frame.closePrice)).toBe(true)
      expect(new MoneyDecimal(frame.lowPrice).gt(0)).toBe(true)
      const spread = new MoneyDecimal(frame.quote.askPrice).minus(frame.quote.bidPrice)
      expect(spread.gt(0)).toBe(true)
      spreads.add(spread.toFixed())
      const next = advanceSimulation(step.state)
      if (next) {
        expect(next.frame.openPrice).toBe(frame.closePrice)
        expect(next.frame.quote.timestampMs - frame.quote.timestampMs).toBe(60_000)
        step = next
      }
    }
    expect(spreads.size).toBeGreaterThan(1)
  })

  it('ends after exactly 1440 completed frames and exposes just one step at a time', () => {
    let step = createSimulation('EUR/USD')
    let count = 1
    while (true) {
      const next = advanceSimulation(step.state)
      if (!next) break
      count += 1
      step = next
    }
    expect(count).toBe(1440)
    expect(step.state.frameIndex).toBe(1439)
    expect(advanceSimulation(step.state)).toBeNull()
  })

  it('supports a single-frame session and seed zero without a stuck RNG', () => {
    const step = createSimulation('EUR/USD', 0, { maxFrames: 1 })
    expect(step.state.seed).toBe(0)
    expect(step.state.randomState).toBeGreaterThan(0)
    expect(advanceSimulation(step.state)).toBeNull()
  })

  it('continues from a supplied historical quote without regenerating its prefix', () => {
    const initial = createSimulationFromQuote('GBP/USD', 11, {
      maxFrames: 30, scenario: 'eventful', startTimestampMs: Date.UTC(2024, 2, 4, 7, 0),
    }, { frameIndex: 19, bidPrice: '1.3', askPrice: '1.3002', timestampMs: Date.UTC(2024, 2, 4, 7, 19) })
    expect(initial).toMatchObject({
      frameIndex: 19, originFrameIndex: 20,
      initialBidPrice: '1.3', initialAskPrice: '1.3002',
      initialTimestampMs: Date.UTC(2024, 2, 4, 7, 19),
    })
    const next = advanceSimulation(initial)!
    expect(next.state.frameIndex).toBe(20)
    expect(next.frame.openPrice).toBe('1.3')
    expect(next.frame.quote.timestampMs).toBe(Date.UTC(2024, 2, 4, 7, 20))
  })

  it('keeps unpublished outcomes absent, commits a scheduled event once, and makes retries identical', () => {
    let state = initializeSimulation('EUR/USD', 7, {
      scenario: 'eventful', startTimestampMs: Date.UTC(2024, 2, 4, 7, 55), maxFrames: 500,
    })
    const scheduled = state.upcomingScheduledEvent!
    expect(scheduled).not.toBeNull()
    expect(Object.keys(scheduled).sort()).toEqual(['expected', 'label', 'timestampMs', 'type'])
    expect(state.lastEvent).toBeNull()
    while (state.currentTimestampMs < scheduled.timestampMs) state = advanceSimulation(state)!.state
    const before = restoreState(state)
    const release = advanceSimulation(state)!
    expect(release).toEqual(advanceSimulation(before))
    expect(release.state.lastEvent).toMatchObject({ occurredAtMs: scheduled.timestampMs, type: scheduled.type, label: scheduled.label })
    expect(release.state.eventVariance).toBeGreaterThan(state.eventVariance)
    expect(release.frame.quote.timestampMs).toBe(scheduled.timestampMs + 60_000)
    expect(release.state.liquidityPressure).toBeGreaterThanOrEqual(0)
    expect(release.state.upcomingScheduledEvent?.timestampMs ?? Infinity).toBeGreaterThan(scheduled.timestampMs)
    const after = advanceSimulation(release.state)!
    if (after.state.lastEvent?.id === release.state.lastEvent?.id) {
      expect(after.state.eventVariance).toBeLessThan(release.state.eventVariance)
      expect(after.state.liquidityPressure).toBeLessThan(release.state.liquidityPressure)
    }
    expect(state).toEqual(before)
  })

  it('does not mutate nested saved event metadata or factors while advancing', () => {
    const step = createSimulation('GBP/USD', 123, { scenario: 'eventful' })
    const savedState = restoreState(step.state)
    advanceSimulation(step.state)
    expect(step.state).toEqual(savedState)
  })

  it('allows economic repricing with resilient liquidity as well as with higher trading costs', () => {
    const pressures: number[] = []
    for (let seed = 1; seed <= 24; seed += 1) {
      let state = initializeSimulation('EUR/USD', seed, {
        scenario: 'eventful', startTimestampMs: Date.UTC(2024, 2, 4, 7, 59), maxFrames: 3,
      })
      for (let index = 0; index < 3; index += 1) state = advanceSimulation(state)!.state
      if (state.lastEvent?.type === 'economic-data') pressures.push(state.liquidityPressure)
    }
    expect(pressures.some((pressure) => pressure === 0)).toBe(true)
    expect(pressures.some((pressure) => pressure > 0)).toBe(true)
  })

  it('keeps economic background stable between events and names GBP releases for Britain', () => {
    let state = initializeSimulation('GBP/USD', 7, { scenario: 'eventful' })
    expect(state.upcomingScheduledEvent?.label).toBe('模拟英国经济数据')
    for (let index = 0; index < 20; index += 1) {
      const next = advanceSimulation(state)!.state
      if (next.lastEvent?.id === state.lastEvent?.id) {
        expect(next.economicContext).toBe(state.economicContext)
        expect(next.policySensitivity).toBe(state.policySensitivity)
      }
      state = next
    }
  })

  it('uses continuous stochastic volatility rather than a repeated 120-minute direction schedule', () => {
    const outcomes: number[] = []
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const initial = initializeSimulation('EUR/USD', seed, { maxFrames: 120 })
      let state = initial
      for (let index = 0; index < 120; index += 1) state = advanceSimulation(state)!.state
      outcomes.push(new MoneyDecimal(state.currentBidPrice).minus(initial.initialBidPrice).toNumber())
    }
    expect(outcomes.some((outcome) => outcome < 0)).toBe(true)
    expect(outcomes.some((outcome) => outcome > 0)).toBe(true)
    expect(Math.abs(outcomes.reduce((sum, outcome) => sum + outcome, 0) / outcomes.length)).toBeLessThan(0.0015)
  })

  it.each([
    { version: 1 }, { parameterVersion: 0 }, { scenario: 'unknown' },
    { randomState: 0 }, { eventRandomState: -1 }, { scheduleRandomState: 0 },
    { seed: 0x1_0000_0000 }, { frameIndex: -2 }, { frameIndex: 1440 },
    { originFrameIndex: 1441 }, { maxFrames: 0 }, { maxFrames: Number.MAX_SAFE_INTEGER }, { startTimestampMs: 1 },
    { currentBidPrice: '0' }, { currentAskPrice: '0.1' },
    { slowLogVariance: NaN }, { fastLogVariance: Infinity },
    { liquidityPressure: -1 }, { eventVariance: Infinity },
    { temporaryDislocationLog: 1 }, { economicContext: 2 }, { policySensitivity: 0 },
    { initialTimestampMs: undefined }, { currentTimestampMs: undefined },
    { lastEvent: undefined }, { upcomingScheduledEvent: undefined },
  ])('rejects invalid persisted fields %o', (invalidFields) => {
    const state = createSimulation('EUR/USD').state
    expect(() => validateSimulationState({ ...state, ...invalidFields } as SimulationState)).toThrow()
  })

  it('rejects a future event result and a leaked scheduled outcome', () => {
    const state = createSimulation('EUR/USD').state
    expect(() => validateSimulationState({ ...state, lastEvent: {
      id: 'future', occurredAtMs: state.currentTimestampMs + 60_000, type: 'policy',
      label: '模拟', detail: '模拟', surprise: 1,
    } })).toThrow()
    expect(() => validateSimulationState({ ...state, upcomingScheduledEvent: {
      timestampMs: state.currentTimestampMs + 60_000, type: 'policy',
      label: '模拟', expected: '模拟', surprise: 1,
    } as SimulationState['upcomingScheduledEvent'] })).toThrow()
  })

  it('rejects unsupported dates, corrupt horizons and invalid anchor quotes before generation', () => {
    expect(() => initializeSimulation('EUR/USD', 7, { startTimestampMs: Date.UTC(2006, 11, 31, 12) })).toThrow()
    expect(() => initializeSimulation('EUR/USD', 7, { maxFrames: Number.MAX_SAFE_INTEGER })).toThrow()
    expect(() => initializeSimulation('EUR/USD', 7, { startTimestampMs: Date.UTC(2099, 11, 31, 23, 59), maxFrames: 1440 })).toThrow()
    expect(() => initializeSimulation('EUR/USD', 7, { initialBidPrice: 'bad' })).toThrow()
    expect(() => createSimulationFromQuote('EUR/USD', 7, {}, { frameIndex: 3, bidPrice: '1.1', askPrice: '1.0' })).toThrow()
  })
})

describe('fixed modern FX market calendar', () => {
  it('uses both DST calendars, including their March mismatch', () => {
    expect(getLondonOffsetMinutes(Date.UTC(2024, 2, 20, 12))).toBe(0)
    expect(getNewYorkOffsetMinutes(Date.UTC(2024, 2, 20, 12))).toBe(-240)
    expect(getLondonOffsetMinutes(Date.UTC(2024, 3, 2, 12))).toBe(60)
    expect(getNewYorkOffsetMinutes(Date.UTC(2024, 0, 2, 12))).toBe(-300)
    expect(getLondonOffsetMinutes(Date.UTC(2024, 9, 28, 12))).toBe(0)
    expect(getNewYorkOffsetMinutes(Date.UTC(2024, 9, 28, 12))).toBe(-240)
  })

  it('skips the weekend and opens after the DST transition without fabricating flat bars', () => {
    const fridayClose = Date.UTC(2024, 2, 8, 22)
    expect(isSimulationMarketOpen(fridayClose - 60_000)).toBe(true)
    expect(isSimulationMarketOpen(fridayClose)).toBe(false)
    expect(nextSimulationTimestamp(fridayClose)).toBe(Date.UTC(2024, 2, 10, 21, 1))
    const first = createSimulation('EUR/USD', 13, { startTimestampMs: fridayClose, maxFrames: 2 })
    const second = advanceSimulation(first.state)!
    expect(second.frame.quote.timestampMs).toBe(Date.UTC(2024, 2, 10, 21, 1))
    expect(second.state.lastEvent?.label).toBe('模拟重新开市')
    expect(second.frame.openPrice).not.toBe(first.frame.closePrice)
    expect(second.state.frameIndex).toBe(1)
  })

  it('normalizes the daily variance profile instead of adding variance at session boundaries', () => {
    for (const day of [Date.UTC(2024, 0, 2), Date.UTC(2024, 2, 20), Date.UTC(2024, 6, 2)]) {
      let total = 0
      for (let minute = 0; minute < 1440; minute += 1) total += getSimulationSeasonality(day + minute * 60_000).varianceMultiplier
      expect(total / 1440).toBeCloseTo(1, 12)
      expect(getSimulationSeasonality(day).varianceMultiplier).not.toBe(getSimulationSeasonality(day + 13 * 3_600_000).varianceMultiplier)
    }
  })
})
