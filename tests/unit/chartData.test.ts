import { describe, expect, it } from 'vitest'
import type { MarketFrame, Position, TradeRecord } from '../../src/engine/types'
import {
  advanceViewport,
  buildTradeMarkers,
  clampViewport,
  formatChartTime,
  formatTimeAxisTick,
  getVisiblePriceRange,
  initialViewport,
  toCandlestickPoint,
  toLinePoint,
  toTimestampKey,
} from '../../src/features/chart/chartData'

const FIRST_TIMESTAMP_MS = Date.parse('2024-03-04T08:01:00Z')

function createFrame(timestampMs: number): MarketFrame {
  return {
    quote: { timestampMs, bidPrice: '1.10000', askPrice: '1.10010', askSource: 'training' },
    openPrice: '1.09990',
    highPrice: '1.10020',
    lowPrice: '1.09980',
    closePrice: '1.10000',
  }
}

const LONG_POSITION: Position = {
  id: 'position-long',
  pair: 'EUR/USD',
  direction: 'long',
  notionalUsd: '100',
  quantityBaseUnits: '90.9008271975275',
  entryPrice: '1.10010',
  openedAtMs: FIRST_TIMESTAMP_MS,
}

describe('chart data adapter', () => {
  it('keeps category timestamps as UTC millisecond strings and displays Asia/Shanghai time', () => {
    expect(toTimestampKey(FIRST_TIMESTAMP_MS)).toBe('1709539260000')
    expect(formatChartTime(FIRST_TIMESTAMP_MS)).toBe('2024/03/04 16:01')
    expect(formatTimeAxisTick(toTimestampKey(FIRST_TIMESTAMP_MS))).toBe('16:01')
    expect(formatChartTime(Date.parse('2024-03-04T16:01:00Z'))).toBe('2024/03/05 00:01')
  })

  it('adapts Bid candles in ECharts open-close-low-high order without changing business prices', () => {
    const frame = createFrame(FIRST_TIMESTAMP_MS)
    expect(toLinePoint(frame)).toBe(1.1)
    expect(toCandlestickPoint(frame)).toEqual([1.0999, 1.1, 1.0998, 1.1002])
    expect(frame.quote.askPrice).toBe('1.10010')
    expect(frame.closePrice).toBe('1.10000')
  })

  it('places a long entry at its actual Ask with a string category coordinate', () => {
    expect(buildTradeMarkers([createFrame(FIRST_TIMESTAMP_MS)], LONG_POSITION, []))
      .toEqual([expect.objectContaining({
        id: 'position-long-open',
        timestampKey: '1709539260000',
        price: 1.1001,
        isBuying: true,
        text: '做多开仓·买 1.10010',
      })])
  })

  it('uses actual buy/sell sides for closed long and short trades in time order', () => {
    const nextTimestampMs = FIRST_TIMESTAMP_MS + 60_000
    const longTrade: TradeRecord = {
      ...LONG_POSITION,
      closedAtMs: nextTimestampMs,
      exitPrice: '1.10100',
      realizedPnlUsd: '0.08',
      reason: 'manual',
    }
    const shortTrade: TradeRecord = { ...longTrade, id: 'position-short', direction: 'short', entryPrice: '1.10000', exitPrice: '1.09910' }
    const markers = buildTradeMarkers(
      [createFrame(FIRST_TIMESTAMP_MS), createFrame(nextTimestampMs)], null, [longTrade, shortTrade],
    )
    expect(markers.map(marker => marker.text)).toEqual([
      '做多开仓·买 1.10010', '做空开仓·卖 1.10000', '做多平仓·卖 1.10100', '做空平仓·买 1.09910',
    ])
    expect(markers.map(marker => marker.price)).toEqual([1.1001, 1.1, 1.101, 1.0991])
    expect(markers.map(marker => marker.isBuying)).toEqual([true, false, false, true])
  })

  it('does not create markers for future or absent minutes', () => {
    const trade: TradeRecord = {
      ...LONG_POSITION,
      closedAtMs: FIRST_TIMESTAMP_MS + 60_000,
      exitPrice: '1.10100',
      realizedPnlUsd: '0.08',
      reason: 'manual',
    }
    const frames = [createFrame(FIRST_TIMESTAMP_MS)]
    const futurePosition = { ...LONG_POSITION, openedAtMs: FIRST_TIMESTAMP_MS + 120_000 }
    expect(buildTradeMarkers(frames, futurePosition, [trade]).map(marker => marker.id)).toEqual(['position-long-open'])
    expect(buildTradeMarkers([], LONG_POSITION, [trade])).toEqual([])
  })

  it('includes a closed Ask above the Bid curve with enough scale padding for its marker', () => {
    const frame = createFrame(FIRST_TIMESTAMP_MS)
    const closedTrade: TradeRecord = { ...LONG_POSITION, closedAtMs: FIRST_TIMESTAMP_MS, exitPrice: frame.quote.bidPrice, realizedPnlUsd: '-0.01', reason: 'manual' }
    const markers = buildTradeMarkers([frame], null, [closedTrade])
    const range = getVisiblePriceRange([frame], { from: 0, to: 0 }, 'line', markers)
    expect(range.minValue).toBeLessThan(1.1)
    expect(range.maxValue).toBeGreaterThan(1.1001)
  })

  it('scales to visible candle extremes while excluding offscreen closed trades', () => {
    const firstFrame = createFrame(FIRST_TIMESTAMP_MS)
    const nextFrame = createFrame(FIRST_TIMESTAMP_MS + 60_000)
    const offscreenMarkers = buildTradeMarkers([firstFrame], { ...LONG_POSITION, entryPrice: '1.50000' }, [])
    const range = getVisiblePriceRange([firstFrame, nextFrame], { from: 1, to: 1 }, 'candlestick', offscreenMarkers)
    expect(range.minValue).toBeLessThan(Number(nextFrame.lowPrice))
    expect(range.maxValue).toBeGreaterThan(Number(nextFrame.highPrice))
    expect(range.maxValue).toBeLessThan(1.2)
    const activeRange = getVisiblePriceRange([firstFrame, nextFrame], { from: 1, to: 1 }, 'line', offscreenMarkers, '1.50000')
    expect(activeRange.maxValue).toBeGreaterThan(1.5)
  })

  it('uses a finite nonzero range for a single flat price', () => {
    const frame = createFrame(FIRST_TIMESTAMP_MS)
    const range = getVisiblePriceRange([frame], { from: 0, to: 0 }, 'line', [])
    expect(range.minValue).toBeCloseTo(1.09992, 8)
    expect(range.maxValue).toBeCloseTo(1.10008, 8)
    expect(getVisiblePriceRange([], { from: 0, to: 0 }, 'line', [])).toEqual({ minValue: 0, maxValue: 1 })
  })
})

describe('chart viewport', () => {
  it('contains only progressed indices, including a single centered category', () => {
    expect(initialViewport(1)).toEqual({ from: 0, to: 0 })
    expect(initialViewport(50)).toEqual({ from: 0, to: 49 })
    expect(initialViewport(1440)).toEqual({ from: 1360, to: 1439 })
    expect(clampViewport({ from: -3, to: 2000 }, 1440)).toEqual({ from: 0, to: 1439 })
  })

  it('expands the initial view and follows latest with a stable window size', () => {
    expect(advanceViewport({ from: 0, to: 0 }, 1, 11, true)).toEqual({ from: 0, to: 10 })
    expect(advanceViewport({ from: 0, to: 74 }, 75, 85, true)).toEqual({ from: 5, to: 84 })
    expect(advanceViewport({ from: 120, to: 159 }, 160, 170, true)).toEqual({ from: 130, to: 169 })
  })

  it('preserves absolute historical indices while new frames arrive', () => {
    expect(advanceViewport({ from: 20, to: 39 }, 100, 110, false)).toEqual({ from: 20, to: 39 })
    expect(advanceViewport({ from: 20, to: 39 }, 100, 1440, false)).toEqual({ from: 20, to: 39 })
  })

  it('clamps a saved window when the dataset becomes shorter', () => {
    expect(advanceViewport({ from: 70, to: 99 }, 100, 20, false)).toEqual({ from: 19, to: 19 })
  })
})
