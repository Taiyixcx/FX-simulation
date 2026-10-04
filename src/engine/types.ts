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

export type SimulationScenario = 'standard' | 'eventful'

export type SimulationEventType = 'economic-data' | 'policy' | 'liquidity'

/** Only published event information; no future outcome is present in the source state. */
export interface ScheduledSimulationEvent {
  timestampMs: number
  type: 'economic-data' | 'policy'
  label: string
  expected: string
}

export interface SimulationEvent {
  id: string
  occurredAtMs: number
  type: SimulationEventType
  label: string
  detail: string
  /** A dimensionless, standardized surprise, not an actual economic statistic. */
  surprise: number
}

export interface SimulationState {
  version: 2
  parameterVersion: 1 | 2
  scenario: SimulationScenario
  pair: CurrencyPair
  seed: number
  randomState: number
  eventRandomState: number
  scheduleRandomState: number
  /** Scheduled candidates at or before this minute have already been sampled. */
  scheduledSearchThroughTimestampMs: number
  frameIndex: number
  originFrameIndex: number
  startTimestampMs: number
  /** null continues until the user pauses or a supported-clock boundary is reached. */
  maxFrames: number | null
  /** Quote time immediately before the first generated suffix frame. */
  initialTimestampMs: number
  currentTimestampMs: number
  initialBidPrice: string
  initialAskPrice: string
  currentBidPrice: string
  currentAskPrice: string
  slowLogVariance: number
  fastLogVariance: number
  liquidityPressure: number
  eventVariance: number
  temporaryDislocationLog: number
  economicContext: number
  policySensitivity: number
  lastEvent: SimulationEvent | null
  upcomingScheduledEvent: ScheduledSimulationEvent | null
}

export interface SimulationStep {
  state: SimulationState
  frame: MarketFrame
}
