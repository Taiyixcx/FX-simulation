import type { MarketFrame, Position, TradeDirection, TradeRecord } from '../../engine/types'

export interface ChartViewport {
  from: number
  to: number
}

export interface ChartPriceRange {
  minValue: number
  maxValue: number
}

export interface TradeMarker {
  id: string
  timestampMs: number
  timestampKey: string
  price: number
  isBuying: boolean
  text: string
}

export const DEFAULT_VISIBLE_FRAMES = 80

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Category keys retain UTC milliseconds; numeric category coordinates would be indices. */
export function toTimestampKey(timestampMs: number): string {
  return String(timestampMs)
}

export function formatChartTime(timestampMs: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestampMs))
}

export function formatTimeAxisTick(timestampKey: string): string {
  return TIME_FORMATTER.format(new Date(Number(timestampKey)))
}

export function toLinePoint(frame: MarketFrame): number {
  return Number(frame.quote.bidPrice)
}

/** ECharts candles use open, close, low, high, rather than financial OHLC order. */
export function toCandlestickPoint(frame: MarketFrame): [number, number, number, number] {
  return [
    Number(frame.openPrice),
    Number(frame.closePrice),
    Number(frame.lowPrice),
    Number(frame.highPrice),
  ]
}

export function formatChartPrice(price: string | number): string {
  return Number(price).toFixed(5)
}

function createTradeMarker(
  position: Position,
  action: 'open' | 'close',
  timestampMs: number,
  actualPrice: string,
): TradeMarker {
  const isBuying = (position.direction === 'long') === (action === 'open')
  const directionLabels: Record<TradeDirection, string> = { long: '做多', short: '做空' }
  const label = `${directionLabels[position.direction]}${action === 'open' ? '开仓' : '平仓'}`
  return {
    id: `${position.id}-${action}`,
    timestampMs,
    timestampKey: toTimestampKey(timestampMs),
    price: Number(actualPrice),
    isBuying,
    text: `${label}·${isBuying ? '买' : '卖'} ${formatChartPrice(actualPrice)}`,
  }
}

/** Marker timestamps must belong to the progressed prefix, never a future minute. */
export function buildTradeMarkers(
  frames: readonly MarketFrame[],
  position: Position | null,
  trades: readonly TradeRecord[],
): TradeMarker[] {
  const progressedTimestamps = new Set(frames.map((frame) => frame.quote.timestampMs))
  const markers: TradeMarker[] = []
  for (const trade of trades) {
    if (progressedTimestamps.has(trade.openedAtMs)) {
      markers.push(createTradeMarker(trade, 'open', trade.openedAtMs, trade.entryPrice))
    }
    if (progressedTimestamps.has(trade.closedAtMs)) {
      markers.push(createTradeMarker(trade, 'close', trade.closedAtMs, trade.exitPrice))
    }
  }
  if (position && progressedTimestamps.has(position.openedAtMs)) {
    markers.push(createTradeMarker(position, 'open', position.openedAtMs, position.entryPrice))
  }
  return markers.sort((left, right) => left.timestampMs - right.timestampMs)
}

export function initialViewport(frameCount: number): ChartViewport {
  const to = Math.max(0, frameCount - 1)
  return { from: Math.max(0, frameCount - DEFAULT_VISIBLE_FRAMES), to }
}

export function clampViewport(viewport: ChartViewport, frameCount: number): ChartViewport {
  const lastIndex = Math.max(0, frameCount - 1)
  const from = Math.max(0, Math.min(lastIndex, Math.round(viewport.from)))
  const to = Math.max(from, Math.min(lastIndex, Math.round(viewport.to)))
  return { from, to }
}

/** Absolute indices avoid a drifting historical window as the series grows. */
export function advanceViewport(
  previous: ChartViewport,
  oldFrameCount: number,
  frameCount: number,
  isFollowingLatest: boolean,
): ChartViewport {
  if (!isFollowingLatest) return clampViewport(previous, frameCount)
  if (previous.from === 0 && previous.to === oldFrameCount - 1
    && oldFrameCount < DEFAULT_VISIBLE_FRAMES) return initialViewport(frameCount)
  const visibleCount = Math.max(1, previous.to - previous.from + 1)
  const to = Math.max(0, frameCount - 1)
  return { from: Math.max(0, to - visibleCount + 1), to }
}

/** Offscreen closed trades do not pin the scale; the active entry remains visible. */
export function getVisiblePriceRange(
  frames: readonly MarketFrame[],
  viewport: ChartViewport,
  chartType: 'line' | 'candlestick',
  markers: readonly TradeMarker[],
  positionEntryPrice: string | null = null,
): ChartPriceRange {
  const visibleFrames = frames.slice(viewport.from, viewport.to + 1)
  if (visibleFrames.length === 0) return { minValue: 0, maxValue: 1 }
  const prices = visibleFrames.flatMap(frame => chartType === 'line'
    ? [Number(frame.quote.bidPrice)]
    : [Number(frame.lowPrice), Number(frame.highPrice)])
  const fromTimestampMs = visibleFrames[0]!.quote.timestampMs
  const toTimestampMs = visibleFrames.at(-1)!.quote.timestampMs
  for (const marker of markers) {
    if (marker.timestampMs >= fromTimestampMs && marker.timestampMs <= toTimestampMs) {
      prices.push(marker.price)
    }
  }
  if (positionEntryPrice !== null) prices.push(Number(positionEntryPrice))
  const minValue = Math.min(...prices)
  const maxValue = Math.max(...prices)
  const padding = Math.max(0.00008, (maxValue - minValue) * 0.18)
  return { minValue: minValue - padding, maxValue: maxValue + padding }
}
