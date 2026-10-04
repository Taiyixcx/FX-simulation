import { INITIAL_BALANCE_USD } from '../engine/account'
import { createHistory, validateHistoryState } from '../engine/historySource'
import type { HistoryDataset, HistoryState } from '../engine/historyTypes'
import type { AccountState, CurrencyPair, MarketFrame, TradeRecord } from '../engine/types'
import { createLedgerValidator, parseAccount, parseTrades, SESSION_FRAME_WINDOW_SIZE } from './sessionSnapshot'
import type { SessionSnapshot } from './sessionSnapshot'

export interface HistoricalSessionSnapshot {
  schemaVersion: 4
  mode: 'historical'
  id: string
  revision: number
  pair: CurrencyPair
  sourceState: HistoryState
  /** Absent in legacy schema 4: trading began at dataset index zero. */
  historyStart?: HistoryPracticeStart
  frameStartIndex: number
  frames: MarketFrame[]
  account: AccountState
  trades: TradeRecord[]
}

export interface HistoryPracticeStart {
  version: 1
  startFrameIndex: number
  /** Actual observed prefix count, excluding the first tradable frame. */
  warmupFrameCount: number
}

export interface HistoryPracticeOptions {
  startFrameIndex?: number
  warmupFrameCount?: number
}

export function getHistoryPracticeStart(snapshot: HistoricalSessionSnapshot): HistoryPracticeStart {
  return snapshot.historyStart ?? { version: 1, startFrameIndex: 0, warmupFrameCount: 0 }
}

export type PracticeSnapshot = SessionSnapshot | HistoricalSessionSnapshot

export function isHistoricalSnapshot(snapshot: PracticeSnapshot): snapshot is HistoricalSessionSnapshot {
  return snapshot.schemaVersion === 4
}

export function copyPracticeSnapshot<T extends PracticeSnapshot>(snapshot: T): T {
  return structuredClone(snapshot)
}

export function createHistoricalSnapshot(dataset: HistoryDataset, id: string = crypto.randomUUID(), options: HistoryPracticeOptions = {}): HistoricalSessionSnapshot {
  const startFrameIndex = options.startFrameIndex ?? 0
  const requestedWarmup = options.warmupFrameCount ?? 0
  const first = createHistory(dataset, startFrameIndex)
  if (!Number.isSafeInteger(requestedWarmup) || requestedWarmup < 0 || requestedWarmup >= SESSION_FRAME_WINDOW_SIZE) fail(`预热须为 0 至 ${SESSION_FRAME_WINDOW_SIZE - 1} 根`)
  const warmupFrameCount = Math.min(startFrameIndex, requestedWarmup)
  const frameStartIndex = startFrameIndex - warmupFrameCount
  return {
    schemaVersion: 4, mode: 'historical', id, revision: 0, pair: dataset.pair,
    historyStart: { version: 1, startFrameIndex, warmupFrameCount },
    sourceState: first.state, frameStartIndex, frames: structuredClone(dataset.frames.slice(frameStartIndex, startFrameIndex + 1)),
    account: { balanceUsd: INITIAL_BALANCE_USD, position: null }, trades: [],
  }
}

function fail(message: string): never {
  throw new Error(`历史练习快照无效：${message}。原有数据没有被覆盖。`)
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(`${field} 必须是对象`)
  return input as Record<string, unknown>
}

function integer(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) fail(`${field} 必须是有效整数`)
  return input
}

function identifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input)) fail('练习标识损坏')
  return input
}

function sameFrame(input: unknown, expected: MarketFrame): void {
  const frame = record(input, '行情')
  const quote = record(frame.quote, '报价')
  if (quote.timestampMs !== expected.quote.timestampMs || quote.bidPrice !== expected.quote.bidPrice || quote.askPrice !== expected.quote.askPrice || quote.askSource !== expected.quote.askSource
    || frame.openPrice !== expected.openPrice || frame.highPrice !== expected.highPrice || frame.lowPrice !== expected.lowPrice || frame.closePrice !== expected.closePrice) {
    fail('行情窗口与原始数据集不一致')
  }
}

/** Dataset must have passed the complete dataset and fingerprint validator first. */
function parseHead(input: unknown, dataset: HistoryDataset): HistoricalSessionSnapshot {
  const snapshot = record(input, '快照')
  if (snapshot.schemaVersion !== 4 || snapshot.mode !== 'historical') fail('格式版本或练习模式不受支持')
  if (snapshot.pair !== dataset.pair) fail('品种与原始数据集不一致')
  const source = record(snapshot.sourceState, '历史进度') as unknown as HistoryState
  validateHistoryState(source, dataset)
  const sourceState: HistoryState = {
    datasetId: source.datasetId, fingerprint: source.fingerprint, frameIndex: source.frameIndex,
    maxFrames: source.maxFrames, currentTimestampMs: source.currentTimestampMs,
  }
  let historyStart: HistoryPracticeStart | undefined
  if (snapshot.historyStart !== undefined) {
    const start = record(snapshot.historyStart, '历史练习起点')
    if (start.version !== 1 || Object.keys(start).some(key => !['version', 'startFrameIndex', 'warmupFrameCount'].includes(key))) fail('历史练习起点版本或字段不受支持')
    const startFrameIndex = integer(start.startFrameIndex, '练习起点索引')
    const warmupFrameCount = integer(start.warmupFrameCount, '预热根数')
    if (startFrameIndex > sourceState.frameIndex || warmupFrameCount > startFrameIndex || warmupFrameCount >= SESSION_FRAME_WINDOW_SIZE) fail('练习起点或预热超出已发生行情范围')
    historyStart = { version: 1, startFrameIndex, warmupFrameCount }
  }
  const frameStartIndex = integer(snapshot.frameStartIndex, '行情窗口起点')
  const firstObservableIndex = (historyStart?.startFrameIndex ?? 0) - (historyStart?.warmupFrameCount ?? 0)
  const expectedLength = Math.min(sourceState.frameIndex + 1 - firstObservableIndex, SESSION_FRAME_WINDOW_SIZE)
  if (!Array.isArray(snapshot.frames) || snapshot.frames.length !== expectedLength || frameStartIndex !== sourceState.frameIndex + 1 - expectedLength) fail('行情窗口数量或索引不一致')
  const frames: MarketFrame[] = []
  for (let index = 0; index < snapshot.frames.length; index += 1) {
    const expected = dataset.frames[frameStartIndex + index]!
    sameFrame(snapshot.frames[index], expected)
    frames.push({
      quote: {
        timestampMs: expected.quote.timestampMs, bidPrice: expected.quote.bidPrice,
        askPrice: expected.quote.askPrice, askSource: expected.quote.askSource,
      },
      openPrice: expected.openPrice, highPrice: expected.highPrice,
      lowPrice: expected.lowPrice, closePrice: expected.closePrice,
    })
  }
  return {
    schemaVersion: 4, mode: 'historical', id: identifier(snapshot.id), revision: integer(snapshot.revision, '保存版本'),
    pair: dataset.pair, sourceState, frameStartIndex, frames,
    ...(historyStart ? { historyStart } : {}),
    account: parseAccount(snapshot.account), trades: parseTrades(snapshot.trades),
  }
}

/** Only progressed quotes enter the ledger, including trades older than the visible window. */
export function validateHistoricalSnapshot(input: unknown, dataset: HistoryDataset): HistoricalSessionSnapshot {
  const snapshot = parseHead(input, dataset)
  const ledger = createLedgerValidator(snapshot.pair, snapshot.account, snapshot.trades)
  for (let index = getHistoryPracticeStart(snapshot).startFrameIndex; index <= snapshot.sourceState.frameIndex; index += 1) ledger.push(dataset.frames[index]!.quote)
  ledger.finish()
  return copyPracticeSnapshot(snapshot)
}

/** A private, fully validated checkpoint lets saves validate only newly advanced quotes. */
export function validateHistoricalTransition(previous: HistoricalSessionSnapshot, input: unknown, dataset: HistoryDataset): HistoricalSessionSnapshot {
  const next = parseHead(input, dataset)
  if (next.id !== previous.id || next.pair !== previous.pair || next.sourceState.datasetId !== previous.sourceState.datasetId || next.sourceState.fingerprint !== previous.sourceState.fingerprint || next.sourceState.maxFrames !== previous.sourceState.maxFrames) fail('练习或原始数据集不可原地改变')
  if (JSON.stringify(next.historyStart) !== JSON.stringify(previous.historyStart)) fail('历史练习起点与预热不可原地改变')
  if (next.revision !== previous.revision && next.revision !== previous.revision + 1) fail('保存版本与当前练习不一致')
  const addedCount = next.sourceState.frameIndex - previous.sourceState.frameIndex
  if (addedCount < 0 || addedCount > SESSION_FRAME_WINDOW_SIZE || next.frameStartIndex > previous.sourceState.frameIndex + 1) fail('新增行情数量或窗口不连续')
  if (next.trades.length < previous.trades.length || !previous.trades.every((trade, index) => JSON.stringify(trade) === JSON.stringify(next.trades[index]))) fail('已有成交记录不可改写')
  const checkpoint = previous.frames.at(-1)!.quote
  const ledger = createLedgerValidator(next.pair, next.account, next.trades.slice(previous.trades.length), previous.account, previous.trades.map(trade => trade.id), checkpoint.timestampMs)
  ledger.push(checkpoint)
  for (let index = previous.sourceState.frameIndex + 1; index <= next.sourceState.frameIndex; index += 1) ledger.push(dataset.frames[index]!.quote)
  ledger.finish()
  return copyPracticeSnapshot(next)
}
