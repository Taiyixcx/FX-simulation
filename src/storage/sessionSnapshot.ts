import { MoneyDecimal } from '../engine/decimal'
import { closePosition, openPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulationFromQuote, initializeSimulation, validateSimulationState } from '../engine/simulationSource'
import type { AccountState, CurrencyPair, MarketFrame, MarketQuote, Position, SimulationScenario, SimulationState, SimulationStep, TradeRecord } from '../engine/types'

export const SESSION_FRAME_WINDOW_SIZE = 1440

export interface SessionSimulationConfig {
  version: 2
  parameterVersion: 1 | 2
  seed: number
  scenario: SimulationScenario
  originFrameIndex: number
  startTimestampMs: number
  maxFrames: number | null
  initialTimestampMs: number
  initialBidPrice: string
  initialAskPrice: string
}

export interface SessionSnapshot {
  schemaVersion: 3
  id: string
  revision: number
  pair: CurrencyPair
  simulationConfig: SessionSimulationConfig
  /** The saved prefix keeps its known validation rules without an old generator. */
  retainedPrefixKind: 'legacy-v1' | 'legacy-v2' | null
  sourceState: SimulationState
  /** Absolute index of frames[0]; archived frames are stored separately. */
  frameStartIndex: number
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

const MAX_CACHED_REPLAY_STEPS = SESSION_FRAME_WINDOW_SIZE
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
    parameterVersion: config.parameterVersion,
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
function verifyRetainedFrame(frame: MarketFrame, index: number, startTimestampMs: number, currencyPair: CurrencyPair, previousClosePrice: string | null): void {
  const spread = currencyPair === 'EUR/USD' ? '0.0001' : '0.00015'
  if (frame.quote.timestampMs !== startTimestampMs + index * 60_000) fail('保留行情的分钟时序不一致')
  const low = new MoneyDecimal(frame.lowPrice)
  const high = new MoneyDecimal(frame.highPrice)
  if (low.gt(frame.openPrice) || low.gt(frame.closePrice) || high.lt(frame.openPrice) || high.lt(frame.closePrice)) fail('保留行情的 OHLC 范围无效')
  sameDecimal(frame.quote.bidPrice, frame.closePrice, '保留行情 Bid')
  sameDecimal(new MoneyDecimal(frame.quote.askPrice).minus(frame.quote.bidPrice).toFixed(), spread, '保留行情点差')
  if (previousClosePrice !== null) sameDecimal(frame.openPrice, previousClosePrice, '保留行情开盘价')
}

function verifyRetainedFrames(frames: MarketFrame[], count: number, startTimestampMs: number, currencyPair: CurrencyPair): void {
  for (let index = 0; index < count; index += 1) {
    verifyRetainedFrame(frames[index]!, index, startTimestampMs, currencyPair, index > 0 ? frames[index - 1]!.closePrice : null)
  }
}

function verifyPhysicalFrame(frame: MarketFrame, previousTimestampMs: number): void {
  if (frame.quote.timestampMs % 60_000 !== 0 || frame.quote.timestampMs <= previousTimestampMs) fail('行情分钟时序无效')
  const low = new MoneyDecimal(frame.lowPrice)
  const high = new MoneyDecimal(frame.highPrice)
  if (low.gt(frame.openPrice) || low.gt(frame.closePrice) || high.lt(frame.openPrice) || high.lt(frame.closePrice)) fail('行情 OHLC 范围无效')
  sameDecimal(frame.quote.bidPrice, frame.closePrice, '行情 Bid')
  if (!new MoneyDecimal(frame.quote.askPrice).gt(frame.quote.bidPrice)) fail('行情 Bid/Ask 无效')
}

export function parseAccount(input: unknown): AccountState {
  const account = record(input, '账户')
  return { balanceUsd: decimal(account.balanceUsd, '账户余额'), position: account.position === null ? null : parsePosition(account.position) }
}

export function parseTrades(input: unknown): TradeRecord[] {
  if (!Array.isArray(input)) fail('成交记录必须是数组')
  return input.map(parseTrade)
}

/** All returned DTOs are detached from both the caller and private validation checkpoints. */
export function copySessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return structuredClone(snapshot)
}

/** Parse only the bounded head. This is deliberately not full history validation. */
function parseHead(input: unknown): SessionSnapshot {
  const snapshot = record(input, '快照')
  if (snapshot.schemaVersion !== 3) fail('格式版本不受支持')
  const currencyPair = pair(snapshot.pair)
  const source = record(snapshot.sourceState, '模拟状态') as unknown as SimulationState
  validateSimulationState(source)
  if (source.pair !== currencyPair || source.frameIndex < 0) fail('模拟状态品种或进度不一致')
  const config = createSimulationConfig(source)
  if (!sameStructure(record(snapshot.simulationConfig, '模拟配置'), config)) fail('模拟配置与当前状态不一致')
  const retainedPrefixKind = snapshot.retainedPrefixKind
  if (retainedPrefixKind !== null && retainedPrefixKind !== 'legacy-v1' && retainedPrefixKind !== 'legacy-v2') fail('保留行情类型无效')
  if ((config.originFrameIndex === 0) !== (retainedPrefixKind === null)) fail('保留行情类型与模拟起点不一致')
  const frameStartIndex = integer(snapshot.frameStartIndex, '行情窗口起点')
  if (!Array.isArray(snapshot.frames) || snapshot.frames.length !== Math.min(source.frameIndex + 1, SESSION_FRAME_WINDOW_SIZE) || frameStartIndex !== source.frameIndex + 1 - snapshot.frames.length) fail('行情窗口数量或索引不一致')
  const frames = snapshot.frames.map(parseFrame)
  let previousTimestampMs = -1
  for (const frame of frames) {
    verifyPhysicalFrame(frame, previousTimestampMs)
    previousTimestampMs = frame.quote.timestampMs
  }
  const last = frames.at(-1)!.quote
  if (last.timestampMs !== source.currentTimestampMs || last.bidPrice !== source.currentBidPrice || last.askPrice !== source.currentAskPrice) fail('最后报价与当前模拟状态不一致')
  return {
    schemaVersion: 3, id: identifier(snapshot.id, '练习'), revision: integer(snapshot.revision, '保存版本'),
    pair: currencyPair, simulationConfig: config, retainedPrefixKind, sourceState: copySimulationState(source), frameStartIndex, frames,
    account: parseAccount(snapshot.account), trades: parseTrades(snapshot.trades),
  }
}

function verifyClosedTrade(actual: TradeRecord, expected: TradeRecord): void {
  samePosition(actual, expected)
  if (actual.closedAtMs !== expected.closedAtMs || actual.reason !== expected.reason) fail('平仓时间或原因不一致')
  sameDecimal(actual.exitPrice, expected.exitPrice, '平仓价')
  sameDecimal(actual.realizedPnlUsd, expected.realizedPnlUsd, '已结算盈亏')
}

/** Reconstruct operations as their quotes arrive; never retain the full quote history. */
export function createLedgerValidator(currencyPair: CurrencyPair, targetAccount: AccountState, trades: TradeRecord[], initialAccount: AccountState = { balanceUsd: '10000', position: null }, priorTradeIds: string[] = [], checkpointTimestampMs = -1) {
  let ledger = structuredClone(initialAccount)
  let tradeIndex = 0
  let depletedTimestampMs = new MoneyDecimal(ledger.balanceUsd).lte(0) ? checkpointTimestampMs : null
  const ids = new Set(priorTradeIds)
  if (initialAccount.position) ids.delete(initialAccount.position.id)
  function targetPosition(): Position | null {
    return trades[tradeIndex] ?? targetAccount.position
  }
  function matchActive(): void {
    const target = targetPosition()
    if (!ledger.position || !target) fail('未结持仓与账本不一致')
    samePosition(target, ledger.position)
  }
  function settle(quote: MarketQuote): void {
    const trade = trades[tradeIndex]
    if (!trade || trade.closedAtMs !== quote.timestampMs) fail('平仓时间与行情不一致')
    if (trade.reason === 'equity-depleted' && !settleDepletedAccount(ledger, quote)) fail('资金耗尽平仓原因不一致')
    const result = closePosition(ledger, quote, trade.reason)
    verifyClosedTrade(trade, result.trade)
    ledger = result.account
    if (new MoneyDecimal(ledger.balanceUsd).lte(0)) depletedTimestampMs = quote.timestampMs
    tradeIndex += 1
  }
  if (ledger.position) {
    matchActive()
    ids.add(ledger.position.id)
  }
  return {
    push(quote: MarketQuote): void {
      if (depletedTimestampMs !== null && quote.timestampMs > depletedTimestampMs) fail('资金耗尽后不可继续推进行情')
      if (ledger.position) {
        matchActive()
        const trade = trades[tradeIndex]
        if (quote.timestampMs > checkpointTimestampMs && quote.timestampMs > ledger.position.openedAtMs && settleDepletedAccount(ledger, quote)) {
          if (!trade || trade.reason !== 'equity-depleted' || trade.closedAtMs !== quote.timestampMs) fail('跳过了资金耗尽停止规则')
          settle(quote)
        } else if (trade) {
          if (trade.closedAtMs < quote.timestampMs) fail('平仓时间与行情不一致')
          if (trade.closedAtMs === quote.timestampMs) settle(quote)
        }
      }
      while (!ledger.position) {
        const target = targetPosition()
        if (!target) break
        if (target.openedAtMs < quote.timestampMs || target.pair !== currencyPair) fail('交易关联或开仓时序不一致')
        if (target.openedAtMs > quote.timestampMs) break
        if (ids.has(target.id)) fail('交易标识重复')
        ids.add(target.id)
        ledger = openPosition(ledger, quote, currencyPair, target.direction, target.notionalUsd, target.id)
        matchActive()
        const trade = trades[tradeIndex]
        if (!trade) break
        if (trade.closedAtMs < quote.timestampMs) fail('平仓时间与行情不一致')
        if (trade.closedAtMs !== quote.timestampMs) break
        settle(quote)
      }
    },
    finish(): void {
      if (tradeIndex !== trades.length) fail('成交记录引用了不存在的行情')
      sameDecimal(targetAccount.balanceUsd, ledger.balanceUsd, '账户余额')
      if (targetAccount.position === null) {
        if (ledger.position) fail('持仓未结清')
      } else {
        if (!ledger.position) fail('持仓引用了不存在的行情')
        samePosition(targetAccount.position, ledger.position)
      }
    },
  }
}

function initializeFromConfig(currencyPair: CurrencyPair, config: SessionSimulationConfig): SimulationState {
  return initializeSimulation(currencyPair, config.seed, {
    startTimestampMs: config.startTimestampMs, maxFrames: config.maxFrames, scenario: config.scenario,
    originFrameIndex: config.originFrameIndex, initialTimestampMs: config.initialTimestampMs,
    initialBidPrice: config.initialBidPrice, initialAskPrice: config.initialAskPrice,
    parameterVersion: config.parameterVersion,
  })
}

export interface SessionHistoryValidator {
  pushFrame(input: unknown): void
  finish(): SessionSnapshot
}

/** Repository feeds one archived chunk at a time. Only the last 1,440 frames stay in RAM. */
export function createSessionHistoryValidator(input: unknown, useReplayCache = false): SessionHistoryValidator {
  const head = parseHead(input)
  const config = head.simulationConfig
  const cache = useReplayCache ? getSimulationReplayCache(head.pair, config) : null
  let source = cache?.initialState ?? initializeFromConfig(head.pair, config)
  const ledger = createLedgerValidator(head.pair, head.account, head.trades)
  const recent: MarketFrame[] = []
  let count = 0
  let previousTimestampMs = -1
  let previousClosePrice: string | null = null
  return {
    pushFrame(inputFrame): void {
      if (count > head.sourceState.frameIndex) fail('归档行情数量超过会话进度')
      const frame = parseFrame(inputFrame)
      verifyPhysicalFrame(frame, previousTimestampMs)
      if (count < config.originFrameIndex && head.retainedPrefixKind === 'legacy-v1') verifyRetainedFrame(frame, count, config.startTimestampMs, head.pair, previousClosePrice)
      if (count === config.originFrameIndex - 1 && (frame.quote.timestampMs !== config.initialTimestampMs || frame.quote.bidPrice !== config.initialBidPrice || frame.quote.askPrice !== config.initialAskPrice)) fail('衔接报价与保留行情不一致')
      if (count >= config.originFrameIndex) {
        const cacheIndex = count - config.originFrameIndex
        let step = cache?.steps[cacheIndex]
        if (!step) {
          const generated = advanceSimulation(source)
          if (!generated) fail('行情进度超过数据末尾')
          step = generated
          if (cache && cacheIndex < MAX_CACHED_REPLAY_STEPS) cache.steps.push(generated)
        }
        verifyFrame(frame, step.frame)
        source = step.state
      }
      if (count >= head.frameStartIndex) verifyFrame(frame, head.frames[count - head.frameStartIndex]!)
      ledger.push(frame.quote)
      recent.push(frame)
      if (recent.length > SESSION_FRAME_WINDOW_SIZE) recent.shift()
      previousTimestampMs = frame.quote.timestampMs
      previousClosePrice = frame.closePrice
      count += 1
    },
    finish(): SessionSnapshot {
      if (count !== head.sourceState.frameIndex + 1 || config.originFrameIndex > count) fail('归档行情缺失或数量不一致')
      if (!sameStructure(head.sourceState, source)) fail('模拟因素、事件或随机状态与已保存行情不一致')
      ledger.finish()
      return copySessionSnapshot({ ...head, sourceState: copySimulationState(source), frames: recent })
    },
  }
}

/** Data-only migration: validate saved prices and ledger, then anchor the sole current generator. */
function validateLegacySnapshot(snapshot: Record<string, unknown>): SessionSnapshot {
  const currencyPair = pair(snapshot.pair)
  if (!Array.isArray(snapshot.frames) || snapshot.frames.length === 0) fail('可见行情不存在')
  const frames = snapshot.frames.map(parseFrame)
  const source = record(snapshot.sourceState, '模拟状态')
  const frameIndex = integer(source.frameIndex, '行情进度')
  const startTimestampMs = integer(source.startTimestampMs, '开始时间')
  const seed = integer(source.seed, '随机种子')
  if (seed > 0xffff_ffff || source.pair !== currencyPair || frameIndex + 1 !== frames.length || startTimestampMs % 60_000 !== 0) fail('旧模拟进度或配置无效')
  const maxFrames = source.maxFrames === null ? null : integer(source.maxFrames, '行情数量', 1)
  if (maxFrames !== null && frameIndex >= maxFrames) fail('旧行情进度超过数据末尾')
  let scenario: SimulationScenario = 'standard'
  let parameterVersion: SimulationState['parameterVersion'] | undefined
  if (snapshot.schemaVersion === 1) {
    if (source.version !== 1 || integer(source.randomState, '旧随机状态', 1) > 0xffff_ffff) fail('旧模拟器状态无效')
    verifyRetainedFrames(frames, frames.length, startTimestampMs, currencyPair)
  } else {
    if (source.version !== 2) fail('旧模拟器版本不受支持')
    const compatible = { ...source, scheduledSearchThroughTimestampMs: source.scheduledSearchThroughTimestampMs ?? (record(source.upcomingScheduledEvent ?? {}, '旧公告').timestampMs ?? source.currentTimestampMs) } as unknown as SimulationState
    validateSimulationState(compatible)
    if (!sameStructure(record(snapshot.simulationConfig, '旧模拟配置'), createSimulationConfig(compatible))) fail('旧模拟配置与状态不一致')
    scenario = compatible.scenario
    parameterVersion = compatible.parameterVersion
    if (compatible.originFrameIndex > frames.length) fail('旧模拟起点超过行情')
    if (compatible.originFrameIndex > 0) {
      const anchor = frames[compatible.originFrameIndex - 1]!.quote
      if (anchor.timestampMs !== compatible.initialTimestampMs || anchor.bidPrice !== compatible.initialBidPrice || anchor.askPrice !== compatible.initialAskPrice) fail('旧衔接报价不一致')
    }
  }
  let previousTimestampMs = -1
  for (const frame of frames) {
    verifyPhysicalFrame(frame, previousTimestampMs)
    previousTimestampMs = frame.quote.timestampMs
  }
  const anchor = frames.at(-1)!.quote
  if (decimal(source.currentBidPrice, '旧当前 Bid', true) !== anchor.bidPrice || (snapshot.schemaVersion === 2 && (source.currentAskPrice !== anchor.askPrice || source.currentTimestampMs !== anchor.timestampMs))) fail('旧最后报价与模拟状态不一致')
  const account = parseAccount(snapshot.account)
  const trades = parseTrades(snapshot.trades)
  const ledger = createLedgerValidator(currencyPair, account, trades)
  frames.forEach((frame) => ledger.push(frame.quote))
  ledger.finish()
  const state = createSimulationFromQuote(currencyPair, seed, { startTimestampMs, maxFrames: null, scenario, parameterVersion }, { frameIndex, timestampMs: anchor.timestampMs, bidPrice: anchor.bidPrice, askPrice: anchor.askPrice })
  return {
    schemaVersion: 3, id: identifier(snapshot.id, '练习'), revision: integer(snapshot.revision, '保存版本'),
    pair: currencyPair, simulationConfig: createSimulationConfig(state), retainedPrefixKind: snapshot.schemaVersion === 1 ? 'legacy-v1' : 'legacy-v2', sourceState: state,
    frameStartIndex: Math.max(0, frames.length - SESSION_FRAME_WINDOW_SIZE), frames: frames.slice(-SESSION_FRAME_WINDOW_SIZE), account, trades,
  }
}

/** Validate a complete standalone snapshot. A rolling head requires its archived history. */
export function validateSessionSnapshot(input: unknown): SessionSnapshot {
  const snapshot = record(input, '快照')
  if (snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2) return validateLegacySnapshot(snapshot)
  if (snapshot.schemaVersion !== 3) fail('格式版本不受支持')
  if (snapshot.frameStartIndex !== 0) fail('滚动快照需要完整归档校验')
  const validator = createSessionHistoryValidator(snapshot, true)
  if (!Array.isArray(snapshot.frames)) fail('可见行情不存在')
  snapshot.frames.forEach((frame) => validator.pushFrame(frame))
  return validator.finish()
}

/** The previous head must already be fully validated and kept privately by its owner. */
export function validateSessionTransition(previous: SessionSnapshot, input: unknown): SessionSnapshot {
  const next = parseHead(input)
  if (next.id !== previous.id || next.pair !== previous.pair || next.retainedPrefixKind !== previous.retainedPrefixKind || !sameStructure(next.simulationConfig, previous.simulationConfig)) fail('练习或模拟配置不可原地改变')
  if (next.revision !== previous.revision && next.revision !== previous.revision + 1) fail('保存版本与当前练习不一致')
  const addedCount = next.sourceState.frameIndex - previous.sourceState.frameIndex
  if (addedCount < 0 || addedCount > SESSION_FRAME_WINDOW_SIZE || next.frameStartIndex > previous.sourceState.frameIndex + 1) fail('新增行情数量或窗口不连续')
  const overlapStart = Math.max(previous.frameStartIndex, next.frameStartIndex)
  for (let index = overlapStart; index <= previous.sourceState.frameIndex; index += 1) verifyFrame(next.frames[index - next.frameStartIndex]!, previous.frames[index - previous.frameStartIndex]!)
  let source = previous.sourceState
  for (let index = previous.sourceState.frameIndex + 1; index <= next.sourceState.frameIndex; index += 1) {
    const step = advanceSimulation(source)
    if (!step) fail('行情进度超过数据末尾')
    verifyFrame(next.frames[index - next.frameStartIndex]!, step.frame)
    source = step.state
  }
  if (!sameStructure(next.sourceState, source)) fail('模拟因素、事件或随机状态与新增行情不一致')
  if (next.trades.length < previous.trades.length || !previous.trades.every((trade, index) => sameStructure(trade, next.trades[index]))) fail('已有成交记录不可改写')
  const checkpoint = previous.frames.at(-1)!.quote
  const ledger = createLedgerValidator(next.pair, next.account, next.trades.slice(previous.trades.length), previous.account, previous.trades.map((trade) => trade.id), checkpoint.timestampMs)
  ledger.push(checkpoint)
  for (let index = previous.sourceState.frameIndex + 1; index <= next.sourceState.frameIndex; index += 1) ledger.push(next.frames[index - next.frameStartIndex]!.quote)
  ledger.finish()
  return copySessionSnapshot(next)
}
