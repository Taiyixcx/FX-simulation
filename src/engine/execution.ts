import { calculateAccount, calculateUnrealizedPnl, validateCurrencyPair, validateNotionalUsd } from './account'
import { decimalToString, MoneyDecimal, readDecimalString } from './decimal'
import { EngineError } from './errors'
import type {
  AccountState,
  CloseReason,
  ClosedPosition,
  CurrencyPair,
  MarketQuote,
  TradeDirection,
} from './types'

export interface TradeRiskPreview {
  direction: TradeDirection
  entryPrice: string
  exitQuoteSide: 'bid' | 'ask'
  quantityBaseUnits: string
  usdPerPip: string
  spreadPips: string
  immediateClosePnlUsd: string
  entryEquityUsd: string
  hypotheticalExitPrice: string | null
  hypotheticalPnlUsd: string | null
  canOpen: boolean
  rejectionMessage: string | null
}

export type PositionRiskPreview = Omit<TradeRiskPreview, 'entryEquityUsd' | 'canOpen' | 'rejectionMessage'> & {
  currentEquityUsd: string
}

const DEPLETED_ENTRY_MESSAGE = '当前报价的点差成本会耗尽训练资金，请减少交易金额或等待其他报价。'

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

/** New-order admission only. Historical ledgers still use openPosition unchanged. */
export function prepareOpenPosition(
  account: AccountState,
  quote: MarketQuote,
  pair: CurrencyPair,
  direction: TradeDirection,
  notionalUsd: string,
  id: string,
): AccountState {
  const candidate = openPosition(account, quote, pair, direction, notionalUsd, id)
  if (new MoneyDecimal(calculateAccount(candidate, quote).equityUsd).lte(0)) {
    throw new EngineError('insufficient-funds', DEPLETED_ENTRY_MESSAGE)
  }
  return candidate
}

/** A hypothetical price is the executable exit side: Bid for long, Ask for short. */
export function previewTradeRisk(
  account: AccountState,
  quote: MarketQuote,
  pair: CurrencyPair,
  direction: TradeDirection,
  notionalUsd: string,
  hypotheticalExitPrice?: string,
): TradeRiskPreview {
  const candidate = openPosition(account, quote, pair, direction, notionalUsd, 'risk-preview')
  const { currentEquityUsd, ...risk } = previewPositionRisk(candidate, quote, hypotheticalExitPrice)
  const canOpen = new MoneyDecimal(currentEquityUsd).gt(0)
  return { ...risk, entryEquityUsd: currentEquityUsd, canOpen, rejectionMessage: canOpen ? null : DEPLETED_ENTRY_MESSAGE }
}

/** Revalue an existing position at the current quote without placing an order. */
export function previewPositionRisk(account: AccountState, quote: MarketQuote, hypotheticalExitPrice?: string): PositionRiskPreview {
  const metrics = calculateAccount(account, quote)
  const position = account.position
  if (!position) throw new EngineError('no-position', '当前没有可预览的持仓。')
  const direction = position.direction
  let hypotheticalPnlUsd: string | null = null
  let normalizedExitPrice: string | null = null
  if (hypotheticalExitPrice !== undefined && hypotheticalExitPrice.trim() !== '') {
    const exitPrice = readDecimalString(hypotheticalExitPrice, '假设平仓价', 'invalid-quote')
    if (exitPrice.lte(0)) throw new EngineError('invalid-quote', '假设平仓价必须为正数。')
    normalizedExitPrice = decimalToString(exitPrice)
    // Equal sides are deliberately hypothetical, rather than fabricated source Ask.
    const exitQuote: MarketQuote = { ...quote, bidPrice: normalizedExitPrice, askPrice: normalizedExitPrice }
    hypotheticalPnlUsd = closePosition(account, exitQuote).trade.realizedPnlUsd
  }
  return {
    direction, entryPrice: position.entryPrice, exitQuoteSide: direction === 'long' ? 'bid' : 'ask',
    quantityBaseUnits: position.quantityBaseUnits,
    usdPerPip: decimalToString(new MoneyDecimal(position.quantityBaseUnits).times('0.0001')),
    spreadPips: decimalToString(new MoneyDecimal(quote.askPrice).minus(quote.bidPrice).div('0.0001')),
    immediateClosePnlUsd: closePosition(account, quote).trade.realizedPnlUsd,
    currentEquityUsd: metrics.equityUsd,
    hypotheticalExitPrice: normalizedExitPrice, hypotheticalPnlUsd,
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
