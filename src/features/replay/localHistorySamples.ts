import { parseHistoryCsv, HISTORY_CSV_MAX_BYTES } from '../../engine/historyCsv'
import type { HistoryDataset } from '../../engine/historyTypes'
import type { CurrencyPair } from '../../engine/types'

export interface LocalHistorySample {
  label: string
  pair: CurrencyPair
  path: string
  sha256: string
  sourceName: string
  sourceUrl: string
  originalTimezone: string
  conversionNotes: string
  conversionVersion: string
  licenseNotes: string
}

export async function readLocalHistorySamples(): Promise<LocalHistorySample[]> {
  const response = await fetch('/data/manifest.json')
  if (!response.ok) throw new Error('未找到本机样本目录，可先导入 CSV。')
  const manifest: unknown = await response.json()
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || manifest.version !== 1
    || !('samples' in manifest) || !Array.isArray(manifest.samples)) throw new Error('本机样本目录格式无效。')
  return manifest.samples.map((input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('本机样本说明无效。')
    const record = input as Record<string, unknown>
    const fields = ['label', 'path', 'sha256', 'sourceName', 'sourceUrl', 'originalTimezone', 'conversionNotes', 'conversionVersion', 'licenseNotes'] as const
    for (const field of fields) {
      if (typeof record[field] !== 'string' || record[field].length > 4000) throw new Error(`本机样本 ${field} 无效。`)
    }
    if ((record.pair !== 'EUR/USD' && record.pair !== 'GBP/USD')
      || !/^[a-z0-9][a-z0-9-]*\.csv$/.test(record.path as string)
      || !/^[a-f0-9]{64}$/.test(record.sha256 as string)
      || !/^https?:\/\//.test(record.sourceUrl as string)) throw new Error('本机样本品种、路径或校验信息无效。')
    return {
      pair: record.pair,
      ...Object.fromEntries(fields.map(field => [field, record[field]])),
    } as LocalHistorySample
  })
}

export async function loadLocalHistorySample(sample: LocalHistorySample): Promise<HistoryDataset> {
  const response = await fetch(`/data/${sample.path}`)
  if (!response.ok) throw new Error('该样本文件尚未准备，请按项目说明在本机转换，或导入已有 CSV。')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > HISTORY_CSV_MAX_BYTES) throw new Error('样本超过 CSV 文件大小限制。')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (sha256 !== sample.sha256) throw new Error('本机样本文件校验不一致，未导入任何数据。')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return parseHistoryCsv(text, sample.pair, {
    label: sample.label, sourceName: sample.sourceName, sourceUrl: sample.sourceUrl,
    originalTimezone: sample.originalTimezone, conversionNotes: sample.conversionNotes,
    conversionVersion: sample.conversionVersion, licenseNotes: sample.licenseNotes,
    verified: true,
  })
}
