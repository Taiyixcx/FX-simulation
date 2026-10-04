import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer } from 'vite'

// Personal, previously acquired HistData inputs remain outside Git. January and
// March are the estimation periods; September is never used to estimate values.
const FIT_MONTHS = ['202401', '202403']
const HOLDOUT_MONTH = '202409'
const PAIRS = ['EUR/USD', 'GBP/USD']
const SEEDS = [104729, 130363, 155921, 196613]
const FRAMES = 6_000
const outputDirectory = resolve('.vite')
await mkdir(outputDirectory, { recursive: true })
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom', logLevel: 'error' })

function quantile(samples, probability) {
  if (!samples.length) throw new Error('统计样本为空。')
  const sorted = [...samples].sort((left, right) => left - right)
  const index = (sorted.length - 1) * probability
  const floor = Math.floor(index)
  return sorted[floor] + (sorted[Math.ceil(index)] - sorted[floor]) * (index - floor)
}
function summarize(samples) {
  const mean = samples.returns.reduce((sum, sample) => sum + sample, 0) / samples.returns.length
  return {
    returnCount: samples.returns.length,
    minuteReturnStd: Math.sqrt(samples.returns.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) / samples.returns.length),
    normalizedRobustStd: quantile(samples.normalizedAbsoluteReturns, .5) / .6744897501960817,
    absoluteReturnP99: quantile(samples.returns.map(Math.abs), .99),
    medianSpreadPips: quantile(samples.spreads, .5), spreadP99Pips: quantile(samples.spreads, .99),
  }
}
function combine(samples) {
  return { returns: samples.flatMap(sample => sample.returns), normalizedAbsoluteReturns: samples.flatMap(sample => sample.normalizedAbsoluteReturns), spreads: samples.flatMap(sample => sample.spreads) }
}

try {
  const { parseHistoryCsv } = await server.ssrLoadModule('/src/engine/historyCsv.ts')
  const { MoneyDecimal } = await server.ssrLoadModule('/src/engine/decimal.ts')
  const { createSimulation, advanceSimulation } = await server.ssrLoadModule('/src/engine/simulationSource.ts')
  const { SIMULATION_PAIR_PARAMETERS, getSimulationSeasonality } = await server.ssrLoadModule('/src/engine/simulationParameters.ts')
  function samplesFromFrames(frames) {
    const result = { returns: [], normalizedAbsoluteReturns: [], spreads: [] }
    let previous
    for (const frame of frames) {
      const quote = frame.quote
      const midpoint = new MoneyDecimal(quote.bidPrice).plus(quote.askPrice).div(2).toNumber()
      result.spreads.push(new MoneyDecimal(quote.askPrice).minus(quote.bidPrice).div('.0001').toNumber())
      if (previous && quote.timestampMs - previous.timestampMs === 60_000) {
        const change = Math.log(midpoint / previous.midpoint)
        result.returns.push(change)
        result.normalizedAbsoluteReturns.push(Math.abs(change) / Math.sqrt(getSimulationSeasonality(quote.timestampMs).varianceMultiplier))
      }
      previous = { midpoint, timestampMs: quote.timestampMs }
    }
    return result
  }
  const provenance = []
  async function history(pair, month, role) {
    const filename = `${pair.replace('/', '').toLowerCase()}-${month}-m1.csv`
    const pathname = resolve('local-data/research', filename)
    const bytes = await readFile(pathname)
    const metadata = JSON.parse(await readFile(`${pathname}.metadata.json`, 'utf8'))
    const fileSha256 = createHash('sha256').update(bytes).digest('hex')
    if (fileSha256 !== metadata.fileSha256) throw new Error(`${filename} 的原始字节校验不一致。`)
    const dataset = await parseHistoryCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes), pair, metadata)
    provenance.push({ pair, month, role, filename, recordCount: dataset.frames.length, startTimestampMs: dataset.metadata.startTimestampMs, endTimestampMs: dataset.metadata.endTimestampMs, fileSha256, fingerprint: dataset.fingerprint, originalTimezone: metadata.originalTimezone, sourceUrl: metadata.sourceUrl })
    return dataset
  }
  function simulationSamples(pair, parameterVersion, startTimestampMs, seed) {
    let step = createSimulation(pair, seed, { parameterVersion, maxFrames: FRAMES, startTimestampMs, scenario: 'standard' })
    if (step.state.parameterVersion !== parameterVersion) throw new Error(`引擎尚不支持参数版本 ${parameterVersion}。`)
    const frames = [step.frame]
    while (frames.length < FRAMES) { step = advanceSimulation(step.state); if (!step) throw new Error('模拟样本提前结束。'); frames.push(step.frame) }
    return samplesFromFrames(frames)
  }

  const fit = {}
  const proposed = {}
  const fitStarts = {}
  for (const pair of PAIRS) {
    const historical = []
    const simulated = []
    const starts = []
    for (const month of FIT_MONTHS) {
      const dataset = await history(pair, month, 'fit')
      historical.push(samplesFromFrames(dataset.frames))
      starts.push(dataset.frames[0].quote.timestampMs)
      for (const seed of SEEDS) simulated.push(simulationSamples(pair, 1, dataset.frames[0].quote.timestampMs, seed))
    }
    const target = summarize(combine(historical))
    const reference = summarize(combine(simulated))
    const old = SIMULATION_PAIR_PARAMETERS[pair]
    proposed[pair] = {
      minuteReturnStd: Number((old.minuteReturnStd * target.normalizedRobustStd / reference.normalizedRobustStd).toPrecision(7)),
      baseSpreadPrice: MoneyDecimal.max(old.minimumSpreadPrice, new MoneyDecimal(old.baseSpreadPrice).times(target.medianSpreadPips).div(reference.medianSpreadPips)).toFixed(5),
    }
    fit[pair] = { historical: target, legacySimulation: reference, proposed: proposed[pair] }
    fitStarts[pair] = starts
    process.stdout.write(`${pair} estimation complete: ${JSON.stringify(proposed[pair])}\n`)
  }
  const artifact = {
    parameterVersion: 2, estimationMonths: FIT_MONTHS, holdoutMonth: HOLDOUT_MONTH,
    method: 'Whole-month contiguous completed-minute midpoint returns; existing calendar seasonality normalization; robust scale matched to legacy reference simulations. Median spread baseline matched with existing minimum floor.',
    pairs: proposed, samples: provenance,
    limitations: ['Single provider, limited periods; no claim of whole-market realism.', 'Only ordinary return scale and baseline spread are estimated. Event frequency, event effects, persistence and seasonality shape remain training assumptions.', 'GBPUSD 202410 was rejected for out-of-order raw ticks; no sorting or row deletion. EURUSD 202410 was explored and is not a holdout.'],
  }
  await writeFile(resolve(outputDirectory, 'calibration-fit.json'), JSON.stringify({ artifact, fit }, null, 2) + '\n')
  const artifactPath = resolve('public/data/simulation-calibration.json')
  try { await access(artifactPath) }
  catch { await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' }) }
  const frozen = JSON.parse(await readFile(artifactPath, 'utf8'))
  if (JSON.stringify(frozen.pairs) !== JSON.stringify(proposed)) throw new Error('已发布参数版本与重新估计不同；不覆盖旧版本，需另建新参数版本。')
  if (process.argv.includes('--fit-only')) {
    process.stdout.write('Candidate version 2 frozen; September has not been evaluated by this run.\n')
  } else {
    const holdout = {}
    for (const pair of PAIRS) {
      const dataset = await history(pair, HOLDOUT_MONTH, 'holdout')
      const target = summarize(samplesFromFrames(dataset.frames))
      const legacy = summarize(combine(SEEDS.map(seed => simulationSamples(pair, 1, dataset.frames[0].quote.timestampMs, seed))))
      const calibrated = summarize(combine(SEEDS.map(seed => simulationSamples(pair, 2, dataset.frames[0].quote.timestampMs, seed))))
      const metrics = ['normalizedRobustStd', 'medianSpreadPips']
      const errors = Object.fromEntries(metrics.map(metric => [metric, {
        legacyRelativeError: Math.abs(legacy[metric] / target[metric] - 1), calibratedRelativeError: Math.abs(calibrated[metric] / target[metric] - 1),
      }]))
      holdout[pair] = { historical: target, legacySimulation: legacy, calibratedSimulation: calibrated, errors }
      process.stdout.write(`${pair} holdout: ${JSON.stringify(errors)}\n`)
    }
    await writeFile(resolve(outputDirectory, 'calibration-validation.json'), JSON.stringify({ parameterVersion: 2, samples: provenance, fit, holdout, fitStarts, seeds: SEEDS, simulationFramesPerSeed: FRAMES, limitations: artifact.limitations }, null, 2) + '\n')
    process.stdout.write('Historical calibration diagnostics saved in .vite/calibration-validation.json.\n')
  }
} finally { await server.close() }
