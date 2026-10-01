import { validateCurrencyPair } from './account'
import { decimalToString, MoneyDecimal, readDecimalString, validateTimestamp } from './decimal'
import { EngineError } from './errors'
import type { CurrencyPair, MarketFrame, SimulationState, SimulationStep } from './types'

export const SIMULATION_VERSION = 1
export const DEFAULT_SIMULATION_SEED = 20240304
export const DEFAULT_SIMULATION_START_TIMESTAMP_MS = Date.UTC(2024, 2, 4, 0, 1)
export const DEFAULT_SIMULATION_MAX_FRAMES = 1440
const MINUTE_MS = 60_000
const INITIAL_BID_PRICE: Record<CurrencyPair, string> = {
  'EUR/USD': '1.08500',
  'GBP/USD': '1.27000',
}
const TRAINING_SPREAD: Record<CurrencyPair, string> = {
  'EUR/USD': '0.0001',
  'GBP/USD': '0.00015',
}

export interface SimulationOptions {
  startTimestampMs?: number
  maxFrames?: number
}

function isUint32(input: number): boolean {
  return Number.isInteger(input) && input >= 0 && input <= 0xffff_ffff
}

export function validateSimulationState(state: SimulationState): void {
  if (!state || typeof state !== 'object' || state.version !== SIMULATION_VERSION) {
    throw new EngineError('invalid-simulation', '不支持该模拟行情版本。')
  }
  validateCurrencyPair(state.pair)
  validateTimestamp(state.startTimestampMs, 'invalid-simulation')
  if (
    !isUint32(state.seed) ||
    !isUint32(state.randomState) ||
    state.randomState === 0 ||
    !Number.isSafeInteger(state.maxFrames) ||
    state.maxFrames < 1 ||
    !Number.isSafeInteger(state.frameIndex) ||
    state.frameIndex < 0 ||
    state.frameIndex >= state.maxFrames ||
    state.startTimestampMs % MINUTE_MS !== 0 ||
    state.startTimestampMs + (state.maxFrames - 1) * MINUTE_MS > 8.64e15 ||
    readDecimalString(state.currentBidPrice, '模拟报价', 'invalid-simulation').lte(0)
  ) {
    throw new EngineError('invalid-simulation', '模拟行情进度或配置无效。')
  }
}

function nextRandomState(randomState: number): number {
  let next = randomState
  next ^= next << 13
  next ^= next >>> 17
  next ^= next << 5
  return next >>> 0
}

function generateFrame(state: SimulationState): SimulationStep {
  let randomState = state.randomState
  const openPrice = new MoneyDecimal(state.currentBidPrice)
  let currentPrice = openPrice
  let highPrice = openPrice
  let lowPrice = openPrice
  // Alternate gentle trends and quieter stretches; this is generated practice data.
  const trendBlock = Math.floor(state.frameIndex / 120) % 4
  const drift = trendBlock === 0 ? '0.000015' : trendBlock === 2 ? '-0.000015' : '0'
  const volatility = Math.floor(state.frameIndex / 60) % 3 === 2 ? '0.00010' : '0.000045'
  for (let tickIndex = 0; tickIndex < 4; tickIndex += 1) {
    randomState = nextRandomState(randomState)
    const signedRandom = new MoneyDecimal(String((randomState % 20001) - 10000)).div('10000')
    const movement = signedRandom.times(volatility).plus(drift)
    currentPrice = MoneyDecimal.max('0.00001', currentPrice.plus(movement)).toDecimalPlaces(5)
    highPrice = MoneyDecimal.max(highPrice, currentPrice)
    lowPrice = MoneyDecimal.min(lowPrice, currentPrice)
  }
  const closePrice = decimalToString(currentPrice)
  const frame: MarketFrame = {
    quote: {
      timestampMs: state.startTimestampMs + state.frameIndex * MINUTE_MS,
      bidPrice: closePrice,
      askPrice: decimalToString(currentPrice.plus(TRAINING_SPREAD[state.pair])),
      askSource: 'training',
    },
    openPrice: decimalToString(openPrice),
    highPrice: decimalToString(highPrice),
    lowPrice: decimalToString(lowPrice),
    closePrice,
  }
  return {
    state: { ...state, randomState, currentBidPrice: closePrice },
    frame,
  }
}

export function createSimulation(
  pair: CurrencyPair,
  seed = DEFAULT_SIMULATION_SEED,
  options: SimulationOptions = {},
): SimulationStep {
  const state: SimulationState = {
    version: SIMULATION_VERSION,
    pair,
    seed,
    randomState: seed === 0 ? 0x6d2b79f5 : seed,
    frameIndex: 0,
    startTimestampMs: options.startTimestampMs ?? DEFAULT_SIMULATION_START_TIMESTAMP_MS,
    maxFrames: options.maxFrames ?? DEFAULT_SIMULATION_MAX_FRAMES,
    currentBidPrice: INITIAL_BID_PRICE[pair],
  }
  validateSimulationState(state)
  return generateFrame(state)
}

export function advanceSimulation(state: SimulationState): SimulationStep | null {
  validateSimulationState(state)
  if (state.frameIndex >= state.maxFrames - 1) {
    return null
  }
  return generateFrame({ ...state, frameIndex: state.frameIndex + 1 })
}
