import { validateSessionSnapshot } from './sessionSnapshot'
import type { SessionSnapshot } from './sessionSnapshot'

export interface SessionRepository {
  loadCurrent(): Promise<unknown | null>
  save(snapshot: SessionSnapshot): Promise<void>
  close(): void
}

export class SessionLoadError extends Error {
  constructor(message: string, readonly rawSnapshot: unknown | null = null) {
    super(message)
    this.name = 'SessionLoadError'
  }
}

interface CurrentPointer {
  id: string
  revision: number
}

function parsePointer(input: unknown): CurrentPointer | null {
  if (input === undefined) return null
  if (typeof input !== 'object' || input === null || !('id' in input) || !('revision' in input) || typeof input.id !== 'string' || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error('当前练习索引损坏。原有数据没有被覆盖。')
  }
  return { id: input.id, revision: input.revision }
}

function samePointer(left: CurrentPointer | null, right: CurrentPointer | null): boolean {
  return left?.id === right?.id && left?.revision === right?.revision
}

/** The session and current pointer commit together; stale browser tabs cannot overwrite newer snapshots. */
export function createSessionRepository(databaseName = 'fx-simulation'): SessionRepository {
  let databasePromise: Promise<IDBDatabase> | null = null
  let baseline: CurrentPointer | null | undefined

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('此浏览器无法使用本地数据库。'))
        return
      }
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('sessions', { keyPath: 'id' })
        database.createObjectStore('settings')
      }
      request.onerror = () => reject(request.error ?? new Error('本地数据库打开失败。'))
      request.onblocked = () => reject(new Error('其他窗口占用了本地数据库，请关闭其他练习窗口后重试。'))
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close()
          databasePromise = null
        }
        resolve(request.result)
      }
    }).catch((error: unknown) => {
      databasePromise = null
      throw error
    })
    return databasePromise
  }

  async function loadCurrent(): Promise<unknown | null> {
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings'], 'readonly')
      let result: unknown | null = null
      let pointer: CurrentPointer | null = null
      let failure: unknown = null
      const request = transaction.objectStore('settings').get('current')
      request.onsuccess = () => {
        try {
          pointer = parsePointer(request.result as unknown)
          if (!pointer) {
            const countRequest = transaction.objectStore('sessions').count()
            countRequest.onsuccess = () => {
              if (countRequest.result > 0) {
                failure = new Error('当前练习索引缺失，但数据库中仍有练习记录。请保留浏览器数据，不会自动创建练习覆盖索引。')
                transaction.abort()
              }
            }
            return
          }
          const sessionRequest = transaction.objectStore('sessions').get(pointer.id)
          sessionRequest.onsuccess = () => {
            result = sessionRequest.result as unknown
            if (result === undefined) {
              failure = new Error('当前练习快照缺失。原有数据没有被覆盖。')
              transaction.abort()
            }
          }
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      transaction.oncomplete = () => {
        if (pointer && (typeof result !== 'object' || result === null || !('revision' in result) || result.revision !== pointer.revision)) {
          reject(new SessionLoadError('练习快照与索引版本不一致。原有数据没有被覆盖。', result))
          return
        }
        baseline = pointer
        resolve(result)
      }
      transaction.onabort = () => {
        const error = failure ?? transaction.error
        reject(new SessionLoadError(error instanceof Error ? error.message : '读取练习失败。', result ?? null))
      }
      transaction.onerror = () => { failure ??= transaction.error }
    })
  }

  async function save(snapshot: SessionSnapshot): Promise<void> {
    const validated = validateSessionSnapshot(snapshot)
    if (baseline === undefined) throw new Error('请先读取当前练习，再保存数据。')
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings'], 'readwrite')
      let failure: unknown = null
      const request = transaction.objectStore('settings').get('current')
      request.onsuccess = () => {
        try {
          const pointer = parsePointer(request.result as unknown)
          if (!samePointer(pointer, baseline ?? null)) {
            throw new Error('另一窗口已更新练习。请先导出此窗口的未保存快照，再关闭此窗口并刷新恢复最新练习；不会覆盖另一窗口的数据。')
          }
          if (pointer?.id === validated.id) {
            if (validated.revision !== pointer.revision && validated.revision !== pointer.revision + 1) {
              throw new Error('保存版本与当前练习不一致。原有数据没有被覆盖。')
            }
            if (validated.revision === pointer.revision) {
              const existingRequest = transaction.objectStore('sessions').get(validated.id)
              existingRequest.onsuccess = () => {
                try {
                  if (JSON.stringify(validateSessionSnapshot(existingRequest.result as unknown)) !== JSON.stringify(validated)) {
                    throw new Error('练习状态发生改变但保存版本未推进。原有数据没有被覆盖。')
                  }
                } catch (error) {
                  failure = error
                  transaction.abort()
                }
              }
              return
            }
          }
          transaction.objectStore('sessions').put(validated)
          transaction.objectStore('settings').put({ id: validated.id, revision: validated.revision }, 'current')
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      transaction.oncomplete = () => {
        baseline = { id: validated.id, revision: validated.revision }
        resolve()
      }
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('保存事务未完成，请重试或导出快照。'))
      transaction.onerror = () => { failure ??= transaction.error }
    })
  }

  return {
    loadCurrent,
    save,
    close() {
      if (databasePromise) void databasePromise.then((database) => database.close(), () => undefined)
      databasePromise = null
    },
  }
}
