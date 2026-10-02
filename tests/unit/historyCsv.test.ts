import { describe, expect, it } from 'vitest'
import { HistoryCsvError, HISTORY_CSV_MAX_BYTES, parseHistoryCsv, parseHistoryTimestamp } from '../../src/engine/historyCsv'
import { validateHistoryDataset } from '../../src/engine/historySource'

const header = 'timestamp,open,high,low,close,ask'
const firstRow = '2024-03-04T00:01:00Z,1.10000,1.10040,1.09980,1.10020,1.10035'
const secondRow = '2024-03-04T00:02:00Z,1.10020,1.10050,1.10000,1.10040,'

describe('normalized completed-minute CSV import', () => {
  it('accepts BOM, CRLF, quoted headers and fields without rounding provider quotes', async () => {
    const csv = `\uFEFF${header.split(',').map((field) => `"${field}"`).join(',')}\r\n${firstRow.split(',').map((field) => `"${field}"`).join(',')}\r\n`
    const dataset = await parseHistoryCsv(csv, 'EUR/USD')
    expect(dataset.frames[0]).toEqual({
      openPrice: '1.1', highPrice: '1.1004', lowPrice: '1.0998', closePrice: '1.1002',
      quote: { timestampMs: Date.UTC(2024, 2, 4, 0, 1), bidPrice: '1.1002', askPrice: '1.10035', askSource: 'source' },
    })
    expect(dataset.metadata.verified).toBe(false)
    expect(dataset.metadata.quoteType).toBe('source')
    expect(dataset.metadata.fileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(dataset.metadata.fileSha256).toBe(createHash('sha256').update(csv, 'utf8').digest('hex'))
  })

  it('uses Decimal training spreads per pair and preserves mixed provenance row by row', async () => {
    const csv = `${header}\n${firstRow}\n${secondRow}\n`
    const eur = await parseHistoryCsv(csv, 'EUR/USD')
    const gbp = await parseHistoryCsv(csv, 'GBP/USD')
    expect(eur.frames[1].quote).toMatchObject({ askPrice: '1.1005', askSource: 'training' })
    expect(gbp.frames[1].quote).toMatchObject({ askPrice: '1.10055', askSource: 'training' })
    expect(eur.frames[0].quote.askSource).toBe('source')
    expect(eur.metadata.quoteType).toBe('mixed')
    expect(eur.fingerprint).not.toBe(gbp.fingerprint)
  })

  it('accepts the five-column interface and fills Ask only when it is missing', async () => {
    const csv = `${header.split(',').slice(0, 5).join(',')}\n${firstRow.split(',').slice(0, 5).join(',')}\n`
    const dataset = await parseHistoryCsv(csv, 'GBP/USD')
    expect(dataset.frames[0].quote.askPrice).toBe('1.10035')
    expect(dataset.metadata.quoteType).toBe('training')
  })

  it('identifies the same prices/times despite raw formatting but keeps each file checksum', async () => {
    const plain = await parseHistoryCsv(`${header}\n${firstRow}\n`, 'EUR/USD')
    const offset = await parseHistoryCsv(`${header}\r\n${firstRow.replace('2024-03-04T00:01:00Z', '2024-03-04T08:01:00+08:00')}\r\n`, 'EUR/USD')
    expect(offset.id).toBe(plain.id)
    expect(offset.fingerprint).toBe(plain.fingerprint)
    expect(offset.metadata.fileSha256).not.toBe(plain.metadata.fileSha256)
  })

  it('keeps actual gaps, actual summaries and independent source verification', async () => {
    const csv = `${header}\n${firstRow}\n${secondRow.replace('00:02', '01:02')}\n`
    const dataset = await parseHistoryCsv(csv, 'EUR/USD', { recordCount: 99, quoteType: 'source', startTimestampMs: 0, label: '个人文件' })
    expect(dataset.frames).toHaveLength(2)
    expect(dataset.frames[1].quote.timestampMs - dataset.frames[0].quote.timestampMs).toBe(61 * 60_000)
    expect(dataset.metadata).toMatchObject({ recordCount: 2, quoteType: 'mixed', startTimestampMs: Date.UTC(2024, 2, 4, 0, 1), label: '个人文件', verified: false })
  })

  it.each([
    ['2024-02-30T00:01:00Z', 'timestamp'],
    ['2023-02-29T00:01:00Z', 'timestamp'],
    ['2024-13-04T00:01:00Z', 'timestamp'],
    ['2024-03-04T24:01:00Z', 'timestamp'],
    ['2024-03-04T00:01:60Z', 'timestamp'],
    ['2024-03-04T00:01:00', 'timestamp'],
    ['2024-03-04T00:01:01Z', 'timestamp'],
    ['2024-03-04T00:01:00.001Z', 'timestamp'],
    ['2024-03-04T00:01:00+14:01', 'timestamp'],
    ['2024-03-04T00:01:00+08:60', 'timestamp'],
  ])('rejects invalid/ambiguous/non-minute time %s at its physical line', async (timestamp, field) => {
    try {
      await parseHistoryCsv(`${header}\n${firstRow.replace('2024-03-04T00:01:00Z', timestamp)}`, 'EUR/USD')
      throw new Error('expected rejection')
    } catch (cause) {
      expect(cause).toBeInstanceOf(HistoryCsvError)
      expect((cause as HistoryCsvError).issues[0]).toMatchObject({ line: 2, field })
    }
  })

  it('rejects duplicate UTC instants and unsorted files rather than sorting them', async () => {
    const duplicate = firstRow.replace('2024-03-04T00:01:00Z', '2024-03-04T08:01:00+08:00')
    await expect(parseHistoryCsv(`${header}\n${firstRow}\n${duplicate}`, 'EUR/USD')).rejects.toMatchObject({ issues: [{ line: 3, field: 'timestamp', message: expect.stringContaining('重复') }] })
    await expect(parseHistoryCsv(`${header}\n${secondRow}\n${firstRow}`, 'EUR/USD')).rejects.toThrow('乱序')
  })

  it.each([
    ['timestamp,open,high,low,close,ask,volume\n' + firstRow, 1, 'header'],
    [header + '\n' + firstRow + ',0', 2, 'columns'],
    [header + '\n' + firstRow.replace(',1.10000,', ',0,'), 2, 'open'],
    [header + '\n' + firstRow.replace(',1.10000,', ',1e0,'), 2, 'open'],
    [header + '\n' + firstRow.replace(',1.10000,', ',NaN,'), 2, 'open'],
    [header + '\n' + firstRow.replace(',1.10040,', ',1.00000,'), 2, 'low'],
    [header + '\n' + firstRow.replace(',1.10000,', ',1.20000,'), 2, 'open'],
    [header + '\n' + firstRow.replace(',1.10020,', ',1.20000,'), 2, 'close'],
    [header + '\n' + firstRow.replace(/1.10035$/, '1.10010'), 2, 'ask'],
    [header + '\n"2024-03-04T00:01:00Z', 2, 'timestamp'],
    [header + '\n"2024-03-04T00:01:00Z"x,1,1,1,1,1', 2, 'timestamp'],
    [header + '\n2024-03-04T00:01:00Z,1,1,"1""0",1,1', 2, 'low'],
  ])('reports invalid columns/prices/quoting by row and field', async (csv, line, field) => {
    await expect(parseHistoryCsv(csv, 'EUR/USD')).rejects.toMatchObject({ issues: [expect.objectContaining({ line, field })] })
  })

  it('collects independent row errors and counts physical lines inside quoted fields', async () => {
    const csv = `${header}\n"bad\ntime",1,1,1,1,1\n2024-03-04T00:02:00Z,0,1,1,1,1`
    await expect(parseHistoryCsv(csv, 'EUR/USD')).rejects.toMatchObject({ issues: [expect.objectContaining({ line: 2, field: 'timestamp' }), expect.objectContaining({ line: 4, field: 'open' })] })
  })

  it('still checks every row after the displayed issue limit', async () => {
    const csv = [header, ...Array.from({ length: 35 }, () => 'bad,1,1,1,1,1')].join('\n')
    await expect(parseHistoryCsv(csv, 'EUR/USD')).rejects.toMatchObject({ issueCount: 35, issues: expect.arrayContaining([expect.objectContaining({ line: 31 })]), message: expect.stringContaining('仅显示前 30 条') })
  })

  it('rejects empty datasets and oversized files before returning an import candidate', async () => {
    await expect(parseHistoryCsv(`${header}\n`, 'EUR/USD')).rejects.toThrow('至少一条')
    await expect(parseHistoryCsv('x'.repeat(HISTORY_CSV_MAX_BYTES + 1), 'EUR/USD')).rejects.toThrow('20 MiB')
  })

  it('rejects empty delimited or quoted trailing records while allowing empty physical lines', async () => {
    await expect(parseHistoryCsv(`${header}\n${firstRow}\n,,,,,\n`, 'EUR/USD')).rejects.toMatchObject({ issues: [expect.objectContaining({ line: 3, field: 'timestamp' })] })
    await expect(parseHistoryCsv(`${header}\n${firstRow}\n""\n`, 'EUR/USD')).rejects.toMatchObject({ issues: [expect.objectContaining({ line: 3, field: 'columns' })] })
    expect((await parseHistoryCsv(`${header}\n${firstRow}\n\n  \n`, 'EUR/USD')).frames).toHaveLength(1)
  })

  it('strictly accepts real leap dates and explicit offsets', () => {
    expect(parseHistoryTimestamp('2024-02-29T08:01:00.000+08:00')).toBe(Date.UTC(2024, 1, 29, 0, 1))
    expect(parseHistoryTimestamp('2024-03-04T00:01:00-05:00')).toBe(Date.UTC(2024, 2, 4, 5, 1))
  })

  it('checks persisted content against the fingerprint and freezes verified datasets', async () => {
    const dataset = await parseHistoryCsv(`${header}\n${firstRow}`, 'EUR/USD')
    expect(Object.isFrozen(dataset.frames[0].quote)).toBe(true)
    const corrupted = structuredClone(dataset)
    corrupted.frames[0].quote.askPrice = '1.10036'
    await expect(validateHistoryDataset(corrupted)).rejects.toThrow('内容校验失败')
    const badMetadata = structuredClone(dataset)
    badMetadata.metadata.recordCount = 2
    await expect(validateHistoryDataset(badMetadata)).rejects.toThrow('记录数')
  })
})
import { createHash } from 'node:crypto'
