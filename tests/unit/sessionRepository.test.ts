import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionRepository, SessionLoadError } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { extendSession, makeSession } from './sessionFixture'

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
    const request = indexedDB.open(name, 1)
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

describe('IndexedDB session repository', () => {
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
      const request = indexedDB.open(name, 1)
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
})
