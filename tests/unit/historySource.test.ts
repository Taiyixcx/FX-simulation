import { describe, expect, it } from 'vitest'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { advanceHistory, createHistory, validateHistoryDataset, validateHistoryDatasetSummary, validateHistoryState } from '../../src/engine/historySource'

const csv = [
  'timestamp,open,high,low,close,ask',
  '2024-03-04T00:01:00Z,1.1,1.101,1.099,1.1,1.10015',
  '2024-03-04T00:02:00Z,1.1,1.102,1.1,1.101,1.10115',
  '2024-03-04T01:01:00Z,1.101,1.102,1.099,1.1,1.10015',
].join('\n')

describe('finite historical replay source', () => {
  it('starts at the first completed minute and exposes one next frame at a time', async () => {
    const dataset = await parseHistoryCsv(csv, 'EUR/USD')
    const initial = createHistory(dataset)
    expect(initial.state).toEqual({ datasetId: dataset.id, fingerprint: dataset.fingerprint, frameIndex: 0, maxFrames: 3, currentTimestampMs: Date.UTC(2024, 2, 4, 0, 1) })
    expect(Object.keys(initial)).toEqual(['state', 'frame'])
    expect(initial.frame).toEqual(dataset.frames[0])
    const second = advanceHistory(initial.state, dataset)!
    expect(second.state.frameIndex).toBe(1)
    expect(second.frame).toEqual(dataset.frames[1])
    expect(initial.state.frameIndex).toBe(0)
    const last = advanceHistory(second.state, dataset)!
    expect(last.frame.quote.timestampMs - second.frame.quote.timestampMs).toBe(59 * 60_000)
    expect(advanceHistory(last.state, dataset)).toBeNull()
  })

  it('does not let UI copies mutate the source or change an already returned step', async () => {
    const dataset = await parseHistoryCsv(csv, 'EUR/USD')
    const initial = createHistory(dataset)
    initial.frame.quote.bidPrice = '9'
    expect(dataset.frames[0].quote.bidPrice).toBe('1.1')
    expect(createHistory(dataset).frame.quote.bidPrice).toBe('1.1')
  })

  it('rejects changed identity, future/broken progress, count and time on restoration', async () => {
    const dataset = await parseHistoryCsv(csv, 'EUR/USD')
    const { state } = createHistory(dataset)
    for (const changed of [
      { datasetId: 'other' }, { fingerprint: '0'.repeat(64) }, { maxFrames: 4 },
      { frameIndex: -1 }, { frameIndex: 3 }, { frameIndex: 0.5 }, { currentTimestampMs: state.currentTimestampMs + 60_000 },
    ]) expect(() => validateHistoryState({ ...state, ...changed }, dataset)).toThrow('不一致')
  })

  it('requires an independent full check after a dataset has crossed a serialization boundary', async () => {
    const dataset = structuredClone(await parseHistoryCsv(csv, 'EUR/USD'))
    expect(() => createHistory(dataset)).toThrow('全量校验')
    await validateHistoryDataset(dataset)
    expect(createHistory(dataset).state.frameIndex).toBe(0)
  })

  it('preserves a backup verification claim independently from local verification and license text', async () => {
    const dataset = await parseHistoryCsv(csv, 'EUR/USD')
    const input = { ...dataset, metadata: { ...dataset.metadata, verified: false, restoredVerificationClaim: true, licenseNotes: '原许可说明'.repeat(100) } }
    const summary = validateHistoryDatasetSummary(input)
    expect(summary.metadata.verified).toBe(false)
    expect(summary.metadata.restoredVerificationClaim).toBe(true)
    expect(summary.metadata.licenseNotes).toBe(input.metadata.licenseNotes)
    expect(validateHistoryDatasetSummary({ ...input, metadata: { ...input.metadata, restoredVerificationClaim: false } }).metadata.restoredVerificationClaim).toBe(false)
    expect(() => validateHistoryDatasetSummary({ ...input, metadata: { ...input.metadata, restoredVerificationClaim: 'yes' } })).toThrow('布尔')
  })

  it('never certifies a cancelled dataset and freezes checked rows before a processing yield', async () => {
    const dataset = structuredClone(await parseHistoryCsv(csv, 'EUR/USD'))
    const signal = { aborted: false }
    let sawFrozenCheckedRow = false
    await expect(validateHistoryDataset(dataset, {
      signal, batchSize: 1, yieldControl: async () => {},
      onProgress: (processed, _total, phase) => {
        if (phase === 'validating' && processed === 1) {
          sawFrozenCheckedRow = Object.isFrozen(dataset.frames[0]!.quote) && Object.isFrozen(dataset.frames[0])
          expect(() => { dataset.frames[0]!.quote.bidPrice = '9' }).toThrow()
          signal.aborted = true
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sawFrozenCheckedRow).toBe(true)
    expect(() => createHistory(dataset)).toThrow('全量校验')
    await validateHistoryDataset(dataset)
    expect(createHistory(dataset).state.frameIndex).toBe(0)
  })

  it('checks an unchecked row changed during a batch yield rather than trusting the old fingerprint', async () => {
    const dataset = structuredClone(await parseHistoryCsv(csv, 'EUR/USD'))
    await expect(validateHistoryDataset(dataset, {
      batchSize: 1, yieldControl: async () => {},
      onProgress: (processed, _total, phase) => {
        if (phase === 'validating' && processed === 1) dataset.frames[2]!.quote.askPrice = '1.10016'
      },
    })).rejects.toThrow('内容校验失败')
    expect(() => createHistory(dataset)).toThrow('全量校验')
  })
})
