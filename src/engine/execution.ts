import { calculateAccount, calculateUnrealizedPnl, validateCurrencyPair, validateNotionalUsd } from './account'
import { decimalToString, MoneyDecimal } from './decimal'
import { EngineError } from './errors'
import type {
  AccountState,
  CloseReason,
  ClosedPosition,
  CurrencyPair,
  MarketQuote,
  TradeDirection,
} from './types'

export function openPosition(
  account: AccountState,
  quote: MarketQuote,
  pair: CurrencyPair,
  direction: TradeDirection,
  notionalUsd: string,
  id: string,
): AccountState {
  const metrics = calculateAccount(account, quote)
  validateCurrencyPair(pair)
  validateNotionalUsd(notionalUsd)
  if (direction !== 'long' && direction !== 'short') {
    throw new EngineError('invalid-account', '请选择买涨或买跌。')
  }
  if (typeof id !== 'string' || !id) {
    throw new EngineError('invalid-account', '交易标识无效。')
  }
  if (account.position) {
    throw new EngineError('position-exists', '请先平仓，再开始下一笔交易。')
  }
  if (new MoneyDecimal(notionalUsd).gt(metrics.availableFundsUsd)) {
    throw new EngineError('insufficient-funds', '交易金额超过当前可用资金。')
  }
  const entryPrice = direction === 'long' ? quote.askPrice : quote.bidPrice
  return {
    balanceUsd: metrics.balanceUsd,
    position: {
      id,
      pair,
      direction,
      notionalUsd: new MoneyDecimal(notionalUsd).toFixed(2),
      quantityBaseUnits: decimalToString(new MoneyDecimal(notionalUsd).div(entryPrice)),
      entryPrice: decimalToString(new MoneyDecimal(entryPrice)),
      openedAtMs: quote.timestampMs,
    },
  }
}

export function closePosition(
  account: AccountState,
  quote: MarketQuote,
  reason: CloseReason = 'manual',
): ClosedPosition {
  const metrics = calculateAccount(account, quote)
  if (!account.position) {
    throw new EngineError('no-position', '当前没有可平仓的持仓。')
  }
  if (reason !== 'manual' && reason !== 'equity-depleted') {
    throw new EngineError('invalid-account', '平仓原因无效。')
  }
  if (reason === 'equity-depleted' && new MoneyDecimal(metrics.equityUsd).gt(0)) {
    throw new EngineError('invalid-account', '权益尚未耗尽，不能记录为资金耗尽平仓。')
  }
  const position = account.position
  const realizedPnlUsd = calculateUnrealizedPnl(position, quote).toDecimalPlaces(2)
  const exitPrice = position.direction === 'long' ? quote.bidPrice : quote.askPrice
  return {
    account: {
      balanceUsd: new MoneyDecimal(account.balanceUsd).plus(realizedPnlUsd).toFixed(2),
      position: null,
    },
    trade: {
      ...position,
      closedAtMs: quote.timestampMs,
      exitPrice: decimalToString(new MoneyDecimal(exitPrice)),
      realizedPnlUsd: realizedPnlUsd.toFixed(2),
      reason,
    },
  }
}

/** Call for every visible frame, including intermediate frames during accelerated replay. */
export function settleDepletedAccount(account: AccountState, quote: MarketQuote): ClosedPosition | null {
  const metrics = calculateAccount(account, quote)
  if (!account.position || new MoneyDecimal(metrics.equityUsd).gt(0)) {
    return null
  }
  return closePosition(account, quote, 'equity-depleted')
}
