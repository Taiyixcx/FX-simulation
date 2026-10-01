import type Decimal from 'decimal.js'
import { decimalToString, MoneyDecimal, readDecimalString, validateTimestamp } from './decimal'
import { EngineError } from './errors'
import type { AccountMetrics, AccountState, CurrencyPair, MarketQuote, Position } from './types'

export const INITIAL_BALANCE_USD = '10000.00'

export function validateCurrencyPair(pair: CurrencyPair): void {
  if (pair !== 'EUR/USD' && pair !== 'GBP/USD') {
    throw new EngineError('invalid-quote', '不支持该货币对。')
  }
}

export function validateMarketQuote(quote: MarketQuote): void {
  if (!quote || typeof quote !== 'object') {
    throw new EngineError('invalid-quote', '当前报价无效。')
  }
  validateTimestamp(quote.timestampMs, 'invalid-quote')
  const bidPrice = readDecimalString(quote.bidPrice, '卖出价', 'invalid-quote')
  const askPrice = readDecimalString(quote.askPrice, '买入价', 'invalid-quote')
  if (bidPrice.lte(0) || askPrice.lte(0) || askPrice.lt(bidPrice)) {
    throw new EngineError('invalid-quote', '报价必须为正，且买入价不能低于卖出价。')
  }
  if (quote.askSource !== 'training' && quote.askSource !== 'source') {
    throw new EngineError('invalid-quote', '买入价来源无效。')
  }
}

/** A user amount is positive USD, expressed with no more than two decimal places. */
export function validateNotionalUsd(notionalUsd: string): void {
  if (
    typeof notionalUsd !== 'string' ||
    !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(notionalUsd) ||
    new MoneyDecimal(notionalUsd).lte(0)
  ) {
    throw new EngineError('invalid-amount', '请输入大于 0 的美元金额，最多两位小数。')
  }
}

export function validatePosition(position: Position): void {
  if (!position || typeof position !== 'object' || typeof position.id !== 'string' || !position.id) {
    throw new EngineError('invalid-account', '持仓标识无效。')
  }
  validateCurrencyPair(position.pair)
  if (position.direction !== 'long' && position.direction !== 'short') {
    throw new EngineError('invalid-account', '持仓方向无效。')
  }
  validateNotionalUsd(position.notionalUsd)
  validateTimestamp(position.openedAtMs, 'invalid-account')
  const entryPrice = readDecimalString(position.entryPrice, '入场价')
  const quantityBaseUnits = readDecimalString(position.quantityBaseUnits, '持仓数量')
  if (
    entryPrice.lte(0) ||
    quantityBaseUnits.lte(0) ||
    !quantityBaseUnits.eq(new MoneyDecimal(position.notionalUsd).div(entryPrice))
  ) {
    throw new EngineError('invalid-account', '持仓数量与交易金额或入场价不一致。')
  }
}

export function validateAccountState(account: AccountState): void {
  if (!account || typeof account !== 'object') {
    throw new EngineError('invalid-account', '账户状态无效。')
  }
  const balanceUsd = readDecimalString(account.balanceUsd, '已结算余额')
  if (!balanceUsd.eq(balanceUsd.toDecimalPlaces(2))) {
    throw new EngineError('invalid-account', '已结算余额必须按美元分记账。')
  }
  if (account.position !== null) {
    validatePosition(account.position)
    if (balanceUsd.lt(account.position.notionalUsd)) {
      throw new EngineError('invalid-account', '持仓资金占用不能超过开仓余额。')
    }
  }
}

export function calculateUnrealizedPnl(position: Position, quote: MarketQuote): Decimal {
  const priceDifference =
    position.direction === 'long'
      ? new MoneyDecimal(quote.bidPrice).minus(position.entryPrice)
      : new MoneyDecimal(position.entryPrice).minus(quote.askPrice)
  return priceDifference.times(position.quantityBaseUnits)
}

export function calculateAccount(account: AccountState, quote: MarketQuote): AccountMetrics {
  validateAccountState(account)
  validateMarketQuote(quote)
  if (account.position && quote.timestampMs < account.position.openedAtMs) {
    throw new EngineError('invalid-quote', '不能使用入场前的报价计算当前持仓。')
  }
  const balanceUsd = new MoneyDecimal(account.balanceUsd)
  const reservedFundsUsd = new MoneyDecimal(account.position?.notionalUsd ?? '0')
  const unrealizedPnlUsd = account.position
    ? calculateUnrealizedPnl(account.position, quote)
    : new MoneyDecimal('0')
  const equityUsd = balanceUsd.plus(unrealizedPnlUsd)
  const availableFundsUsd = MoneyDecimal.max('0', equityUsd.minus(reservedFundsUsd))
  return {
    balanceUsd: balanceUsd.toFixed(2),
    reservedFundsUsd: decimalToString(reservedFundsUsd),
    unrealizedPnlUsd: decimalToString(unrealizedPnlUsd),
    equityUsd: decimalToString(equityUsd),
    availableFundsUsd: decimalToString(availableFundsUsd),
  }
}
