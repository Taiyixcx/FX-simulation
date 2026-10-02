import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import Decimal from 'decimal.js'

export const HISTDATA_CONVERSION_VERSION = 'histdata-tick-m1-v1'
const SOURCE_URL = 'https://www.histdata.com/f-a-q/data-files-detailed-specification/'
const PriceDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

function invalid(line, field, message) {
  throw new Error(`第 ${line} 行 / ${field}：${message}`)
}

function parseTickTimestamp(input, line) {
  const match = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})(\d{3})$/.exec(input)
  if (!match) invalid(line, 'timestamp', '须为 HistData YYYYMMDD HHMMSSNNN 格式。')
  const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map(Number)
  if (year < 1970 || year > 9998 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) invalid(line, 'timestamp', '日期时间超出有效范围。')
  const localTimestampMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const localDate = new Date(localTimestampMs)
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day) invalid(line, 'timestamp', '不存在的日历日期。')
  // HistData uses fixed EST, never America/New_York daylight-saving time.
  return localTimestampMs + 5 * 60 * 60 * 1_000
}

function parsePrice(input, line, field) {
  if (input.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) invalid(line, field, '价格须为正的有限十进制数。')
  const price = new PriceDecimal(input)
  if (!price.isFinite() || price.lte(0)) invalid(line, field, '价格必须为正。')
  return price
}

/** Reads user-prepared local files only; no downloading or network data calls. */
export async function convertHistData(options) {
  const inputPath = resolve(options.input)
  const outputPath = resolve(options.output)
  const metadataPath = `${outputPath}.metadata.json`
  if (!['EUR/USD', 'GBP/USD'].includes(options.pair)) throw new Error('--pair 须为 EUR/USD 或 GBP/USD。')
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error('输出不能覆盖原始输入文件。')
  const sourceStat = await stat(inputPath)
  if (!sourceStat.isFile() || sourceStat.size > 2 * 1024 * 1024 * 1024) throw new Error('输入须为不超过 2 GiB 的本机 tick 文件。')
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' })
  try {
    const { parseHistoryCsv, parseHistoryTimestamp } = await server.ssrLoadModule('/src/engine/historyCsv.ts')
    const fromTimestampMs = options.from ? parseHistoryTimestamp(options.from) : 0
    const toTimestampMs = options.to ? parseHistoryTimestamp(options.to) : 253_402_300_740_000
    if (fromTimestampMs > toTimestampMs) throw new Error('--from 不能晚于 --to（均为 UTC 完成分钟，含边界）。')
    const inputHash = createHash('sha256')
    const input = createReadStream(inputPath)
    let inputBytes = 0
    input.on('data', (chunk) => { inputBytes += chunk.length; inputHash.update(chunk) })
    const reader = createInterface({ input, crlfDelay: Infinity })
    let inputRecordCount = 0
    let totalMinuteCount = 0
    let previousTimestampMs = -1
    let firstTimestampMs = null
    let currentMinute = null
    const outputRows = []
    function flushMinute() {
      if (!currentMinute) return
      totalMinuteCount += 1
      const completedTimestampMs = currentMinute.minuteStartMs + 60_000
      if (completedTimestampMs < fromTimestampMs || completedTimestampMs > toTimestampMs) return
      outputRows.push([
        new Date(completedTimestampMs).toISOString(), currentMinute.openPrice, currentMinute.highPrice,
        currentMinute.lowPrice, currentMinute.closePrice, currentMinute.askPrice,
      ].join(','))
      if (outputRows.length > 200_000) throw new Error('输出超过 200,000 根，请用 --from/--to 选择较短范围。')
    }
    try {
    for await (const rawLine of reader) {
      inputRecordCount += 1
      const line = inputRecordCount === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine
      if (!line || line.length > 512) invalid(inputRecordCount, 'file', '空行或过长的 tick 行。')
      const cells = line.split(',')
      if (cells.length !== 4) invalid(inputRecordCount, 'columns', '双边 Generic ASCII tick 须含 timestamp,bid,ask,volume 四列。')
      const timestampMs = parseTickTimestamp(cells[0], inputRecordCount)
      if (timestampMs < previousTimestampMs) invalid(inputRecordCount, 'timestamp', '原始 tick 不得乱序；不会静默排序。')
      previousTimestampMs = timestampMs
      firstTimestampMs ??= timestampMs
      const bid = parsePrice(cells[1], inputRecordCount, 'bid')
      const ask = parsePrice(cells[2], inputRecordCount, 'ask')
      if (ask.lt(bid)) invalid(inputRecordCount, 'ask', 'Ask 不能低于 Bid。')
      if (cells[3].length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(cells[3]) || !new PriceDecimal(cells[3]).isFinite()) invalid(inputRecordCount, 'volume', '原始 volume 字段无效；本工具不将其输出为真实成交量。')
      const minuteStartMs = Math.floor(timestampMs / 60_000) * 60_000
      if (!currentMinute || currentMinute.minuteStartMs !== minuteStartMs) {
        flushMinute()
        currentMinute = { minuteStartMs, openPrice: cells[1], highPrice: cells[1], lowPrice: cells[1], closePrice: cells[1], askPrice: cells[2] }
      } else {
        if (bid.gt(currentMinute.highPrice)) currentMinute.highPrice = cells[1]
        if (bid.lt(currentMinute.lowPrice)) currentMinute.lowPrice = cells[1]
        currentMinute.closePrice = cells[1]
        currentMinute.askPrice = cells[2]
      }
    }
    } finally { reader.close(); input.destroy() }
    flushMinute()
    if (!inputRecordCount || !outputRows.length) throw new Error('输入为空或指定完成时间范围内没有行情。')
    if (inputBytes !== sourceStat.size) throw new Error('读取期间原始文件大小发生变化，请使用稳定的本机源文件重试。')
    const inputSha256 = inputHash.digest('hex')
    const outputText = `timestamp,open,high,low,close,ask\n${outputRows.join('\n')}\n`
    const dataset = await parseHistoryCsv(outputText, options.pair, {
      label: `${options.pair} HistData M1`, sourceName: 'HistData Generic ASCII 双边 tick', sourceUrl: SOURCE_URL,
      originalTimezone: '固定 EST / UTC−05:00（不采用夏令时）', verified: false,
      conversionVersion: HISTDATA_CONVERSION_VERSION,
      conversionNotes: '按 UTC [minuteStart, minuteStart+60秒) 聚合 Bid OHLC，时间标为分钟完成；保留最后一组 Bid/Ask，不补无 tick 分钟。原始 tick 已全量校验，--from/--to 仅裁剪输出完成时间（含边界）。',
      licenseNotes: '仅在本机按来源允许的个人策略研究用途使用；尚未核实公开再分发许可，原始及转换价格文件不提交公开仓库。',
    })
    const metadata = {
      ...dataset.metadata,
      provenance: {
        version: HISTDATA_CONVERSION_VERSION, inputFilename: basename(inputPath), inputBytes: sourceStat.size,
        inputSha256, inputRecordCount, inputStartTimestampMs: firstTimestampMs, inputEndTimestampMs: previousTimestampMs,
        fullOutputMinuteCount: totalMinuteCount, outputRecordCount: dataset.frames.length,
        outputSha256: dataset.metadata.fileSha256, fingerprint: dataset.fingerprint,
        completedTimeRangeInclusive: { fromTimestampMs, toTimestampMs },
        validation: '原始时间、顺序、正 Bid/Ask、Ask≥Bid、volume 字段与全部输出 CSV 校验通过',
      },
    }
    for (const path of [outputPath, metadataPath]) {
      try { await stat(path) } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') continue
        throw cause
      }
      throw new Error(`输出已存在，拒绝覆盖：${path}`)
    }
    await mkdir(dirname(outputPath), { recursive: true })
    // Refuse existing files: a mistaken path must not destroy a local dataset.
    await writeFile(outputPath, outputText, { encoding: 'utf8', flag: 'wx' })
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return { outputPath, metadataPath, inputRecordCount, recordCount: dataset.frames.length, fileSha256: dataset.metadata.fileSha256, fingerprint: dataset.fingerprint }
  } finally {
    await server.close()
  }
}

function parseArguments(argumentsList) {
  const options = {}
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index]
    const argument = argumentsList[index + 1]
    if (!['--input', '--output', '--pair', '--from', '--to'].includes(name) || !argument) throw new Error('用法：node scripts/convertHistData.mjs --input 本机tick.csv --output 完成分钟.csv --pair EUR/USD [--from 2024-03-04T00:00:00Z --to 2024-03-08T23:59:00Z]')
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`重复参数：${name}`)
    options[name.slice(2)] = argument
  }
  if (!options.input || !options.output || !options.pair) throw new Error('必须提供 --input、--output 和 --pair。')
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await convertHistData(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
