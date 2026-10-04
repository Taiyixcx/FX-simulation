import { describe, expect, it } from 'vitest'
import { aggregateMarketFrames, aggregateValidatedMarketFrames } from '../../src/engine/frameAggregation'
import type { MarketFrame } from '../../src/engine/types'

const BASE_TIMESTAMP_MS = Date.parse('2024-03-04T08:00:00Z')
function frame(minute: number, closePrice = '1'): MarketFrame {
  return {
    quote: { timestampMs: BASE_TIMESTAMP_MS + minute * 60_000, bidPrice: closePrice, askPrice: closePrice, askSource: 'source' },
    openPrice: closePrice, highPrice: closePrice, lowPrice: closePrice, closePrice,
  }
}

describe('UTC aggregation of progressed completed M1', () => {
  it('keeps 08:05 in its completed 08:00–08:05 interval and exposes only the partial next interval', () => {
    const input = [frame(1), frame(2, '1.2'), frame(3, '0.9'), frame(4, '1.1'), frame(5), frame(6, '1.3')]
    const result = aggregateMarketFrames(input, 'M5')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ intervalStartMs: BASE_TIMESTAMP_MS, intervalEndMs: BASE_TIMESTAMP_MS + 5 * 60_000, sourceFrameCount: 5, isComplete: true, hasGap: false, openPrice: '1', highPrice: '1.2', lowPrice: '0.9', closePrice: '1' })
    expect(result[1]).toMatchObject({ sourceFrameCount: 1, isComplete: false, hasGap: false, quote: { timestampMs: input[5]!.quote.timestampMs, bidPrice: '1.3' }, highPrice: '1.3' })
    expect(result[1]!.quote.timestampMs).toBeLessThan(result[1]!.intervalEndMs)
    expect(input[0]!.quote.timestampMs).toBe(BASE_TIMESTAMP_MS + 60_000)
  })

  it('marks actual gaps, truncated leading intervals and missing old interval endings instead of grouping every five rows', () => {
    const result = aggregateMarketFrames([frame(2), frame(3), frame(6), frame(7), frame(8)], 'M5')
    expect(result.map(item => item.sourceFrameCount)).toEqual([2, 3])
    expect(result[0]).toMatchObject({ isComplete: false, hasGap: true })
    expect(result[1]).toMatchObject({ isComplete: false, hasGap: false })
    expect(aggregateMarketFrames([frame(1), frame(3), frame(5)], 'M5')[0]).toMatchObject({ hasGap: true, isComplete: false })
  })

  it('never reads a future final high and completes H1 only after its sixtieth completed minute', () => {
    const input = Array.from({ length: 60 }, (_, index) => frame(index + 1, index === 59 ? '10' : '1'))
    expect(aggregateMarketFrames(input.slice(0, 59), 'H1')[0]).toMatchObject({ highPrice: '1', isComplete: false, sourceFrameCount: 59 })
    expect(aggregateMarketFrames(input, 'H1')[0]).toMatchObject({ highPrice: '10', isComplete: true, sourceFrameCount: 60 })
    expect(aggregateMarketFrames([], 'M5')).toEqual([])
    expect(aggregateMarketFrames([frame(1)], 'M1')[0]).toMatchObject({ isComplete: true, hasGap: false })
  })

  it('rejects repeated or descending source minutes', () => {
    expect(() => aggregateMarketFrames([frame(2), frame(1)], 'M5')).toThrow('严格递增')
    expect(() => aggregateMarketFrames([frame(1), frame(1)], 'M5')).toThrow('严格递增')
  })

  it('produces identical display aggregation for repository-validated frames without using it as a validation certificate', () => {
    const frames = [frame(1), frame(3, '1.1'), frame(5), frame(6)]
    for (const period of ['M1', 'M5', 'H1'] as const) expect(aggregateValidatedMarketFrames(frames, period)).toEqual(aggregateMarketFrames(frames, period))
    expect(() => aggregateValidatedMarketFrames([frame(1), frame(1)], 'M1')).toThrow('严格递增')
  })
})
