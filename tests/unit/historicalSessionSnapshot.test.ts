import { describe, expect, it } from 'vitest'
import { closePosition, openPosition } from '../../src/engine/execution'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { advanceHistory, createHistory, findHistoryStartIndex } from '../../src/engine/historySource'
import { createHistoricalSnapshot, getHistoryPracticeStart, validateHistoricalSnapshot, validateHistoricalTransition } from '../../src/storage/historicalSessionSnapshot'
import { SESSION_FRAME_WINDOW_SIZE } from '../../src/storage/sessionSnapshot'

async function dataset() {
  return parseHistoryCsv([
    'timestamp,open,high,low,close,ask',
    '2024-03-04T08:01:00Z,1,1,1,1,1.0001',
    '2024-03-04T08:02:00Z,1.1,1.1,1.1,1.1,1.1001',
    '2024-03-04T08:05:00Z,1.2,1.2,1.2,1.2,1.2001',
    '2024-03-04T08:06:00Z,1.3,1.3,1.3,1.3,1.3001',
    '2024-03-04T08:07:00Z,1.4,1.4,1.4,1.4,1.4001',
  ].join('\n'), 'EUR/USD')
}

describe('history practice start and observation-only warmup', () => {
  it('starts an independent account in the middle with only earlier warmup and no future frames', async () => {
    const source = await dataset()
    const snapshot = createHistoricalSnapshot(source, 'start-middle', { startFrameIndex: 3, warmupFrameCount: 2 })
    expect(snapshot.historyStart).toEqual({ version: 1, startFrameIndex: 3, warmupFrameCount: 2 })
    expect(snapshot.frameStartIndex).toBe(1)
    expect(snapshot.frames).toEqual(source.frames.slice(1, 4))
    expect(snapshot.account).toEqual({ balanceUsd: '10000.00', position: null })
    expect(validateHistoricalSnapshot(snapshot, source)).toEqual(snapshot)
    const prewarmTrade = openPosition(snapshot.account, source.frames[2]!.quote, source.pair, 'long', '100', 'too-early')
    expect(() => validateHistoricalSnapshot({ ...snapshot, account: prewarmTrade }, source)).toThrow('开仓时序')
  })

  it('keeps no-warmup, truncated leading warmup and the final quote valid', async () => {
    const source = await dataset()
    const beginning = createHistoricalSnapshot(source, 'start-beginning', { warmupFrameCount: 500 })
    expect(beginning.historyStart!.warmupFrameCount).toBe(0)
    const middle = createHistoricalSnapshot(source, 'no-warmup', { startFrameIndex: 2 })
    expect(middle.frames).toEqual([source.frames[2]])
    expect(middle.frameStartIndex).toBe(2)
    expect(validateHistoricalSnapshot(middle, source)).toEqual(middle)
    const last = createHistoricalSnapshot(source, 'start-last', { startFrameIndex: 4, warmupFrameCount: 10 })
    expect(last.historyStart!.warmupFrameCount).toBe(4)
    expect(advanceHistory(last.sourceState, source)).toBeNull()
    expect(() => createHistoricalSnapshot(source, 'invalid', { startFrameIndex: 5 })).toThrow('起点')
    expect(() => createHistoricalSnapshot(source, 'invalid-warmup', { warmupFrameCount: 1440 })).toThrow('预热')
  })

  it('selects the next real minute across a source gap without synthesizing bars', async () => {
    const source = await dataset()
    expect(findHistoryStartIndex(source, Date.parse('2024-03-04T08:03:00Z'))).toBe(2)
    expect(findHistoryStartIndex(source, Date.parse('2024-03-04T08:01:00Z'))).toBe(0)
    expect(createHistory(source, 2).frame).toEqual(source.frames[2])
    expect(() => findHistoryStartIndex(source, Date.parse('2024-03-04T08:08:00Z'))).toThrow('末尾')
  })

  it('preserves the chosen origin while validating new quotes and rejects moving it in place', async () => {
    const source = await dataset()
    const initial = createHistoricalSnapshot(source, 'stable-start', { startFrameIndex: 2, warmupFrameCount: 1 })
    const opened = { ...initial, revision: 1, account: openPosition(initial.account, source.frames[2]!.quote, source.pair, 'long', '1200.10', 'start-trade') }
    expect(validateHistoricalTransition(initial, opened, source)).toEqual(opened)
    const step = advanceHistory(opened.sourceState, source)!
    const closed = closePosition(opened.account, step.frame.quote)
    const next = { ...opened, revision: 2, sourceState: step.state, frames: [...opened.frames, step.frame], account: closed.account, trades: [closed.trade] }
    expect(validateHistoricalTransition(opened, next, source)).toEqual(next)
    expect(validateHistoricalSnapshot(next, source)).toEqual(next)
    expect(() => validateHistoricalTransition(next, { ...next, historyStart: { version: 1, startFrameIndex: 1, warmupFrameCount: 0 } }, source)).toThrow('起点与预热')
  })

  it('restores old schema 4 without inventing a changed origin or rewriting its balance', async () => {
    const source = await dataset()
    const legacy = createHistoricalSnapshot(source, 'legacy-start')
    delete legacy.historyStart
    legacy.account.balanceUsd = '10000'
    const restored = validateHistoricalSnapshot(legacy, source)
    expect(restored).toEqual(legacy)
    expect(restored.historyStart).toBeUndefined()
    expect(getHistoryPracticeStart(restored)).toEqual({ version: 1, startFrameIndex: 0, warmupFrameCount: 0 })
    expect(() => validateHistoricalSnapshot({ ...legacy, historyStart: { version: 2, startFrameIndex: 0, warmupFrameCount: 0 } }, source)).toThrow('版本')
  })

  it('restores an origin-specific ledger after the warmup and early trade leave the rolling window', async () => {
    const firstTimestampMs = Date.parse('2024-03-04T08:01:00Z')
    const rows = Array.from({ length: 1600 }, (_, index) => `${new Date(firstTimestampMs + index * 60_000).toISOString()},1,1,1,1,1.0001`)
    const source = await parseHistoryCsv(['timestamp,open,high,low,close,ask', ...rows].join('\n'), 'EUR/USD')
    let snapshot = createHistoricalSnapshot(source, 'rolling-start', { startFrameIndex: 20, warmupFrameCount: 5 })
    const opened = openPosition(snapshot.account, source.frames[20]!.quote, source.pair, 'long', '1000.10', 'early-origin')
    const closed = closePosition(opened, source.frames[21]!.quote)
    snapshot = { ...snapshot, account: closed.account, trades: [closed.trade] }
    while (snapshot.sourceState.frameIndex < source.frames.length - 1) {
      const step = advanceHistory(snapshot.sourceState, source)!
      const frames = [...snapshot.frames, step.frame].slice(-SESSION_FRAME_WINDOW_SIZE)
      snapshot = { ...snapshot, sourceState: step.state, frames, frameStartIndex: step.state.frameIndex + 1 - frames.length }
    }
    expect(snapshot.frameStartIndex).toBe(160)
    expect(snapshot.trades[0]!.openedAtMs).toBeLessThan(snapshot.frames[0]!.quote.timestampMs)
    expect(validateHistoricalSnapshot(snapshot, source)).toEqual(snapshot)
    expect(snapshot.account.balanceUsd).toBe('9999.90')
    expect(snapshot.historyStart!.startFrameIndex).toBe(20)
  })
})
