import type { CurrencyPair, SimulationScenario } from './types'

/** Versioned training assumptions, not estimates calibrated to a historical sample. */
export const SIMULATION_PARAMETER_VERSION = 1
export const SIMULATION_MINUTE_MS = 60_000
export const SIMULATION_DAY_MS = 86_400_000
export const SIMULATION_SUBSTEPS = 12
export const MIN_SIMULATION_TIMESTAMP_MS = Date.UTC(2007, 0, 1)
export const MAX_SIMULATION_TIMESTAMP_MS = Date.UTC(2100, 0, 1) - SIMULATION_MINUTE_MS

export const SIMULATION_VOLATILITY = Object.freeze({
  slowHalfLifeMinutes: 720,
  fastHalfLifeMinutes: 30,
  slowStationaryVariance: 0.36,
  fastStationaryVariance: 0.24,
  eventHalfLifeMinutes: 24,
  liquidityHalfLifeMinutes: 12,
  temporaryHalfLifeMinutes: 18,
})

export const SIMULATION_PAIR_PARAMETERS: Readonly<Record<CurrencyPair, {
  initialBidPrice: string
  baseSpreadPrice: string
  minimumSpreadPrice: string
  minuteReturnStd: number
  eventReturnStd: number
}>> = Object.freeze({
  'EUR/USD': Object.freeze({
    initialBidPrice: '1.08500', baseSpreadPrice: '0.0001', minimumSpreadPrice: '0.00002',
    minuteReturnStd: 0.0001, eventReturnStd: 0.00065,
  }),
  'GBP/USD': Object.freeze({
    initialBidPrice: '1.27000', baseSpreadPrice: '0.00015', minimumSpreadPrice: '0.00003',
    minuteReturnStd: 0.00013, eventReturnStd: 0.00085,
  }),
})

export const SIMULATION_SCENARIO_PARAMETERS: Readonly<Record<SimulationScenario, {
  londonDataProbability: number
  newYorkDataProbability: number
  policyProbability: number
  surpriseProbabilityPerMinute: number
}>> = Object.freeze({
  standard: Object.freeze({
    londonDataProbability: 0.22, newYorkDataProbability: 0.3, policyProbability: 0.025,
    surpriseProbabilityPerMinute: 1 / 12_000,
  }),
  eventful: Object.freeze({
    londonDataProbability: 0.9, newYorkDataProbability: 0.9, policyProbability: 0.65,
    surpriseProbabilityPerMinute: 1 / 420,
  }),
})

function nthSundayUtc(year: number, month: number, ordinal: number, hour: number): number {
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const day = 1 + (7 - firstDay) % 7 + (ordinal - 1) * 7
  return Date.UTC(year, month, day, hour)
}

function lastSundayUtc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1)
}

/** Modern calendar rules are fixed here, so replay never depends on the host timezone. */
export function getLondonOffsetMinutes(timestampMs: number): number {
  const year = new Date(timestampMs).getUTCFullYear()
  return timestampMs >= lastSundayUtc(year, 2) && timestampMs < lastSundayUtc(year, 9) ? 60 : 0
}

export function getNewYorkOffsetMinutes(timestampMs: number): number {
  const year = new Date(timestampMs).getUTCFullYear()
  // US transitions occur at 02:00 local: 07:00 UTC in March, 06:00 UTC in November.
  return timestampMs >= nthSundayUtc(year, 2, 2, 7) && timestampMs < nthSundayUtc(year, 10, 1, 6)
    ? -240 : -300
}

export function isSimulationMarketOpen(timestampMs: number): boolean {
  const localDate = new Date(timestampMs + getNewYorkOffsetMinutes(timestampMs) * SIMULATION_MINUTE_MS)
  const weekday = localDate.getUTCDay()
  const localMinute = localDate.getUTCHours() * 60 + localDate.getUTCMinutes()
  return weekday !== 6 && (weekday !== 5 || localMinute < 17 * 60) && (weekday !== 0 || localMinute >= 17 * 60)
}

/** The timestamp is the END of a completed minute, including the last Friday 17:00 bar. */
export function nextSimulationTimestamp(timestampMs: number): number {
  let nextTimestampMs = timestampMs + SIMULATION_MINUTE_MS
  if (isSimulationMarketOpen(nextTimestampMs - SIMULATION_MINUTE_MS)) return nextTimestampMs
  const localDate = new Date(nextTimestampMs + getNewYorkOffsetMinutes(nextTimestampMs) * SIMULATION_MINUTE_MS)
  const daysUntilSunday = (7 - localDate.getUTCDay()) % 7
  const sundayDateUtc = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate() + daysUntilSunday, 17)
  // At the Sunday opening the DST transition has already happened.
  nextTimestampMs = sundayDateUtc - getNewYorkOffsetMinutes(sundayDateUtc + 5 * 3_600_000) * SIMULATION_MINUTE_MS + SIMULATION_MINUTE_MS
  return nextTimestampMs
}

export function lastSimulationTimestamp(initialTimestampMs: number, remainingFrames: number): number {
  let timestampMs = initialTimestampMs
  let remaining = remainingFrames
  while (remaining > 0) {
    const firstTimestampMs = nextSimulationTimestamp(timestampMs)
    const localDate = new Date(firstTimestampMs + getNewYorkOffsetMinutes(firstTimestampMs) * SIMULATION_MINUTE_MS)
    const daysUntilFriday = (5 - localDate.getUTCDay() + 7) % 7
    const fridayDateUtc = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate() + daysUntilFriday, 17)
    const fridayCloseMs = fridayDateUtc - getNewYorkOffsetMinutes(fridayDateUtc) * SIMULATION_MINUTE_MS
    const availableMinutes = Math.floor((fridayCloseMs - firstTimestampMs) / SIMULATION_MINUTE_MS) + 1
    const minutesToAdvance = Math.min(remaining, Math.max(1, availableMinutes))
    timestampMs = firstTimestampMs + (minutesToAdvance - 1) * SIMULATION_MINUTE_MS
    remaining -= minutesToAdvance
  }
  return timestampMs
}

function circularHourDistance(hour: number, center: number): number {
  const distance = Math.abs(hour - center)
  return Math.min(distance, 24 - distance)
}

function rawSeasonalVariance(londonHour: number, newYorkHour: number): number {
  return 0.35
    + 0.75 * Math.exp(-0.5 * (circularHourDistance(londonHour, 10) / 2.5) ** 2)
    + 0.95 * Math.exp(-0.5 * (circularHourDistance(newYorkHour, 10) / 2.8) ** 2)
}

const seasonalNormalizers = new Map<string, number>()

export function getSimulationSeasonality(timestampMs: number): { varianceMultiplier: number, spreadMultiplier: number } {
  const londonOffset = getLondonOffsetMinutes(timestampMs)
  const newYorkOffset = getNewYorkOffsetMinutes(timestampMs)
  const key = `${londonOffset}:${newYorkOffset}`
  let normalizer = seasonalNormalizers.get(key)
  if (normalizer === undefined) {
    let sum = 0
    for (let minute = 0; minute < 1440; minute += 1) {
      sum += rawSeasonalVariance(((minute + londonOffset + 1440) % 1440) / 60, ((minute + newYorkOffset + 1440) % 1440) / 60)
    }
    normalizer = sum / 1440
    seasonalNormalizers.set(key, normalizer)
  }
  const utcMinute = ((timestampMs % SIMULATION_DAY_MS) / SIMULATION_MINUTE_MS + 1440) % 1440
  const londonHour = ((utcMinute + londonOffset + 1440) % 1440) / 60
  const newYorkHour = ((utcMinute + newYorkOffset + 1440) % 1440) / 60
  const isActive = (londonHour >= 7 && londonHour < 17) || (newYorkHour >= 8 && newYorkHour < 17)
  const rolloverDistance = circularHourDistance(newYorkHour, 17)
  return {
    varianceMultiplier: rawSeasonalVariance(londonHour, newYorkHour) / normalizer,
    spreadMultiplier: (isActive ? 0.8 : 1.25) + 1.5 * Math.exp(-0.5 * (rolloverDistance / 0.12) ** 2),
  }
}
