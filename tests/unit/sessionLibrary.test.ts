import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionRepository } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { createHistoricalSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { openPosition } from '../../src/engine/execution'
import { extendSession, makeLegacySession, makeSession } from './sessionFixture'

const repositories: SessionRepository[] = []
function repository(name = `fx-library-${crypto.randomUUID()}`): SessionRepository {
  const created = createSessionRepository(name)
  repositories.push(created)
  return created
}
afterEach(() => { repositories.splice(0).forEach(created => created.close()); vi.restoreAllMocks() })
async function access(name: string, work: (database: IDBDatabase) => Promise<void>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try { await work(database) } finally { database.close() }
}
async function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
}
async function dataset(verified = false) {
  return parseHistoryCsv('timestamp,open,high,low,close,ask\n2024-03-04T08:01:00Z,1.1,1.11,1.09,1.1,1.1002\n2024-03-04T08:02:00Z,1.1,1.11,1.09,1.1,1.1002', 'EUR/USD', {
    label: '隔离测试', sourceName: '合成 CSV', originalTimezone: 'UTC', verified,
  })
}

describe('practice library and complete backups', () => {
  it('activates existing records without rewriting them, detects A-B-A and deletes only inactive sessions', async () => {
    const name = `fx-library-${crypto.randomUUID()}`
    const first = repository(name)
    await first.loadCurrent()
    const a = makeSession()
    await first.save(a)
    const b = { ...makeSession('GBP/USD'), id: 'session-b' }
    await first.save(b)
    const stale = repository(name)
    await stale.loadCurrent()
    await first.activateSession(a.id)
    await first.activateSession(b.id)
    await expect(stale.save(extendSession(b))).rejects.toThrow('另一窗口')
    expect((await first.listSessions()).find(summary => summary.id === a.id)?.revision).toBe(0)
    await expect(first.deleteSession(b.id, b.revision)).rejects.toThrow('当前练习')
    await first.deleteSession(a.id, a.revision)
    expect(await first.loadSession(a.id)).toBeNull()
    expect(await first.loadCurrent()).toEqual(b)
  })

  it('reads source and actual summary records without a second dataset load or unselected full objects', async () => {
    const created = repository()
    await created.loadCurrent()
    const source = await dataset()
    await created.importDataset(source)
    const snapshot = createHistoricalSnapshot(source)
    await created.save(snapshot)
    const loaded = await created.loadCurrentWithSource()
    expect(loaded?.dataset?.id).toBe(source.id)
    expect(Object.isFrozen(loaded?.dataset)).toBe(true)
    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    expect(await created.listDatasets()).toHaveLength(1)
    expect(await created.listSessions()).toHaveLength(1)
    expect(spy.mock.contexts.every(store => store instanceof IDBObjectStore && store.name !== 'datasets' && store.name !== 'sessions')).toBe(true)
    expect((await created.readSessionFrames(snapshot.id))).toHaveLength(1)
    await expect(created.deleteDataset(source.id)).rejects.toThrow('仍被练习引用')
  })

  it('round-trips complete archives, plans and no-trade observations; append preserves the local current session', async () => {
    const original = repository()
    await original.loadCurrent()
    let snapshot = makeSession('EUR/USD', null)
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'trade-plan')
    await original.save(snapshot, { tradeId: 'trade-plan', expectedRevision: null, entryReason: '开始前判断', exitPlan: '等待观察' })
    await original.recordSessionObservation(snapshot.id, { timestampMs: snapshot.sourceState.currentTimestampMs, frameIndex: 0, reason: '暂时不加仓' })
    const initial = (await original.getTradeAnnotation(snapshot.id, 'trade-plan'))!
    await original.saveTradeAnnotation(snapshot.id, 'trade-plan', { expectedRevision: initial.revision, entryReason: '事后修订' })
    snapshot = extendSession(snapshot, 1440)
    await original.save(snapshot)
    const json = await original.exportBackupJson()
    const empty = repository()
    const preview = await empty.previewBackup(json)
    expect(preview.mode).toBe('empty')
    const restored = await empty.restoreBackup(preview)
    expect(restored.loadedSession?.snapshot).toEqual(snapshot)
    expect(await empty.readSessionFrames(snapshot.id)).toHaveLength(1441)
    const annotation = (await empty.getTradeAnnotation(snapshot.id, 'trade-plan'))!
    expect(annotation.firstPlan?.entryReason).toBe('开始前判断')
    expect(annotation.planRevisions.at(-1)?.isBeforeEntry).toBe(false)
    expect(await empty.listSessionObservations(snapshot.id)).toHaveLength(1)
    const append = await empty.previewBackup(json)
    const copies = await empty.restoreBackup(append)
    expect(copies.sessionIds[0]).not.toBe(snapshot.id)
    expect(copies.currentSessionId).toBe(snapshot.id)
    expect(copies.loadedSession).toBeNull()
    expect(await empty.listTradeAnnotations(copies.sessionIds[0]!)).toHaveLength(1)
    expect(await empty.listSessionObservations(copies.sessionIds[0]!)).toHaveLength(1)
  }, 30_000)

  it('preserves a last committed complete backup when the newer candidate failed to save', async () => {
    const created = repository()
    await created.loadCurrent()
    const snapshot = makeSession()
    await created.save(snapshot)
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
      const request = original.call(this, record, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.save(extendSession(snapshot))).rejects.toThrow()
    vi.restoreAllMocks()
    const backup = JSON.parse(await created.exportBackupJson()) as { sessions: unknown[] }
    expect(backup.sessions).toEqual([snapshot])
  })

  it('rejects stale restore previews, unknown versions, missing chunks and cancellation without writing', async () => {
    const created = repository()
    await created.loadCurrent()
    await created.save(makeSession())
    const json = await created.exportBackupJson()
    const target = repository()
    const preview = await target.previewBackup(json)
    await target.setOnboardingStatus('skipped')
    await expect(target.restoreBackup(preview)).rejects.toThrow('预览后数据库已变化')
    expect(await target.listSessions()).toEqual([])
    const invalid = JSON.parse(json) as { backupFormatVersion: number; historyChunks: unknown[] }
    invalid.backupFormatVersion = 100
    await expect(target.previewBackup(JSON.stringify(invalid))).rejects.toThrow('格式版本')
    invalid.backupFormatVersion = 1
    invalid.historyChunks = []
    await expect(target.previewBackup(JSON.stringify(invalid))).rejects.toThrow('归档行情块')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(target.previewBackup(json, cancelled.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(await target.listSessions()).toEqual([])
  })

  it('downgrades external verified claims, preserves local metadata when reusing a source, and refuses corrupt collisions', async () => {
    const original = repository()
    await original.loadCurrent()
    const source = await dataset(true)
    await original.importDataset(source)
    await original.save(createHistoricalSnapshot(source))
    const json = await original.exportBackupJson()
    const name = `fx-library-${crypto.randomUUID()}`
    const target = repository(name)
    await target.restoreBackup(await target.previewBackup(json))
    expect((await target.loadDataset(source.id))?.metadata.verified).toBe(false)
    expect((await target.loadDataset(source.id))?.metadata.restoredVerificationClaim).toBe(true)
    expect((await target.loadDataset(source.id))?.metadata.licenseNotes).toBe(source.metadata.licenseNotes)
    await access(name, async database => {
      const transaction = database.transaction('datasets', 'readwrite')
      const damaged = structuredClone(source)
      damaged.frames[0]!.highPrice = '100'
      transaction.objectStore('datasets').put(damaged)
      await transactionDone(transaction)
    })
    await expect(target.previewBackup(json)).rejects.toThrow('同标识历史数据已损坏')
  })

  it('rolls back every restore record after an abort and allows retrying the exact preview', async () => {
    const source = repository()
    await source.loadCurrent()
    await source.save(makeSession())
    const target = repository()
    const preview = await target.previewBackup(await source.exportBackupJson())
    const originalAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
      const request = originalAdd.call(this, record, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(target.restoreBackup(preview)).rejects.toThrow()
    expect(await target.listSessions()).toEqual([])
    expect(await target.loadCurrent()).toBeNull()
    vi.restoreAllMocks()
    expect((await target.restoreBackup(preview)).sessionIds).toEqual(['session-test'])
  })

  it('discards abandoned previews and prevents an earlier concurrent validation becoming active', async () => {
    const source = repository()
    await source.loadCurrent()
    await source.save(makeSession())
    const json = await source.exportBackupJson()
    const target = repository()
    const first = target.previewBackup(json)
    const second = target.previewBackup(json)
    const results = await Promise.allSettled([first, second])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    if (results[1].status !== 'fulfilled') throw new Error('second preview failed')
    const active = results[1].value
    target.discardBackupPreview(active.id)
    await expect(target.restoreBackup(active)).rejects.toThrow('预览已失效')
    expect(await target.listSessions()).toEqual([])
  })

  it('rolls back a failed entry together with its first plan and preserves the first plan on exact retry', async () => {
    const created = repository()
    await created.loadCurrent()
    const prior = makeSession()
    await created.save(prior)
    const candidate = { ...prior, revision: 1, account: openPosition(prior.account, prior.frames[0]!.quote, prior.pair, 'long', '1000', 'atomic-plan') }
    const input = { tradeId: 'atomic-plan', expectedRevision: null, entryReason: '事前计划', exitPlan: '观察后退出' }
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
      const request = original.call(this, record, key)
      if (this.name === 'annotations') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.save(candidate, input)).rejects.toThrow()
    expect(await created.getTradeAnnotation(prior.id, input.tradeId)).toBeNull()
    expect((await created.loadSession(prior.id))?.snapshot).toEqual(prior)
    vi.restoreAllMocks()
    await created.save(candidate, input)
    expect((await created.getTradeAnnotation(prior.id, input.tradeId))?.firstPlan?.entryReason).toBe(input.entryReason)
  })

  it('reuses healthy local source metadata and establishes an entrance when the target contains only datasets', async () => {
    const original = repository()
    await original.loadCurrent()
    const source = await dataset(true)
    await original.importDataset(source)
    await original.save(createHistoricalSnapshot(source))
    const target = repository()
    await target.loadCurrent()
    const local = structuredClone(source)
    local.metadata.label = '本机保留标签'
    await target.importDataset(local)
    const preview = await target.previewBackup(await original.exportBackupJson())
    expect(preview.mode).toBe('append')
    const restored = await target.restoreBackup(preview)
    expect(restored.currentSessionId).toBe(restored.sessionIds[0])
    expect((await target.loadDataset(source.id))?.metadata.label).toBe('本机保留标签')
    expect((await target.loadDataset(source.id))?.metadata.verified).toBe(true)
    expect(await target.loadCurrent()).not.toBeNull()
  })

  it('keeps the current pointer and save baseline when opening an empty or dataset-only backup', async () => {
    const target = repository()
    await target.loadCurrent()
    let snapshot = makeSession()
    await target.save(snapshot)
    const empty = repository()
    const emptyPreview = await target.previewBackup(await empty.exportBackupJson())
    const emptyResult = await target.restoreBackup(emptyPreview, { openRestoredSession: true })
    expect(emptyResult.loadedSession).toBeNull()
    expect(emptyResult.currentSessionId).toBe(snapshot.id)
    snapshot = extendSession(snapshot)
    await target.save(snapshot)
    const sourceOnly = repository()
    const source = await dataset()
    await sourceOnly.importDataset(source)
    const sourcePreview = await target.previewBackup(await sourceOnly.exportBackupJson())
    const sourceResult = await target.restoreBackup(sourcePreview, { openRestoredSession: true })
    expect(sourceResult.loadedSession).toBeNull()
    expect(sourceResult.currentSessionId).toBe(snapshot.id)
    expect((await target.loadDataset(source.id))?.id).toBe(source.id)
    snapshot = extendSession(snapshot)
    await target.save(snapshot)
    expect(await target.loadCurrent()).toEqual(snapshot)
  })

  it('cancels a restore during its write requests with every record rolled back', async () => {
    const source = repository()
    await source.loadCurrent()
    await source.save(makeSession())
    const target = repository()
    const preview = await target.previewBackup(await source.exportBackupJson())
    const signal = new AbortController()
    const original = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
      const request = original.call(this, record, key)
      if (this.name === 'sessions') request.addEventListener('success', () => signal.abort())
      return request
    })
    await expect(target.restoreBackup(preview, { signal: signal.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(await target.listSessions()).toEqual([])
    expect(await target.loadCurrent()).toBeNull()
  })

  it('keeps annotation concurrency independent of trading revision and rejects future observations', async () => {
    const created = repository()
    await created.loadCurrent()
    const snapshot = makeSession()
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'short', '1000', 'note-trade')
    await created.save(snapshot)
    await created.saveTradeAnnotation(snapshot.id, 'note-trade', { expectedRevision: null, entryReason: '后来补记' })
    await expect(created.saveTradeAnnotation(snapshot.id, 'note-trade', { expectedRevision: null, exitNote: '陈旧编辑' })).rejects.toThrow('另一窗口')
    expect((await created.getTradeAnnotation(snapshot.id, 'note-trade'))?.firstPlan).toBeNull()
    expect((await created.loadCurrent())?.revision).toBe(snapshot.revision)
    await expect(created.recordSessionObservation(snapshot.id, { timestampMs: snapshot.sourceState.currentTimestampMs + 60_000, frameIndex: 1, reason: '未来' })).rejects.toThrow('进度已变化')
  })

  it('upgrades legacy databases without writing migrated heads and preserves legacy archives through a complete backup', async () => {
    const name = `fx-library-${crypto.randomUUID()}`
    const legacy = makeLegacySession()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('sessions', { keyPath: 'id' }); request.result.createObjectStore('settings') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sessions', 'settings'], 'readwrite')
    transaction.objectStore('sessions').add(legacy)
    transaction.objectStore('settings').put({ id: legacy.id, revision: legacy.revision }, 'current')
    await transactionDone(transaction)
    database.close()
    const upgraded = repository(name)
    expect((await upgraded.listSessions())[0]?.errorMessage).toBeNull()
    const json = await upgraded.exportBackupJson()
    expect((JSON.parse(json) as { sessions: unknown[] }).sessions).toEqual([legacy])
    const restored = repository()
    await restored.restoreBackup(await restored.previewBackup(json))
    expect(await restored.readSessionFrames(legacy.id)).toEqual(legacy.frames)
    expect((await restored.loadCurrent())?.account).toEqual(legacy.account)
  })
})
