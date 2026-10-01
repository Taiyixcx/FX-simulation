import { TickMarkType } from 'lightweight-charts'
import type {
  CandlestickData,
  LineData,
  IRange,
  PriceRange,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import type { MarketFrame, Position, TradeDirection, TradeRecord } from '../../engine/types'

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

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
})

/** Only this adapter converts internal UTC milliseconds to chart seconds. */
export function toTimeSec(timestampMs: number): UTCTimestamp {
  return Math.floor(timestampMs / 1000) as UTCTimestamp
}

export function formatChartTime(time: Time): string {
  if (typeof time === 'number') return DATE_TIME_FORMATTER.format(new Date(time * 1000))
  if (typeof time === 'string') return time
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
}

export function formatTimeAxisTick(time: Time, tickMarkType: TickMarkType): string {
  if (typeof time !== 'number') return formatChartTime(time)
  const date = new Date(time * 1000)
  if (tickMarkType === TickMarkType.Year) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
    }).format(date)
  }
  if (tickMarkType === TickMarkType.Month || tickMarkType === TickMarkType.DayOfMonth) {
    return DATE_FORMATTER.format(date)
  }
  return TIME_FORMATTER.format(date)
}

export function toLinePoint(frame: MarketFrame): LineData<Time> {
  return { time: toTimeSec(frame.quote.timestampMs), value: Number(frame.quote.bidPrice) }
}

export function toCandlestickPoint(frame: MarketFrame): CandlestickData<Time> {
  return {
    time: toTimeSec(frame.quote.timestampMs),
    open: Number(frame.openPrice),
    high: Number(frame.highPrice),
    low: Number(frame.lowPrice),
    close: Number(frame.closePrice),
  }
}

export function formatChartPrice(price: string): string {
  return Number(price).toFixed(5)
}

function createTradeMarker(
  position: Position,
  action: 'open' | 'close',
  timestampMs: number,
  actualPrice: string,
): SeriesMarker<Time> {
  const isBuying = (position.direction === 'long') === (action === 'open')
  const directionLabels: Record<TradeDirection, string> = { long: '做多', short: '做空' }
  const label = `${directionLabels[position.direction]}${action === 'open' ? '开仓' : '平仓'}`
  return {
    id: `${position.id}-${action}`,
    time: toTimeSec(timestampMs),
    position: isBuying ? 'atPriceBottom' : 'atPriceTop',
    shape: isBuying ? 'arrowUp' : 'arrowDown',
    color: isBuying ? '#176b56' : '#a64237',
    price: Number(actualPrice),
    text: `${label}·${isBuying ? '买' : '卖'} ${formatChartPrice(actualPrice)}`,
  }
}

/** Marker timestamps must belong to the visible prefix, never a future minute. */
export function buildTradeMarkers(
  frames: readonly MarketFrame[],
  position: Position | null,
  trades: readonly TradeRecord[],
): SeriesMarker<Time>[] {
  const visibleTimestamps = new Set(frames.map((frame) => frame.quote.timestampMs))
  const markers: SeriesMarker<Time>[] = []
  for (const trade of trades) {
    if (visibleTimestamps.has(trade.openedAtMs)) {
      markers.push(createTradeMarker(trade, 'open', trade.openedAtMs, trade.entryPrice))
    }
    if (visibleTimestamps.has(trade.closedAtMs)) {
      markers.push(createTradeMarker(trade, 'close', trade.closedAtMs, trade.exitPrice))
    }
  }
  if (position && visibleTimestamps.has(position.openedAtMs)) {
    markers.push(createTradeMarker(position, 'open', position.openedAtMs, position.entryPrice))
  }
  return markers.sort((left, right) => Number(left.time) - Number(right.time))
}

/** Include actual executions in view; old offscreen trades must not pin the scale. */
export function includeVisibleTradePrices(
  priceRange: PriceRange,
  markers: readonly SeriesMarker<Time>[],
  visibleTimeRange: IRange<Time> | null,
  positionEntryPrice: string | null = null,
): PriceRange {
  let minValue = priceRange.minValue
  let maxValue = priceRange.maxValue
  if (positionEntryPrice !== null) {
    const entryPrice = Number(positionEntryPrice)
    minValue = Math.min(minValue, entryPrice)
    maxValue = Math.max(maxValue, entryPrice)
  }
  if (visibleTimeRange && typeof visibleTimeRange.from === 'number'
    && typeof visibleTimeRange.to === 'number') {
    for (const marker of markers) {
      if (typeof marker.time !== 'number' || marker.price === undefined
        || marker.time < visibleTimeRange.from || marker.time > visibleTimeRange.to) continue
      minValue = Math.min(minValue, marker.price)
      maxValue = Math.max(maxValue, marker.price)
    }
  }
  return { minValue, maxValue }
}
