import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePosition } from '../../src/engine/execution'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { createSessionRepository } from '../../src/storage/sessionRepository'
import { useSessionStore } from '../../src/stores/useSessionStore'

let store: ReturnType<typeof useSessionStore>
beforeEach(() => {
  setActivePinia(createPinia())
  store = useSessionStore()
  store.setRepositoryForTesting(createSessionRepository(`history-store-${crypto.randomUUID()}`))
})
afterEach(() => {
  store.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('historical session coordination', () => {
  it('checks every intermediate quotation at high speed and settles exhaustion before a future recovery', async () => {
    const dataset = await parseHistoryCsv([
      'timestamp,open,high,low,close,ask',
      '2024-03-04T08:01:00Z,1.1,1.1,1.1,1.1,1.1001',
      '2024-03-04T08:02:00Z,1.2,1.2,1.2,1.2,1.2001',
      '2024-03-04T08:03:00Z,3,3,3,3,3.0001',
      '2024-03-04T08:04:00Z,1.1,1.1,1.1,1.1,1.1001',
    ].join('\n'), 'EUR/USD')
    await store.initialize()
    expect(await store.importHistoryDataset(dataset)).toBe(true)
    await store.startHistorySession(dataset.id)
    await store.openTrade('short', '10000')
    const expected = closePosition(store.snapshot!.account, dataset.frames[2]!.quote, 'equity-depleted')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    store.setSpeed(10)
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(store.saveStatus).toBe('saved'))
    expect(store.progressedFrameCount).toBe(3)
    expect(store.snapshot!.frames).toEqual(dataset.frames.slice(0, 3))
    expect(store.snapshot!.account).toEqual(expected.account)
    expect(store.snapshot!.trades).toEqual([expected.trade])
    expect(store.isPlaying).toBe(false)
    expect(store.isEnded).toBe(false)
    expect(store.canAdvance).toBe(false)
    expect(store.errorMessage).toContain('训练权益已耗尽')
    const stopped = structuredClone(store.snapshot)
    await vi.advanceTimersByTimeAsync(5000)
    await store.next()
    expect(store.snapshot).toEqual(stopped)
  })

  it('keeps failed imports separate from a saved trading session and permits trading again', async () => {
    const dataset = await parseHistoryCsv([
      'timestamp,open,high,low,close',
      '2024-03-04T08:01:00Z,1.1,1.2,1.0,1.1',
    ].join('\n'), 'GBP/USD')
    await store.initialize()
    await store.openTrade('long', '500')
    const current = structuredClone(store.snapshot)
    const initialSaveStatus = store.saveStatus
    expect(await store.importHistoryDataset(dataset)).toBe(true)
    expect(store.snapshot).toEqual(current)
    expect(await store.importHistoryDataset(dataset)).toBe(false)
    expect(store.historyDatasets).toHaveLength(1)
    expect(store.historyErrorMessage).toContain('已经导入')
    expect(store.snapshot).toEqual(current)
    expect(store.saveStatus).toBe(initialSaveStatus)
    expect(store.canOperate).toBe(true)
    await store.closeTrade()
    expect(store.snapshot!.account.position).toBeNull()
    expect(store.snapshot!.trades).toHaveLength(1)
  })
})
