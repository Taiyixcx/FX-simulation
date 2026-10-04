import 'fake-indexeddb/auto'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../src/stores/useSessionStore'
import { createSessionRepository } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { closePosition, openPosition } from '../../src/engine/execution'
import { createHistoricalSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { extendSession, makeSession } from './sessionFixture'

type PracticeStore = ReturnType<typeof useSessionStore>
const stores: PracticeStore[] = []
const repositories: SessionRepository[] = []
function repository(name: string): SessionRepository {
  const created = createSessionRepository(name)
  repositories.push(created)
  return created
}
async function createStore(name = `fx-store-library-${crypto.randomUUID()}`) {
  const created = useSessionStore(createPinia())
  const storage = repository(name)
  created.setRepositoryForTesting(storage)
  stores.push(created)
  await created.initialize()
  return { store: created, repository: storage, name }
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose())
  repositories.splice(0).forEach(storage => storage.close())
  vi.restoreAllMocks()
})
async function history(count = 8, extremeSpread = false) {
  const startTimestampMs = Date.UTC(2024, 2, 4, 8, 1)
  const records = Array.from({ length: count }, (_, index) => {
    const price = extremeSpread ? 1 : 1.1 + index * 0.001
    const ask = extremeSpread ? 3 : price + 0.0002
    return `${new Date(startTimestampMs + index * 60_000).toISOString()},${price.toFixed(5)},${(price + 0.002).toFixed(5)},${(price - 0.002).toFixed(5)},${price.toFixed(5)},${ask.toFixed(5)}`
  })
  return parseHistoryCsv(['timestamp,open,high,low,close,ask', ...records].join('\n'), 'EUR/USD', {
    label: 'Store 隔离合成行情', sourceName: '生成测试样本', originalTimezone: 'UTC', verified: false,
  })
}
async function record(name: string, storeName: string, key: IDBValidKey, replacement?: unknown): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, replacement === undefined ? 'readonly' : 'readwrite')
      const request = replacement === undefined ? transaction.objectStore(storeName).get(key) : transaction.objectStore(storeName).put(replacement)
      let result: unknown
      request.onsuccess = () => { result = request.result as unknown }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

describe('real IndexedDB practice library integration', () => {
  it('rejects an equity-depleting new entry without changing the snapshot or persisted ledger', async () => {
    const { store, name } = await createStore()
    const source = await history(2, true)
    expect(await store.importHistoryDataset(source)).toBe(true)
    await store.startHistorySession(source.id)
    const before = structuredClone(store.snapshot)
    await store.openTrade('short', '10000', { entryReason: '异常点差测试', exitPlan: '' })
    expect(store.snapshot).toEqual(before)
    expect(store.errorMessage).toContain('点差')
    expect(store.saveStatus).toBe('saved')
    expect(store.snapshot?.account.position).toBeNull()
    expect(await repository(name).loadCurrent()).toEqual(before)
    expect(await repository(name).listTradeAnnotations(before!.id)).toEqual([])
  })

  it('retains a failed entry and its original first plan and retries exactly once', async () => {
    const { store, name } = await createStore()
    const original = structuredClone(store.snapshot)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'annotations') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await store.openTrade('long', '1000', { entryReason: '首次事前理由', exitPlan: '观察两根后退出' })
    expect(store.saveStatus).toBe('error')
    const candidate = structuredClone(store.snapshot)
    const tradeId = candidate!.account.position!.id
    expect(await repository(name).loadCurrent()).toEqual(original)
    expect(await repository(name).getTradeAnnotation(candidate!.id, tradeId)).toBeNull()
    vi.restoreAllMocks()
    await store.retrySave()
    expect(store.saveStatus).toBe('saved')
    expect(store.snapshot).toEqual(candidate)
    expect(store.tradeAnnotations[tradeId]?.firstPlan?.entryReason).toBe('首次事前理由')
    expect(store.tradeAnnotations[tradeId]?.planRevisions).toHaveLength(1)
    await store.retrySave()
    expect((await repository(name).getTradeAnnotation(candidate!.id, tradeId))?.planRevisions).toHaveLength(1)
  })

  it('returns to the same open position and progress while pausing replay', async () => {
    const { store, name } = await createStore()
    await store.openTrade('short', '1000', { entryReason: '旧练习计划', exitPlan: '' })
    await store.next()
    const previous = structuredClone(store.snapshot)!
    const tradeId = previous.account.position!.id
    store.play()
    await store.startNewSession('GBP/USD')
    const newerId = store.snapshot!.id
    expect(newerId).not.toBe(previous.id)
    expect(store.isPlaying).toBe(false)
    expect(await store.activateSavedSession(previous.id)).toBe(true)
    expect(store.snapshot).toEqual(previous)
    expect(store.isPlaying).toBe(false)
    expect(store.tradeAnnotations[tradeId]?.firstPlan?.entryReason).toBe('旧练习计划')
    expect((await repository(name).loadSession(newerId))?.snapshot.account.position).toBeNull()
    expect((await repository(name).listSessions()).filter(summary => summary.isCurrent).map(summary => summary.id)).toEqual([previous.id])
  })

  it('rejects a stale window after another window switches A-B-A and preserves both states', async () => {
    const first = await createStore()
    const second = await createStore(first.name)
    const original = structuredClone(first.store.snapshot)!
    await first.store.startNewSession('GBP/USD')
    expect(await first.store.activateSavedSession(original.id)).toBe(true)
    await second.store.next()
    expect(second.store.saveStatus).toBe('error')
    expect(second.store.isPlaying).toBe(false)
    expect(second.store.snapshot?.sourceState.frameIndex).toBe(original.sourceState.frameIndex + 1)
    expect(await repository(first.name).loadCurrent()).toEqual(original)
    expect(JSON.parse(second.store.exportSnapshotJson()!).sourceState.frameIndex).toBe(original.sourceState.frameIndex + 1)
    const reopened = await createStore(first.name)
    expect(reopened.store.snapshot).toEqual(original)
    expect(reopened.store.isPlaying).toBe(false)
  })

  it('exports the last committed complete library while retaining a failed close as separate recovery material', async () => {
    const { store, name } = await createStore()
    await store.openTrade('long', '1000')
    const committed = structuredClone(store.snapshot)!
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await store.closeTrade()
    expect(store.saveStatus).toBe('error')
    const failedClose = structuredClone(store.snapshot)
    vi.restoreAllMocks()
    const json = await store.exportBackupJson()
    expect(json).not.toBeNull()
    expect((JSON.parse(json!) as { sessions: unknown[] }).sessions).toEqual([committed])
    expect(store.libraryMessage).toContain('最近成功提交')
    expect(JSON.parse(store.exportSnapshotJson()!)).toEqual(failedClose)
    expect(store.saveStatus).toBe('error')
    expect(await repository(name).loadCurrent()).toEqual(committed)
  })

  it('appends backup copies while keeping current by default and opens a copy only when selected', async () => {
    const { store, name } = await createStore()
    await store.openTrade('short', '1000')
    await store.next()
    const current = structuredClone(store.snapshot)!
    const json = (await store.exportBackupJson())!
    expect(await store.prepareBackupRestore(json)).toBe(true)
    expect(store.backupPreview?.mode).toBe('append')
    expect(await store.restoreBackup()).toBe(true)
    expect(store.snapshot).toEqual(current)
    expect(store.savedSessions).toHaveLength(2)
    expect(await store.prepareBackupRestore(json)).toBe(true)
    expect(await store.restoreBackup(true)).toBe(true)
    expect(store.snapshot!.id).not.toBe(current.id)
    expect(store.snapshot!.account).toEqual(current.account)
    expect(store.snapshot!.sourceState).toEqual(current.sourceState)
    expect(store.isPlaying).toBe(false)
    expect(store.savedSessions).toHaveLength(3)
    expect((await repository(name).loadCurrent())?.id).toBe(store.snapshot!.id)
  })

  it('loads restored first plans, observations and imported training declarations immediately', async () => {
    const { store } = await createStore()
    expect(await store.repeatCurrentPractice()).toBe(true)
    await store.openTrade('long', '1000', { entryReason: '重练事前理由', exitPlan: '观察后退出' })
    const tradeId = store.snapshot!.account.position!.id
    expect(await store.recordObservation('这次等待下一根')).toBe(true)
    const priorId = store.snapshot!.id
    const json = (await store.exportBackupJson())!
    expect(await store.prepareBackupRestore(json)).toBe(true)
    expect(await store.restoreBackup(true)).toBe(true)
    expect(store.snapshot!.id).not.toBe(priorId)
    expect(store.tradeAnnotations[tradeId]?.firstPlan?.entryReason).toBe('重练事前理由')
    expect(store.sessionObservations[0]?.reason).toBe('这次等待下一根')
    expect(store.trainingContext?.kind).toBe('repeat')
    expect(store.trainingContext?.isImportedClaim).toBe(true)
    expect(store.trainingContext?.sessionId).toBe(store.snapshot!.id)
    expect(store.isPlaying).toBe(false)
  })

  it('reports metadata read failures independently after a successful restore transaction', async () => {
    const { store, name } = await createStore()
    expect(await store.repeatCurrentPractice()).toBe(true)
    const json = (await store.exportBackupJson())!
    expect(await store.prepareBackupRestore(json)).toBe(true)
    const originalGet = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = originalGet.call(this, key)
      if (this.name === 'settings' && Array.isArray(key) && key[0] === 'training') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    expect(await store.restoreBackup(true)).toBe(true)
    expect(store.saveStatus).toBe('saved')
    expect(store.libraryErrorMessage).toContain('读取练习备注失败')
    expect(store.libraryMessage).toContain('已恢复')
    expect(store.errorMessage).toBe('')
    vi.restoreAllMocks()
    expect((await repository(name).loadCurrent())?.id).toBe(store.snapshot!.id)
    expect((await repository(name).getTrainingContext(store.snapshot!.id))?.isImportedClaim).toBe(true)
    expect(await store.refreshCurrentMetadata()).toBe(true)
    expect(store.trainingContext?.isImportedClaim).toBe(true)
  })

  it('keeps a committed repeat saved when its context read fails and never retries the transaction as a failed save', async () => {
    const { store, name } = await createStore()
    const originalGet = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = originalGet.call(this, key)
      if (this.name === 'settings' && Array.isArray(key) && key[0] === 'training') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    expect(await store.repeatCurrentPractice()).toBe(true)
    expect(store.saveStatus).toBe('saved')
    expect(store.libraryErrorMessage).toContain('已保存')
    const committedId = store.snapshot!.id
    vi.restoreAllMocks()
    await store.retrySave()
    expect((await repository(name).listSessions())).toHaveLength(2)
    expect((await repository(name).getTrainingContext(committedId))?.kind).toBe('repeat')
    expect(await store.refreshCurrentMetadata()).toBe(true)
    expect(store.trainingContext?.kind).toBe('repeat')
  })

  it('preserves the repeat context candidate across an aborted metadata transaction and exact retry', async () => {
    const { store, name } = await createStore()
    const original = structuredClone(store.snapshot)!
    const originalAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalAdd.call(this, input, key)
      if (this.name === 'settings' && Array.isArray(key) && key[0] === 'training') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    expect(await store.repeatCurrentPractice()).toBe(false)
    expect(store.saveStatus).toBe('error')
    const candidate = structuredClone(store.snapshot)!
    expect(candidate.id).not.toBe(original.id)
    expect(await repository(name).loadCurrent()).toEqual(original)
    expect(await repository(name).loadSession(candidate.id)).toBeNull()
    vi.restoreAllMocks()
    await store.retrySave()
    expect(store.saveStatus).toBe('saved')
    expect(store.snapshot!.id).toBe(candidate.id)
    expect(store.trainingContext?.kind).toBe('repeat')
    expect(store.trainingContext?.sourceSessionId).toBe(original.id)
    expect((await repository(name).listSessions())).toHaveLength(2)
  })

  it('loads an archived trade for review without moving the account or the current market', async () => {
    const name = `fx-store-library-${crypto.randomUUID()}`
    const seed = repository(name)
    await seed.loadCurrent()
    let snapshot = makeSession('EUR/USD', null)
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'archived-trade')
    await seed.save(snapshot)
    snapshot = extendSession(snapshot, 2)
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot = { ...snapshot, account: closed.account, trades: [closed.trade] }
    await seed.save(snapshot)
    snapshot = extendSession(snapshot, 1440)
    await seed.save(snapshot)
    const { store } = await createStore(name)
    expect(store.snapshot!.frameStartIndex).toBeGreaterThan(2)
    const before = structuredClone(store.snapshot)!
    const currentQuote = structuredClone(store.currentQuote)
    await store.selectReviewTrade(store.snapshot!.trades[0]!, 'open')
    expect(store.reviewError).toBe('')
    expect(store.isReviewing).toBe(true)
    expect(store.chartFrames.some(frame => frame.quote.timestampMs === closed.trade.openedAtMs)).toBe(true)
    expect(store.snapshot).toEqual(before)
    expect(store.currentQuote).toEqual(currentQuote)
    expect(await repository(name).loadCurrent()).toEqual(before)
    store.exitReview()
    expect(store.chartFrames).toEqual(before.frames)
    expect(store.isReviewing).toBe(false)
  }, 30_000)

  it('excludes warmup from practice progress and account statistics and invalidates completed statistics on advance', async () => {
    const { store, name } = await createStore()
    const source = await history()
    expect(await store.importHistoryDataset(source)).toBe(true)
    await store.startHistorySession(source.id, { startTimestampMs: source.frames[3]!.quote.timestampMs, warmupFrameCount: 2 })
    expect(store.snapshot!.frames).toHaveLength(3)
    expect(store.progressedFrameCount).toBe(1)
    expect(store.totalPracticeFrameCount).toBe(5)
    await store.openTrade('long', '1000')
    await store.next()
    await store.closeTrade()
    await store.loadPracticeStatistics()
    expect(store.statisticsError).toBe('')
    expect(store.practiceStatistics?.curve.map(point => point.timestampMs)).toEqual(source.frames.slice(3, 5).map(frame => frame.quote.timestampMs))
    expect(store.practiceStatistics?.trades.tradeCount).toBe(1)
    await store.refreshLibrary()
    expect(store.savedSessions.find(summary => summary.id === store.snapshot!.id)?.progressedFrameCount).toBe(2)
    const observer = repository(name)
    expect((await observer.loadCurrent())?.sourceState.frameIndex).toBe(4)
    await store.next()
    expect(store.practiceStatistics).toBeNull()
    await store.loadPracticeStatistics()
    expect(store.practiceStatistics?.curve).toHaveLength(3)
  })

  it('can recalculate after account progress invalidates an in-flight statistics request', async () => {
    const { store } = await createStore()
    const pending = store.loadPracticeStatistics()
    const changed = store.next()
    await Promise.all([pending, changed])
    expect(store.isStatisticsLoading).toBe(false)
    expect(store.practiceStatistics).toBeNull()
    await store.loadPracticeStatistics()
    expect(store.statisticsError).toBe('')
    expect(store.practiceStatistics?.curve).toHaveLength(2)
  })

  it('persists onboarding and no-trade observations without changing the trading revision, including complete restore', async () => {
    const first = await createStore()
    const before = structuredClone(first.store.snapshot)!
    await first.store.setOnboardingStatus('skipped')
    expect(await first.store.recordObservation('当前没有足够理由，选择等待')).toBe(true)
    expect(first.store.snapshot).toEqual(before)
    const json = (await first.store.exportBackupJson())!
    const reopened = await createStore(first.name)
    expect(reopened.store.onboardingStatus).toBe('skipped')
    expect(reopened.store.sessionObservations).toHaveLength(1)
    expect(reopened.store.sessionObservations[0]?.timestampMs).toBe(before.sourceState.currentTimestampMs)
    const restored = repository(`fx-restored-observation-${crypto.randomUUID()}`)
    await restored.restoreBackup(await restored.previewBackup(json))
    expect(await restored.getOnboardingStatus()).toBe('skipped')
    expect((await restored.listSessionObservations(before.id))[0]?.reason).toBe('当前没有足够理由，选择等待')
  })

  it('refuses a damaged backup and a corrupted target session while preserving the usable current session', async () => {
    const { store, name } = await createStore()
    const older = structuredClone(store.snapshot)!
    await store.startNewSession('GBP/USD')
    const current = structuredClone(store.snapshot)!
    const json = (await store.exportBackupJson())!
    const damaged = JSON.parse(json) as { historyChunks: unknown[] }
    damaged.historyChunks = []
    expect(await store.prepareBackupRestore(JSON.stringify(damaged))).toBe(false)
    expect(store.snapshot).toEqual(current)
    expect(store.backupPreview).toBeNull()
    const corruptedOlder = { ...older, account: { ...older.account, balanceUsd: '9999.00' } }
    await record(name, 'sessions', older.id, corruptedOlder)
    expect(await store.activateSavedSession(older.id)).toBe(false)
    expect(store.libraryErrorMessage).toContain('打开练习失败')
    expect(store.snapshot).toEqual(current)
    expect(await record(name, 'sessions', older.id)).toEqual(corruptedOlder)
    expect(await repository(name).loadCurrent()).toEqual(current)
  })

  it('keeps a corrupted current snapshot intact across initialization and retry failures', async () => {
    const name = `fx-store-library-${crypto.randomUUID()}`
    const seed = repository(name)
    await seed.loadCurrent()
    const source = await history(3)
    await seed.importDataset(source)
    const initial = createHistoricalSnapshot(source)
    await seed.save(initial)
    const corrupted = { ...initial, account: { ...initial.account, balanceUsd: '9999.00' } }
    await record(name, 'sessions', initial.id, corrupted)
    const { store } = await createStore(name)
    expect(store.loadStatus).toBe('error')
    expect(store.snapshot).toBeNull()
    expect(JSON.parse(store.exportSnapshotJson()!)).toEqual(corrupted)
    await store.retryLoad()
    expect(store.loadStatus).toBe('error')
    expect(await record(name, 'sessions', initial.id)).toEqual(corrupted)
    expect(await seed.listSessions()).toHaveLength(1)
  })
})
