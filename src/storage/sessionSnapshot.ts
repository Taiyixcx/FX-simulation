import { calculateAccount } from '../engine/account'
import { MoneyDecimal } from '../engine/decimal'
import { closePosition, openPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulation, validateSimulationState } from '../engine/simulationSource'
import type { AccountState, CurrencyPair, MarketFrame, Position, SimulationState, TradeRecord } from '../engine/types'

export interface SessionSnapshot {
  schemaVersion: 1
  id: string
  revision: number
  pair: CurrencyPair
  sourceState: SimulationState
  frames: MarketFrame[]
  account: AccountState
  trades: TradeRecord[]
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

/** Validate untrusted DTOs, including deterministic market history and the full account ledger. */
export function validateSessionSnapshot(input: unknown): SessionSnapshot {
  const snapshot = record(input, '快照')
  if (snapshot.schemaVersion !== 1) fail('格式版本不受支持')
  const id = identifier(snapshot.id, '练习')
  const revision = integer(snapshot.revision, '保存版本')
  const currencyPair = pair(snapshot.pair)
  const source = record(snapshot.sourceState, '模拟状态')
  if (source.version !== 1) fail('模拟器版本不受支持')
  const sourceState: SimulationState = {
    version: 1,
    pair: pair(source.pair),
    seed: integer(source.seed, '随机种子'),
    randomState: integer(source.randomState, '随机状态'),
    frameIndex: integer(source.frameIndex, '行情进度'),
    startTimestampMs: integer(source.startTimestampMs, '开始时间'),
    maxFrames: integer(source.maxFrames, '行情数量', 1),
    currentBidPrice: decimal(source.currentBidPrice, '当前 Bid', true),
  }
  validateSimulationState(sourceState)
  if (sourceState.pair !== currencyPair) fail('模拟状态品种不一致')
  if (!Array.isArray(snapshot.frames) || snapshot.frames.length !== sourceState.frameIndex + 1) fail('可见行情与进度不一致')
  const frames = snapshot.frames.map(parseFrame)
  let replay = createSimulation(currencyPair, sourceState.seed, {
    startTimestampMs: sourceState.startTimestampMs,
    maxFrames: sourceState.maxFrames,
  })
  for (const [index, frame] of frames.entries()) {
    if (index > 0) {
      const next = advanceSimulation(replay.state)
      if (!next) fail('行情进度超过数据末尾')
      replay = next
    }
    const expected = replay.frame
    if (frame.quote.timestampMs !== expected.quote.timestampMs || frame.quote.askSource !== expected.quote.askSource) fail('行情时序或来源不一致')
    sameDecimal(frame.quote.bidPrice, expected.quote.bidPrice, 'Bid')
    sameDecimal(frame.quote.askPrice, expected.quote.askPrice, 'Ask')
    sameDecimal(frame.openPrice, expected.openPrice, '开盘价')
    sameDecimal(frame.highPrice, expected.highPrice, '最高价')
    sameDecimal(frame.lowPrice, expected.lowPrice, '最低价')
    sameDecimal(frame.closePrice, expected.closePrice, '收盘价')
  }
  if (replay.state.randomState !== sourceState.randomState || replay.state.frameIndex !== sourceState.frameIndex) fail('模拟随机状态与进度不一致')
  sameDecimal(sourceState.currentBidPrice, replay.state.currentBidPrice, '当前 Bid')
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
  return { schemaVersion: 1, id, revision, pair: currencyPair, sourceState, frames, account, trades }
}
