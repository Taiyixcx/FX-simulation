import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { advanceHistory, createHistory } from '../../src/engine/historySource'
import type { HistoryDataset } from '../../src/engine/historyTypes'
import { closePosition, openPosition } from '../../src/engine/execution'
import { createSessionRepository, SessionLoadError } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { createHistoricalSnapshot } from '../../src/storage/historicalSessionSnapshot'
import type { HistoricalSessionSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { SESSION_FRAME_WINDOW_SIZE } from '../../src/storage/sessionSnapshot'
import { extendSession, makeSession } from './sessionFixture'

const repositories: SessionRepository[] = []
function repository(name: string): SessionRepository {
  const created = createSessionRepository(name)
  repositories.push(created)
  return created
}

afterEach(() => {
  repositories.splice(0).forEach(created => created.close())
  vi.restoreAllMocks()
})

async function makeDataset(count = 8): Promise<HistoryDataset> {
  const startTimestampMs = Date.UTC(2024, 2, 4, 8)
  const records = Array.from({ length: count }, (_, index) =>
    `${new Date(startTimestampMs + index * 60_000).toISOString()},1.085,1.086,1.084,1.085,1.0852`)
  return parseHistoryCsv(['timestamp,open,high,low,close,ask', ...records].join('\n'), 'EUR/USD', {
    label: '本机来源测试', sourceName: '用户 CSV', originalTimezone: 'UTC', verified: false,
  })
}

function extendHistory(snapshot: HistoricalSessionSnapshot, dataset: HistoryDataset, count = 1): HistoricalSessionSnapshot {
  let state = snapshot.sourceState
  const frames = [...snapshot.frames]
  for (let index = 0; index < count; index += 1) {
    const next = advanceHistory(state, dataset)
    if (!next) throw new Error('fixture exhausted')
    state = next.state
    frames.push(next.frame)
  }
  const recent = frames.slice(-SESSION_FRAME_WINDOW_SIZE)
  return { ...snapshot, revision: snapshot.revision + 1, sourceState: state, frames: recent, frameStartIndex: state.frameIndex + 1 - recent.length }
}

async function stored(name: string, storeName: string, key?: IDBValidKey, input?: unknown, remove = false): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, input === undefined && !remove ? 'readonly' : 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = remove ? store.delete(key!) : input !== undefined ? store.put(input, storeName === 'settings' ? key : undefined) : key === undefined ? store.getAll() : store.get(key)
      let result: unknown
      request.onsuccess = () => { result = request.result as unknown }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

describe('historical IndexedDB persistence', () => {
  it('imports immutable datasets independently, lists metadata only and never overwrites a duplicate', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const simulation = makeSession()
    await created.save(simulation)
    const dataset = await makeDataset()
    await created.importDataset(dataset)
    expect(await created.loadCurrent()).toEqual(simulation)
    const summaries = await created.listDatasets()
    expect(summaries).toEqual([{ id: dataset.id, pair: dataset.pair, fingerprint: dataset.fingerprint, metadata: dataset.metadata }])
    expect(summaries[0]).not.toHaveProperty('frames')
    summaries[0]!.metadata.label = 'caller change'
    const duplicate = structuredClone(dataset)
    duplicate.metadata.label = 'replacement label'
    await expect(created.importDataset(duplicate)).rejects.toThrow('已经导入')
    expect(await stored(name, 'datasets', dataset.id)).toEqual(dataset)
    const loaded = (await created.loadDataset(dataset.id))!
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(createHistory(loaded).frame).toEqual(dataset.frames[0])
    expect(await created.loadDataset('missing')).toBeNull()
  })

  it('rejects invalid content before writing and rolls back an aborted import with the current exercise untouched', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const simulation = makeSession()
    await created.save(simulation)
    const dataset = await makeDataset()
    const damaged = structuredClone(dataset)
    damaged.frames[2]!.highPrice = '2'
    await expect(created.importDataset(damaged)).rejects.toThrow('校验')
    const originalAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalAdd.call(this, input, key)
      if (this.name === 'datasets') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.importDataset(dataset)).rejects.toThrow()
    expect(await stored(name, 'datasets')).toEqual([])
    expect(await stored(name, 'settings', 'current')).toEqual({ id: simulation.id, revision: simulation.revision })
    expect(await created.loadCurrent()).toEqual(simulation)
    vi.restoreAllMocks()
    await created.importDataset(dataset)
    expect(await created.listDatasets()).toHaveLength(1)
  })

  it('commits a session switch atomically, retains the simulation archive, and retries an aborted switch', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const simulation = extendSession(makeSession(), 2)
    await created.save(simulation)
    const dataset = await makeDataset()
    await created.importDataset(dataset)
    const next = createHistoricalSnapshot(dataset, 'historical-session')
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.save(next)).rejects.toThrow()
    expect(await stored(name, 'sessions', next.id)).toBeUndefined()
    expect(await stored(name, 'settings', 'current')).toEqual({ id: simulation.id, revision: simulation.revision })
    vi.restoreAllMocks()
    await created.save(next)
    expect(await repository(name).loadCurrent()).toEqual(next)
    expect(await stored(name, 'sessions', simulation.id)).toEqual(simulation)
    const archives = await stored(name, 'historyChunks') as { sessionId: string }[]
    expect(archives).toHaveLength(1)
    expect(archives[0]!.sessionId).toBe(simulation.id)
    expect(await stored(name, 'datasets', dataset.id)).toEqual(dataset)
  })

  it('restores trades older than the bounded window without exposing any future quotes', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const dataset = await makeDataset(3001)
    await created.importDataset(dataset)
    let snapshot = createHistoricalSnapshot(dataset, 'long-history')
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'old-trade')
    await created.save(snapshot)
    snapshot = extendHistory(snapshot, dataset, 2)
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot = { ...snapshot, account: closed.account, trades: [closed.trade] }
    await created.save(snapshot)
    for (const count of [1440, 1440, 117]) {
      snapshot = extendHistory(snapshot, dataset, count)
      await created.save(snapshot)
    }
    const restored = (await repository(name).loadCurrent())!
    expect(restored).toEqual(snapshot)
    expect(restored.frames).toHaveLength(1440)
    expect(restored.frameStartIndex).toBe(1560)
    expect(restored.trades[0]!.openedAtMs).toBeLessThan(restored.frames[0]!.quote.timestampMs)
    expect(restored.frames.at(-1)!.quote.timestampMs).toBeLessThan(dataset.frames.at(-1)!.quote.timestampMs)
    expect(await stored(name, 'historyChunks')).toEqual([])
  })

  it.each(['missing dataset', 'old original quote', 'future original quote', 'head quote', 'balance', 'future trade', 'fingerprint', 'progress'] as const)('rejects %s without modifying the stored snapshot or dataset', async (kind) => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const dataset = await makeDataset()
    await created.importDataset(dataset)
    const snapshot = extendHistory(createHistoricalSnapshot(dataset, 'damaged-history'), dataset, 2)
    await created.save(snapshot)
    if (kind === 'missing dataset') await stored(name, 'datasets', dataset.id, undefined, true)
    else if (kind === 'old original quote' || kind === 'future original quote') {
      const damaged = structuredClone(dataset)
      damaged.frames[kind === 'old original quote' ? 0 : 7]!.highPrice = '2'
      await stored(name, 'datasets', dataset.id, damaged)
    } else {
      const damaged = structuredClone(snapshot)
      if (kind === 'head quote') damaged.frames[0]!.quote.askPrice = '2'
      else if (kind === 'balance') damaged.account.balanceUsd = '9999'
      else if (kind === 'fingerprint') damaged.sourceState.fingerprint = '0'.repeat(64)
      else if (kind === 'progress') damaged.sourceState.frameIndex += 1
      else damaged.account = openPosition(damaged.account, dataset.frames[7]!.quote, dataset.pair, 'long', '1000', 'future-position')
      await stored(name, 'sessions', snapshot.id, damaged)
    }
    const originalHead = await stored(name, 'sessions', snapshot.id)
    const originalDataset = await stored(name, 'datasets', dataset.id)
    const loading = repository(name)
    let failure: unknown
    try { await loading.loadCurrent() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SessionLoadError)
    expect((failure as SessionLoadError).rawSnapshot).toEqual(originalHead)
    expect(await stored(name, 'sessions', snapshot.id)).toEqual(originalHead)
    expect(await stored(name, 'datasets', dataset.id)).toEqual(originalDataset)
    await expect(loading.save(makeSession())).rejects.toThrow('先读取')
  })

  it('keeps revision checks across simulation and history windows, and allows recovery after reloading', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const first = repository(name)
    await first.loadCurrent()
    const simulation = makeSession()
    await first.save(simulation)
    const second = repository(name)
    await second.loadCurrent()
    const dataset = await makeDataset()
    await second.importDataset(dataset)
    await second.save(createHistoricalSnapshot(dataset, 'second-window'))
    await expect(first.save(extendSession(simulation))).rejects.toThrow('另一窗口')
    const loaded = (await first.loadCurrent())!
    if (loaded.schemaVersion !== 4) throw new Error('expected historical snapshot')
    const next = extendHistory(loaded, dataset)
    await expect(first.save({ ...next, revision: loaded.revision })).rejects.toThrow('版本未推进')
    await expect(first.save({ ...next, revision: 9 })).rejects.toThrow('保存版本')
    await first.save(next)
    await expect(second.save(extendHistory(loaded, dataset))).rejects.toThrow('另一窗口')
    expect(await repository(name).loadCurrent()).toEqual(next)
  })

  it('refuses to save a dangling dataset reference and retains the previously saved head', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const dataset = await makeDataset()
    await created.importDataset(dataset)
    const snapshot = createHistoricalSnapshot(dataset, 'lost-source-history')
    await created.save(snapshot)
    await stored(name, 'datasets', dataset.id, undefined, true)
    await expect(created.save(extendHistory(snapshot, dataset))).rejects.toThrow('数据集在保存期间丢失')
    expect(await stored(name, 'sessions', snapshot.id)).toEqual(snapshot)
    expect(await stored(name, 'settings', 'current')).toEqual({ id: snapshot.id, revision: snapshot.revision })
    expect(await stored(name, 'datasets', dataset.id)).toBeUndefined()
  })

  it('retains a private validated checkpoint and rejects rewritten historical trades or a changed dataset', async () => {
    const name = `fx-history-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const dataset = await makeDataset()
    await created.importDataset(dataset)
    let snapshot = createHistoricalSnapshot(dataset, 'checkpoint-history')
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'checkpoint-trade')
    const closed = closePosition(snapshot.account, snapshot.frames[0]!.quote)
    snapshot = { ...snapshot, account: closed.account, trades: [closed.trade] }
    await created.save(snapshot)
    const expected = structuredClone(snapshot)
    snapshot.trades[0]!.realizedPnlUsd = '9999'
    snapshot.frames[0]!.highPrice = '2'
    const next = extendHistory(expected, dataset)
    await created.save(next)
    const modified = structuredClone(extendHistory(next, dataset))
    modified.trades[0]!.exitPrice = '2'
    await expect(created.save(modified)).rejects.toThrow('成交记录')
    const changed = extendHistory(next, dataset)
    changed.sourceState.fingerprint = '0'.repeat(64)
    await expect(created.save(changed)).rejects.toThrow('数据集')
    expect(await created.loadCurrent()).toEqual(next)
  })
})
