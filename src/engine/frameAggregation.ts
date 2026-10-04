import { MoneyDecimal, decimalToString } from './decimal'
import { HISTORY_MINUTE_MS, validateHistoryFrame } from './historySource'
import type { MarketFrame } from './types'

export type ChartPeriod = 'M1' | 'M5' | 'H1'

export interface AggregatedMarketFrame extends MarketFrame {
  /** UTC interval boundaries, not additional observed quote timestamps. */
  intervalStartMs: number
  intervalEndMs: number
  sourceFrameCount: number
  isComplete: boolean
  hasGap: boolean
}

const PERIOD_MINUTES: Record<ChartPeriod, number> = { M1: 1, M5: 5, H1: 60 }

/** Consume completed M1 frames only. No source dataset or future frame is read. */
export function aggregateMarketFrames(frames: readonly MarketFrame[], period: ChartPeriod): AggregatedMarketFrame[] {
  return aggregateFrames(frames, period, true)
}

/** Display-only path for frames already validated by the source/session repository.
 * It cannot certify input for saving, trading or restoring any account.
 */
export function aggregateValidatedMarketFrames(frames: readonly MarketFrame[], period: ChartPeriod): AggregatedMarketFrame[] {
  return aggregateFrames(frames, period, false)
}

function aggregateFrames(frames: readonly MarketFrame[], period: ChartPeriod, shouldValidatePrices: boolean): AggregatedMarketFrame[] {
  const minutes = PERIOD_MINUTES[period]
  if (!minutes) throw new Error('不支持该图表周期。')
  const intervalMs = minutes * HISTORY_MINUTE_MS
  const aggregated: AggregatedMarketFrame[] = []
  let previousTimestampMs = -1
  for (const frame of frames) {
    if (shouldValidatePrices) validateHistoryFrame(frame, previousTimestampMs)
    else if (!Number.isSafeInteger(frame.quote.timestampMs) || frame.quote.timestampMs < 0 || frame.quote.timestampMs % HISTORY_MINUTE_MS !== 0 || frame.quote.timestampMs <= previousTimestampMs) throw new Error('图表行情须为严格递增的完整分钟。')
    previousTimestampMs = frame.quote.timestampMs
    // A frame completed exactly at 09:00 belongs to the preceding interval.
    const intervalStartMs = Math.floor((frame.quote.timestampMs - 1) / intervalMs) * intervalMs
    let current = aggregated.at(-1)
    if (!current || current.intervalStartMs !== intervalStartMs) {
      current = {
        quote: { ...frame.quote }, openPrice: frame.openPrice, highPrice: frame.highPrice,
        lowPrice: frame.lowPrice, closePrice: frame.closePrice,
        intervalStartMs, intervalEndMs: intervalStartMs + intervalMs,
        sourceFrameCount: 1, isComplete: false, hasGap: false,
      }
      aggregated.push(current)
    } else {
      current.highPrice = decimalToString(MoneyDecimal.max(current.highPrice, frame.highPrice))
      current.lowPrice = decimalToString(MoneyDecimal.min(current.lowPrice, frame.lowPrice))
      current.closePrice = frame.closePrice
      current.quote = { ...frame.quote }
      current.sourceFrameCount += 1
    }
  }
  const progressedTimestampMs = frames.at(-1)?.quote.timestampMs ?? 0
  for (const frame of aggregated) {
    const observedMinutes = Math.min(minutes, (Math.min(progressedTimestampMs, frame.intervalEndMs) - frame.intervalStartMs) / HISTORY_MINUTE_MS)
    frame.hasGap = frame.sourceFrameCount < observedMinutes
    frame.isComplete = frame.sourceFrameCount === minutes && frame.quote.timestampMs === frame.intervalEndMs
  }
  return aggregated
}
