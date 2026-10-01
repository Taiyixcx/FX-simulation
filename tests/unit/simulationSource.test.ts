import { describe, expect, it } from 'vitest'
import { MoneyDecimal } from '../../src/engine/decimal'
import {
  advanceSimulation,
  createSimulation,
  validateSimulationState,
} from '../../src/engine/simulationSource'
import type { CurrencyPair, SimulationStep } from '../../src/engine/types'

describe('deterministic completed-minute simulation', () => {
  it('keeps the version-1 seed-7 reference frame stable', () => {
    expect(createSimulation('EUR/USD', 7)).toMatchObject({
      state: { version: 1, seed: 7, randomState: 3069989445, frameIndex: 0, currentBidPrice: '1.08509' },
      frame: {
        openPrice: '1.085',
        highPrice: '1.08509',
        lowPrice: '1.085',
        closePrice: '1.08509',
        quote: { bidPrice: '1.08509', askPrice: '1.08519', askSource: 'training' },
      },
    })
  })

  it.each(['EUR/USD', 'GBP/USD'] as CurrencyPair[])('reproduces %s frames from the same seed and persisted random state', (pair) => {
    let first = createSimulation(pair, 7)
    let second = createSimulation(pair, 7)
    for (let index = 0; index < 100; index += 1) {
      expect(first).toEqual(second)
      first = advanceSimulation(first.state)!
      second = advanceSimulation(second.state)!
    }
    const restoredState = JSON.parse(JSON.stringify(first.state)) as SimulationStep['state']
    expect(advanceSimulation(restoredState)).toEqual(advanceSimulation(first.state))
    expect(createSimulation(pair, 8)).not.toEqual(createSimulation(pair, 7))
  })

  it.each(['EUR/USD', 'GBP/USD'] as CurrencyPair[])('returns valid %s Bid OHLC and the documented training Ask spread', (pair) => {
    let step = createSimulation(pair, 42, { maxFrames: 40 })
    for (let index = 0; index < 40; index += 1) {
      const { frame } = step
      expect(frame.quote.askSource).toBe('training')
      expect(frame.quote.bidPrice).toBe(frame.closePrice)
      expect(new MoneyDecimal(frame.lowPrice).lte(frame.openPrice)).toBe(true)
      expect(new MoneyDecimal(frame.lowPrice).lte(frame.closePrice)).toBe(true)
      expect(new MoneyDecimal(frame.highPrice).gte(frame.openPrice)).toBe(true)
      expect(new MoneyDecimal(frame.highPrice).gte(frame.closePrice)).toBe(true)
      expect(new MoneyDecimal(frame.lowPrice).gt(0)).toBe(true)
      expect(new MoneyDecimal(frame.quote.askPrice).minus(frame.quote.bidPrice).toFixed()).toBe(pair === 'EUR/USD' ? '0.0001' : '0.00015')
      const next = advanceSimulation(step.state)
      if (next) {
        expect(next.frame.openPrice).toBe(frame.closePrice)
        expect(next.frame.quote.timestampMs - frame.quote.timestampMs).toBe(60_000)
        step = next
      }
    }
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

  it('does not mutate the saved source state while advancing', () => {
    const step = createSimulation('GBP/USD', 123)
    const savedState = { ...step.state }
    advanceSimulation(step.state)
    expect(step.state).toEqual(savedState)
  })

  it.each([
    { version: 2 },
    { randomState: 0 },
    { randomState: -1 },
    { seed: 0x1_0000_0000 },
    { frameIndex: -1 },
    { frameIndex: 1440 },
    { maxFrames: 0 },
    { startTimestampMs: 1 },
    { currentBidPrice: '0' },
  ])('rejects an invalid persisted generator field %o', (invalidFields) => {
    const state = createSimulation('EUR/USD').state
    expect(() => validateSimulationState({ ...state, ...invalidFields } as typeof state)).toThrow()
  })
})
