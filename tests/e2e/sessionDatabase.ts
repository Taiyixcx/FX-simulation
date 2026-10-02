import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { MarketFrame } from '../../src/engine/types'
import { SESSION_FRAME_WINDOW_SIZE } from '../../src/storage/sessionSnapshot'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'

export interface SavedHistoryChunk {
  sessionId: string
  chunkIndex: number
  frames: MarketFrame[]
}

export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveText('已保存到本机')
}

/** Read the persisted head after the entire readonly transaction completes. */
export async function readSnapshot<T = SessionSnapshot>(page: Page, sessionId?: string): Promise<T> {
  const saved = await page.evaluate(async (requestedId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction(['settings', 'sessions'], 'readonly')
        let result: unknown
        function read(id: string): void {
          const request = transaction.objectStore('sessions').get(id)
          request.onsuccess = () => { result = request.result as unknown }
        }
        if (requestedId) read(requestedId)
        else {
          const pointer = transaction.objectStore('settings').get('current')
          pointer.onsuccess = () => { read((pointer.result as { id: string }).id) }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () => reject(transaction.error ?? new Error('读取测试快照失败'))
      })
    } finally { database.close() }
  }, sessionId)
  return saved as T
}

/** Fixtures use the same head-plus-complete-chunks format as the application. */
export async function writeSnapshot(
  page: Page,
  savedSnapshot: { id: string; revision: number; schemaVersion: number; frames: MarketFrame[] },
  fullHistory?: MarketFrame[],
): Promise<void> {
  const frames = fullHistory ?? savedSnapshot.frames
  if (savedSnapshot.schemaVersion === 3 && 'frameStartIndex' in savedSnapshot
    && savedSnapshot.frameStartIndex !== 0 && !fullHistory) {
    throw new Error('注入滚动窗口时必须提供完整历史行情')
  }
  await page.evaluate(async ({ snapshot, history, chunkSize }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['settings', 'sessions', 'historyChunks'], 'readwrite')
        const chunks = transaction.objectStore('historyChunks')
        chunks.delete(IDBKeyRange.bound([snapshot.id, 0], [snapshot.id, Number.MAX_SAFE_INTEGER]))
        if (snapshot.schemaVersion === 3) {
          for (let index = 0; index < history.length; index += chunkSize) {
            chunks.put({ sessionId: snapshot.id, chunkIndex: index / chunkSize, frames: history.slice(index, index + chunkSize) })
          }
        }
        transaction.objectStore('sessions').put(snapshot)
        transaction.objectStore('settings').put({ id: snapshot.id, revision: snapshot.revision }, 'current')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('写入测试快照失败'))
      })
    } finally { database.close() }
  }, { snapshot: savedSnapshot, history: frames, chunkSize: SESSION_FRAME_WINDOW_SIZE })
}

export async function readHistoryChunks(page: Page, sessionId: string): Promise<SavedHistoryChunk[]> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<SavedHistoryChunk[]>((resolve, reject) => {
        const transaction = database.transaction('historyChunks', 'readonly')
        let chunks: SavedHistoryChunk[] = []
        const request = transaction.objectStore('historyChunks').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
        request.onsuccess = () => { chunks = request.result as SavedHistoryChunk[] }
        transaction.oncomplete = () => resolve(chunks)
        transaction.onabort = () => reject(transaction.error ?? new Error('读取测试历史块失败'))
      })
    } finally { database.close() }
  }, sessionId)
}

export async function countSessions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction('sessions', 'readonly')
        let count = 0
        const request = transaction.objectStore('sessions').count()
        request.onsuccess = () => { count = request.result }
        transaction.oncomplete = () => resolve(count)
        transaction.onabort = () => reject(transaction.error ?? new Error('读取测试练习数量失败'))
      })
    } finally { database.close() }
  })
}
