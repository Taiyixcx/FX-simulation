import { describe, expect, it } from 'vitest'
import { TickMarkType } from 'lightweight-charts'
import type { MarketFrame, Position, TradeRecord } from '../../src/engine/types'
import {
  buildTradeMarkers,
  formatChartTime,
  formatTimeAxisTick,
  includeVisibleTradePrices,
  toCandlestickPoint,
  toLinePoint,
  toTimeSec,
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
  it('keeps chart timestamps in UTC seconds and displays Asia/Shanghai time', () => {
    const timeSec = toTimeSec(FIRST_TIMESTAMP_MS)
    expect(timeSec).toBe(1709539260)
    expect(formatChartTime(timeSec)).toBe('2024/03/04 16:01')
    expect(formatTimeAxisTick(timeSec, TickMarkType.Time)).toBe('16:01')
    expect(formatChartTime(toTimeSec(Date.parse('2024-03-04T16:01:00Z'))))
      .toBe('2024/03/05 00:01')
  })

  it('adapts only Bid OHLC without modifying decimal business prices', () => {
    const frame = createFrame(FIRST_TIMESTAMP_MS)
    expect(toLinePoint(frame)).toEqual({ time: 1709539260, value: 1.1 })
    expect(toCandlestickPoint(frame)).toEqual({
      time: 1709539260,
      open: 1.0999,
      high: 1.1002,
      low: 1.0998,
      close: 1.1,
    })
    expect(frame.quote.askPrice).toBe('1.10010')
    expect(frame.closePrice).toBe('1.10000')
  })

  it('places a long entry on its actual Ask instead of the Bid curve', () => {
    expect(buildTradeMarkers([createFrame(FIRST_TIMESTAMP_MS)], LONG_POSITION, []))
      .toEqual([expect.objectContaining({
        id: 'position-long-open',
        price: 1.1001,
        position: 'atPriceBottom',
        shape: 'arrowUp',
        text: '做多开仓·买 1.10010',
      })])
  })

  it('uses buy/sell sides for closed long and short trades in time order', () => {
    const nextTimestampMs = FIRST_TIMESTAMP_MS + 60_000
    const longTrade: TradeRecord = {
      ...LONG_POSITION,
      closedAtMs: nextTimestampMs,
      exitPrice: '1.10100',
      realizedPnlUsd: '0.08',
      reason: 'manual',
    }
    const shortTrade: TradeRecord = {
      ...longTrade,
      id: 'position-short',
      direction: 'short',
      entryPrice: '1.10000',
      exitPrice: '1.09910',
    }
    const markers = buildTradeMarkers(
      [createFrame(FIRST_TIMESTAMP_MS), createFrame(nextTimestampMs)],
      null,
      [longTrade, shortTrade],
    )
    expect(markers.map((marker) => marker.text)).toEqual([
      '做多开仓·买 1.10010',
      '做空开仓·卖 1.10000',
      '做多平仓·卖 1.10100',
      '做空平仓·买 1.09910',
    ])
    expect(markers.map((marker) => marker.price)).toEqual([1.1001, 1.1, 1.101, 1.0991])
    expect(markers.map((marker) => marker.shape)).toEqual(['arrowUp', 'arrowDown', 'arrowDown', 'arrowUp'])
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
    expect(buildTradeMarkers(frames, futurePosition, [trade])).toHaveLength(1)
    expect(buildTradeMarkers(frames, futurePosition, [trade])[0]?.id).toBe('position-long-open')
    expect(buildTradeMarkers([], LONG_POSITION, [trade])).toEqual([])
  })

  it('keeps a closed long entry Ask within the scale above the Bid range', () => {
    const frame = createFrame(FIRST_TIMESTAMP_MS)
    const closedTrade: TradeRecord = {
      ...LONG_POSITION,
      closedAtMs: FIRST_TIMESTAMP_MS,
      exitPrice: frame.quote.bidPrice,
      realizedPnlUsd: '-0.01',
      reason: 'manual',
    }
    const timeSec = toTimeSec(FIRST_TIMESTAMP_MS)
    const markers = buildTradeMarkers([frame], null, [closedTrade])
    expect(includeVisibleTradePrices(
      { minValue: 1.09995, maxValue: 1.10005 }, markers, { from: timeSec, to: timeSec },
    )).toEqual({ minValue: 1.09995, maxValue: 1.1001 })
  })

  it('excludes offscreen closed trades but retains an active horizontal entry line', () => {
    const markers = buildTradeMarkers([createFrame(FIRST_TIMESTAMP_MS)], LONG_POSITION, [])
    const nextTimeSec = toTimeSec(FIRST_TIMESTAMP_MS + 60_000)
    const range = { minValue: 1.1002, maxValue: 1.1003 }
    expect(includeVisibleTradePrices(range, markers, { from: nextTimeSec, to: nextTimeSec }))
      .toEqual(range)
    expect(includeVisibleTradePrices(range, markers, { from: nextTimeSec, to: nextTimeSec }, '1.10010'))
      .toEqual({ minValue: 1.1001, maxValue: 1.1003 })
    expect(includeVisibleTradePrices(range, markers, null)).toEqual(range)
  })
})
