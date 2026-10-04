import { INITIAL_BALANCE_USD, calculateAccount, calculateUnrealizedPnl, validatePosition } from './account'
import { MoneyDecimal, decimalToString, readDecimalString, validateTimestamp } from './decimal'
import { closePosition, openPosition } from './execution'
import type { AccountMetrics, AccountState, MarketQuote, Position, TradeRecord } from './types'

export interface TradeStatistics {
  tradeCount: number
  winningTradeCount: number
  losingTradeCount: number
  flatTradeCount: number
  netRealizedPnlUsd: string
  grossProfitUsd: string
  /** Positive magnitude; averageLossUsd retains the negative sign. */
  grossLossUsd: string
  averageProfitUsd: string | null
  averageLossUsd: string | null
  averagePnlUsd: string | null
  winRatePercent: string | null
  profitFactor: string | null
  averageHoldingMinutes: string | null
}

export interface AccountCurvePoint {
  timestampMs: number
  balanceUsd: string
  equityUsd: string
}

export interface DrawdownMetrics {
  maximumUsd: string
  /** Null when no sampled range or no positive reference peak exists. */
  maximumPercent: string | null
  hasNonPositiveEquity: boolean
}

export interface TradeExcursion {
  tradeId: string
  sampleCount: number
  maximumFavorablePnlUsd: string
  maximumAdversePnlUsd: string
  hasGap: boolean
  closedAtMs: number | null
}

export interface PracticeStatistics {
  trades: TradeStatistics
  curve: AccountCurvePoint[]
  balanceDrawdown: DrawdownMetrics
  equityDrawdown: DrawdownMetrics
  excursions: TradeExcursion[]
}

function validateTrade(trade: TradeRecord): void {
  validatePosition(trade)
  validateTimestamp(trade.closedAtMs, 'invalid-account')
  if (trade.closedAtMs < trade.openedAtMs || !['manual', 'equity-depleted'].includes(trade.reason)) throw new Error('成交平仓时间或原因无效。')
  const exitPrice = readDecimalString(trade.exitPrice, '平仓价')
  const pnl = readDecimalString(trade.realizedPnlUsd, '已结算盈亏')
  if (exitPrice.lte(0) || !pnl.eq(pnl.toDecimalPlaces(2))) throw new Error('成交平仓价或美元分结算无效。')
}

function createTradeStatisticsCalculator() {
  let profit = new MoneyDecimal(0)
  let loss = new MoneyDecimal(0)
  let holdingMinutes = new MoneyDecimal(0)
  let winningTradeCount = 0
  let losingTradeCount = 0
  let flatTradeCount = 0
  function push(trade: TradeRecord): void {
    validateTrade(trade)
    const pnl = new MoneyDecimal(trade.realizedPnlUsd)
    if (pnl.gt(0)) { winningTradeCount += 1; profit = profit.plus(pnl) }
    else if (pnl.lt(0)) { losingTradeCount += 1; loss = loss.minus(pnl) }
    else flatTradeCount += 1
    holdingMinutes = holdingMinutes.plus(new MoneyDecimal(trade.closedAtMs - trade.openedAtMs).div(60_000))
  }
  return {
    push,
    finish(): TradeStatistics {
      const count = winningTradeCount + losingTradeCount + flatTradeCount
      const net = profit.minus(loss)
      return {
        tradeCount: count, winningTradeCount, losingTradeCount, flatTradeCount,
        netRealizedPnlUsd: net.toFixed(2), grossProfitUsd: profit.toFixed(2), grossLossUsd: loss.toFixed(2),
        averageProfitUsd: winningTradeCount ? profit.div(winningTradeCount).toFixed(2) : null,
        averageLossUsd: losingTradeCount ? loss.negated().div(losingTradeCount).toFixed(2) : null,
        averagePnlUsd: count ? net.div(count).toFixed(2) : null,
        winRatePercent: count ? decimalToString(new MoneyDecimal(winningTradeCount).div(count).times(100)) : null,
        profitFactor: loss.gt(0) ? decimalToString(profit.div(loss)) : null,
        averageHoldingMinutes: count ? decimalToString(holdingMinutes.div(count)) : null,
      }
    },
  }
}

/** Settled outcomes only. No claim about strategy quality follows from these values. */
export function calculateTradeStatistics(trades: readonly TradeRecord[]): TradeStatistics {
  const calculator = createTradeStatisticsCalculator()
  for (const trade of trades) calculator.push(trade)
  return calculator.finish()
}

function createDrawdown(initial: string) {
  let peak = readDecimalString(initial, '初始训练资金')
  let maximum = new MoneyDecimal(0)
  let maximumPercent = peak.gt(0) ? new MoneyDecimal(0) : null
  let hasNonPositiveEquity = peak.lte(0)
  let sampleCount = 0
  return {
    push(input: string): void {
      const amount = new MoneyDecimal(input)
      peak = MoneyDecimal.max(peak, amount)
      maximum = MoneyDecimal.max(maximum, peak.minus(amount))
      if (peak.gt(0)) maximumPercent = MoneyDecimal.max(maximumPercent ?? 0, peak.minus(amount).div(peak).times(100))
      if (amount.lte(0)) hasNonPositiveEquity = true
      sampleCount += 1
    },
    finish(): DrawdownMetrics {
      return { maximumUsd: decimalToString(maximum), maximumPercent: sampleCount && maximumPercent !== null ? decimalToString(maximumPercent) : null, hasNonPositiveEquity }
    },
  }
}

function samePosition(actual: Position, expected: Position): void {
  if (actual.id !== expected.id || actual.pair !== expected.pair || actual.direction !== expected.direction || actual.openedAtMs !== expected.openedAtMs
    || !new MoneyDecimal(actual.entryPrice).eq(expected.entryPrice) || !new MoneyDecimal(actual.quantityBaseUnits).eq(expected.quantityBaseUnits)
    || !new MoneyDecimal(actual.notionalUsd).eq(expected.notionalUsd)) throw new Error('统计所需持仓与已推进报价不一致。')
}

/** Complete progressed quote prefix from the practice start, excluding warmup.
 * Quotes must include the real Bid/Ask, including minutes without any closed trade.
 * The caller supplies no future quotes and loads archived minutes when needed.
 */
function createPracticeStatisticsCalculator(
  trades: readonly TradeRecord[],
  currentPosition: Position | null,
  initialBalanceUsd: string,
) {
  const tradeStatistics = createTradeStatisticsCalculator()
  if (currentPosition) validatePosition(currentPosition)
  let account: AccountState = { balanceUsd: initialBalanceUsd, position: null }
  const balanceDrawdown = createDrawdown(initialBalanceUsd)
  const equityDrawdown = createDrawdown(initialBalanceUsd)
  const curve: AccountCurvePoint[] = []
  const excursions: TradeExcursion[] = []
  let activeExcursion: TradeExcursion | null = null
  let lastSampleTimestampMs = -1
  let tradeIndex = 0
  let previousTimestampMs = -1
  let latestMetrics: AccountMetrics | null = null
  const tradeIds = new Set<string>()

  function targetPosition(): Position | null { return trades[tradeIndex] ?? currentPosition }

  function sample(quote: MarketQuote): void {
    const metrics = calculateAccount(account, quote)
    latestMetrics = metrics
    balanceDrawdown.push(metrics.balanceUsd)
    equityDrawdown.push(metrics.equityUsd)
    if (account.position && activeExcursion && lastSampleTimestampMs !== quote.timestampMs) {
      const pnl = calculateUnrealizedPnl(account.position, quote)
      activeExcursion.maximumFavorablePnlUsd = decimalToString(MoneyDecimal.max(activeExcursion.maximumFavorablePnlUsd, pnl))
      activeExcursion.maximumAdversePnlUsd = decimalToString(MoneyDecimal.min(activeExcursion.maximumAdversePnlUsd, pnl))
      if (lastSampleTimestampMs >= 0 && quote.timestampMs - lastSampleTimestampMs > 60_000) activeExcursion.hasGap = true
      activeExcursion.sampleCount += 1
      lastSampleTimestampMs = quote.timestampMs
    }
  }

  function settle(quote: MarketQuote): void {
    const target = trades[tradeIndex]
    if (!target || !account.position || target.closedAtMs !== quote.timestampMs) throw new Error('统计缺少成交对应的已推进分钟。')
    samePosition(account.position, target)
    const closed = closePosition(account, quote, target.reason)
    if (!new MoneyDecimal(closed.trade.exitPrice).eq(target.exitPrice) || !new MoneyDecimal(closed.trade.realizedPnlUsd).eq(target.realizedPnlUsd)) throw new Error('统计成交结算与实际双边报价不一致。')
    tradeStatistics.push(target)
    if (activeExcursion) activeExcursion.closedAtMs = quote.timestampMs
    activeExcursion = null
    account = closed.account
    tradeIndex += 1
    sample(quote)
  }

  function* pushSteps(quote: MarketQuote): Generator<void> {
    if (quote.timestampMs <= previousTimestampMs || quote.timestampMs % 60_000 !== 0) throw new Error('统计报价须为严格递增的已完成分钟。')
    previousTimestampMs = quote.timestampMs
    sample(quote)
    if (account.position) {
      const target = trades[tradeIndex]
      if (target && target.closedAtMs < quote.timestampMs) throw new Error('统计缺少平仓分钟，不能用窗口或流水代替完整已推进行情。')
      if (target?.closedAtMs === quote.timestampMs) { settle(quote); yield }
    }
    while (!account.position) {
      const target = targetPosition()
      if (!target) break
      if (target.openedAtMs < quote.timestampMs) throw new Error('统计缺少开仓分钟，不能用窗口或流水代替完整已推进行情。')
      if (target.openedAtMs > quote.timestampMs) break
      if (tradeIds.has(target.id)) throw new Error('统计交易标识重复。')
      tradeIds.add(target.id)
      // Preserve the rules used for legacy ledgers, including an old depleted entry.
      account = openPosition(account, quote, target.pair, target.direction, target.notionalUsd, target.id)
      samePosition(account.position!, target)
      activeExcursion = { tradeId: target.id, sampleCount: 0, maximumFavorablePnlUsd: '0', maximumAdversePnlUsd: '0', hasGap: false, closedAtMs: null }
      excursions.push(activeExcursion)
      lastSampleTimestampMs = -1
      sample(quote)
      yield
      const trade = trades[tradeIndex]
      if (!trade || trade.closedAtMs !== quote.timestampMs) break
      settle(quote)
      yield
    }
    const metrics = latestMetrics!
    curve.push({ timestampMs: quote.timestampMs, balanceUsd: metrics.balanceUsd, equityUsd: metrics.equityUsd })
  }
  return {
    pushSteps,
    push(quote: MarketQuote): void { for (const step of pushSteps(quote)) { void step } },
    finish(): PracticeStatistics {
      if (tradeIndex !== trades.length || Boolean(account.position) !== Boolean(currentPosition)) throw new Error('统计行情范围未包含全部成交与当前持仓。')
      if (account.position && currentPosition) samePosition(account.position, currentPosition)
      return { trades: tradeStatistics.finish(), curve, balanceDrawdown: balanceDrawdown.finish(), equityDrawdown: equityDrawdown.finish(), excursions }
    },
  }
}

export function calculatePracticeStatistics(
  quotes: readonly MarketQuote[],
  trades: readonly TradeRecord[],
  currentPosition: Position | null,
  initialBalanceUsd = INITIAL_BALANCE_USD,
): PracticeStatistics {
  const calculator = createPracticeStatisticsCalculator(trades, currentPosition, initialBalanceUsd)
  for (const quote of quotes) calculator.push(quote)
  return calculator.finish()
}

export interface StatisticsCalculationOptions {
  signal?: { readonly aborted: boolean }
  batchSize?: number
  /** Caller owns scheduling; inject a task yield when running in the UI. */
  yieldControl?: () => Promise<void>
  onProgress?: (processedQuoteCount: number, totalQuoteCount: number) => void
}

function checkCancellation(options: StatisticsCalculationOptions): void {
  if (options.signal?.aborted) {
    const error = new Error('已取消复盘统计。')
    error.name = 'AbortError'
    throw error
  }
}

export async function calculatePracticeStatisticsAsync(
  quotes: readonly MarketQuote[],
  trades: readonly TradeRecord[],
  currentPosition: Position | null,
  initialBalanceUsd = INITIAL_BALANCE_USD,
  options: StatisticsCalculationOptions = {},
): Promise<PracticeStatistics> {
  const batchSize = options.batchSize ?? 256
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096) throw new Error('统计分批根数须为 1 至 4,096。')
  checkCancellation(options)
  const calculator = createPracticeStatisticsCalculator(trades, currentPosition, initialBalanceUsd)
  let operationCount = 0
  for (let offset = 0; offset < quotes.length; offset += batchSize) {
    checkCancellation(options)
    const end = Math.min(quotes.length, offset + batchSize)
    for (let index = offset; index < end; index += 1) {
      // A single minute can contain many operations. Those also need bounded work.
      for (const step of calculator.pushSteps(quotes[index]!)) {
        void step
        operationCount += 1
        if (operationCount >= batchSize) {
          options.onProgress?.(index, quotes.length)
          await (options.yieldControl?.() ?? Promise.resolve())
          operationCount = 0
          checkCancellation(options)
        }
      }
    }
    options.onProgress?.(end, quotes.length)
    if (end < quotes.length) {
      await (options.yieldControl?.() ?? Promise.resolve())
      operationCount = 0
    }
  }
  checkCancellation(options)
  return calculator.finish()
}
