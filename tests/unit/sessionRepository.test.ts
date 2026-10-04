import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionRepository, SessionLoadError } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { SESSION_FRAME_WINDOW_SIZE, validateSessionSnapshot } from '../../src/storage/sessionSnapshot'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'
import type { MarketFrame } from '../../src/engine/types'
import { closePosition, openPosition } from '../../src/engine/execution'
import { advanceSimulation } from '../../src/engine/simulationSource'
import * as simulationSource from '../../src/engine/simulationSource'
import * as snapshots from '../../src/storage/sessionSnapshot'
import { extendSession, makeLegacySession, makeSession } from './sessionFixture'

const repositories: SessionRepository[] = []
function repository(name = `fx-test-${crypto.randomUUID()}`): SessionRepository {
  const created = createSessionRepository(name)
  repositories.push(created)
  return created
}
afterEach(() => {
  repositories.splice(0).forEach((created) => created.close())
  vi.restoreAllMocks()
})

async function changePointer(name: string, pointer: unknown | null): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite')
      if (pointer === null) transaction.objectStore('settings').delete('current')
      else transaction.objectStore('settings').put(pointer, 'current')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

async function seedLegacySnapshot(name: string, snapshot: unknown): Promise<void> {
  const legacy = snapshot as { id: string; revision: number }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' })
      request.result.createObjectStore('settings')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings'], 'readwrite')
      transaction.objectStore('sessions').put(snapshot)
      transaction.objectStore('settings').put({ id: legacy.id, revision: legacy.revision }, 'current')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

interface StoredChunk { sessionId: string; chunkIndex: number; frames: MarketFrame[] }

async function openStoredDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readRecord(name: string, store: string, key: IDBValidKey): Promise<unknown> {
  const database = await openStoredDatabase(name)
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, 'readonly')
      const request = transaction.objectStore(store).get(key)
      let result: unknown
      request.onsuccess = () => { result = request.result as unknown }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

async function readChunks(name: string): Promise<StoredChunk[]> {
  const database = await openStoredDatabase(name)
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('historyChunks', 'readonly')
      const request = transaction.objectStore('historyChunks').getAll()
      let result: StoredChunk[] = []
      request.onsuccess = () => { result = request.result as StoredChunk[] }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

async function changeRecord(name: string, store: string, key: IDBValidKey, input: unknown): Promise<void> {
  const database = await openStoredDatabase(name)
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite')
      if (input === undefined) transaction.objectStore(store).delete(key)
      else transaction.objectStore(store).put(input)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

async function saveThrough(created: SessionRepository, input: SessionSnapshot, count: number): Promise<SessionSnapshot> {
  let snapshot = input
  for (let remaining = count; remaining > 0; remaining -= SESSION_FRAME_WINDOW_SIZE) {
    snapshot = extendSession(snapshot, Math.min(remaining, SESSION_FRAME_WINDOW_SIZE))
    await created.save(snapshot)
  }
  return snapshot
}

describe('IndexedDB session repository', () => {
  it('closes a connection that succeeds after a blocked open was rejected and allows retrying', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const originalOpen = indexedDB.open.bind(indexedDB)
    const blockingDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = originalOpen(name, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let lateDatabase: IDBDatabase | null = null
    const close = vi.spyOn(IDBDatabase.prototype, 'close')
    let resolveSuccess!: (database: IDBDatabase) => void
    const success = new Promise<IDBDatabase>((resolve) => { resolveSuccess = resolve })
    // An upgrade makes IndexedDB emit blocked while the earlier connection remains open.
    vi.spyOn(indexedDB, 'open').mockImplementation((databaseName, version) => {
      const request = originalOpen(databaseName, version)
      request.addEventListener('success', () => resolveSuccess(request.result), { once: true })
      return request
    })
    const created = repository(name)
    try {
      await expect(created.loadCurrent()).rejects.toThrow('其他窗口占用了本地数据库')
      blockingDatabase.close()
      lateDatabase = await success
      expect(close.mock.contexts).toContain(lateDatabase)
      expect(() => lateDatabase!.transaction('settings')).toThrowError(expect.objectContaining({ name: 'InvalidStateError' }))
      expect(await created.loadCurrent()).toBeNull()
      const snapshot = makeSession()
      await created.save(snapshot)
      expect(await created.loadCurrent()).toEqual(snapshot)
    } finally {
      blockingDatabase.close()
      lateDatabase?.close()
    }
  })

  it('commits a coherent snapshot and current pointer and retains the previous session when switching', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const firstRepository = repository(name)
    expect(await firstRepository.loadCurrent()).toBeNull()
    const first = makeSession()
    await firstRepository.save(first)
    expect(await firstRepository.loadCurrent()).toEqual(first)
    const second = { ...makeSession('GBP/USD'), id: 'another-session' }
    await firstRepository.save(second)
    expect(await repository(name).loadCurrent()).toEqual(second)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const oldSession = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('sessions', 'readonly').objectStore('sessions').get(first.id)
      request.onsuccess = () => resolve(request.result as unknown)
      request.onerror = () => reject(request.error)
    })
    database.close()
    expect(oldSession).toEqual(first)
  })

  it('rejects an aborted transaction after a successful write request and keeps the old snapshot', async () => {
    const created = repository()
    await created.loadCurrent()
    const oldSnapshot = makeSession()
    await created.save(oldSnapshot)
    const nextSnapshot = extendSession(oldSnapshot)
    const originalPut = IDBObjectStore.prototype.put
    let writeRequestSucceeded = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'sessions') {
        request.addEventListener('success', () => {
          writeRequestSucceeded = true
          this.transaction.abort()
        })
      }
      return request
    })
    await expect(created.save(nextSnapshot)).rejects.toThrow()
    expect(writeRequestSucceeded).toBe(true)
    expect(await created.loadCurrent()).toEqual(oldSnapshot)
    vi.restoreAllMocks()
    await created.save(nextSnapshot)
    expect(await created.loadCurrent()).toEqual(nextSnapshot)
  })

  it('does not write malformed snapshots', async () => {
    const created = repository()
    await created.loadCurrent()
    const snapshot = makeSession()
    await created.save(snapshot)
    await expect(created.save({ ...snapshot, account: { balanceUsd: 'NaN', position: null } })).rejects.toThrow()
    expect(await created.loadCurrent()).toEqual(snapshot)
  })

  it('rejects stale browser tabs without overwriting a newly created or advanced session', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const first = repository(name)
    const second = repository(name)
    await first.loadCurrent()
    await second.loadCurrent()
    const snapshot = makeSession()
    await first.save(snapshot)
    await expect(second.save({ ...snapshot, id: 'other-tab' })).rejects.toThrow('另一窗口')
    await second.loadCurrent()
    const advanced = extendSession(snapshot)
    await first.save(advanced)
    await expect(second.save({ ...extendSession(snapshot, 2) })).rejects.toThrow('另一窗口')
    await expect(second.save({ ...extendSession(snapshot, 2) })).rejects.toThrow('另一窗口')
    expect(await repository(name).loadCurrent()).toEqual(advanced)
  })

  it('rejects a missing index when records remain and exposes a read snapshot when the index revision is damaged', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    const snapshot = makeSession()
    await created.save(snapshot)
    await changePointer(name, null)
    await expect(repository(name).loadCurrent()).rejects.toThrow('索引缺失')
    await changePointer(name, { id: snapshot.id, revision: 999 })
    let failure: unknown
    try { await repository(name).loadCurrent() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SessionLoadError)
    expect((failure as SessionLoadError).rawSnapshot).toEqual(snapshot)
  })

  it('rejects changed states that reuse an already saved revision', async () => {
    const created = repository()
    await created.loadCurrent()
    const snapshot = makeSession()
    await created.save(snapshot)
    await created.save(snapshot)
    const advanced = extendSession(snapshot)
    await expect(created.save({ ...advanced, revision: snapshot.revision })).rejects.toThrow('版本未推进')
    await expect(created.save({ ...advanced, revision: 5 })).rejects.toThrow('保存版本')
    expect(await created.loadCurrent()).toEqual(snapshot)
  })

  it('keeps schema1 raw data through read-only migration and an aborted first archive commit, then retries once', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const legacy = makeLegacySession()
    await seedLegacySnapshot(name, legacy)
    const created = repository(name)
    const migrated = validateSessionSnapshot(legacy)
    expect(await created.loadCurrent()).toEqual(migrated)
    expect(migrated.sourceState.maxFrames).toBeNull()
    expect(await readRecord(name, 'sessions', legacy.id)).toEqual(legacy)
    expect(await readChunks(name)).toEqual([])
    const advanced = extendSession(migrated)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.save(advanced)).rejects.toThrow()
    expect(await readRecord(name, 'sessions', legacy.id)).toEqual(legacy)
    expect(await readChunks(name)).toEqual([])
    vi.restoreAllMocks()
    await created.save(advanced)
    expect(await repository(name).loadCurrent()).toEqual(advanced)
    expect((await readChunks(name))[0]!.frames).toEqual(advanced.frames)
    expect(advanced.frames.slice(0, legacy.frames.length)).toEqual(legacy.frames)
    expect(advanced.account).toEqual(legacy.account)
    expect(advanced.trades).toEqual(legacy.trades)
    await created.save(advanced)
    expect((await readChunks(name))[0]!.frames).toHaveLength(legacy.frames.length + 1)
  })

  it('migrates an early schema2 state without the search cursor as saved data and preserves the old record until saving', async () => {
    const original = extendSession(makeSession(), 6)
    const { frameStartIndex: _frameStartIndex, ...oldFields } = structuredClone(original)
    const { scheduledSearchThroughTimestampMs: _cursor, ...oldSource } = oldFields.sourceState
    const legacy = { ...oldFields, schemaVersion: 2, sourceState: oldSource }
    const name = `fx-test-${crypto.randomUUID()}`
    await seedLegacySnapshot(name, legacy)
    const created = repository(name)
    const loaded = (await created.loadCurrent())!
    if (loaded.schemaVersion !== 3) throw new Error('expected simulation snapshot')
    expect(loaded.sourceState).toMatchObject({ version: 2, maxFrames: null, originFrameIndex: original.frames.length, frameIndex: original.sourceState.frameIndex, currentBidPrice: original.sourceState.currentBidPrice })
    expect(loaded.frames).toEqual(original.frames)
    expect(await readRecord(name, 'sessions', original.id)).toEqual(legacy)
    await created.save(loaded)
    expect(await repository(name).loadCurrent()).toEqual(loaded)
    expect((await readChunks(name))[0]!.frames).toEqual(original.frames)
    expect(advanceSimulation(loaded.sourceState)).not.toBeNull()
  })

  it('rejects corrupt old data without creating archives or changing the original record', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const legacy = makeLegacySession()
    legacy.trades[0]!.realizedPnlUsd = '999'
    await seedLegacySnapshot(name, legacy)
    const created = repository(name)
    await expect(created.loadCurrent()).rejects.toThrow('盈亏')
    expect(await readRecord(name, 'sessions', legacy.id)).toEqual(legacy)
    expect(await readChunks(name)).toEqual([])
    await expect(created.save(makeSession())).rejects.toThrow('先读取')
  })

  it('retains every frame and archived trade while restoring only a bounded window across three chunks', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    let snapshot = makeSession('EUR/USD', null, 'eventful')
    snapshot.account = openPosition(snapshot.account, snapshot.frames[0]!.quote, snapshot.pair, 'long', '1000', 'archived-trade')
    await created.save(snapshot)
    snapshot = await saveThrough(created, snapshot, SESSION_FRAME_WINDOW_SIZE)
    const closed = closePosition(snapshot.account, snapshot.frames.at(-1)!.quote)
    snapshot = { ...snapshot, revision: snapshot.revision + 1, account: closed.account, trades: [closed.trade] }
    await created.save(snapshot)
    snapshot = await saveThrough(created, snapshot, SESSION_FRAME_WINDOW_SIZE + 120)
    expect(snapshot.sourceState.frameIndex + 1).toBe(3001)
    expect(snapshot.frames).toHaveLength(SESSION_FRAME_WINDOW_SIZE)
    expect(snapshot.frameStartIndex).toBe(1561)
    const chunks = await readChunks(name)
    expect(chunks.map(chunk => [chunk.chunkIndex, chunk.frames.length])).toEqual([[0, 1440], [1, 1440], [2, 121]])
    expect(chunks.flatMap(chunk => chunk.frames).slice(-1440)).toEqual(snapshot.frames)
    const restored = (await repository(name).loadCurrent())!
    if (restored.schemaVersion !== 3) throw new Error('expected simulation snapshot')
    expect(restored).toEqual(snapshot)
    expect(restored.trades[0]!.openedAtMs).toBe(chunks[0]!.frames[0]!.quote.timestampMs)
    expect(restored.trades[0]!.openedAtMs).toBeLessThan(restored.frames[0]!.quote.timestampMs)
    expect(advanceSimulation(restored.sourceState)).toEqual(advanceSimulation(snapshot.sourceState))
  }, 15_000)

  it.each(['tampered old frame', 'missing block', 'extra block', 'incorrect frame count', 'damaged head window', 'damaged source state'] as const)('rejects %s during complete streaming restoration and keeps the stored records', async (kind) => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    let snapshot = makeSession('EUR/USD', null)
    await created.save(snapshot)
    snapshot = await saveThrough(created, snapshot, 1450)
    const chunks = await readChunks(name)
    if (kind === 'missing block') await changeRecord(name, 'historyChunks', [snapshot.id, 0], undefined)
    else if (kind === 'extra block') await changeRecord(name, 'historyChunks', [snapshot.id, 2], { sessionId: snapshot.id, chunkIndex: 2, frames: [] })
    else if (kind === 'tampered old frame' || kind === 'incorrect frame count') {
      const damaged = structuredClone(chunks[0]!)
      if (kind === 'tampered old frame') damaged.frames[0]!.highPrice = '2'
      else damaged.frames.pop()
      await changeRecord(name, 'historyChunks', [snapshot.id, 0], damaged)
    } else {
      const damaged = structuredClone(snapshot)
      if (kind === 'damaged head window') damaged.frames[0]!.highPrice = '2'
      else damaged.sourceState.fastLogVariance += 0.1
      await changeRecord(name, 'sessions', snapshot.id, damaged)
    }
    const storedHead = await readRecord(name, 'sessions', snapshot.id)
    const storedChunks = await readChunks(name)
    let failure: unknown
    try { await repository(name).loadCurrent() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SessionLoadError)
    expect((failure as SessionLoadError).rawSnapshot).toEqual(storedHead)
    expect(await readRecord(name, 'sessions', snapshot.id)).toEqual(storedHead)
    expect(await readChunks(name)).toEqual(storedChunks)
  }, 15_000)

  it('rolls back a failed append over a chunk boundary and retries without duplicate frames', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    let oldSnapshot = makeSession('EUR/USD', null)
    await created.save(oldSnapshot)
    oldSnapshot = await saveThrough(created, oldSnapshot, 1438)
    const oldChunks = await readChunks(name)
    const next = extendSession(oldSnapshot, 10)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, input, key)
      if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(created.save(next)).rejects.toThrow()
    expect(await readRecord(name, 'sessions', oldSnapshot.id)).toEqual(oldSnapshot)
    expect(await readChunks(name)).toEqual(oldChunks)
    vi.restoreAllMocks()
    await created.save(next)
    expect(await repository(name).loadCurrent()).toEqual(next)
    const chunks = await readChunks(name)
    expect(chunks.map(chunk => chunk.frames.length)).toEqual([1440, 9])
    expect(chunks.flatMap(chunk => chunk.frames)).toHaveLength(1449)
    await created.save(next)
    expect(await readChunks(name)).toEqual(chunks)
  }, 15_000)

  it('rejects an unexpected orphan at a new chunk boundary without overwriting any record', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    let snapshot = makeSession('EUR/USD', null)
    await created.save(snapshot)
    snapshot = await saveThrough(created, snapshot, 1439)
    const orphan = { sessionId: snapshot.id, chunkIndex: 1, frames: [snapshot.frames.at(-1)!] }
    await changeRecord(name, 'historyChunks', [snapshot.id, 1], orphan)
    const chunks = await readChunks(name)
    const pointer = await readRecord(name, 'settings', 'current')
    const next = extendSession(snapshot)
    await expect(created.save(next)).rejects.toThrow('归档')
    expect(await readRecord(name, 'sessions', snapshot.id)).toEqual(snapshot)
    expect(await readRecord(name, 'settings', 'current')).toEqual(pointer)
    expect(await readChunks(name)).toEqual(chunks)
    await changeRecord(name, 'historyChunks', [snapshot.id, 1], undefined)
    await created.save(next)
    expect(await repository(name).loadCurrent()).toEqual(next)
  }, 15_000)

  it('isolates caller and returned objects from the verified baseline, including nested event state', async () => {
    const name = `fx-test-${crypto.randomUUID()}`
    const created = repository(name)
    await created.loadCurrent()
    let snapshot = makeSession('EUR/USD', null, 'eventful', Date.UTC(2024, 2, 4, 7, 55))
    while (!snapshot.sourceState.lastEvent || !snapshot.sourceState.upcomingScheduledEvent) snapshot = extendSession(snapshot)
    const expected = structuredClone(snapshot)
    await created.save(snapshot)
    snapshot.frames[0]!.highPrice = '2'
    snapshot.sourceState.lastEvent!.detail = 'caller mutation'
    snapshot.sourceState.upcomingScheduledEvent!.expected = 'caller mutation'
    const next = extendSession(expected)
    await created.save(next)
    const returned = (await created.loadCurrent())!
    if (returned.schemaVersion !== 3) throw new Error('expected simulation snapshot')
    returned.frames[0]!.lowPrice = '2'
    returned.sourceState.lastEvent!.detail = 'returned mutation'
    returned.sourceState.upcomingScheduledEvent!.label = 'returned mutation'
    returned.simulationConfig.initialBidPrice = '2'
    await created.save(extendSession(next))
    expect(await created.loadCurrent()).toEqual(extendSession(next))
  })

  it('validates only added deterministic steps while still rejecting altered overlap, source factors and past ledger', async () => {
    const created = repository()
    await created.loadCurrent()
    let oldSnapshot = makeSession('EUR/USD', null)
    await created.save(oldSnapshot)
    oldSnapshot = await saveThrough(created, oldSnapshot, 1450)
    const next = extendSession(oldSnapshot, 10)
    const advance = vi.spyOn(simulationSource, 'advanceSimulation')
    await created.save(next)
    expect(advance).toHaveBeenCalledTimes(10)
    advance.mockRestore()
    for (const mutate of [
      (copy: SessionSnapshot) => { copy.frames[0]!.highPrice = '2' },
      (copy: SessionSnapshot) => { copy.sourceState.eventVariance += 0.1 },
      (copy: SessionSnapshot) => { copy.account.balanceUsd = '9999' },
    ]) {
      const damaged = structuredClone(extendSession(next))
      mutate(damaged)
      await expect(created.save(damaged)).rejects.toThrow()
    }
    expect(await created.loadCurrent()).toEqual(next)
  }, 15_000)
})

async function createCheckpointPractice(count = 3001) {
  const name = `fx-checkpoint-${crypto.randomUUID()}`
  const seed = repository(name)
  await seed.loadCurrent()
  let snapshot = makeSession('EUR/USD', null)
  await seed.save(snapshot)
  for (let remaining = count - 1; remaining > 0; remaining -= SESSION_FRAME_WINDOW_SIZE) {
    snapshot = extendSession(snapshot, Math.min(SESSION_FRAME_WINDOW_SIZE, remaining))
    await seed.save(snapshot)
  }
  seed.close()
  const reader = repository(name)
  expect(await reader.loadCurrent()).toEqual(snapshot)
  return { name, reader, snapshot }
}

describe('private validated archive checkpoints', () => {
  it('avoids full replay for repeated range reads before and after a validated append or unchanged save', async () => {
    const { reader, snapshot } = await createCheckpointPractice()
    const replay = vi.spyOn(snapshots, 'createSessionHistoryValidator')
    const range = { fromTimestampMs: snapshot.frames.at(-3)!.quote.timestampMs, toTimestampMs: snapshot.sourceState.currentTimestampMs }
    const expected = snapshot.frames.slice(-3)
    expect(await reader.readSessionFrames(snapshot.id, range)).toEqual(expected)
    const detached = await reader.readSessionFrames(snapshot.id, range)
    detached[0]!.highPrice = '123'
    expect(await reader.readSessionFrames(snapshot.id, range)).toEqual(expected)
    expect(replay).not.toHaveBeenCalled()
    await reader.save(snapshot)
    expect(await reader.readSessionFrames(snapshot.id, range)).toEqual(expected)
    expect(replay).not.toHaveBeenCalled()
    const next = extendSession(snapshot)
    await reader.save(next)
    expect(await reader.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs })).toEqual([next.frames.at(-1)!])
    expect(replay).not.toHaveBeenCalled()
    expect(await reader.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs + 60_000 })).toEqual([])
  }, 30_000)

  it.each(['earlier', 'later', 'missing', 'head'] as const)('rejects %s corruption outside the requested window without returning a cached range', async kind => {
    const { name, reader, snapshot } = await createCheckpointPractice()
    const range = kind === 'later' ? { toTimestampMs: snapshot.frames[0]!.quote.timestampMs } : { fromTimestampMs: snapshot.sourceState.currentTimestampMs }
    if (kind === 'head') {
      const damaged = structuredClone(await readRecord(name, 'sessions', snapshot.id)) as SessionSnapshot
      damaged.account.balanceUsd = '9999.00'
      await changeRecord(name, 'sessions', snapshot.id, damaged)
    } else if (kind === 'missing') await changeRecord(name, 'historyChunks', [snapshot.id, 0], undefined)
    else {
      const chunkIndex = kind === 'earlier' ? 0 : 2
      const damaged = structuredClone(await readRecord(name, 'historyChunks', [snapshot.id, chunkIndex])) as { sessionId: string; chunkIndex: number; frames: MarketFrame[] }
      damaged.frames[0]!.highPrice = '2'
      await changeRecord(name, 'historyChunks', [snapshot.id, chunkIndex], damaged)
    }
    await expect(reader.readSessionFrames(snapshot.id, range)).rejects.toThrow()
  }, 30_000)

  it('never certifies an altered partial block while appending one valid new minute', async () => {
    const { name, reader, snapshot } = await createCheckpointPractice()
    const damaged = structuredClone(await readRecord(name, 'historyChunks', [snapshot.id, 2])) as { sessionId: string; chunkIndex: number; frames: MarketFrame[] }
    damaged.frames[0]!.highPrice = '2'
    await changeRecord(name, 'historyChunks', [snapshot.id, 2], damaged)
    await expect(reader.save(extendSession(snapshot))).rejects.toThrow('最后归档块与已验证练习不一致')
    expect(await readRecord(name, 'sessions', snapshot.id)).toEqual(snapshot)
    await expect(reader.readSessionFrames(snapshot.id, { fromTimestampMs: snapshot.sourceState.currentTimestampMs })).rejects.toThrow()
  }, 30_000)

  it('does not certify unmodified older database blocks after an append to the current block', async () => {
    const { name, reader, snapshot } = await createCheckpointPractice()
    const damaged = structuredClone(await readRecord(name, 'historyChunks', [snapshot.id, 0])) as { sessionId: string; chunkIndex: number; frames: MarketFrame[] }
    damaged.frames[0]!.highPrice = '2'
    await changeRecord(name, 'historyChunks', [snapshot.id, 0], damaged)
    const next = extendSession(snapshot)
    await reader.save(next)
    expect(await readRecord(name, 'historyChunks', [snapshot.id, 0])).toEqual(damaged)
    await expect(reader.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs })).rejects.toThrow()
  }, 30_000)

  it('invalidates a stale owner on A-B-A activation and a cross-window progress update', async () => {
    const { name, reader, snapshot } = await createCheckpointPractice(1701)
    const other = repository(name)
    await other.loadCurrent()
    const b = { ...makeSession('GBP/USD'), id: 'another-practice' }
    await other.save(b)
    await other.activateSession(snapshot.id)
    const replay = vi.spyOn(snapshots, 'createSessionHistoryValidator')
    expect(await reader.readSessionFrames(snapshot.id, { fromTimestampMs: snapshot.sourceState.currentTimestampMs })).toEqual([snapshot.frames.at(-1)!])
    expect(replay).toHaveBeenCalled()
    replay.mockClear()
    const next = extendSession(snapshot)
    await other.save(next)
    expect(await reader.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs })).toEqual([next.frames.at(-1)!])
    expect(replay).toHaveBeenCalled()
    await expect(reader.save(extendSession(snapshot))).rejects.toThrow('另一窗口')
  }, 30_000)

  it('keeps a successful save and cold read usable when optional fingerprinting fails', async () => {
    const { name, reader, snapshot } = await createCheckpointPractice(1701)
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('optional cache unavailable'))
    const next = extendSession(snapshot)
    await expect(reader.save(next)).resolves.toBeUndefined()
    expect(await reader.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs })).toEqual([next.frames.at(-1)!])
    const cold = repository(name)
    expect(await cold.loadCurrent()).toEqual(next)
    vi.restoreAllMocks()
    expect(await cold.readSessionFrames(next.id, { fromTimestampMs: next.sourceState.currentTimestampMs })).toEqual([next.frames.at(-1)!])
  }, 30_000)

  it('drops the checkpoint when generation changes during hashing even if the change sequence is unchanged', async () => {
    const { name, reader, snapshot } = await createCheckpointPractice(1701)
    const replay = vi.spyOn(snapshots, 'createSessionHistoryValidator')
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let changed = false
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
      const result = await digest(algorithm, input)
      if (!changed) {
        changed = true
        const database = await openStoredDatabase(name)
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction('settings', 'readwrite')
            const request = transaction.objectStore('settings').get('library')
            request.onsuccess = () => {
              const state = request.result as { epoch: string; sequence: number; generation: number }
              transaction.objectStore('settings').put({ ...state, generation: state.generation + 1 }, 'library')
            }
            transaction.oncomplete = () => resolve()
            transaction.onabort = () => reject(transaction.error)
          })
        } finally { database.close() }
      }
      return result
    })
    expect(await reader.readSessionFrames(snapshot.id, { fromTimestampMs: snapshot.sourceState.currentTimestampMs })).toEqual([snapshot.frames.at(-1)!])
    expect(replay).toHaveBeenCalled()
    await expect(reader.save(extendSession(snapshot))).rejects.toThrow('另一窗口')
  }, 30_000)

  it('retains the legacy inline history before and after atomic migration into archived blocks', async () => {
    const name = `fx-checkpoint-legacy-${crypto.randomUUID()}`
    const legacy = makeLegacySession()
    await seedLegacySnapshot(name, legacy)
    const created = repository(name)
    const migrated = (await created.loadCurrent()) as SessionSnapshot
    expect(await created.readSessionFrames(legacy.id)).toEqual(legacy.frames)
    await created.save(migrated)
    expect(await created.readSessionFrames(legacy.id)).toEqual(legacy.frames)
    expect((await created.loadCurrent())?.account).toEqual(legacy.account)
  })
})
