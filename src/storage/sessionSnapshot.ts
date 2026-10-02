import { calculateAccount } from '../engine/account'
import { MoneyDecimal } from '../engine/decimal'
import { closePosition, openPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulationFromQuote, initializeSimulation, validateSimulationState } from '../engine/simulationSource'
import type { AccountState, CurrencyPair, MarketFrame, Position, SimulationScenario, SimulationState, SimulationStep, TradeRecord } from '../engine/types'

export interface SessionSimulationConfig {
  version: 2
  parameterVersion: 1
  seed: number
  scenario: SimulationScenario
  originFrameIndex: number
  startTimestampMs: number
  maxFrames: number
  initialTimestampMs: number
  initialBidPrice: string
  initialAskPrice: string
}

export interface SessionSnapshot {
  schemaVersion: 2
  id: string
  revision: number
  pair: CurrencyPair
  simulationConfig: SessionSimulationConfig
  sourceState: SimulationState
  frames: MarketFrame[]
  account: AccountState
  trades: TradeRecord[]
}

/** Immutable replay configuration is saved separately from advancing source state. */
export function createSimulationConfig(state: SimulationState): SessionSimulationConfig {
  return {
    version: state.version,
    parameterVersion: state.parameterVersion,
    seed: state.seed,
    scenario: state.scenario,
    originFrameIndex: state.originFrameIndex,
    startTimestampMs: state.startTimestampMs,
    maxFrames: state.maxFrames,
    initialTimestampMs: state.initialTimestampMs,
    initialBidPrice: state.initialBidPrice,
    initialAskPrice: state.initialAskPrice,
  }
}

interface SimulationReplayCache {
  key: string
  initialState: SimulationState
  steps: SimulationStep[]
}

const MAX_CACHED_REPLAY_STEPS = 1440
// One configuration and at most 1,440 generated steps; no caller-owned state is cached.
let simulationReplayCache: SimulationReplayCache | null = null

function getSimulationReplayCache(currencyPair: CurrencyPair, config: SessionSimulationConfig): SimulationReplayCache {
  const key = JSON.stringify([currencyPair, config])
  if (simulationReplayCache?.key === key) return simulationReplayCache
  const initialState = initializeSimulation(currencyPair, config.seed, {
    startTimestampMs: config.startTimestampMs,
    maxFrames: config.maxFrames,
    scenario: config.scenario,
    originFrameIndex: config.originFrameIndex,
    initialTimestampMs: config.initialTimestampMs,
    initialBidPrice: config.initialBidPrice,
    initialAskPrice: config.initialAskPrice,
  })
  simulationReplayCache = { key, initialState, steps: [] }
  return simulationReplayCache
}

function copySimulationState(state: SimulationState): SimulationState {
  return {
    ...state,
    lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    upcomingScheduledEvent: state.upcomingScheduledEvent ? { ...state.upcomingScheduledEvent } : null,
  }
}

function fail(message: string): never {
  throw new Error(`练习快照无效：${message}。原有数据没有被覆盖。`)
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(`${field} 必须是对象`)
  return input as Record<string, unknown>
}

function integer(input: unknown, field: string, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) fail(`${field} 必须是有效整数`)
  return input
}

function identifier(input: unknown, field: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input)) fail(`${field} 标识损坏`)
  return input
}

function decimal(input: unknown, field: string, positive = false): string {
  if (typeof input !== 'string' || input.length > 200 || !/^-?\d+(?:\.\d+)?$/.test(input)) fail(`${field} 必须是十进制字符串`)
  const parsed = new MoneyDecimal(input)
  if (!parsed.isFinite() || (positive && !parsed.gt(0))) fail(`${field} 数值无效`)
  return input
}

function pair(input: unknown): CurrencyPair {
  if (input !== 'EUR/USD' && input !== 'GBP/USD') fail('品种不受支持')
  return input
}

function parseFrame(input: unknown): MarketFrame {
  const frame = record(input, '行情')
  const quote = record(frame.quote, '报价')
  const askSource = quote.askSource
  if (askSource !== 'training') fail('模拟行情报价来源不匹配')
  return {
    quote: {
      timestampMs: integer(quote.timestampMs, '行情时间'),
      bidPrice: decimal(quote.bidPrice, 'Bid', true),
      askPrice: decimal(quote.askPrice, 'Ask', true),
      askSource,
    },
    openPrice: decimal(frame.openPrice, '开盘价', true),
    highPrice: decimal(frame.highPrice, '最高价', true),
    lowPrice: decimal(frame.lowPrice, '最低价', true),
    closePrice: decimal(frame.closePrice, '收盘价', true),
  }
}

function parsePosition(input: unknown): Position {
  const position = record(input, '持仓')
  const direction = position.direction
  if (direction !== 'long' && direction !== 'short') fail('交易方向无效')
  return {
    id: identifier(position.id, '交易'),
    pair: pair(position.pair),
    direction,
    notionalUsd: decimal(position.notionalUsd, '交易金额', true),
    quantityBaseUnits: decimal(position.quantityBaseUnits, '货币数量', true),
    entryPrice: decimal(position.entryPrice, '入场价', true),
    openedAtMs: integer(position.openedAtMs, '开仓时间'),
  }
}

function parseTrade(input: unknown): TradeRecord {
  const trade = record(input, '成交记录')
  const reason = trade.reason
  if (reason !== 'manual' && reason !== 'equity-depleted') fail('平仓原因无效')
  return {
    ...parsePosition(input),
    closedAtMs: integer(trade.closedAtMs, '平仓时间'),
    exitPrice: decimal(trade.exitPrice, '平仓价', true),
    realizedPnlUsd: decimal(trade.realizedPnlUsd, '已结算盈亏'),
    reason,
  }
}

function sameDecimal(actual: string, expected: string, field: string): void {
  if (!new MoneyDecimal(actual).eq(expected)) fail(`${field} 与行情或账本不一致`)
}

function samePosition(actual: Position, expected: Position): void {
  if (actual.id !== expected.id || actual.pair !== expected.pair || actual.direction !== expected.direction || actual.openedAtMs !== expected.openedAtMs) fail('持仓关联状态不一致')
  sameDecimal(actual.notionalUsd, expected.notionalUsd, '交易金额')
  sameDecimal(actual.quantityBaseUnits, expected.quantityBaseUnits, '货币数量')
  sameDecimal(actual.entryPrice, expected.entryPrice, '入场价')
}

function sameStructure(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => sameStructure(actual[index], item))
  }
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
  const actualFields = actual as Record<string, unknown>
  const expectedFields = expected as Record<string, unknown>
  const actualKeys = Object.keys(actualFields).sort()
  const expectedKeys = Object.keys(expectedFields).sort()
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) => actualKeys[index] === key && sameStructure(actualFields[key], expectedFields[key]))
}

function verifyFrame(actual: MarketFrame, expected: MarketFrame): void {
  if (actual.quote.timestampMs !== expected.quote.timestampMs || actual.quote.askSource !== expected.quote.askSource) fail('行情时序或来源不一致')
  sameDecimal(actual.quote.bidPrice, expected.quote.bidPrice, 'Bid')
  sameDecimal(actual.quote.askPrice, expected.quote.askPrice, 'Ask')
  sameDecimal(actual.openPrice, expected.openPrice, '开盘价')
  sameDecimal(actual.highPrice, expected.highPrice, '最高价')
  sameDecimal(actual.lowPrice, expected.lowPrice, '最低价')
  sameDecimal(actual.closePrice, expected.closePrice, '收盘价')
}

/** Retained version-1 prices are history, never input to an obsolete generator. */
function verifyRetainedFrames(frames: MarketFrame[], count: number, startTimestampMs: number, currencyPair: CurrencyPair): void {
  const spread = currencyPair === 'EUR/USD' ? '0.0001' : '0.00015'
  for (let index = 0; index < count; index += 1) {
    const frame = frames[index]!
    if (frame.quote.timestampMs !== startTimestampMs + index * 60_000) fail('保留行情的分钟时序不一致')
    const low = new MoneyDecimal(frame.lowPrice)
    const high = new MoneyDecimal(frame.highPrice)
    if (low.gt(frame.openPrice) || low.gt(frame.closePrice) || high.lt(frame.openPrice) || high.lt(frame.closePrice)) fail('保留行情的 OHLC 范围无效')
    sameDecimal(frame.quote.bidPrice, frame.closePrice, '保留行情 Bid')
    sameDecimal(new MoneyDecimal(frame.quote.askPrice).minus(frame.quote.bidPrice).toFixed(), spread, '保留行情点差')
    if (index > 0) sameDecimal(frame.openPrice, frames[index - 1]!.closePrice, '保留行情开盘价')
  }
}

function readSourceState(snapshot: Record<string, unknown>, currencyPair: CurrencyPair, frames: MarketFrame[]): SimulationState {
  const source = record(snapshot.sourceState, '模拟状态')
  if (pair(source.pair) !== currencyPair) fail('模拟状态品种不一致')
  const frameIndex = integer(source.frameIndex, '行情进度')
  const startTimestampMs = integer(source.startTimestampMs, '开始时间')
  const maxFrames = integer(source.maxFrames, '行情数量', 1)
  const seed = integer(source.seed, '随机种子')
  if (seed > 0xffff_ffff || startTimestampMs % 60_000 !== 0 || frameIndex >= maxFrames || frames.length !== frameIndex + 1 || startTimestampMs + (maxFrames - 1) * 60_000 > 8.64e15) fail('模拟进度或配置无效')

  if (snapshot.schemaVersion === 1) {
    if (source.version !== 1) fail('旧快照模拟器版本不受支持')
    const randomState = integer(source.randomState, '旧随机状态', 1)
    if (randomState > 0xffff_ffff) fail('旧随机状态无效')
    verifyRetainedFrames(frames, frames.length, startTimestampMs, currencyPair)
    const anchor = frames.at(-1)!.quote
    sameDecimal(decimal(source.currentBidPrice, '旧当前 Bid', true), anchor.bidPrice, '旧当前 Bid')
    return createSimulationFromQuote(currencyPair, seed, { startTimestampMs, maxFrames, scenario: 'standard' }, {
      frameIndex,
      timestampMs: anchor.timestampMs,
      bidPrice: anchor.bidPrice,
      askPrice: anchor.askPrice,
    })
  }

  if (source.version !== 2) fail('模拟器版本不受支持')
  // The engine validates the complete untrusted state before its typed fields are used.
  const sourceState = source as unknown as SimulationState
  validateSimulationState(sourceState)
  const config = createSimulationConfig(sourceState)
  if (!sameStructure(record(snapshot.simulationConfig, '模拟配置'), config)) fail('模拟配置与当前状态不一致')
  const originFrameIndex = sourceState.originFrameIndex
  if (originFrameIndex > frames.length) fail('新模拟起点超过已保存行情')
  verifyRetainedFrames(frames, originFrameIndex, startTimestampMs, currencyPair)
  if (originFrameIndex > 0) {
    const anchor = frames[originFrameIndex - 1]!.quote
    sameDecimal(sourceState.initialBidPrice, anchor.bidPrice, '衔接 Bid')
    sameDecimal(sourceState.initialAskPrice, anchor.askPrice, '衔接 Ask')
    if (sourceState.initialTimestampMs !== anchor.timestampMs) fail('衔接时间与保留行情不一致')
  }
  const cache = getSimulationReplayCache(currencyPair, config)
  let replayState = cache.initialState
  for (let index = originFrameIndex; index < frames.length; index += 1) {
    const cacheIndex = index - originFrameIndex
    let next = cache.steps[cacheIndex]
    if (!next) {
      const generated = advanceSimulation(replayState)
      if (!generated) fail('行情进度超过数据末尾')
      next = generated
      if (cacheIndex < MAX_CACHED_REPLAY_STEPS) cache.steps.push(generated)
    }
    verifyFrame(frames[index]!, next.frame)
    replayState = next.state
  }
  if (!sameStructure(source, replayState)) fail('模拟因素、事件或随机状态与已保存行情不一致')
  return copySimulationState(replayState)
}

/** Validate untrusted DTOs, including deterministic market history and the full account ledger. */
export function validateSessionSnapshot(input: unknown): SessionSnapshot {
  const snapshot = record(input, '快照')
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) fail('格式版本不受支持')
  const id = identifier(snapshot.id, '练习')
  const revision = integer(snapshot.revision, '保存版本')
  const currencyPair = pair(snapshot.pair)
  if (!Array.isArray(snapshot.frames) || snapshot.frames.length === 0) fail('可见行情不存在')
  const frames = snapshot.frames.map(parseFrame)
  const sourceState = readSourceState(snapshot, currencyPair, frames)
  const accountInput = record(snapshot.account, '账户')
  const account: AccountState = {
    balanceUsd: decimal(accountInput.balanceUsd, '账户余额'),
    position: accountInput.position === null ? null : parsePosition(accountInput.position),
  }
  if (!Array.isArray(snapshot.trades)) fail('成交记录必须是数组')
  const trades = snapshot.trades.map(parseTrade)
  const quoteIndices = new Map(frames.map((frame, index) => [frame.quote.timestampMs, index]))
  const tradeIds = new Set<string>()
  let ledger: AccountState = { balanceUsd: '10000', position: null }
  let previousClosedAtMs = frames[0]!.quote.timestampMs
  function verifyOpen(position: Position): number {
    const index = quoteIndices.get(position.openedAtMs)
    if (index === undefined || position.openedAtMs < previousClosedAtMs || position.pair !== currencyPair || tradeIds.has(position.id)) fail('交易关联或开仓时序不一致')
    tradeIds.add(position.id)
    ledger = openPosition(ledger, frames[index]!.quote, currencyPair, position.direction, position.notionalUsd, position.id)
    if (!ledger.position) fail('持仓不存在')
    samePosition(position, ledger.position)
    return index
  }
  for (const trade of trades) {
    const openedIndex = verifyOpen(trade)
    const closedIndex = quoteIndices.get(trade.closedAtMs)
    if (closedIndex === undefined || closedIndex < openedIndex) fail('平仓时间与行情不一致')
    for (let index = openedIndex + 1; index <= closedIndex; index += 1) {
      const depleted = settleDepletedAccount(ledger, frames[index]!.quote)
      if (depleted && (index !== closedIndex || trade.reason !== 'equity-depleted')) fail('跳过了资金耗尽停止规则')
    }
    if (trade.reason === 'equity-depleted' && new MoneyDecimal(calculateAccount(ledger, frames[closedIndex]!.quote).equityUsd).gt(0)) fail('资金耗尽平仓原因不一致')
    const closed = closePosition(ledger, frames[closedIndex]!.quote, trade.reason)
    sameDecimal(trade.exitPrice, closed.trade.exitPrice, '平仓价')
    sameDecimal(trade.realizedPnlUsd, closed.trade.realizedPnlUsd, '已结算盈亏')
    ledger = closed.account
    previousClosedAtMs = trade.closedAtMs
  }
  if (account.position) {
    const openedIndex = verifyOpen(account.position)
    for (let index = openedIndex + 1; index < frames.length; index += 1) {
      if (settleDepletedAccount(ledger, frames[index]!.quote)) fail('资金耗尽持仓未结清')
    }
  }
  sameDecimal(account.balanceUsd, ledger.balanceUsd, '账户余额')
  return { schemaVersion: 2, id, revision, pair: currencyPair, simulationConfig: createSimulationConfig(sourceState), sourceState, frames, account, trades }
}
