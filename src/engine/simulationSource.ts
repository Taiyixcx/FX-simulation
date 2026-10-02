import { validateCurrencyPair } from './account'
import { decimalToString, MoneyDecimal, readDecimalString, validateTimestamp } from './decimal'
import { EngineError } from './errors'
import {
  getLondonOffsetMinutes, getNewYorkOffsetMinutes, getSimulationSeasonality,
  isSimulationMarketOpen, lastSimulationTimestamp, MAX_SIMULATION_TIMESTAMP_MS,
  MIN_SIMULATION_TIMESTAMP_MS, nextSimulationTimestamp, SIMULATION_DAY_MS,
  SIMULATION_MINUTE_MS, SIMULATION_PAIR_PARAMETERS, SIMULATION_PARAMETER_VERSION,
  SIMULATION_SCENARIO_PARAMETERS, SIMULATION_SUBSTEPS, SIMULATION_VOLATILITY,
} from './simulationParameters'
import type {
  CurrencyPair, MarketFrame, ScheduledSimulationEvent, SimulationEvent,
  SimulationScenario, SimulationState, SimulationStep,
} from './types'

export const SIMULATION_VERSION = 2
export const DEFAULT_SIMULATION_SEED = 20240304
export const DEFAULT_SIMULATION_START_TIMESTAMP_MS = Date.UTC(2024, 2, 4, 0, 1)
export const DEFAULT_SIMULATION_MAX_FRAMES = 1440

export interface SimulationOptions {
  startTimestampMs?: number
  maxFrames?: number
  scenario?: SimulationScenario
  originFrameIndex?: number
  initialBidPrice?: string
  initialAskPrice?: string
  initialTimestampMs?: number
}

export interface SimulationAnchor {
  frameIndex: number
  bidPrice: string
  askPrice: string
  timestampMs?: number
}

function fail(message: string): never {
  throw new EngineError('invalid-simulation', message)
}

function isUint32(input: number): boolean {
  return Number.isInteger(input) && input >= 0 && input <= 0xffff_ffff
}

function isFiniteInRange(input: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(input) && input >= minimum && input <= maximum
}

/** Fixed precision is part of the model contract across JS runtimes. */
function roundFactor(input: number, decimalPlaces = 12): number {
  return Number(input.toFixed(decimalPlaces))
}

function validateModelTimestamp(timestampMs: number): void {
  validateTimestamp(timestampMs, 'invalid-simulation')
  if (timestampMs % SIMULATION_MINUTE_MS !== 0 || timestampMs < MIN_SIMULATION_TIMESTAMP_MS - SIMULATION_MINUTE_MS || timestampMs > MAX_SIMULATION_TIMESTAMP_MS) {
    fail('模拟时钟须为整分钟，日期范围为 2007 至 2099 年。')
  }
}

function validateQuotePrices(bidPrice: string, askPrice: string): void {
  if (typeof bidPrice !== 'string' || bidPrice.length > 80 || typeof askPrice !== 'string' || askPrice.length > 80) fail('模拟报价无效。')
  const bid = readDecimalString(bidPrice, '模拟 Bid', 'invalid-simulation')
  const ask = readDecimalString(askPrice, '模拟 Ask', 'invalid-simulation')
  if (bid.lte(0) || ask.lte(bid)) fail('模拟 Bid 必须为正，Ask 必须高于 Bid。')
}

function isShortText(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 240
}

function validateEvent(event: SimulationEvent | null, currentTimestampMs: number): void {
  if (event === null) return
  if (!event || typeof event !== 'object' || !isShortText(event.id) || !isShortText(event.label) || !isShortText(event.detail)
    || !['economic-data', 'policy', 'liquidity'].includes(event.type) || !isFiniteInRange(event.surprise, -20, 20)) fail('已发生的模拟事件无效。')
  validateModelTimestamp(event.occurredAtMs)
  if (event.occurredAtMs > currentTimestampMs) fail('不能保存尚未发生的模拟事件结果。')
}

function validateScheduledEvent(event: ScheduledSimulationEvent | null, currentTimestampMs: number): void {
  if (event === null) return
  if (!event || typeof event !== 'object' || !['economic-data', 'policy'].includes(event.type)
    || !isShortText(event.label) || !isShortText(event.expected)
    || Object.keys(event).some((key) => !['timestampMs', 'type', 'label', 'expected'].includes(key))) fail('计划模拟发布只能包含时间、类型和预期。')
  validateModelTimestamp(event.timestampMs)
  if (event.timestampMs < currentTimestampMs || !isSimulationMarketOpen(event.timestampMs)) fail('计划模拟发布的时间无效。')
}

export function validateSimulationState(state: SimulationState): void {
  if (!state || typeof state !== 'object' || state.version !== SIMULATION_VERSION || state.parameterVersion !== SIMULATION_PARAMETER_VERSION) {
    fail('不支持该模拟模型或参数版本。')
  }
  validateCurrencyPair(state.pair)
  if (!['standard', 'eventful'].includes(state.scenario) || !isUint32(state.seed)
    || ![state.randomState, state.eventRandomState, state.scheduleRandomState].every((randomState) => isUint32(randomState) && randomState !== 0)
    || !Number.isSafeInteger(state.maxFrames) || state.maxFrames < 1
    || state.maxFrames > (MAX_SIMULATION_TIMESTAMP_MS - MIN_SIMULATION_TIMESTAMP_MS) / SIMULATION_MINUTE_MS + 1
    || !Number.isSafeInteger(state.originFrameIndex) || state.originFrameIndex < 0 || state.originFrameIndex > state.maxFrames
    || !Number.isSafeInteger(state.frameIndex) || state.frameIndex < state.originFrameIndex - 1 || state.frameIndex >= state.maxFrames
    || !isFiniteInRange(state.slowLogVariance, -12, 12) || !isFiniteInRange(state.fastLogVariance, -12, 12)
    || !isFiniteInRange(state.liquidityPressure, 0, 20) || !isFiniteInRange(state.eventVariance, 0, 0.01)
    || !isFiniteInRange(state.temporaryDislocationLog, -0.2, 0.2)
    || !isFiniteInRange(state.economicContext, -1, 1) || !isFiniteInRange(state.policySensitivity, 0.5, 1.5)) {
    fail('模拟行情进度、随机状态或市场因子无效。')
  }
  validateModelTimestamp(state.startTimestampMs)
  validateModelTimestamp(state.initialTimestampMs)
  validateModelTimestamp(state.currentTimestampMs)
  if (state.startTimestampMs < MIN_SIMULATION_TIMESTAMP_MS || state.initialTimestampMs < state.startTimestampMs - SIMULATION_MINUTE_MS
    || state.currentTimestampMs < state.initialTimestampMs
    || (state.frameIndex === state.originFrameIndex - 1 && state.currentTimestampMs !== state.initialTimestampMs)
    || (state.frameIndex >= state.originFrameIndex && (state.currentTimestampMs <= state.initialTimestampMs || !isSimulationMarketOpen(state.currentTimestampMs - SIMULATION_MINUTE_MS)))) {
    fail('模拟时钟与已完成行情不一致。')
  }
  validateQuotePrices(state.initialBidPrice, state.initialAskPrice)
  validateQuotePrices(state.currentBidPrice, state.currentAskPrice)
  validateEvent(state.lastEvent, state.currentTimestampMs)
  validateScheduledEvent(state.upcomingScheduledEvent, state.currentTimestampMs)
}

function mixSeed(seed: number, salt: number): number {
  let mixed = (seed ^ salt) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0
  return ((mixed ^ (mixed >>> 16)) >>> 0) || 0x6d2b79f5
}

class RandomStream {
  constructor(public state: number) {}

  uniform(): number {
    let next = this.state
    next ^= next << 13
    next ^= next >>> 17
    next ^= next << 5
    this.state = next >>> 0
    return (this.state + 0.5) / 0x1_0000_0000
  }

  normal(): number {
    // No spare draw is cached outside persisted state.
    return roundFactor(Math.sqrt(-2 * Math.log(this.uniform())) * Math.cos(2 * Math.PI * this.uniform()))
  }
}

function nextLogVariance(current: number, halfLifeMinutes: number, stationaryVariance: number, minutes: number, random: RandomStream): number {
  const persistence = Math.exp(-Math.LN2 * minutes / halfLifeMinutes)
  return roundFactor(persistence * current + Math.sqrt(stationaryVariance * (1 - persistence ** 2)) * random.normal())
}

function scheduledCandidates(utcDayMs: number): Array<ScheduledSimulationEvent & { probabilityKey: 'londonDataProbability' | 'newYorkDataProbability' | 'policyProbability' }> {
  const londonAtEightMs = utcDayMs + 8 * 3_600_000 - getLondonOffsetMinutes(utcDayMs + 12 * 3_600_000) * SIMULATION_MINUTE_MS
  const newYorkAtEightThirtyMs = utcDayMs + (8 * 60 + 30 - getNewYorkOffsetMinutes(utcDayMs + 12 * 3_600_000)) * SIMULATION_MINUTE_MS
  const newYorkAtFourteenMs = utcDayMs + (14 * 60 - getNewYorkOffsetMinutes(utcDayMs + 12 * 3_600_000)) * SIMULATION_MINUTE_MS
  return [
    { timestampMs: londonAtEightMs, type: 'economic-data', label: '模拟欧洲经济数据', expected: '市场预期：符合当前经济背景', probabilityKey: 'londonDataProbability' },
    { timestampMs: newYorkAtEightThirtyMs, type: 'economic-data', label: '模拟美国经济数据', expected: '市场预期：符合当前经济背景', probabilityKey: 'newYorkDataProbability' },
    { timestampMs: newYorkAtFourteenMs, type: 'policy', label: '模拟政策声明', expected: '市场预期：当前政策路径延续', probabilityKey: 'policyProbability' },
  ]
}

function selectNextScheduledEvent(state: SimulationState, lastTimestampMs: number): void {
  if (state.frameIndex >= state.maxFrames - 1) {
    state.upcomingScheduledEvent = null
    return
  }
  const random = new RandomStream(state.scheduleRandomState)
  const parameters = SIMULATION_SCENARIO_PARAMETERS[state.scenario]
  let nextEvent: ScheduledSimulationEvent | null = null
  for (let utcDayMs = Math.floor(state.currentTimestampMs / SIMULATION_DAY_MS) * SIMULATION_DAY_MS; utcDayMs <= lastTimestampMs; utcDayMs += SIMULATION_DAY_MS) {
    for (const candidate of scheduledCandidates(utcDayMs)) {
      if (candidate.timestampMs <= state.currentTimestampMs || candidate.timestampMs >= lastTimestampMs || !isSimulationMarketOpen(candidate.timestampMs)) continue
      if (random.uniform() < parameters[candidate.probabilityKey]) {
        const { timestampMs, type, label, expected } = candidate
        nextEvent = { timestampMs, type, label: state.pair === 'GBP/USD' && label.includes('欧洲') ? '模拟英国经济数据' : label, expected }
        break
      }
    }
    if (nextEvent) break
  }
  state.scheduleRandomState = random.state
  state.upcomingScheduledEvent = nextEvent
}

/** Initialize a reproducible generator without creating or revealing its first frame. */
export function initializeSimulation(pair: CurrencyPair, seed = DEFAULT_SIMULATION_SEED, options: SimulationOptions = {}): SimulationState {
  validateCurrencyPair(pair)
  if (!isUint32(seed)) fail('模拟种子须为 32 位无符号整数。')
  const parameters = SIMULATION_PAIR_PARAMETERS[pair]
  const initialBidPrice = options.initialBidPrice ?? parameters.initialBidPrice
  if (typeof initialBidPrice !== 'string' || initialBidPrice.length > 80) fail('初始模拟报价无效。')
  const initialBid = readDecimalString(initialBidPrice, '初始模拟 Bid', 'invalid-simulation')
  const initialAskPrice = options.initialAskPrice ?? decimalToString(initialBid.plus(parameters.baseSpreadPrice))
  const originFrameIndex = options.originFrameIndex ?? 0
  const startTimestampMs = options.startTimestampMs ?? DEFAULT_SIMULATION_START_TIMESTAMP_MS
  const initialTimestampMs = options.initialTimestampMs ?? startTimestampMs + (originFrameIndex - 1) * SIMULATION_MINUTE_MS
  const random = new RandomStream(mixSeed(seed, pair === 'EUR/USD' ? 0x455552 : 0x474250))
  const state: SimulationState = {
    version: SIMULATION_VERSION, parameterVersion: SIMULATION_PARAMETER_VERSION,
    pair, seed, scenario: options.scenario ?? 'standard', randomState: random.state,
    eventRandomState: mixSeed(seed, 0x45564e54), scheduleRandomState: mixSeed(seed, 0x53434844),
    frameIndex: originFrameIndex - 1, originFrameIndex, startTimestampMs,
    maxFrames: options.maxFrames ?? DEFAULT_SIMULATION_MAX_FRAMES,
    initialTimestampMs, currentTimestampMs: initialTimestampMs,
    initialBidPrice, initialAskPrice, currentBidPrice: initialBidPrice, currentAskPrice: initialAskPrice,
    slowLogVariance: roundFactor(Math.sqrt(SIMULATION_VOLATILITY.slowStationaryVariance) * random.normal()),
    fastLogVariance: roundFactor(Math.sqrt(SIMULATION_VOLATILITY.fastStationaryVariance) * random.normal()),
    liquidityPressure: 0, eventVariance: 0, temporaryDislocationLog: 0,
    economicContext: roundFactor(Math.tanh(random.normal())), policySensitivity: roundFactor(1 + 0.2 * Math.tanh(random.normal())),
    lastEvent: null, upcomingScheduledEvent: null,
  }
  state.randomState = random.state
  validateSimulationState(state)
  const lastTimestampMs = lastSimulationTimestamp(state.initialTimestampMs, state.maxFrames - state.originFrameIndex)
  if (lastTimestampMs > MAX_SIMULATION_TIMESTAMP_MS) fail('练习结束日期超出模拟时钟支持范围。')
  selectNextScheduledEvent(state, lastTimestampMs)
  return state
}

/** Continue after an existing quote; the historical prefix is not regenerated. */
export function createSimulationFromQuote(pair: CurrencyPair, seed: number, options: SimulationOptions, anchor: SimulationAnchor): SimulationState {
  if (!Number.isSafeInteger(anchor.frameIndex) || anchor.frameIndex < 0) fail('模拟衔接位置无效。')
  return initializeSimulation(pair, seed, {
    ...options, originFrameIndex: anchor.frameIndex + 1,
    initialBidPrice: anchor.bidPrice, initialAskPrice: anchor.askPrice,
    initialTimestampMs: anchor.timestampMs ?? (options.startTimestampMs ?? DEFAULT_SIMULATION_START_TIMESTAMP_MS) + anchor.frameIndex * SIMULATION_MINUTE_MS,
  })
}

interface EventImpact {
  permanentLogJump: number
  temporaryLogJump: number
  varianceBoost: number
  liquidityBoost: number
  event: SimulationEvent
}

function createEventImpact(state: SimulationState, timestampMs: number, random: RandomStream, scheduled: ScheduledSimulationEvent | null, isReopening: boolean): EventImpact {
  const parameters = SIMULATION_PAIR_PARAMETERS[state.pair]
  const type = isReopening ? 'liquidity' : scheduled?.type ?? (random.uniform() < 0.6 ? 'liquidity' : 'policy')
  const surprise = random.normal()
  const contextMultiplier = 1 + 0.25 * state.economicContext
  const policyMultiplier = type === 'policy' ? state.policySensitivity : 1
  // The first calendar slot is the base-currency release; labels never drive prices.
  const isBaseCurrencyRelease = scheduled?.type === 'economic-data'
    && scheduled.timestampMs === scheduledCandidates(Math.floor(scheduled.timestampMs / SIMULATION_DAY_MS) * SIMULATION_DAY_MS)[0]!.timestampMs
  const regionalSign = isBaseCurrencyRelease ? 1 : -1
  const interpretationNoise = 0.4 * random.normal()
  const liquiditySeverity = type === 'liquidity' ? (isReopening ? 0.7 : 1.4) : 1
  let informationInnovation = regionalSign * surprise * contextMultiplier * policyMultiplier + interpretationNoise
  if (type === 'policy') {
    const decisionSurprise = random.normal()
    const economicInformation = random.normal()
    // USD policy surprise, expected future path, and information effects may offset.
    informationInnovation = -(0.4 * decisionSurprise + 0.8 * policyMultiplier * surprise)
      + 0.35 * state.economicContext * economicInformation + interpretationNoise
  }
  const shock = parameters.eventReturnStd * liquiditySeverity * informationInnovation
  const temporaryFraction = type === 'liquidity' ? 0.2 + 0.4 * random.uniform() : 0.1 * random.uniform()
  const severity = Math.abs(surprise) + 0.25
  const varianceBoost = parameters.minuteReturnStd ** 2 * (type === 'liquidity' ? 5 : 9) * severity
  // A macro repricing can be absorbed by resilient liquidity. This is an independent draw.
  const liquidityBoost = type === 'liquidity' ? 1.3 * Math.sqrt(severity)
    : random.uniform() < 0.45 ? 0 : 0.05 + 0.6 * random.uniform()
  const label = isReopening ? '模拟重新开市' : scheduled?.label ?? (type === 'liquidity' ? '模拟流动性冲击' : '模拟意外政策消息')
  const detail = type === 'liquidity'
    ? '模拟订单与流动性失衡，报价可能跳变，点差和波动暂时上升；后续方向仍不确定。'
    : type === 'policy'
      ? `模拟政策路径与预期${surprise > 0.3 ? '偏鹰' : surprise < -0.3 ? '偏鸽' : '接近'}，当期决定、经济信息与解读分歧共同影响报价；后续方向仍不确定。`
      : `模拟发布与原先预期${surprise > 0.3 ? '偏强' : surprise < -0.3 ? '偏弱' : '接近'}，结合经济背景与解读分歧即时重新计价；后续方向仍不确定。`
  return {
    permanentLogJump: shock * (1 - temporaryFraction), temporaryLogJump: shock * temporaryFraction,
    varianceBoost, liquidityBoost,
    event: { id: `${scheduled?.timestampMs ?? timestampMs}:${type}`, occurredAtMs: scheduled?.timestampMs ?? timestampMs, type, label, detail, surprise },
  }
}

function createSpreadPrice(state: SimulationState, timestampMs: number, liquidityPressure: number, random: RandomStream): ReturnType<typeof MoneyDecimal.max> {
  const parameters = SIMULATION_PAIR_PARAMETERS[state.pair]
  const { spreadMultiplier } = getSimulationSeasonality(timestampMs)
  const volatilityCost = 0.1 * Math.exp((state.slowLogVariance + state.fastLogVariance) / 2)
  const multiplier = (spreadMultiplier + volatilityCost) * Math.exp(liquidityPressure + 0.035 * random.normal())
  return MoneyDecimal.max(parameters.minimumSpreadPrice, new MoneyDecimal(parameters.baseSpreadPrice).times(String(multiplier))).toDecimalPlaces(5)
}

export function advanceSimulation(savedState: SimulationState): SimulationStep | null {
  validateSimulationState(savedState)
  if (savedState.frameIndex >= savedState.maxFrames - 1) return null
  const timestampMs = nextSimulationTimestamp(savedState.currentTimestampMs)
  if (timestampMs > MAX_SIMULATION_TIMESTAMP_MS) fail('下一根行情超出模拟时钟支持范围。')
  const elapsedMinutes = (timestampMs - savedState.currentTimestampMs) / SIMULATION_MINUTE_MS
  const state: SimulationState = { ...savedState, frameIndex: savedState.frameIndex + 1, currentTimestampMs: timestampMs }
  const random = new RandomStream(savedState.randomState)
  const eventRandom = new RandomStream(savedState.eventRandomState)
  const volatility = SIMULATION_VOLATILITY
  state.slowLogVariance = nextLogVariance(savedState.slowLogVariance, volatility.slowHalfLifeMinutes, volatility.slowStationaryVariance, elapsedMinutes, random)
  state.fastLogVariance = nextLogVariance(savedState.fastLogVariance, volatility.fastHalfLifeMinutes, volatility.fastStationaryVariance, elapsedMinutes, random)
  const liquidityDecay = Math.exp(-Math.LN2 * elapsedMinutes / volatility.liquidityHalfLifeMinutes)
  const varianceDecay = Math.exp(-Math.LN2 * elapsedMinutes / volatility.eventHalfLifeMinutes)
  const temporaryDecay = Math.exp(-Math.LN2 * elapsedMinutes / volatility.temporaryHalfLifeMinutes)
  state.liquidityPressure = roundFactor(state.liquidityPressure * liquidityDecay)
  state.eventVariance = roundFactor(state.eventVariance * varianceDecay, 16)
  const previousDislocation = state.temporaryDislocationLog
  state.temporaryDislocationLog = roundFactor(state.temporaryDislocationLog * temporaryDecay)
  // Background is stable between information arrivals and has no ordinary directional drift.
  const scheduled = savedState.upcomingScheduledEvent?.timestampMs === timestampMs - SIMULATION_MINUTE_MS ? savedState.upcomingScheduledEvent : null
  const isReopening = elapsedMinutes > 1
  const surpriseProbability = SIMULATION_SCENARIO_PARAMETERS[state.scenario].surpriseProbabilityPerMinute
  const hasSurprise = eventRandom.uniform() < surpriseProbability
  const impact = scheduled || isReopening || hasSurprise ? createEventImpact(state, timestampMs, eventRandom, scheduled, isReopening) : null
  if (impact) {
    state.lastEvent = impact.event
    if (impact.event.type !== 'liquidity') {
      state.economicContext = roundFactor(0.9 * state.economicContext + 0.1 * Math.tanh(impact.event.surprise))
      if (impact.event.type === 'policy') state.policySensitivity = roundFactor(0.95 * state.policySensitivity + 0.05 * (1 + 0.2 * Math.tanh(impact.event.surprise)))
    }
  }
  const eventSubstep = impact ? (isReopening ? -1 : scheduled ? 0 : Math.floor(eventRandom.uniform() * SIMULATION_SUBSTEPS)) : -1
  const parameters = SIMULATION_PAIR_PARAMETERS[state.pair]
  const { varianceMultiplier } = getSimulationSeasonality(timestampMs - SIMULATION_MINUTE_MS)
  const stationaryVariance = volatility.slowStationaryVariance + volatility.fastStationaryVariance
  const baseMinuteVariance = parameters.minuteReturnStd ** 2 * varianceMultiplier * Math.exp(state.slowLogVariance + state.fastLogVariance - stationaryVariance / 2)
  let openPrice = new MoneyDecimal(savedState.currentBidPrice)
  let midPrice = new MoneyDecimal(savedState.currentBidPrice).plus(savedState.currentAskPrice).div(2)
  if (isReopening && impact) {
    midPrice = midPrice.times(new MoneyDecimal(String(impact.permanentLogJump + impact.temporaryLogJump)).exp())
    state.temporaryDislocationLog = roundFactor(state.temporaryDislocationLog + impact.temporaryLogJump)
    state.eventVariance = roundFactor(state.eventVariance + impact.varianceBoost, 16)
    state.liquidityPressure = roundFactor(state.liquidityPressure + impact.liquidityBoost)
    openPrice = midPrice.minus(createSpreadPrice(state, timestampMs - SIMULATION_MINUTE_MS, state.liquidityPressure, random).div(2)).toDecimalPlaces(5)
    if (openPrice.lte(0)) fail('模拟开市报价超出可表示范围。')
  }
  let highPrice = openPrice
  let lowPrice = openPrice
  let bidPrice = openPrice
  let askPrice = new MoneyDecimal(savedState.currentAskPrice)
  for (let substep = 0; substep < SIMULATION_SUBSTEPS; substep += 1) {
    let logJump = 0
    if (impact && substep === eventSubstep) {
      logJump = impact.permanentLogJump + impact.temporaryLogJump
      state.temporaryDislocationLog = roundFactor(state.temporaryDislocationLog + impact.temporaryLogJump)
      state.eventVariance = roundFactor(state.eventVariance + impact.varianceBoost, 16)
      state.liquidityPressure = roundFactor(state.liquidityPressure + impact.liquidityBoost)
    }
    const continuousStd = Math.sqrt((baseMinuteVariance + state.eventVariance) / SIMULATION_SUBSTEPS)
    const temporaryChange = (roundFactor(savedState.temporaryDislocationLog * temporaryDecay) - previousDislocation) / SIMULATION_SUBSTEPS
    // Common USD innovations preserve imperfect co-movement for equal seeds and clocks.
    const sharedRandom = new RandomStream(mixSeed(state.seed, ((timestampMs / SIMULATION_MINUTE_MS) * 17 + substep) >>> 0))
    const innovation = Math.sqrt(0.55) * sharedRandom.normal() + Math.sqrt(0.45) * random.normal()
    const logReturn = continuousStd * innovation + temporaryChange + logJump
    midPrice = midPrice.times(new MoneyDecimal(String(logReturn)).exp())
    const spreadPrice = createSpreadPrice(state, timestampMs, state.liquidityPressure, random)
    bidPrice = midPrice.minus(spreadPrice.div(2)).toDecimalPlaces(5)
    askPrice = midPrice.plus(spreadPrice.div(2)).toDecimalPlaces(5)
    if (bidPrice.lte(0) || askPrice.lte(bidPrice)) fail('模拟报价超出可表示范围。')
    highPrice = MoneyDecimal.max(highPrice, bidPrice)
    lowPrice = MoneyDecimal.min(lowPrice, bidPrice)
  }
  state.currentBidPrice = decimalToString(bidPrice)
  state.currentAskPrice = decimalToString(askPrice)
  state.randomState = random.state
  state.eventRandomState = eventRandom.state
  if (scheduled || state.frameIndex === state.maxFrames - 1) {
    selectNextScheduledEvent(state, lastSimulationTimestamp(timestampMs, state.maxFrames - 1 - state.frameIndex))
  }
  validateSimulationState(state)
  const frame: MarketFrame = {
    quote: { timestampMs, bidPrice: state.currentBidPrice, askPrice: state.currentAskPrice, askSource: 'training' },
    openPrice: decimalToString(openPrice), highPrice: decimalToString(highPrice), lowPrice: decimalToString(lowPrice), closePrice: state.currentBidPrice,
  }
  return { state, frame }
}

export function createSimulation(pair: CurrencyPair, seed = DEFAULT_SIMULATION_SEED, options: SimulationOptions = {}): SimulationStep {
  const firstStep = advanceSimulation(initializeSimulation(pair, seed, options))
  if (!firstStep) fail('该模拟会话已经完成，没有新行情可生成。')
  return firstStep
}
