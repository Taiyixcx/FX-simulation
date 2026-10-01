export type CurrencyPair = 'EUR/USD' | 'GBP/USD'

export type TradeDirection = 'long' | 'short'

export type AskSource = 'training' | 'source'

/** Prices and monetary quantities cross module boundaries as decimal strings. */
export interface MarketQuote {
  timestampMs: number
  bidPrice: string
  askPrice: string
  askSource: AskSource
}

/** A completed minute; all OHLC values refer to Bid prices. */
export interface MarketFrame {
  quote: MarketQuote
  openPrice: string
  highPrice: string
  lowPrice: string
  closePrice: string
}

export interface Position {
  id: string
  pair: CurrencyPair
  direction: TradeDirection
  notionalUsd: string
  quantityBaseUnits: string
  entryPrice: string
  openedAtMs: number
}

export interface AccountState {
  balanceUsd: string
  position: Position | null
}

export type CloseReason = 'manual' | 'equity-depleted'

export interface TradeRecord extends Position {
  closedAtMs: number
  exitPrice: string
  realizedPnlUsd: string
  reason: CloseReason
}

export interface AccountMetrics {
  balanceUsd: string
  reservedFundsUsd: string
  unrealizedPnlUsd: string
  equityUsd: string
  availableFundsUsd: string
}

export interface ClosedPosition {
  account: AccountState
  trade: TradeRecord
}

export interface SimulationState {
  version: 1
  pair: CurrencyPair
  seed: number
  randomState: number
  frameIndex: number
  startTimestampMs: number
  maxFrames: number
  currentBidPrice: string
}

export interface SimulationStep {
  state: SimulationState
  frame: MarketFrame
}
