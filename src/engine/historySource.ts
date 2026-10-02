import { validateCurrencyPair } from './account'
import { decimalToString, readDecimalString } from './decimal'
import type { HistoryDataset, HistoryDatasetSummary, HistoryQuoteType, HistoryState, HistoryStep } from './historyTypes'
import type { MarketFrame } from './types'

export const HISTORY_MAX_FRAMES = 200_000
export const HISTORY_MINUTE_MS = 60_000

// A verified dataset is frozen, so later calls cannot reuse a check after mutation.
const verifiedDatasets = new WeakSet<HistoryDataset>()

function fail(message: string): never {
  throw new Error(message)
}

export function validateHistoryFrame(frame: MarketFrame, previousTimestampMs = -1): void {
  if (!frame || typeof frame !== 'object' || !frame.quote || typeof frame.quote !== 'object') fail('历史行情结构无效。')
  const { quote } = frame
  if (Object.keys(frame).some((key) => !['quote', 'openPrice', 'highPrice', 'lowPrice', 'closePrice'].includes(key))
    || Object.keys(quote).some((key) => !['timestampMs', 'bidPrice', 'askPrice', 'askSource'].includes(key))) fail('历史行情只能包含已定义的分钟 OHLC 和同步报价字段。')
  if (!Number.isSafeInteger(quote.timestampMs) || quote.timestampMs < 0 || quote.timestampMs > 253_402_300_740_000
    || quote.timestampMs % HISTORY_MINUTE_MS !== 0 || quote.timestampMs <= previousTimestampMs) fail('历史时间必须是严格递增的有效 UTC 完整分钟。')
  if (!['source', 'training'].includes(quote.askSource)) fail('历史 Ask 来源无效。')
  const prices = [frame.openPrice, frame.highPrice, frame.lowPrice, frame.closePrice, quote.bidPrice, quote.askPrice]
  const decimals = prices.map((price) => {
    if (typeof price !== 'string' || price.length > 80) fail('历史报价必须是有效的正十进制数。')
    const decimal = readDecimalString(price, '历史报价', 'invalid-quote')
    if (decimal.lte(0)) fail('历史报价必须为正数。')
    return decimal
  })
  const [open, high, low, close, bid, ask] = decimals
  if (low.gt(high) || open.lt(low) || open.gt(high) || close.lt(low) || close.gt(high)) fail('历史 Bid OHLC 高低价关系无效。')
  if (!bid.eq(close) || ask.lt(bid)) fail('历史报价必须以 Bid 收盘价及不低于 Bid 的 Ask 交易。')
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getHistoryQuoteType(frames: readonly MarketFrame[]): HistoryQuoteType {
  const hasSource = frames.some((frame) => frame.quote.askSource === 'source')
  const hasTraining = frames.some((frame) => frame.quote.askSource === 'training')
  return hasSource && hasTraining ? 'mixed' : hasSource ? 'source' : 'training'
}

export async function calculateHistoryFingerprint(pair: HistoryDataset['pair'], frames: readonly MarketFrame[]): Promise<string> {
  const records = frames.map((frame) => [
    frame.quote.timestampMs,
    ...[frame.openPrice, frame.highPrice, frame.lowPrice, frame.closePrice, frame.quote.bidPrice, frame.quote.askPrice]
      .map((price) => decimalToString(readDecimalString(price, '历史报价', 'invalid-quote'))),
    frame.quote.askSource,
  ])
  return sha256Text(JSON.stringify([pair, records]))
}

export function getHistoryDatasetId(pair: HistoryDataset['pair'], fingerprint: string): string {
  return `history-${pair.replace('/', '')}-${fingerprint}`
}

/** Dataset lists inspect metadata only; a selected dataset still needs full validation. */
export function validateHistoryDatasetSummary(input: unknown): HistoryDatasetSummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('历史数据集摘要无效。')
  const summary = input as Record<string, unknown>
  validateCurrencyPair(summary.pair as HistoryDataset['pair'])
  if (typeof summary.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(summary.fingerprint)
    || summary.id !== getHistoryDatasetId(summary.pair as HistoryDataset['pair'], summary.fingerprint)) fail('历史数据集标识或校验信息无效。')
  if (!summary.metadata || typeof summary.metadata !== 'object' || Array.isArray(summary.metadata)) fail('历史来源元信息无效。')
  const metadata = summary.metadata as Record<string, unknown>
  for (const key of ['label', 'sourceName', 'sourceUrl', 'originalTimezone', 'conversionNotes', 'conversionVersion', 'licenseNotes'] as const) {
    if (typeof metadata[key] !== 'string' || metadata[key].length > 2_000) fail('历史来源文字无效或过长。')
  }
  if (!(metadata.label as string).trim() || !(metadata.sourceName as string).trim() || !(metadata.originalTimezone as string).trim()
    || typeof metadata.verified !== 'boolean' || metadata.period !== 'M1' || !['source', 'training', 'mixed'].includes(metadata.quoteType as string)
    || typeof metadata.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.fileSha256)) fail('历史来源或文件校验信息无效。')
  const startTimestampMs = metadata.startTimestampMs
  const endTimestampMs = metadata.endTimestampMs
  const recordCount = metadata.recordCount
  if (typeof startTimestampMs !== 'number' || typeof endTimestampMs !== 'number' || typeof recordCount !== 'number'
    || !Number.isSafeInteger(startTimestampMs) || !Number.isSafeInteger(endTimestampMs)
    || startTimestampMs < 0 || endTimestampMs > 253_402_300_740_000 || endTimestampMs < startTimestampMs
    || startTimestampMs % HISTORY_MINUTE_MS !== 0 || endTimestampMs % HISTORY_MINUTE_MS !== 0
    || !Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > HISTORY_MAX_FRAMES
    || recordCount > (endTimestampMs - startTimestampMs) / HISTORY_MINUTE_MS + 1) fail('历史摘要的时间范围或记录数无效。')
  const sourceUrl = metadata.sourceUrl as string
  if (sourceUrl) {
    let url: URL
    try { url = new URL(sourceUrl) } catch { fail('历史来源链接无效。') }
    if (!['http:', 'https:'].includes(url.protocol)) fail('历史来源链接须使用 HTTP 或 HTTPS。')
  }
  return {
    id: summary.id as string, pair: summary.pair as HistoryDataset['pair'], fingerprint: summary.fingerprint,
    metadata: {
      label: metadata.label as string, sourceName: metadata.sourceName as string, sourceUrl,
      originalTimezone: metadata.originalTimezone as string, verified: metadata.verified as boolean,
      period: 'M1', quoteType: metadata.quoteType as HistoryQuoteType, startTimestampMs, endTimestampMs, recordCount,
      conversionNotes: metadata.conversionNotes as string, conversionVersion: metadata.conversionVersion as string,
      licenseNotes: metadata.licenseNotes as string, fileSha256: metadata.fileSha256 as string,
    },
  }
}

/** Validate persisted/untrusted content before it becomes available for replay. */
export async function validateHistoryDataset(dataset: HistoryDataset): Promise<void> {
  if (verifiedDatasets.has(dataset)) return
  if (!dataset || typeof dataset !== 'object') fail('历史数据集无效。')
  validateHistoryDatasetSummary(dataset)
  if (!Array.isArray(dataset.frames) || dataset.frames.length < 1 || dataset.frames.length > HISTORY_MAX_FRAMES) fail(`历史数据集须含 1 至 ${HISTORY_MAX_FRAMES.toLocaleString('en-US')} 根行情。`)
  let previousTimestampMs = -1
  for (const frame of dataset.frames) {
    validateHistoryFrame(frame, previousTimestampMs)
    if (frame.quote.askSource === 'training') {
      const expectedAsk = readDecimalString(frame.closePrice, '历史 Bid', 'invalid-quote')
        .plus(dataset.pair === 'EUR/USD' ? '0.0001' : '0.00015')
      if (!expectedAsk.eq(frame.quote.askPrice)) fail('历史训练 Ask 与对应品种的固定训练点差不一致。')
    }
    previousTimestampMs = frame.quote.timestampMs
  }
  const metadata = dataset.metadata
  if (!metadata || typeof metadata !== 'object' || typeof metadata.verified !== 'boolean' || metadata.period !== 'M1'
    || metadata.startTimestampMs !== dataset.frames[0].quote.timestampMs
    || metadata.endTimestampMs !== dataset.frames.at(-1)!.quote.timestampMs
    || metadata.recordCount !== dataset.frames.length || metadata.quoteType !== getHistoryQuoteType(dataset.frames)) fail('历史数据集元信息与实际行情不一致。')
  // Freeze before yielding to the digest: callers cannot change the checked input
  // while an asynchronous validation is in progress.
  for (const frame of dataset.frames) {
    Object.freeze(frame.quote)
    Object.freeze(frame)
  }
  Object.freeze(dataset.frames)
  Object.freeze(dataset.metadata)
  Object.freeze(dataset)
  if (dataset.fingerprint !== await calculateHistoryFingerprint(dataset.pair, dataset.frames)) fail('历史数据集内容校验失败，不能继续回放。')
  verifiedDatasets.add(dataset)
}

function requireVerifiedDataset(dataset: HistoryDataset): void {
  if (!verifiedDatasets.has(dataset)) fail('历史数据集须先通过全量校验后才能回放。')
}

export function validateHistoryState(state: HistoryState, dataset: HistoryDataset): void {
  requireVerifiedDataset(dataset)
  if (!state || typeof state !== 'object' || state.datasetId !== dataset.id || state.fingerprint !== dataset.fingerprint
    || state.maxFrames !== dataset.frames.length || !Number.isSafeInteger(state.frameIndex)
    || state.frameIndex < 0 || state.frameIndex >= dataset.frames.length
    || state.currentTimestampMs !== dataset.frames[state.frameIndex].quote.timestampMs) fail('历史数据集或已推进进度与会话不一致。')
}

function getStep(dataset: HistoryDataset, frameIndex: number): HistoryStep {
  const originalFrame = dataset.frames[frameIndex]
  return {
    state: { datasetId: dataset.id, fingerprint: dataset.fingerprint, frameIndex, maxFrames: dataset.frames.length, currentTimestampMs: originalFrame.quote.timestampMs },
    frame: {
      openPrice: originalFrame.openPrice, highPrice: originalFrame.highPrice,
      lowPrice: originalFrame.lowPrice, closePrice: originalFrame.closePrice,
      quote: {
        timestampMs: originalFrame.quote.timestampMs, bidPrice: originalFrame.quote.bidPrice,
        askPrice: originalFrame.quote.askPrice, askSource: originalFrame.quote.askSource,
      },
    },
  }
}

/** Expose the first completed minute only, regardless of the total dataset size. */
export function createHistory(dataset: HistoryDataset): HistoryStep {
  requireVerifiedDataset(dataset)
  return getStep(dataset, 0)
}

export function advanceHistory(state: HistoryState, dataset: HistoryDataset): HistoryStep | null {
  validateHistoryState(state, dataset)
  if (state.frameIndex + 1 >= dataset.frames.length) return null
  return getStep(dataset, state.frameIndex + 1)
}
