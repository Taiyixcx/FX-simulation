import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'

// This checks internal statistical behavior, not agreement with a historical dataset.
// Keep these seeds separate from the engine's reference-frame and event fixtures.
const SEEDS = [104729, 130363, 155921, 196613, 262147, 327673, 393241, 524287]
const STARTS = [
  '2024-03-04T00:01:00Z', '2024-03-08T00:01:00Z',
  '2024-03-11T00:01:00Z', '2024-03-25T00:01:00Z',
  '2024-07-01T00:01:00Z', '2024-10-28T00:01:00Z',
  '2024-11-04T00:01:00Z', '2024-12-02T00:01:00Z',
]

function mean(samples) {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length
}

function correlation(left, right) {
  const leftMean = mean(left)
  const rightMean = mean(right)
  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - leftMean
    const y = right[index] - rightMean
    covariance += x * y
    leftVariance += x * x
    rightVariance += y * y
  }
  return covariance / Math.sqrt(leftVariance * rightVariance)
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
}

function rounded(input) {
  return Number(input.toFixed(6))
}

const failures = []
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { createSimulation, advanceSimulation } = await server.ssrLoadModule('/src/engine/simulationSource.ts')
  const results = []
  for (const pair of ['EUR/USD', 'GBP/USD']) {
    for (const scenario of ['standard', 'eventful']) {
      const returns = []
      const precedingReturns = []
      const followingReturns = []
      const precedingAbsoluteReturns = []
      const followingAbsoluteReturns = []
      const spreads = []
      const eventCounts = []
      let positiveReturns = 0
      let nonzeroReturns = 0
      let phaseCorrect = 0
      let phaseTrials = 0
      let momentumCorrect = 0
      let momentumTrials = 0
      let momentumTrades = 0
      let momentumNetPips = 0
      let checkedFrames = 0

      for (const [sessionIndex, seed] of SEEDS.entries()) {
        let step = createSimulation(pair, seed, { scenario, startTimestampMs: Date.parse(STARTS[sessionIndex]) })
        let previousMid = null
        let previousSpread = null
        let previousReturn = null
        const recentReturns = []
        const eventIds = new Set()
        while (true) {
          const { frame, state } = step
          const bidPrice = Number(frame.quote.bidPrice)
          const askPrice = Number(frame.quote.askPrice)
          const midPrice = (bidPrice + askPrice) / 2
          const spread = askPrice - bidPrice
          if (!(bidPrice > 0 && askPrice > bidPrice && Number(frame.lowPrice) > 0
            && Number(frame.lowPrice) <= Math.min(Number(frame.openPrice), bidPrice)
            && Number(frame.highPrice) >= Math.max(Number(frame.openPrice), bidPrice)
            && frame.closePrice === frame.quote.bidPrice)) {
            throw new Error(`${pair}/${scenario}/${seed}: invalid OHLC or Bid/Ask`)
          }
          if (state.lastEvent) {
            if (state.lastEvent.occurredAtMs > frame.quote.timestampMs) throw new Error('Future event leaked')
            eventIds.add(state.lastEvent.id)
          }
          if (state.upcomingScheduledEvent && 'surprise' in state.upcomingScheduledEvent) throw new Error('Future surprise leaked')
          spreads.push(spread / .0001)
          checkedFrames += 1
          if (previousMid !== null) {
            const logReturn = Math.log(midPrice / previousMid)
            returns.push(logReturn)
            const direction = Math.sign(logReturn)
            if (direction !== 0) {
              nonzeroReturns += 1
              if (direction > 0) positiveReturns += 1
              // Challenge the old model's deterministic 120-minute directional blocks.
              const oldPhase = Math.floor(state.frameIndex / 120) % 4
              if (oldPhase === 0 || oldPhase === 2) {
                phaseTrials += 1
                if (direction === (oldPhase === 0 ? 1 : -1)) phaseCorrect += 1
              }
            }
            if (recentReturns.length >= 5) {
              const prediction = Math.sign(recentReturns.slice(-5).reduce((sum, sample) => sum + sample, 0))
              if (prediction !== 0) {
                momentumTrades += 1
                if (direction !== 0) {
                  momentumTrials += 1
                  if (prediction === direction) momentumCorrect += 1
                }
                // Include flat outcomes too: trade decisions cannot use the next return.
                momentumNetPips += (prediction * (midPrice - previousMid) - (spread + previousSpread) / 2) / .0001
              }
            }
            if (previousReturn !== null) {
              precedingReturns.push(previousReturn)
              followingReturns.push(logReturn)
              precedingAbsoluteReturns.push(Math.abs(previousReturn))
              followingAbsoluteReturns.push(Math.abs(logReturn))
            }
            previousReturn = logReturn
            recentReturns.push(logReturn)
          }
          previousMid = midPrice
          previousSpread = spread
          const next = advanceSimulation(state)
          if (!next) break
          if (next.frame.quote.timestampMs <= frame.quote.timestampMs) throw new Error('Non-increasing simulated clock')
          step = next
        }
        eventCounts.push(eventIds.size)
      }

      const meanReturn = mean(returns)
      const variance = mean(returns.map(sample => (sample - meanReturn) ** 2))
      const excessKurtosis = mean(returns.map(sample => (sample - meanReturn) ** 4)) / variance ** 2 - 3
      const sortedAbsoluteReturns = returns.map(Math.abs).sort((left, right) => left - right)
      spreads.sort((left, right) => left - right)
      const directionCorrelation = correlation(precedingReturns, followingReturns)
      const volatilityCorrelation = correlation(precedingAbsoluteReturns, followingAbsoluteReturns)
      const phaseAccuracy = phaseCorrect / phaseTrials
      const result = {
        pair, scenario, sessions: SEEDS.length, checkedFrames,
        meanLogReturn: rounded(meanReturn),
        positiveShare: rounded(positiveReturns / nonzeroReturns),
        lagOneReturnCorrelation: rounded(directionCorrelation),
        lagOneAbsoluteReturnCorrelation: rounded(volatilityCorrelation),
        excessKurtosis: rounded(excessKurtosis),
        absoluteReturnQuantiles: Object.fromEntries([.95, .99, .999].map(probability => [probability, rounded(quantile(sortedAbsoluteReturns, probability))])),
        spreadPips: { minimum: rounded(spreads[0]), median: rounded(quantile(spreads, .5)), p99: rounded(quantile(spreads, .99)), maximum: rounded(spreads.at(-1)) },
        eventsPerSession: eventCounts,
        oldFixedPhaseAccuracy: rounded(phaseAccuracy),
        fiveMinuteMomentumAccuracy: rounded(momentumCorrect / momentumTrials),
        fiveMinuteMomentumMeanNetPips: rounded(momentumNetPips / momentumTrades),
      }
      // Broad engineering checks, deliberately not a claim of market calibration or efficiency.
      if (Math.abs(directionCorrelation) > .15) failures.push(`${pair}/${scenario}: large first-lag directional correlation`)
      if (volatilityCorrelation < .04) failures.push(`${pair}/${scenario}: no persistent volatility`)
      if (phaseAccuracy > .58 || phaseAccuracy < .42) failures.push(`${pair}/${scenario}: fixed-phase directional artifact`)
      if (excessKurtosis < .1) failures.push(`${pair}/${scenario}: unconditional tails remain near constant Gaussian noise`)
      results.push(result)
      process.stdout.write(`${pair} ${scenario}: direction ACF=${result.lagOneReturnCorrelation}, |return| ACF=${result.lagOneAbsoluteReturnCorrelation}, phase accuracy=${result.oldFixedPhaseAccuracy}, events=${eventCounts.join(',')}\n`)
    }
  }
  const report = {
    purpose: 'Internal model diagnostics; no historical dataset used, no claim of calibrated realism or proof of unpredictability.',
    modelVersion: 2, seeds: SEEDS, starts: STARTS, results, failures,
  }
  const outputDirectory = resolve('.vite')
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(resolve(outputDirectory, 'simulation-validation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('Internal diagnostics passed. Report: .vite/simulation-validation.json\n')
  }
} finally {
  await server.close()
}
