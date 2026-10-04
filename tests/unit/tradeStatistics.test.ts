import { describe, expect, it } from 'vitest'
import { MoneyDecimal } from '../../src/engine/decimal'
import { closePosition, openPosition } from '../../src/engine/execution'
import { calculatePracticeStatistics, calculatePracticeStatisticsAsync, calculateTradeStatistics } from '../../src/engine/tradeStatistics'
import type { AccountState, MarketQuote, TradeDirection } from '../../src/engine/types'

const START_TIMESTAMP_MS = Date.parse('2024-03-04T08:01:00Z')
function quote(minute: number, bidPrice: string, askPrice = bidPrice): MarketQuote {
  return { timestampMs: START_TIMESTAMP_MS + minute * 60_000, bidPrice, askPrice, askSource: 'source' }
}

function closedTrade(direction: TradeDirection, exitPrice: string, id: string) {
  const account = openPosition({ balanceUsd: '10000', position: null }, quote(0, '1'), 'EUR/USD', direction, '1000', id)
  return closePosition(account, quote(1, exitPrice)).trade
}

describe('settled outcome statistics', () => {
  it('distinguishes zero samples, flat, all-winning and all-losing samples without infinite ratios', () => {
    expect(calculateTradeStatistics([])).toMatchObject({ tradeCount: 0, averagePnlUsd: null, winRatePercent: null, profitFactor: null, netRealizedPnlUsd: '0.00' })
    expect(calculateTradeStatistics([closedTrade('long', '1', 'flat')])).toMatchObject({ flatTradeCount: 1, winningTradeCount: 0, averagePnlUsd: '0.00', profitFactor: null })
    expect(calculateTradeStatistics([closedTrade('long', '1.1', 'win')])).toMatchObject({ winningTradeCount: 1, averageProfitUsd: '100.00', averageLossUsd: null, winRatePercent: '100', profitFactor: null })
    expect(calculateTradeStatistics([closedTrade('long', '0.9', 'loss')])).toMatchObject({ losingTradeCount: 1, averageLossUsd: '-100.00', winRatePercent: '0', profitFactor: '0' })
  })

  it('uses dollar cents and actual holding time for distribution and averages', () => {
    const result = calculateTradeStatistics([closedTrade('long', '1.2', 'win'), closedTrade('long', '0.9', 'loss'), closedTrade('long', '1', 'flat')])
    expect(result).toMatchObject({ tradeCount: 3, winningTradeCount: 1, losingTradeCount: 1, flatTradeCount: 1, netRealizedPnlUsd: '100.00', grossProfitUsd: '200.00', grossLossUsd: '100.00', averagePnlUsd: '33.33', profitFactor: '2', averageHoldingMinutes: '1' })
  })
})

describe('full progressed executable-quote account path', () => {
  it('includes unclosed floating drawdown that a settled-trades-only calculation cannot see', () => {
    const quotes = [quote(0, '1', '1.0001'), quote(1, '0.8', '0.8001'), quote(2, '1.2', '1.2001')]
    const opened = openPosition({ balanceUsd: '10000', position: null }, quotes[0]!, 'EUR/USD', 'long', '1000.10', 'long')
    const closed = closePosition(opened, quotes[2]!)
    const result = calculatePracticeStatistics(quotes, [closed.trade], null)
    expect(result.balanceDrawdown.maximumUsd).toBe('0')
    expect(result.equityDrawdown.maximumUsd).toBe('200.1')
    expect(result.equityDrawdown.maximumPercent).toBe('2.001')
    expect(result.excursions[0]).toEqual({ tradeId: 'long', sampleCount: 3, maximumFavorablePnlUsd: '199.9', maximumAdversePnlUsd: '-200.1', hasGap: false, closedAtMs: quotes[2]!.timestampMs })
    expect(result.curve.at(-1)).toMatchObject({ balanceUsd: closed.account.balanceUsd, equityUsd: new MoneyDecimal(closed.account.balanceUsd).toFixed() })
  })

  it('uses short executable Ask and flags unsampled gaps without inventing intraminute highs', () => {
    const quotes = [quote(0, '1', '1.01'), quote(1, '0.8', '1.1'), quote(4, '0.9', '0.92')]
    const opened = openPosition({ balanceUsd: '10000', position: null }, quotes[0]!, 'EUR/USD', 'short', '1000', 'short')
    const result = calculatePracticeStatistics(quotes, [], opened.position)
    expect(result.excursions[0]).toMatchObject({ maximumAdversePnlUsd: '-100', maximumFavorablePnlUsd: '80', sampleCount: 3, hasGap: true, closedAtMs: null })
    expect(result.equityDrawdown.maximumUsd).toBe('100')
  })

  it('preserves multiple open/close operations at the same completed quote and a final open position', () => {
    const quotes = [quote(0, '1', '1.0001'), quote(1, '1.001', '1.0011')]
    let account: AccountState = { balanceUsd: '10000', position: null }
    account = openPosition(account, quotes[0]!, 'EUR/USD', 'long', '1000.10', 'same-long')
    const first = closePosition(account, quotes[0]!)
    account = openPosition(first.account, quotes[0]!, 'EUR/USD', 'short', '1000', 'same-short')
    const second = closePosition(account, quotes[0]!)
    account = openPosition(second.account, quotes[0]!, 'EUR/USD', 'long', '500', 'still-open')
    const result = calculatePracticeStatistics(quotes, [first.trade, second.trade], account.position)
    expect(result.trades.netRealizedPnlUsd).toBe('-0.20')
    expect(result.curve[0]!.balanceUsd).toBe('9999.80')
    expect(result.excursions.map(item => item.sampleCount)).toEqual([1, 1, 2])
    expect(result.excursions.map(item => item.tradeId)).toEqual(['same-long', 'same-short', 'still-open'])
    expect(new MoneyDecimal(result.equityDrawdown.maximumUsd).gt('0.20')).toBe(true)
  })

  it('retains negative equity and percentages above 100% when the reference peak is positive', () => {
    const quotes = [quote(0, '1'), quote(1, '3')]
    const opened = openPosition({ balanceUsd: '10000', position: null }, quotes[0]!, 'EUR/USD', 'short', '10000', 'gap-depletion')
    const closed = closePosition(opened, quotes[1]!, 'equity-depleted')
    const result = calculatePracticeStatistics(quotes, [closed.trade], null)
    expect(result.equityDrawdown).toEqual({ maximumUsd: '20000', maximumPercent: '200', hasNonPositiveEquity: true })
    expect(result.balanceDrawdown).toEqual({ maximumUsd: '20000', maximumPercent: '200', hasNonPositiveEquity: true })
    expect(calculatePracticeStatistics([quote(0, '1')], [], null, '-10.00').equityDrawdown.maximumPercent).toBeNull()
    expect(calculatePracticeStatistics([], [], null).equityDrawdown.maximumPercent).toBeNull()
  })

  it('refuses a partial window, fabricated settlement and future trade reference', () => {
    const quotes = [quote(0, '1'), quote(1, '1.1')]
    const account = openPosition({ balanceUsd: '10000', position: null }, quotes[0]!, 'EUR/USD', 'long', '1000', '完整分钟')
    const closed = closePosition(account, quotes[1]!)
    expect(() => calculatePracticeStatistics(quotes.slice(1), [closed.trade], null)).toThrow('缺少开仓分钟')
    expect(() => calculatePracticeStatistics(quotes.slice(0, 1), [closed.trade], null)).toThrow('行情范围')
    expect(() => calculatePracticeStatistics(quotes, [{ ...closed.trade, realizedPnlUsd: '200.00' }], null)).toThrow('结算')
    expect(() => calculatePracticeStatistics([quotes[0]!, quotes[0]!], [], null)).toThrow('严格递增')
  })

  it('yields between bounded batches with the same result and discards cancelled calculation', async () => {
    const quotes = Array.from({ length: 600 }, (_, minute) => quote(minute, '1', '1.0001'))
    const opened = openPosition({ balanceUsd: '10000', position: null }, quotes[0]!, 'EUR/USD', 'long', '1000', 'batch-position')
    let yields = 0
    const progress: number[] = []
    const result = await calculatePracticeStatisticsAsync(quotes, [], opened.position, '10000.00', {
      yieldControl: async () => { yields += 1 },
      onProgress: count => { progress.push(count) },
    })
    expect(result).toEqual(calculatePracticeStatistics(quotes, [], opened.position))
    expect(yields).toBe(2)
    expect(progress).toEqual([256, 512, 600])
    const signal = { aborted: false }
    await expect(calculatePracticeStatisticsAsync(quotes, [], opened.position, '10000.00', {
      signal, yieldControl: async () => { signal.aborted = true },
    })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(calculatePracticeStatisticsAsync([], [], null, '10000.00', { signal: { aborted: true } })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('also bounds many same-minute account operations so cancellation can interrupt a single quote', async () => {
    const currentQuote = quote(0, '1')
    const trades = Array.from({ length: 300 }, (_, index) => {
      const account = openPosition({ balanceUsd: '10000', position: null }, currentQuote, 'EUR/USD', 'long', '1000', `same-minute-${index}`)
      return closePosition(account, currentQuote).trade
    })
    let yields = 0
    const result = await calculatePracticeStatisticsAsync([currentQuote], trades, null, '10000.00', { yieldControl: async () => { yields += 1 } })
    expect(result).toEqual(calculatePracticeStatistics([currentQuote], trades, null))
    expect(yields).toBe(2)
    const signal = { aborted: false }
    await expect(calculatePracticeStatisticsAsync([currentQuote], trades, null, '10000.00', { signal, yieldControl: async () => { signal.aborted = true } })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
