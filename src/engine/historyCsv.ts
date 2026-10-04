import { validateCurrencyPair } from './account'
import { decimalToString, MoneyDecimal } from './decimal'
import {
  calculateHistoryFingerprint, getHistoryDatasetId, getHistoryQuoteType,
  checkpointHistoryProcessing, getHistoryProcessingBatchSize, HISTORY_MAX_FRAMES,
  sha256Text, throwIfHistoryCancelled, validateHistoryDataset,
} from './historySource'
import type { HistoryCsvIssue, HistoryDataset, HistoryMetadata, HistoryProcessingControls } from './historyTypes'
import type { CurrencyPair, MarketFrame } from './types'

export const HISTORY_CSV_MAX_BYTES = 20 * 1024 * 1024
const MAX_ISSUES = 30
const FIELD_NAMES = ['timestamp', 'open', 'high', 'low', 'close', 'ask'] as const
const TRAINING_SPREAD = { 'EUR/USD': '0.0001', 'GBP/USD': '0.00015' } as const

export class HistoryCsvError extends Error {
  constructor(readonly issues: HistoryCsvIssue[], readonly issueCount = issues.length) {
    super(issues.map((issue) => `第 ${issue.line} 行 / ${issue.field}：${issue.message}`).join('\n')
      + (issueCount > issues.length ? `\n共 ${issueCount} 行校验失败，仅显示前 ${issues.length} 条提示。` : ''))
    this.name = 'HistoryCsvError'
  }
}

interface CsvRecord {
  cells: string[]
  line: number
  isBlankLine: boolean
}

function error(line: number, field: string, message: string): never {
  throw new HistoryCsvError([{ line, field, message }])
}

/** Strict CSV quoting, including BOM, CRLF and physical-line diagnostics. */
function* readCsvRecords(text: string, characterBatchSize: number): Generator<number, CsvRecord[]> {
  const records: CsvRecord[] = []
  let cells: string[] = []
  let cell = ''
  let line = 1
  let recordLine = 1
  let isQuoted = false
  let hasClosedQuote = false
  let hasCsvStructure = false
  const input = text.replace(/^\uFEFF/, '')
  let nextCheckpoint = characterBatchSize
  for (let index = 0; index < input.length; index += 1) {
    if (index >= nextCheckpoint) {
      yield index
      nextCheckpoint = index + characterBatchSize
    }
    const character = input[index]
    if (isQuoted) {
      if (character === '"') {
        if (input[index + 1] === '"') { cell += '"'; index += 1 }
        else { isQuoted = false; hasClosedQuote = true }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && input[index + 1] === '\n') index += 1
        cell += '\n'
        line += 1
      } else cell += character
      if (cell.length > 2_000) error(line, FIELD_NAMES[cells.length] ?? 'columns', '单元格过长。')
      continue
    }
    if (character === '"') {
      if (cell.length || hasClosedQuote) error(line, FIELD_NAMES[cells.length] ?? 'columns', '引号必须包围整个单元格。')
      isQuoted = true
      hasCsvStructure = true
    } else if (character === ',' || character === '\r' || character === '\n') {
      cells.push(cell)
      cell = ''
      hasClosedQuote = false
      if (character !== ',') {
        if (character === '\r' && input[index + 1] === '\n') index += 1
        records.push({ cells, line: recordLine, isBlankLine: cells.length === 1 && !cells[0].trim() && !hasCsvStructure })
        if (records.length > HISTORY_MAX_FRAMES + 2) error(recordLine, 'file', `最多导入 ${HISTORY_MAX_FRAMES.toLocaleString('en-US')} 根行情。`)
        cells = []
        hasCsvStructure = false
        line += 1
        recordLine = line
      } else hasCsvStructure = true
    } else {
      if (hasClosedQuote) error(line, FIELD_NAMES[cells.length] ?? 'columns', '结束引号之后只能是逗号或换行。')
      cell += character
    }
    if (cell.length > 2_000) error(line, FIELD_NAMES[cells.length] ?? 'columns', '单元格过长。')
  }
  if (isQuoted) error(recordLine, FIELD_NAMES[cells.length] ?? 'columns', '单元格引号未闭合。')
  if (cell.length || cells.length || hasClosedQuote) records.push({ cells: [...cells, cell], line: recordLine, isBlankLine: cells.length === 0 && !cell.trim() && !hasCsvStructure })
  // Trailing empty physical lines are harmless; interior empty lines are invalid.
  while (records.length && records.at(-1)!.isBlankLine) records.pop()
  return records
}

async function collectCsvRecords(text: string, batchSize: number, controls?: HistoryProcessingControls): Promise<CsvRecord[]> {
  const reader = readCsvRecords(text, Math.min(65_536, Math.max(4096, batchSize * 256)))
  if (controls) await checkpointHistoryProcessing(controls, 0, text.length, 'reading')
  let step = reader.next()
  while (!step.done) {
    if (controls) await checkpointHistoryProcessing(controls, step.value, text.length, 'reading')
    step = reader.next()
  }
  if (controls) await checkpointHistoryProcessing(controls, text.length, text.length, 'reading')
  return step.value
}

/** ISO completed-minute time. No Date.parse normalization of impossible dates. */
export function parseHistoryTimestamp(input: string, line = 1): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input)
  if (!match) error(line, 'timestamp', '须使用带 Z 或明确 UTC 偏移的 ISO 日期时间。')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', timezone] = match
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) error(line, 'timestamp', '日期或时间超出有效范围（年份须为 1970–9999）。')
  const localTimestampMs = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0')))
  const localDate = new Date(localTimestampMs)
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day) error(line, 'timestamp', '日期不存在，请检查月份、天数及闰年。')
  let offsetMinutes = 0
  if (timezone !== 'Z') {
    const offsetHour = Number(timezone.slice(1, 3))
    const offsetMinute = Number(timezone.slice(4, 6))
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) error(line, 'timestamp', 'UTC 偏移须在 −14:00 至 +14:00 之间。')
    offsetMinutes = (timezone[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  }
  const timestampMs = localTimestampMs - offsetMinutes * 60_000
  if (timestampMs < 0 || timestampMs > 253_402_300_740_000 || timestampMs % 60_000 !== 0) error(line, 'timestamp', '须为有效 UTC 完整分钟完成时刻，秒和毫秒必须为零。')
  return timestampMs
}

function readPrice(input: string, line: number, field: string): InstanceType<typeof MoneyDecimal> {
  if (input.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) error(line, field, '须为正的有限十进制数，不接受指数或非数值文字。')
  const price = new MoneyDecimal(input)
  if (!price.isFinite() || price.lte(0)) error(line, field, '价格必须为正的有限十进制数。')
  return price
}

/** No dataset is returned until every row has passed and its checksum is ready. */
export async function parseHistoryCsv(text: string, pair: CurrencyPair, metadata: Partial<HistoryMetadata> = {}, controls?: HistoryProcessingControls): Promise<HistoryDataset> {
  const batchSize = getHistoryProcessingBatchSize(controls)
  throwIfHistoryCancelled(controls)
  validateCurrencyPair(pair)
  if (typeof text !== 'string' || text.length > HISTORY_CSV_MAX_BYTES
    || new TextEncoder().encode(text).length > HISTORY_CSV_MAX_BYTES) error(1, 'file', 'CSV 文件最大为 20 MiB。')
  const records = await collectCsvRecords(text, batchSize, controls)
  if (records.length < 2) error(1, 'file', '需要表头及至少一条有效行情。')
  const header = records[0].cells.map((cell) => cell.trim())
  if ((header.length !== 5 && header.length !== 6) || header.some((field, index) => field !== FIELD_NAMES[index])) error(records[0].line, 'header', '表头须为 timestamp,open,high,low,close，可选最后一列 ask。')
  if (records.length - 1 > HISTORY_MAX_FRAMES) error(records[HISTORY_MAX_FRAMES + 1].line, 'file', `最多导入 ${HISTORY_MAX_FRAMES.toLocaleString('en-US')} 根行情。`)
  const frames: MarketFrame[] = []
  const issues: HistoryCsvIssue[] = []
  let issueCount = 0
  let previousTimestampMs = -1
  if (controls) await checkpointHistoryProcessing(controls, 0, records.length - 1, 'validating')
  for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex]!
    try {
      if (record.cells.length !== header.length) error(record.line, 'columns', `本行须含 ${header.length} 列，实际为 ${record.cells.length} 列。`)
      const cells = record.cells.map((cell) => cell.trim())
      const timestampMs = parseHistoryTimestamp(cells[0], record.line)
      if (timestampMs <= previousTimestampMs) error(record.line, 'timestamp', 'UTC 时间必须严格递增，不能重复或乱序。')
      previousTimestampMs = timestampMs
      const [open, high, low, close] = cells.slice(1, 5).map((cell, index) => readPrice(cell, record.line, FIELD_NAMES[index + 1]))
      if (low.gt(high)) error(record.line, 'low', 'low 不能高于 high。')
      if (open.lt(low) || open.gt(high)) error(record.line, 'open', 'open 必须位于 low 与 high 之间。')
      if (close.lt(low) || close.gt(high)) error(record.line, 'close', 'close 必须位于 low 与 high 之间。')
      const hasSourceAsk = Boolean(cells[5])
      const ask = hasSourceAsk ? readPrice(cells[5], record.line, 'ask') : close.plus(TRAINING_SPREAD[pair])
      if (ask.lt(close)) error(record.line, 'ask', 'ask 不能低于 Bid close。')
      frames.push({
        openPrice: decimalToString(open), highPrice: decimalToString(high), lowPrice: decimalToString(low), closePrice: decimalToString(close),
        quote: { timestampMs, bidPrice: decimalToString(close), askPrice: decimalToString(ask), askSource: hasSourceAsk ? 'source' : 'training' },
      })
    } catch (cause) {
      if (!(cause instanceof HistoryCsvError)) throw cause
      issueCount += cause.issues.length
      if (issues.length < MAX_ISSUES) issues.push(...cause.issues.slice(0, MAX_ISSUES - issues.length))
    }
    if (controls && (recordIndex % batchSize === 0 || recordIndex === records.length - 1)) await checkpointHistoryProcessing(controls, recordIndex, records.length - 1, 'validating')
  }
  throwIfHistoryCancelled(controls)
  if (issues.length) throw new HistoryCsvError(issues, issueCount)
  const fingerprint = await calculateHistoryFingerprint(pair, frames, controls)
  const dataset: HistoryDataset = {
    id: getHistoryDatasetId(pair, fingerprint), pair, frames, fingerprint,
    metadata: {
      label: '导入的分钟行情', sourceName: '用户 CSV（来源未核实）', sourceUrl: '', originalTimezone: '文件中明确给出的 UTC 偏移',
      conversionNotes: '已完成 M1 Bid OHLC；缺少 Ask 的行使用训练点差。', conversionVersion: 'normalized-csv-v1',
      licenseNotes: '用户负责核实来源及使用许可；未核实公开再分发许可。',
      ...metadata,
      // Caller-supplied summaries never override values established by this file.
      verified: metadata.verified === true,
      period: 'M1', quoteType: getHistoryQuoteType(frames), recordCount: frames.length,
      startTimestampMs: frames[0].quote.timestampMs, endTimestampMs: frames.at(-1)!.quote.timestampMs,
      fileSha256: await sha256Text(text, controls),
    },
  }
  await validateHistoryDataset(dataset, controls)
  throwIfHistoryCancelled(controls)
  return dataset
}
