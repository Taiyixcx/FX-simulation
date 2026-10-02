import type { CurrencyPair, MarketFrame } from './types'

/** Quote provenance is independent of whether the provider has been verified. */
export type HistoryQuoteType = 'source' | 'training' | 'mixed'

export interface HistoryMetadata {
  label: string
  sourceName: string
  sourceUrl: string
  originalTimezone: string
  quoteType: HistoryQuoteType
  verified: boolean
  period: 'M1'
  startTimestampMs: number
  endTimestampMs: number
  recordCount: number
  conversionNotes: string
  conversionVersion: string
  licenseNotes: string
  /** SHA-256 of the exact UTF-8 CSV file, separate from normalized content. */
  fileSha256: string
}

export interface HistoryDataset {
  id: string
  pair: CurrencyPair
  frames: MarketFrame[]
  metadata: HistoryMetadata
  /** SHA-256 of the currency pair and all normalized completed quotations. */
  fingerprint: string
}

export type HistoryDatasetSummary = Pick<HistoryDataset, 'id' | 'pair' | 'fingerprint' | 'metadata'>

/** Contains progress only. Future quotations stay in the dataset owner. */
export interface HistoryState {
  datasetId: string
  fingerprint: string
  frameIndex: number
  maxFrames: number
  currentTimestampMs: number
}

export interface HistoryStep {
  state: HistoryState
  frame: MarketFrame
}

export interface HistoryCsvIssue {
  /** Physical line in the original file, starting at 1. */
  line: number
  field: string
  message: string
}
