import { copySessionSnapshot, createSessionHistoryValidator, SESSION_FRAME_WINDOW_SIZE, validateSessionSnapshot, validateSessionTransition } from './sessionSnapshot'
import type { SessionSnapshot } from './sessionSnapshot'
import type { MarketFrame } from '../engine/types'

export interface SessionRepository {
  loadCurrent(): Promise<SessionSnapshot | null>
  save(snapshot: SessionSnapshot): Promise<void>
  close(): void
}

export class SessionLoadError extends Error {
  constructor(message: string, readonly rawSnapshot: unknown | null = null) {
    super(message)
    this.name = 'SessionLoadError'
  }
}

interface CurrentPointer { id: string; revision: number }
interface HistoryChunk { sessionId: string; chunkIndex: number; frames: MarketFrame[] }

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

function readStored(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(key)
    let result: unknown
    request.onsuccess = () => { result = request.result as unknown }
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(transaction.error ?? new Error('读取事务失败。'))
    transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
  })
}

function parseChunk(input: unknown, sessionId: string, chunkIndex: number, expectedLength: number): HistoryChunk {
  if (typeof input !== 'object' || input === null || !('sessionId' in input) || !('chunkIndex' in input) || !('frames' in input) || input.sessionId !== sessionId || input.chunkIndex !== chunkIndex || !Array.isArray(input.frames) || input.frames.length !== expectedLength) {
    throw new Error('归档行情块缺失、数量或关联损坏。原有数据没有被覆盖。')
  }
  return input as HistoryChunk
}

/** Head, archive append and current pointer commit together under the same revision check. */
export function createSessionRepository(databaseName = 'fx-simulation'): SessionRepository {
  let databasePromise: Promise<IDBDatabase> | null = null
  let baseline: CurrentPointer | null | undefined
  let verifiedHead: SessionSnapshot | null = null
  let pendingMigrationFrames: MarketFrame[] | null = null

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器无法使用本地数据库。')); return }
      const request = indexedDB.open(databaseName, 2)
      let wasBlocked = false
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings')
        if (!database.objectStoreNames.contains('historyChunks')) database.createObjectStore('historyChunks', { keyPath: ['sessionId', 'chunkIndex'] })
      }
      request.onerror = () => reject(request.error ?? new Error('本地数据库打开失败。'))
      request.onblocked = () => { wasBlocked = true; reject(new Error('其他窗口占用了本地数据库，请关闭其他练习窗口后重试。')) }
      request.onsuccess = () => {
        if (wasBlocked) { request.result.close(); return }
        request.result.onversionchange = () => { request.result.close(); databasePromise = null }
        resolve(request.result)
      }
    }).catch((error: unknown) => { databasePromise = null; throw error })
    return databasePromise
  }

  async function loadCurrent(): Promise<SessionSnapshot | null> {
    baseline = undefined
    verifiedHead = null
    pendingMigrationFrames = null
    let raw: unknown | null = null
    try {
      const database = await openDatabase()
      const loaded = await new Promise<{ raw: unknown | null; pointer: CurrentPointer | null }>((resolve, reject) => {
        const transaction = database.transaction(['sessions', 'settings'], 'readonly')
        let pointer: CurrentPointer | null = null
        let failure: unknown = null
        const request = transaction.objectStore('settings').get('current')
        request.onsuccess = () => {
          try {
            pointer = parsePointer(request.result as unknown)
            if (!pointer) {
              const count = transaction.objectStore('sessions').count()
              count.onsuccess = () => {
                if (count.result > 0) { failure = new Error('当前练习索引缺失，但数据库中仍有练习记录。请保留浏览器数据，不会自动创建练习覆盖索引。'); transaction.abort() }
              }
              return
            }
            const session = transaction.objectStore('sessions').get(pointer.id)
            session.onsuccess = () => {
              raw = session.result as unknown
              if (raw === undefined) { failure = new Error('当前练习快照缺失。原有数据没有被覆盖。'); transaction.abort() }
            }
          } catch (error) { failure = error; transaction.abort() }
        }
        transaction.oncomplete = () => resolve({ raw, pointer })
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('读取练习失败。'))
        transaction.onerror = () => { failure ??= transaction.error }
      })
      if (!loaded.pointer) { baseline = null; return null }
      raw = loaded.raw
      if (typeof raw !== 'object' || raw === null || !('revision' in raw) || raw.revision !== loaded.pointer.revision || !('id' in raw) || raw.id !== loaded.pointer.id) {
        throw new Error('练习快照与索引版本不一致。原有数据没有被覆盖。')
      }
      let restored: SessionSnapshot
      if ('schemaVersion' in raw && (raw.schemaVersion === 1 || raw.schemaVersion === 2)) {
        restored = validateSessionSnapshot(raw)
        // All fields were checked above by the complete legacy validator.
        const legacyFrames = (raw as unknown as { frames: MarketFrame[] }).frames
        pendingMigrationFrames = legacyFrames.map(frame => ({
          quote: { ...frame.quote }, openPrice: frame.openPrice, highPrice: frame.highPrice,
          lowPrice: frame.lowPrice, closePrice: frame.closePrice,
        }))
      } else {
        const validator = createSessionHistoryValidator(raw)
        const frameCount = (raw as SessionSnapshot).sourceState.frameIndex + 1
        const chunkCount = Math.ceil(frameCount / SESSION_FRAME_WINDOW_SIZE)
        const archivedCount = await new Promise<number>((resolve, reject) => {
          const transaction = database.transaction('historyChunks', 'readonly')
          const request = transaction.objectStore('historyChunks').count(IDBKeyRange.bound([loaded.pointer!.id, 0], [loaded.pointer!.id, Number.MAX_SAFE_INTEGER]))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        if (archivedCount !== chunkCount) throw new Error('归档行情块数量与会话进度不一致。原有数据没有被覆盖。')
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const expectedLength = Math.min(SESSION_FRAME_WINDOW_SIZE, frameCount - chunkIndex * SESSION_FRAME_WINDOW_SIZE)
          const chunk = parseChunk(await readStored(database, 'historyChunks', [loaded.pointer.id, chunkIndex]), loaded.pointer.id, chunkIndex, expectedLength)
          for (const frame of chunk.frames) validator.pushFrame(frame)
        }
        restored = validator.finish()
      }
      if (!samePointer(parsePointer(await readStored(database, 'settings', 'current')), loaded.pointer)) throw new Error('另一窗口在读取期间更新了练习，请重试读取。原有数据没有被覆盖。')
      baseline = loaded.pointer
      verifiedHead = copySessionSnapshot(restored)
      return copySessionSnapshot(restored)
    } catch (error) {
      pendingMigrationFrames = null
      throw new SessionLoadError(error instanceof Error ? error.message : '读取练习失败。', raw ?? null)
    }
  }

  async function save(snapshot: SessionSnapshot): Promise<void> {
    if (baseline === undefined) throw new Error('请先读取当前练习，再保存数据。')
    const previous = verifiedHead?.id === snapshot.id ? verifiedHead : null
    const validated = previous ? validateSessionTransition(previous, snapshot) : validateSessionSnapshot(snapshot)
    if (previous && validated.revision === previous.revision && JSON.stringify(validated) !== JSON.stringify(previous)) {
      throw new Error('练习状态发生改变但保存版本未推进。原有数据没有被覆盖。')
    }
    const database = await openDatabase()
    const migration = previous && pendingMigrationFrames !== null
    const appendStart = migration || !previous ? 0 : previous.sourceState.frameIndex + 1
    const appendFrames = migration
      ? [...pendingMigrationFrames!, ...validated.frames.slice(previous!.sourceState.frameIndex + 1 - validated.frameStartIndex)]
      : previous ? validated.frames.slice(appendStart - validated.frameStartIndex) : validated.frames
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings', 'historyChunks'], 'readwrite')
      let failure: unknown = null
      function abort(error: unknown): void { failure = error; transaction.abort() }
      function writeHead(): void {
        transaction.objectStore('sessions').put(validated)
        transaction.objectStore('settings').put({ id: validated.id, revision: validated.revision }, 'current')
      }
      function writeHistory(prefix: MarketFrame[]): void {
        let chunkIndex = Math.floor(appendStart / SESSION_FRAME_WINDOW_SIZE)
        let frames = prefix
        for (const frame of appendFrames) {
          frames.push(frame)
          if (frames.length === SESSION_FRAME_WINDOW_SIZE) {
            transaction.objectStore('historyChunks').put({ sessionId: validated.id, chunkIndex, frames })
            chunkIndex += 1
            frames = []
          }
        }
        if (frames.length > 0) transaction.objectStore('historyChunks').put({ sessionId: validated.id, chunkIndex, frames })
        writeHead()
      }
      function appendHistory(): void {
        if (appendFrames.length === 0) { writeHead(); return }
        const chunkIndex = Math.floor(appendStart / SESSION_FRAME_WINDOW_SIZE)
        const prefixLength = appendStart % SESSION_FRAME_WINDOW_SIZE
        const archive = transaction.objectStore('historyChunks')
        const firstNewChunkIndex = chunkIndex + (prefixLength > 0 ? 1 : 0)
        const count = archive.count(IDBKeyRange.bound([validated.id, firstNewChunkIndex], [validated.id, Number.MAX_SAFE_INTEGER]))
        count.onsuccess = () => {
          try {
            if (count.result !== 0) throw new Error('归档中存在超出已保存进度的行情块，不能覆盖原数据。')
            if (prefixLength === 0) { writeHistory([]); return }
            const request = archive.get([validated.id, chunkIndex])
            request.onsuccess = () => {
              try {
                const chunk = parseChunk(request.result as unknown, validated.id, chunkIndex, prefixLength)
                const expectedPrefix = previous!.frames.slice(chunkIndex * SESSION_FRAME_WINDOW_SIZE - previous!.frameStartIndex)
                if (JSON.stringify(chunk.frames) !== JSON.stringify(expectedPrefix)) throw new Error('最后归档块与已验证练习不一致。原有数据没有被覆盖。')
                writeHistory(chunk.frames)
              } catch (error) { abort(error) }
            }
          } catch (error) { abort(error) }
        }
      }
      const pointerRequest = transaction.objectStore('settings').get('current')
      pointerRequest.onsuccess = () => {
        try {
          const pointer = parsePointer(pointerRequest.result as unknown)
          if (!samePointer(pointer, baseline ?? null)) throw new Error('另一窗口已更新练习。请先导出此窗口的未保存快照，再关闭此窗口并刷新恢复最新练习；不会覆盖另一窗口的数据。')
          if (previous && validated.revision === previous.revision && !migration) return
          if (!previous) {
            const existing = transaction.objectStore('sessions').get(validated.id)
            existing.onsuccess = () => {
              try {
                if (existing.result !== undefined) throw new Error('练习标识已存在，不能覆盖已保存记录。')
                appendHistory()
              } catch (error) { abort(error) }
            }
          } else appendHistory()
        } catch (error) { abort(error) }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('保存事务未完成，请重试或导出快照。'))
      transaction.onerror = () => { failure ??= transaction.error }
    })
    baseline = { id: validated.id, revision: validated.revision }
    verifiedHead = copySessionSnapshot(validated)
    pendingMigrationFrames = null
  }

  return {
    loadCurrent, save,
    close() {
      if (databasePromise) void databasePromise.then(database => database.close(), () => undefined)
      databasePromise = null
      baseline = undefined
      verifiedHead = null
      pendingMigrationFrames = null
    },
  }
}
