import { copySessionSnapshot, createSessionHistoryValidator, SESSION_FRAME_WINDOW_SIZE, validateSessionSnapshot, validateSessionTransition } from './sessionSnapshot'
import type { SessionSnapshot } from './sessionSnapshot'
import type { MarketFrame } from '../engine/types'
import { sha256Text, throwIfHistoryCancelled, validateHistoryDataset, validateHistoryDatasetSummary } from '../engine/historySource'
import type { HistoryDataset, HistoryDatasetSummary, HistoryProcessingControls } from '../engine/historyTypes'
import { copyPracticeSnapshot, isHistoricalSnapshot, validateHistoricalSnapshot, validateHistoricalTransition } from './historicalSessionSnapshot'
import type { HistoricalSessionSnapshot, PracticeSnapshot } from './historicalSessionSnapshot'
import { createSessionSummary, createSessionTrainingContext, readLibraryState, reviseTradeAnnotation, validateTradeAnnotation, validateSessionObservation, validateSessionSummary, validateSessionTrainingContext } from './sessionMetadata'
import type { LibraryState, OnboardingStatus, PendingTradeAnnotation, SessionSummary, TradeAnnotation, TradeAnnotationInput, SessionObservation, SessionTrainingContext, TrainingContextInput } from './sessionMetadata'
import { BACKUP_MAX_BYTES, checkCancelled, validatePracticeBackup } from './sessionBackup'
import { yieldToEventLoop } from '../yieldToEventLoop'
import type { BackupPreview, PracticeBackup, ValidatedBackup } from './sessionBackup'

export interface LoadedSession { snapshot: PracticeSnapshot; dataset: HistoryDataset | null }
export interface DatasetListEntry { id: string; summary: HistoryDatasetSummary | null; errorMessage: string | null }
export interface RestoreResult { sessionIds: string[]; currentSessionId: string | null; loadedSession: LoadedSession | null }
export interface StorageHealth { usageBytes: number | null; quotaBytes: number | null; isPersistent: boolean | null }
export interface CleanupProtection { sessionId: string; datasetId: string | null }
export interface RecoveryBackupInput {
  snapshot: PracticeSnapshot
  dataset: HistoryDataset | null
  annotation?: PendingTradeAnnotation
  trainingContext?: TrainingContextInput
}

export interface SessionRepository {
  loadCurrent(): Promise<PracticeSnapshot | null>
  loadCurrentWithSource(): Promise<LoadedSession | null>
  loadSession(id: string): Promise<LoadedSession | null>
  activateSession(id: string): Promise<LoadedSession>
  listSessions(): Promise<SessionSummary[]>
  save(snapshot: PracticeSnapshot, annotation?: PendingTradeAnnotation, trainingContext?: TrainingContextInput): Promise<void>
  importDataset(dataset: HistoryDataset, controls?: HistoryProcessingControls): Promise<void>
  listDatasets(): Promise<HistoryDatasetSummary[]>
  loadDataset(id: string): Promise<HistoryDataset | null>
  listDatasetEntries(): Promise<DatasetListEntry[]>
  exportBackupJson(signal?: AbortSignal): Promise<string>
  exportSessionBackupJson(id: string, signal?: AbortSignal): Promise<string>
  exportRecoveryBackupJson(input: RecoveryBackupInput, signal?: AbortSignal): Promise<string>
  previewBackup(json: string, signal?: AbortSignal): Promise<BackupPreview>
  discardBackupPreview(id: string): void
  restoreBackup(preview: BackupPreview, options?: { openRestoredSession?: boolean; signal?: AbortSignal }): Promise<RestoreResult>
  deleteSession(id: string, expectedRevision: number, protection?: CleanupProtection): Promise<void>
  deleteDataset(id: string, protection?: CleanupProtection): Promise<void>
  getTradeAnnotation(sessionId: string, tradeId: string): Promise<TradeAnnotation | null>
  getTrainingContext(sessionId: string): Promise<SessionTrainingContext | null>
  listTradeAnnotations(sessionId: string): Promise<TradeAnnotation[]>
  saveTradeAnnotation(sessionId: string, tradeId: string, input: TradeAnnotationInput): Promise<TradeAnnotation>
  readSessionFrames(sessionId: string, range?: { fromTimestampMs?: number; toTimestampMs?: number }): Promise<MarketFrame[]>
  storageHealth(): Promise<StorageHealth>
  requestPersistentStorage(): Promise<boolean>
  getOnboardingStatus(): Promise<OnboardingStatus | null>
  setOnboardingStatus(status: OnboardingStatus): Promise<void>
  listSessionObservations(sessionId: string): Promise<SessionObservation[]>
  recordSessionObservation(sessionId: string, input: { timestampMs: number; frameIndex: number; reason: string }): Promise<SessionObservation>
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
interface ArchiveCheckpoint {
  sessionId: string
  revision: number
  frameCount: number
  currentTimestampMs: number
  epoch: string
  generation: number
  headFingerprint: string
  verifiedHeadFingerprint: string
  chunkFingerprints: Map<number, string>
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
  let verifiedHead: PracticeSnapshot | null = null
  let verifiedDataset: HistoryDataset | null = null
  let pendingMigrationFrames: MarketFrame[] | null = null
  let baselineState: LibraryState | null = null
  const pendingBackups = new Map<string, { backup: ValidatedBackup; state: LibraryState; mode: 'empty' | 'append'; localCurrentSessionId: string | null }>()
  let backupRequestGeneration = 0
  // Only fingerprints are retained; archived frames remain owned by IndexedDB.
  let archiveCheckpoint: ArchiveCheckpoint | null = null
  let archiveScope = 0

  function invalidateArchiveCheckpoint(): void { archiveCheckpoint = null; archiveScope += 1 }
  function fingerprintRecord(input: unknown): Promise<string> { return sha256Text(JSON.stringify(input)) }
  async function createArchiveCheckpoint(raw: unknown, head: SessionSnapshot, chunkFingerprints: Map<number, string>, state: LibraryState): Promise<ArchiveCheckpoint> {
    return { sessionId: head.id, revision: head.revision, frameCount: head.sourceState.frameIndex + 1,
      currentTimestampMs: head.sourceState.currentTimestampMs, epoch: state.epoch, generation: state.generation,
      headFingerprint: await fingerprintRecord(raw), verifiedHeadFingerprint: await fingerprintRecord(head), chunkFingerprints }
  }
  async function validateArchiveFrames(validator: ReturnType<typeof createSessionHistoryValidator>, frames: MarketFrame[]): Promise<void> {
    let batchStartedAt = performance.now()
    let batchFrameCount = 0
    for (let index = 0; index < frames.length; index += 1) {
      validator.pushFrame(frames[index]!)
      batchFrameCount += 1
      if (batchFrameCount >= 128 || performance.now() - batchStartedAt >= 16) {
        await yieldToEventLoop()
        batchStartedAt = performance.now()
        batchFrameCount = 0
      }
    }
  }

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器无法使用本地数据库。')); return }
      const request = indexedDB.open(databaseName, 4)
      let wasBlocked = false
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings')
        if (!database.objectStoreNames.contains('historyChunks')) database.createObjectStore('historyChunks', { keyPath: ['sessionId', 'chunkIndex'] })
        if (!database.objectStoreNames.contains('datasets')) database.createObjectStore('datasets', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('sessionSummaries')) database.createObjectStore('sessionSummaries', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('datasetSummaries')) database.createObjectStore('datasetSummaries', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('annotations')) database.createObjectStore('annotations', { keyPath: ['sessionId', 'tradeId'] })
        if (!database.objectStoreNames.contains('observations')) database.createObjectStore('observations', { keyPath: 'id' })
        const upgrade = request.transaction!
        const settings = upgrade.objectStore('settings')
        const stateRequest = settings.get('library')
        stateRequest.onsuccess = () => {
          if (stateRequest.result === undefined) settings.put({ epoch: crypto.randomUUID(), sequence: 0, generation: 0 }, 'library')
        }
        const sessions = upgrade.objectStore('sessions').openCursor()
        sessions.onsuccess = () => {
          const cursor = sessions.result
          if (!cursor) return
          upgrade.objectStore('sessionSummaries').put(createSessionSummary(cursor.value as unknown, null, null, String(cursor.primaryKey)))
          cursor.continue()
        }
        const datasets = upgrade.objectStore('datasets').openCursor()
        datasets.onsuccess = () => {
          const cursor = datasets.result
          if (!cursor) return
          let entry: DatasetListEntry
          try { entry = { id: String(cursor.primaryKey), summary: validateHistoryDatasetSummary(cursor.value as unknown), errorMessage: null } }
          catch (error) { entry = { id: String(cursor.primaryKey), summary: null, errorMessage: error instanceof Error ? error.message : '数据集摘要损坏。' } }
          upgrade.objectStore('datasetSummaries').put(entry)
          cursor.continue()
        }
      }
      request.onerror = () => reject(request.error ?? new Error('本地数据库打开失败。'))
      request.onblocked = () => { wasBlocked = true; reject(new Error('其他窗口占用了本地数据库，请关闭其他练习窗口后重试。')) }
      request.onsuccess = () => {
        if (wasBlocked) { request.result.close(); return }
        request.result.onversionchange = () => { request.result.close(); databasePromise = null; baseline = undefined; baselineState = null; verifiedDataset = null; verifiedHead = null; invalidateArchiveCheckpoint() }
        resolve(request.result)
      }
    }).catch((error: unknown) => { databasePromise = null; throw error })
    return databasePromise
  }

  async function currentState(): Promise<LibraryState> {
    return readLibraryState(await readStored(await openDatabase(), 'settings', 'library'))
  }
  function readCurrentFence(database: IDBDatabase): Promise<{ state: LibraryState; pointer: CurrentPointer | null }> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('settings', 'readonly')
      let state: LibraryState
      let pointer: CurrentPointer | null = null
      let failure: unknown = null
      const library = transaction.objectStore('settings').get('library')
      library.onsuccess = () => { try { state = readLibraryState(library.result as unknown) } catch (error) { failure = error; transaction.abort() } }
      const current = transaction.objectStore('settings').get('current')
      current.onsuccess = () => { try { pointer = parsePointer(current.result as unknown) } catch (error) { failure = error; transaction.abort() } }
      transaction.oncomplete = () => resolve({ state, pointer })
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('读取练习版本失败。'))
    })
  }
  function sameState(left: LibraryState, right: LibraryState): boolean {
    return left.epoch === right.epoch && left.sequence === right.sequence && left.generation === right.generation
  }
  async function writeTransaction(
    stores: string[], work: (transaction: IDBTransaction, abort: (error: unknown) => void) => void,
    options: { checkBaseline?: boolean; activate?: boolean; expectedState?: LibraryState; signal?: AbortSignal; failureMessage?: string } = {},
  ): Promise<LibraryState> {
    checkCancelled(options.signal)
    const database = await openDatabase()
    return new Promise<LibraryState>((resolve, reject) => {
      const transaction = database.transaction([...new Set(['settings', ...stores])], 'readwrite')
      let failure: unknown = null
      let committedState: LibraryState
      const abort = (error: unknown): void => { failure = error; try { transaction.abort() } catch { /* Completion is authoritative. */ } }
      const cancel = (): void => abort(new DOMException('操作已取消，原有数据保留。', 'AbortError'))
      options.signal?.addEventListener('abort', cancel, { once: true })
      const stateRequest = transaction.objectStore('settings').get('library')
      stateRequest.onsuccess = () => {
        try {
          checkCancelled(options.signal)
          const state = readLibraryState(stateRequest.result as unknown)
          if (options.expectedState && !sameState(state, options.expectedState)) throw new Error('预览后数据库已变化，请重新读取预览；原有数据没有被覆盖。')
          if (options.checkBaseline && (!baselineState || state.epoch !== baselineState.epoch || state.generation !== baselineState.generation)) throw new Error('另一窗口已更新练习或切换当前练习，请重新读取；原有数据没有被覆盖。')
          if (state.sequence >= Number.MAX_SAFE_INTEGER || state.generation >= Number.MAX_SAFE_INTEGER) throw new Error('本地数据版本超出安全范围，请导出备份。')
          const execute = (): void => {
            committedState = { ...state, sequence: state.sequence + 1, generation: state.generation + (options.activate ? 1 : 0) }
            transaction.objectStore('settings').put(committedState, 'library')
            try { work(transaction, abort) } catch (error) { abort(error) }
          }
          if (options.checkBaseline) {
            const pointer = transaction.objectStore('settings').get('current')
            pointer.onsuccess = () => {
              try {
                if (!samePointer(parsePointer(pointer.result as unknown), baseline ?? null)) throw new Error('另一窗口已更新练习，原有数据没有被覆盖。')
                execute()
              } catch (error) { abort(error) }
            }
          } else execute()
        } catch (error) { abort(error) }
      }
      transaction.oncomplete = () => { options.signal?.removeEventListener('abort', cancel); resolve(committedState) }
      transaction.onabort = () => { options.signal?.removeEventListener('abort', cancel); reject(failure ?? transaction.error ?? new Error(options.failureMessage ?? '保存事务未完成，原有数据保留。')) }
      transaction.onerror = () => { failure ??= transaction.error }
    })
  }

  async function readAll<T>(storeName: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const database = await openDatabase()
    return new Promise<T[]>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).getAll(query)
      let records: T[] = []
      request.onsuccess = () => { records = request.result as T[] }
      transaction.oncomplete = () => resolve(records)
      transaction.onabort = () => reject(transaction.error ?? new Error('读取本地记录失败。'))
    })
  }

  async function importDataset(input: HistoryDataset, controls?: HistoryProcessingControls): Promise<void> {
    throwIfHistoryCancelled(controls)
    const dataset = structuredClone(input)
    await validateHistoryDataset(dataset, controls)
    throwIfHistoryCancelled(controls)
    const signal = typeof AbortSignal !== 'undefined' && controls?.signal instanceof AbortSignal ? controls.signal : undefined
    await writeTransaction(['datasets', 'datasetSummaries'], (transaction, abort) => {
      throwIfHistoryCancelled(controls)
      const store = transaction.objectStore('datasets')
      const existing = store.get(dataset.id)
      existing.onsuccess = () => {
        if (controls?.signal?.aborted) { abort(new DOMException('历史导入已取消，原有数据保留。', 'AbortError')); return }
        if (existing.result !== undefined) {
          abort(new Error('这份历史数据已经导入，原数据集没有被覆盖。请从已导入列表中选择。'))
        } else {
          store.add(dataset)
          transaction.objectStore('datasetSummaries').add({ id: dataset.id, summary: validateHistoryDatasetSummary(dataset), errorMessage: null })
        }
      }
    }, { signal, failureMessage: '导入事务未完成，原有数据保留。' })
  }

  async function loadDataset(id: string): Promise<HistoryDataset | null> {
    const database = await openDatabase()
    const input = await readStored(database, 'datasets', id)
    if (input === undefined) return null
    // Validation includes every original row and the immutable source fingerprint.
    await validateHistoryDataset(input as HistoryDataset, { yieldControl: yieldToEventLoop })
    const dataset = input as HistoryDataset
    if (dataset.id !== id) throw new Error('历史数据集标识与数据库索引不一致。原有数据没有被覆盖。')
    // The engine freezes verified datasets. Reusing that object preserves its
    // private validation certificate without letting callers mutate the source.
    verifiedDataset = dataset
    return dataset
  }

  async function listDatasets(): Promise<HistoryDatasetSummary[]> {
    return (await listDatasetEntries()).flatMap(entry => entry.summary ? [entry.summary] : [])
  }
  async function listDatasetEntries(): Promise<DatasetListEntry[]> {
    return (await readAll<unknown>('datasetSummaries')).map(raw => {
      const id = raw && typeof raw === 'object' && 'id' in raw ? String(raw.id) : 'unknown'
      try {
        if (!raw || typeof raw !== 'object' || !('summary' in raw)) throw new Error('数据集摘要损坏。')
        const summary = raw.summary ? validateHistoryDatasetSummary(raw.summary) : null
        if (summary && summary.id !== id) throw new Error('数据集摘要标识不一致。')
        return { id, summary, errorMessage: summary ? null : ('errorMessage' in raw && typeof raw.errorMessage === 'string' ? raw.errorMessage : '数据集摘要损坏。') }
      }
      catch (error) { return { id, summary: null, errorMessage: error instanceof Error ? error.message : '数据集摘要损坏。' } }
    })
  }
  async function listSessions(): Promise<SessionSummary[]> {
    const database = await openDatabase()
    return new Promise<SessionSummary[]>((resolve, reject) => {
      const transaction = database.transaction(['sessionSummaries', 'settings'], 'readonly')
      let summaries: SessionSummary[] = []
      let pointer: CurrentPointer | null = null
      const request = transaction.objectStore('sessionSummaries').getAll()
      request.onsuccess = () => { summaries = (request.result as unknown[]).map(validateSessionSummary) }
      const current = transaction.objectStore('settings').get('current')
      current.onsuccess = () => { try { pointer = parsePointer(current.result as unknown) } catch { /* All records remain visible. */ } }
      transaction.oncomplete = () => resolve(summaries.map(summary => ({ ...summary, isCurrent: summary.id === pointer?.id })))
      transaction.onabort = () => reject(transaction.error ?? new Error('读取练习列表失败。'))
    })
  }

  async function loadCurrent(): Promise<PracticeSnapshot | null> {
    invalidateArchiveCheckpoint()
    const scope = archiveScope
    baseline = undefined
    verifiedHead = null
    pendingMigrationFrames = null
    baselineState = null
    let raw: unknown | null = null
    try {
      const database = await openDatabase()
      const initialState = await currentState()
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
      if (!loaded.pointer) { baseline = null; baselineState = initialState; return null }
      raw = loaded.raw
      if (typeof raw !== 'object' || raw === null || !('revision' in raw) || raw.revision !== loaded.pointer.revision || !('id' in raw) || raw.id !== loaded.pointer.id) {
        throw new Error('练习快照与索引版本不一致。原有数据没有被覆盖。')
      }
      let restored: PracticeSnapshot
      const chunkFingerprints = new Map<number, string>()
      let canCheckpoint = true
      if ('schemaVersion' in raw && raw.schemaVersion === 4) {
        const source = 'sourceState' in raw && typeof raw.sourceState === 'object' && raw.sourceState !== null && 'datasetId' in raw.sourceState ? raw.sourceState : null
        if (!source || typeof source.datasetId !== 'string') throw new Error('历史练习的数据集引用损坏。原有数据没有被覆盖。')
        const dataset = await loadDataset(source.datasetId)
        if (!dataset) throw new Error('历史练习引用的原始数据集缺失。原有数据没有被覆盖。')
        restored = validateHistoricalSnapshot(raw, dataset)
      } else if ('schemaVersion' in raw && (raw.schemaVersion === 1 || raw.schemaVersion === 2)) {
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
          await validateArchiveFrames(validator, chunk.frames)
          if (canCheckpoint) {
            try { chunkFingerprints.set(chunkIndex, await fingerprintRecord(chunk)) }
            catch { canCheckpoint = false; chunkFingerprints.clear() }
          }
        }
        restored = validator.finish()
      }
      if (!samePointer(parsePointer(await readStored(database, 'settings', 'current')), loaded.pointer)) throw new Error('另一窗口在读取期间更新了练习，请重试读取。原有数据没有被覆盖。')
      const finalState = await currentState()
      if (!sameState(initialState, finalState)) throw new Error('另一窗口在读取期间更新了数据库，请重试读取。原有数据没有被覆盖。')
      baseline = loaded.pointer
      baselineState = finalState
      verifiedHead = copyPracticeSnapshot(restored)
      if (canCheckpoint && restored.schemaVersion === 3 && pendingMigrationFrames === null) {
        try {
          const checkpoint = await createArchiveCheckpoint(raw, restored, chunkFingerprints, finalState)
          if (scope === archiveScope) archiveCheckpoint = checkpoint
        } catch { if (scope === archiveScope) invalidateArchiveCheckpoint() }
      }
      return copyPracticeSnapshot(restored)
    } catch (error) {
      pendingMigrationFrames = null
      throw new SessionLoadError(error instanceof Error ? error.message : '读取练习失败。', raw ?? null)
    }
  }

  function writeMetadata(transaction: IDBTransaction, snapshot: PracticeSnapshot, annotation: PendingTradeAnnotation | undefined, prior: PracticeSnapshot | null, abort: (error: unknown) => void, trainingContext?: SessionTrainingContext): void {
    if (trainingContext) transaction.objectStore('settings').add(trainingContext, ['training', snapshot.id])
    const summaryRequest = transaction.objectStore('sessionSummaries').get(snapshot.id)
    summaryRequest.onsuccess = () => {
      const previousSummary = summaryRequest.result === undefined ? undefined : validateSessionSummary(summaryRequest.result as unknown)
      transaction.objectStore('sessionSummaries').put(createSessionSummary(snapshot, previousSummary ? previousSummary.createdAtMs : Date.now(), Date.now()))
    }
    if (!annotation) return
    if (snapshot.account.position?.id !== annotation.tradeId && !snapshot.trades.some(trade => trade.id === annotation.tradeId)) { abort(new Error('备注必须关联已保存的交易。')); return }
    const request = transaction.objectStore('annotations').get([snapshot.id, annotation.tradeId])
    request.onsuccess = () => {
      try {
        const previousAnnotation = request.result === undefined ? null : validateTradeAnnotation(request.result as unknown)
        const isBeforeEntry = snapshot.account.position?.id === annotation.tradeId && prior?.account.position?.id !== annotation.tradeId
        const nextAnnotation = reviseTradeAnnotation(snapshot.id, annotation.tradeId, previousAnnotation, annotation, isBeforeEntry)
        transaction.objectStore('annotations').put(nextAnnotation)
      } catch (error) { abort(error) }
    }
  }

  async function saveHistorical(snapshot: HistoricalSessionSnapshot, annotation?: PendingTradeAnnotation, trainingContextInput?: TrainingContextInput): Promise<void> {
    if (baseline === undefined) throw new Error('请先读取当前练习，再保存数据。')
    const prior = verifiedHead?.id === snapshot.id ? verifiedHead : null
    if (prior && trainingContextInput) throw new Error('训练对照信息只能在新练习创建时记录，不能改写既有标签。')
    const trainingContext = trainingContextInput ? createSessionTrainingContext(snapshot.id, trainingContextInput) : undefined
    if (trainingContext && trainingContext.sourceFingerprint !== snapshot.sourceState.fingerprint) throw new Error('训练对照来源指纹与历史练习不一致。')
    if (prior && !isHistoricalSnapshot(prior)) throw new Error('练习模式不可原地改变。原有数据没有被覆盖。')
    const dataset = verifiedDataset?.id === snapshot.sourceState.datasetId
      ? verifiedDataset : await loadDataset(snapshot.sourceState.datasetId)
    if (!dataset) throw new Error('历史练习引用的原始数据集缺失。原有数据没有被覆盖。')
    const validated = prior ? validateHistoricalTransition(prior, snapshot, dataset) : validateHistoricalSnapshot(snapshot, dataset)
    if (prior && validated.revision === prior.revision && JSON.stringify(validated) !== JSON.stringify(prior)) throw new Error('练习状态发生改变但保存版本未推进。原有数据没有被覆盖。')
    const committedState = await writeTransaction(['sessions', 'datasets', 'sessionSummaries', 'annotations'], (transaction, abort) => {
      function writeHead(): void {
        transaction.objectStore('sessions').put(validated)
        transaction.objectStore('settings').put({ id: validated.id, revision: validated.revision }, 'current')
        writeMetadata(transaction, validated, annotation, prior, abort, trainingContext)
      }
      const pointer = transaction.objectStore('settings').get('current')
      pointer.onsuccess = () => {
        try {
          if (!samePointer(parsePointer(pointer.result as unknown), baseline ?? null)) throw new Error('另一窗口已更新练习。请先导出此窗口的未保存快照，再关闭此窗口并刷新恢复最新练习；不会覆盖另一窗口的数据。')
          // Datasets are append-only. Full source validation runs when opening
          // one; a key check avoids cloning every future quote on each save.
          const source = transaction.objectStore('datasets').count(dataset.id)
          source.onsuccess = () => {
            try {
              if (source.result !== 1) throw new Error('历史数据集在保存期间丢失。原有数据没有被覆盖。')
              if (prior) {
                if (validated.revision !== prior.revision) writeHead()
                else if (annotation) writeMetadata(transaction, validated, annotation, prior, abort)
              } else {
                const existing = transaction.objectStore('sessions').get(validated.id)
                existing.onsuccess = () => {
                  if (existing.result !== undefined) abort(new Error('练习标识已存在，不能覆盖已保存记录。'))
                  else writeHead()
                }
              }
            } catch (error) { abort(error) }
          }
        } catch (error) { abort(error) }
      }
    }, { checkBaseline: true, activate: true })
    baseline = { id: validated.id, revision: validated.revision }
    baselineState = committedState
    verifiedHead = copyPracticeSnapshot(validated)
    pendingMigrationFrames = null
    invalidateArchiveCheckpoint()
  }

  async function saveSimulation(snapshot: SessionSnapshot, annotation?: PendingTradeAnnotation, trainingContextInput?: TrainingContextInput): Promise<void> {
    if (baseline === undefined) throw new Error('请先读取当前练习，再保存数据。')
    const prior = verifiedHead?.id === snapshot.id ? verifiedHead : null
    if (prior && trainingContextInput) throw new Error('训练对照信息只能在新练习创建时记录，不能改写既有标签。')
    const trainingContext = trainingContextInput ? createSessionTrainingContext(snapshot.id, trainingContextInput) : undefined
    if (prior && isHistoricalSnapshot(prior)) throw new Error('练习模式不可原地改变。原有数据没有被覆盖。')
    const previous = prior
    let inheritedCheckpoint = archiveCheckpoint
    if (previous && inheritedCheckpoint) {
      try {
        if (inheritedCheckpoint.sessionId !== previous.id || inheritedCheckpoint.revision !== previous.revision
          || inheritedCheckpoint.epoch !== baselineState?.epoch || inheritedCheckpoint.generation !== baselineState?.generation
          || inheritedCheckpoint.verifiedHeadFingerprint !== await fingerprintRecord(previous)) inheritedCheckpoint = null
      } catch { inheritedCheckpoint = null }
    } else inheritedCheckpoint = null
    const validated = previous ? validateSessionTransition(previous, snapshot) : validateSessionSnapshot(snapshot)
    if (previous && validated.revision === previous.revision && JSON.stringify(validated) !== JSON.stringify(previous)) {
      throw new Error('练习状态发生改变但保存版本未推进。原有数据没有被覆盖。')
    }
    const migration = previous && pendingMigrationFrames !== null
    const appendStart = migration || !previous ? 0 : previous.sourceState.frameIndex + 1
    const appendFrames = migration
      ? [...pendingMigrationFrames!, ...validated.frames.slice(previous!.sourceState.frameIndex + 1 - validated.frameStartIndex)]
      : previous ? validated.frames.slice(appendStart - validated.frameStartIndex) : validated.frames
    const writtenChunks: HistoryChunk[] = []
    const committedState = await writeTransaction(['sessions', 'historyChunks', 'sessionSummaries', 'annotations'], (transaction, abort) => {
      function writeHead(): void {
        transaction.objectStore('sessions').put(validated)
        transaction.objectStore('settings').put({ id: validated.id, revision: validated.revision }, 'current')
        writeMetadata(transaction, validated, annotation, previous, abort, trainingContext)
      }
      function writeHistory(prefix: MarketFrame[]): void {
        let chunkIndex = Math.floor(appendStart / SESSION_FRAME_WINDOW_SIZE)
        let frames = prefix
        for (const frame of appendFrames) {
          frames.push(frame)
          if (frames.length === SESSION_FRAME_WINDOW_SIZE) {
            const chunk = { sessionId: validated.id, chunkIndex, frames }
            transaction.objectStore('historyChunks').put(chunk)
            writtenChunks.push(chunk)
            chunkIndex += 1
            frames = []
          }
        }
        if (frames.length > 0) {
          const chunk = { sessionId: validated.id, chunkIndex, frames }
          transaction.objectStore('historyChunks').put(chunk)
          writtenChunks.push(chunk)
        }
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
          if (previous && validated.revision === previous.revision && !migration) { if (annotation) writeMetadata(transaction, validated, annotation, previous, abort); return }
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
    }, { checkBaseline: true, activate: true })
    baseline = { id: validated.id, revision: validated.revision }
    baselineState = committedState
    verifiedHead = copySessionSnapshot(validated)
    pendingMigrationFrames = null
    invalidateArchiveCheckpoint()
    const scope = archiveScope
    // The transaction is already complete. Optional cache maintenance must not
    // turn a committed trade into a reported save failure.
    if (!migration && (!previous || inheritedCheckpoint)) {
      try {
        const fingerprints = new Map(inheritedCheckpoint?.chunkFingerprints)
        for (const chunk of writtenChunks) fingerprints.set(chunk.chunkIndex, await fingerprintRecord(chunk))
        if (fingerprints.size === Math.ceil((validated.sourceState.frameIndex + 1) / SESSION_FRAME_WINDOW_SIZE)) {
          const checkpoint = await createArchiveCheckpoint(validated, validated, fingerprints, committedState)
          if (previous && validated.revision === previous.revision && inheritedCheckpoint) checkpoint.headFingerprint = inheritedCheckpoint.headFingerprint
          if (scope === archiveScope) archiveCheckpoint = checkpoint
        }
      } catch { /* Keep the committed state; the next range read fully validates. */ }
    }
  }

  async function loadCurrentWithSource(): Promise<LoadedSession | null> {
    const snapshot = await loadCurrent()
    return snapshot ? { snapshot, dataset: snapshot.schemaVersion === 4 ? verifiedDataset : null } : null
  }

  async function loadSessionInternal(id: string): Promise<{ loaded: LoadedSession; migrationFrames: MarketFrame[] | null; state: LibraryState; chunks: HistoryChunk[]; checkpoint: ArchiveCheckpoint | null } | null> {
    const scope = archiveScope
    const initialState = await currentState()
    const database = await openDatabase()
    const raw = await readStored(database, 'sessions', id)
    if (raw === undefined) return null
    try {
      if (!raw || typeof raw !== 'object' || !('id' in raw) || raw.id !== id || !('schemaVersion' in raw)) throw new Error('练习标识或格式损坏。')
      let snapshot: PracticeSnapshot
      let dataset: HistoryDataset | null = null
      let migrationFrames: MarketFrame[] | null = null
      let chunks: HistoryChunk[] = []
      const chunkFingerprints = new Map<number, string>()
      let canCheckpoint = true
      if (raw.schemaVersion === 4) {
        const source = 'sourceState' in raw && raw.sourceState && typeof raw.sourceState === 'object' && 'datasetId' in raw.sourceState ? raw.sourceState : null
        if (!source || typeof source.datasetId !== 'string') throw new Error('历史数据集引用损坏。')
        dataset = await loadDataset(source.datasetId)
        if (!dataset) throw new Error('历史数据集缺失。')
        snapshot = validateHistoricalSnapshot(raw, dataset)
      } else if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
        snapshot = validateSessionSnapshot(raw)
        if (!('frames' in raw) || !Array.isArray(raw.frames)) throw new Error('旧格式练习行情缺失。')
        migrationFrames = structuredClone(raw.frames as MarketFrame[])
      } else {
        const validator = createSessionHistoryValidator(raw)
        const count = (raw as SessionSnapshot).sourceState.frameIndex + 1
        chunks = await readAll<HistoryChunk>('historyChunks', IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
        if (chunks.length !== Math.ceil(count / SESSION_FRAME_WINDOW_SIZE)) throw new Error('归档行情块数量不一致。')
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = parseChunk(chunks[index], id, index, Math.min(SESSION_FRAME_WINDOW_SIZE, count - index * SESSION_FRAME_WINDOW_SIZE))
          await validateArchiveFrames(validator, chunk.frames)
          if (canCheckpoint) {
            try { chunkFingerprints.set(index, await fingerprintRecord(chunk)) }
            catch { canCheckpoint = false; chunkFingerprints.clear() }
          }
        }
        snapshot = validator.finish()
      }
      const finalState = await currentState()
      if (!sameState(initialState, finalState)) throw new Error('另一窗口在读取期间更新了数据库，请重试读取。')
      let checkpoint: ArchiveCheckpoint | null = null
      if (canCheckpoint && snapshot.schemaVersion === 3 && migrationFrames === null) {
        try {
          checkpoint = await createArchiveCheckpoint(raw, snapshot, chunkFingerprints, finalState)
          const pointer = parsePointer(await readStored(database, 'settings', 'current'))
          const verifiedFingerprint = verifiedHead ? await fingerprintRecord(verifiedHead) : null
          if (scope === archiveScope && verifiedHead && samePointer(pointer, { id, revision: snapshot.revision })
            && samePointer(baseline ?? null, pointer) && baselineState?.epoch === finalState.epoch && baselineState.generation === finalState.generation
            && checkpoint.verifiedHeadFingerprint === verifiedFingerprint) archiveCheckpoint = checkpoint
        } catch { checkpoint = null }
      }
      return { loaded: { snapshot: copyPracticeSnapshot(snapshot), dataset }, migrationFrames, state: finalState, chunks, checkpoint }
    } catch (error) { throw new SessionLoadError(error instanceof Error ? error.message : '读取练习失败。', raw) }
  }
  async function loadSession(id: string): Promise<LoadedSession | null> { return (await loadSessionInternal(id))?.loaded ?? null }

  async function activateSession(id: string): Promise<LoadedSession> {
    if (baseline === undefined || !baselineState) throw new Error('请先读取当前练习。')
    invalidateArchiveCheckpoint()
    const target = await loadSessionInternal(id)
    if (!target) throw new Error('选择的练习不存在。')
    const snapshot = target.loaded.snapshot
    const state = await writeTransaction(['sessions', 'datasets'], (transaction, abort) => {
      const request = transaction.objectStore('sessions').get(id)
      request.onsuccess = () => {
        try {
          const current = request.result as { revision?: unknown } | undefined
          if (!current || current.revision !== snapshot.revision) throw new Error('目标练习已更新或删除，请重新读取。')
          const commit = (): void => { transaction.objectStore('settings').put({ id, revision: snapshot.revision }, 'current') }
          if (target.loaded.dataset) {
            const source = transaction.objectStore('datasets').count(target.loaded.dataset.id)
            source.onsuccess = () => { if (source.result !== 1) abort(new Error('目标数据集已删除。')); else commit() }
          } else commit()
        } catch (error) { abort(error) }
      }
    }, { checkBaseline: true, activate: true, expectedState: target.state })
    baseline = { id, revision: snapshot.revision }
    baselineState = state
    verifiedHead = copyPracticeSnapshot(snapshot)
    verifiedDataset = target.loaded.dataset
    pendingMigrationFrames = target.migrationFrames
    if (target.checkpoint) archiveCheckpoint = { ...target.checkpoint, epoch: state.epoch, generation: state.generation }
    return { snapshot: copyPracticeSnapshot(snapshot), dataset: target.loaded.dataset }
  }

  async function getTradeAnnotation(sessionId: string, tradeId: string): Promise<TradeAnnotation | null> {
    const raw = await readStored(await openDatabase(), 'annotations', [sessionId, tradeId])
    return raw === undefined ? null : validateTradeAnnotation(raw)
  }
  async function getTrainingContext(sessionId: string): Promise<SessionTrainingContext | null> {
    const raw = await readStored(await openDatabase(), 'settings', ['training', sessionId])
    if (raw === undefined) return null
    const context = validateSessionTrainingContext(raw)
    if (context.sessionId !== sessionId) throw new Error('训练对照信息与练习标识不一致。')
    return context
  }
  async function listTradeAnnotations(sessionId: string): Promise<TradeAnnotation[]> {
    return (await readAll<unknown>('annotations', IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']))).map(validateTradeAnnotation)
  }
  async function saveTradeAnnotation(sessionId: string, tradeId: string, input: TradeAnnotationInput): Promise<TradeAnnotation> {
    let result: TradeAnnotation | null = null
    await writeTransaction(['sessions', 'annotations'], (transaction, abort) => {
      const session = transaction.objectStore('sessions').get(sessionId)
      session.onsuccess = () => {
        try {
          const snapshot = session.result as PracticeSnapshot | undefined
          if (!snapshot || (snapshot.account.position?.id !== tradeId && !snapshot.trades.some(trade => trade.id === tradeId))) throw new Error('备注关联的交易不存在。')
          const prior = transaction.objectStore('annotations').get([sessionId, tradeId])
          prior.onsuccess = () => {
            try {
              result = reviseTradeAnnotation(sessionId, tradeId, prior.result === undefined ? null : validateTradeAnnotation(prior.result as unknown), input, false)
              transaction.objectStore('annotations').put(result)
            } catch (error) { abort(error) }
          }
        } catch (error) { abort(error) }
      }
    })
    return result!
  }

  async function readCheckpointFrames(sessionId: string, range: { fromTimestampMs?: number; toTimestampMs?: number }): Promise<MarketFrame[] | null> {
    const checkpoint = archiveCheckpoint
    if (!checkpoint || checkpoint.sessionId !== sessionId) return null
    const scope = archiveScope
    const expire = (): null => { if (archiveCheckpoint === checkpoint) invalidateArchiveCheckpoint(); return null }
    try {
      const database = await openDatabase()
      // Still read every archived block. Unrequested older/later corruption must
      // not disappear merely because a chart asks for a small visible range.
      const captured = await new Promise<{ raw: unknown; chunks: HistoryChunk[]; state: LibraryState; pointer: CurrentPointer | null }>((resolve, reject) => {
        const transaction = database.transaction(['sessions', 'historyChunks', 'settings'], 'readonly')
        let raw: unknown
        let chunks: HistoryChunk[] = []
        let state: LibraryState
        let pointer: CurrentPointer | null = null
        let failure: unknown = null
        const head = transaction.objectStore('sessions').get(sessionId)
        head.onsuccess = () => { raw = head.result as unknown }
        const archive = transaction.objectStore('historyChunks').getAll(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]))
        archive.onsuccess = () => { chunks = archive.result as HistoryChunk[] }
        const library = transaction.objectStore('settings').get('library')
        library.onsuccess = () => { try { state = readLibraryState(library.result as unknown) } catch (error) { failure = error; transaction.abort() } }
        const current = transaction.objectStore('settings').get('current')
        current.onsuccess = () => { try { pointer = parsePointer(current.result as unknown) } catch (error) { failure = error; transaction.abort() } }
        transaction.oncomplete = () => resolve({ raw, chunks, state, pointer })
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('读取归档失败。'))
      })
      const pointer = { id: checkpoint.sessionId, revision: checkpoint.revision }
      const expectedCount = Math.ceil(checkpoint.frameCount / SESSION_FRAME_WINDOW_SIZE)
      if (captured.state.epoch !== checkpoint.epoch || captured.state.generation !== checkpoint.generation
        || !samePointer(captured.pointer, pointer) || checkpoint.chunkFingerprints.size !== expectedCount || captured.chunks.length !== expectedCount
        || await fingerprintRecord(captured.raw) !== checkpoint.headFingerprint) return expire()
      const frames: MarketFrame[] = []
      for (let index = 0; index < captured.chunks.length; index += 1) {
        const chunk = parseChunk(captured.chunks[index], sessionId, index, Math.min(SESSION_FRAME_WINDOW_SIZE, checkpoint.frameCount - index * SESSION_FRAME_WINDOW_SIZE))
        if (await fingerprintRecord(chunk) !== checkpoint.chunkFingerprints.get(index)) return expire()
        for (const frame of chunk.frames) {
          const timestampMs = frame.quote.timestampMs
          if (timestampMs <= checkpoint.currentTimestampMs && (range.fromTimestampMs === undefined || timestampMs >= range.fromTimestampMs)
            && (range.toTimestampMs === undefined || timestampMs <= range.toTimestampMs)) frames.push(frame)
        }
      }
      const finalFence = await readCurrentFence(database)
      if (scope !== archiveScope || !sameState(captured.state, finalFence.state) || !samePointer(captured.pointer, finalFence.pointer)) return expire()
      return structuredClone(frames)
    } catch { return expire() }
  }

  async function readSessionFrames(sessionId: string, range: { fromTimestampMs?: number; toTimestampMs?: number } = {}): Promise<MarketFrame[]> {
    const { fromTimestampMs, toTimestampMs } = range
    if ([fromTimestampMs, toTimestampMs].some(time => time !== undefined && (!Number.isSafeInteger(time) || time < 0))
      || (fromTimestampMs !== undefined && toTimestampMs !== undefined && fromTimestampMs > toTimestampMs)) throw new Error('观察时间范围无效。')
    const checkpointFrames = await readCheckpointFrames(sessionId, range)
    if (checkpointFrames !== null) return checkpointFrames
    const target = await loadSessionInternal(sessionId)
    if (!target) throw new Error('练习不存在。')
    const snapshot = target.loaded.snapshot
    let frames: MarketFrame[]
    if (target.loaded.dataset) {
      const start = 'historyStart' in snapshot && snapshot.historyStart && typeof snapshot.historyStart === 'object'
        && 'startFrameIndex' in snapshot.historyStart && 'warmupFrameCount' in snapshot.historyStart
        && typeof snapshot.historyStart.startFrameIndex === 'number' && typeof snapshot.historyStart.warmupFrameCount === 'number'
        ? snapshot.historyStart.startFrameIndex - snapshot.historyStart.warmupFrameCount : 0
      frames = target.loaded.dataset.frames.slice(start, snapshot.sourceState.frameIndex + 1)
    } else frames = target.migrationFrames ?? target.chunks.flatMap(chunk => chunk.frames)
    return structuredClone(frames.filter(frame => (fromTimestampMs === undefined || frame.quote.timestampMs >= fromTimestampMs)
      && (toTimestampMs === undefined || frame.quote.timestampMs <= toTimestampMs) && frame.quote.timestampMs <= snapshot.sourceState.currentTimestampMs))
  }

  async function deleteSession(id: string, expectedRevision: number, protection?: CleanupProtection): Promise<void> {
    if (id === protection?.sessionId) throw new Error('不能删除当前窗口的未保存练习。')
    await writeTransaction(['sessions', 'sessionSummaries', 'historyChunks', 'annotations', 'observations'], (transaction, abort) => {
      const pointer = transaction.objectStore('settings').get('current')
      pointer.onsuccess = () => {
        try {
          if (parsePointer(pointer.result as unknown)?.id === id) throw new Error('请先切换到另一练习，再删除当前练习。')
          const request = transaction.objectStore('sessions').get(id)
          request.onsuccess = () => {
            const snapshot = request.result as { revision?: unknown } | undefined
            if (!snapshot || snapshot.revision !== expectedRevision) { abort(new Error('练习版本已变化或已删除，请刷新列表。')); return }
            transaction.objectStore('sessions').delete(id)
            transaction.objectStore('sessionSummaries').delete(id)
            transaction.objectStore('settings').delete(['training', id])
            transaction.objectStore('historyChunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
            transaction.objectStore('annotations').delete(IDBKeyRange.bound([id, ''], [id, '\uffff']))
            const observations = transaction.objectStore('observations').openCursor()
            observations.onsuccess = () => { const cursor = observations.result; if (cursor) { if ((cursor.value as SessionObservation).sessionId === id) cursor.delete(); cursor.continue() } }
          }
        } catch (error) { abort(error) }
      }
    }, { checkBaseline: protection !== undefined })
  }
  async function deleteDataset(id: string, protection?: CleanupProtection): Promise<void> {
    if (id === protection?.datasetId) throw new Error('此数据集仍被当前窗口的未保存练习引用。')
    await writeTransaction(['sessions', 'datasets', 'datasetSummaries'], (transaction, abort) => {
      const sessions = transaction.objectStore('sessions').openCursor()
      sessions.onsuccess = () => {
        const cursor = sessions.result
        if (!cursor) { transaction.objectStore('datasets').delete(id); transaction.objectStore('datasetSummaries').delete(id); return }
        try {
          const snapshot = cursor.value as PracticeSnapshot
          if (snapshot.schemaVersion === 4 && snapshot.sourceState.datasetId === id) throw new Error('此数据集仍被练习引用，请先删除相关练习。')
          cursor.continue()
        } catch (error) { abort(error) }
      }
    }, { checkBaseline: protection !== undefined })
    if (verifiedDataset?.id === id) verifiedDataset = null
  }

  async function storageHealth(): Promise<StorageHealth> {
    if (typeof navigator === 'undefined' || !navigator.storage) return { usageBytes: null, quotaBytes: null, isPersistent: null }
    const [estimate, persisted] = await Promise.allSettled([navigator.storage.estimate(), navigator.storage.persisted()])
    return { usageBytes: estimate.status === 'fulfilled' ? estimate.value.usage ?? null : null,
      quotaBytes: estimate.status === 'fulfilled' ? estimate.value.quota ?? null : null, isPersistent: persisted.status === 'fulfilled' ? persisted.value : null }
  }
  async function requestPersistentStorage(): Promise<boolean> {
    return typeof navigator !== 'undefined' && navigator.storage?.persist ? navigator.storage.persist() : false
  }
  async function getOnboardingStatus(): Promise<OnboardingStatus | null> {
    const raw = await readStored(await openDatabase(), 'settings', 'onboarding')
    return raw === 'completed' || raw === 'skipped' ? raw : null
  }
  async function setOnboardingStatus(status: OnboardingStatus): Promise<void> {
    if (status !== 'completed' && status !== 'skipped') throw new Error('引导状态无效。')
    await writeTransaction([], transaction => { transaction.objectStore('settings').put(status, 'onboarding') })
  }
  async function listSessionObservations(sessionId: string): Promise<SessionObservation[]> {
    return (await readAll<unknown>('observations')).map(validateSessionObservation).filter(observation => observation.sessionId === sessionId)
  }
  async function recordSessionObservation(sessionId: string, input: { timestampMs: number; frameIndex: number; reason: string }): Promise<SessionObservation> {
    const observation = validateSessionObservation({ ...input, id: crypto.randomUUID(), sessionId, recordedAtMs: Date.now() })
    await writeTransaction(['sessions', 'observations'], (transaction, abort) => {
      const session = transaction.objectStore('sessions').get(sessionId)
      session.onsuccess = () => {
        const snapshot = session.result as PracticeSnapshot | undefined
        if (!snapshot || snapshot.sourceState.frameIndex !== input.frameIndex || snapshot.sourceState.currentTimestampMs !== input.timestampMs
          || baseline?.id !== sessionId) { abort(new Error('练习进度已变化，请按当前报价重新记录观察。')); return }
        transaction.objectStore('observations').add(observation)
      }
    }, { checkBaseline: true })
    return observation
  }

  async function captureLibrary(): Promise<{ backup: PracticeBackup; state: LibraryState }> {
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings', 'historyChunks', 'datasets', 'annotations', 'observations', 'sessionSummaries'], 'readonly')
      const backup: PracticeBackup = { backupFormatVersion: 1, exportedAtMs: Date.now(), currentSessionId: null, sessions: [],
        historyChunks: [], datasets: [], annotations: [], observations: [], trainingContexts: [], sessionTimes: [], onboardingStatus: null }
      let state: LibraryState
      let capturedPointer: CurrentPointer | null = null
      let failure: unknown = null
      const sessions = transaction.objectStore('sessions').getAll()
      sessions.onsuccess = () => { backup.sessions = sessions.result as unknown[] }
      const chunks = transaction.objectStore('historyChunks').getAll()
      chunks.onsuccess = () => { backup.historyChunks = chunks.result as HistoryChunk[] }
      const datasets = transaction.objectStore('datasets').getAll()
      datasets.onsuccess = () => { backup.datasets = datasets.result as HistoryDataset[] }
      const annotations = transaction.objectStore('annotations').getAll()
      annotations.onsuccess = () => { backup.annotations = annotations.result as TradeAnnotation[] }
      const observations = transaction.objectStore('observations').getAll()
      observations.onsuccess = () => { backup.observations = observations.result as SessionObservation[] }
      const trainingContexts = transaction.objectStore('settings').openCursor()
      trainingContexts.onsuccess = () => {
        const cursor = trainingContexts.result
        if (!cursor) return
        try {
          const key = cursor.primaryKey
          if (!Array.isArray(key) || key[0] !== 'training') { cursor.continue(); return }
          const context = validateSessionTrainingContext(cursor.value as unknown)
          if (key.length !== 2 || key[1] !== context.sessionId) throw new Error('训练对照索引与练习标识不一致。')
          backup.trainingContexts.push(context)
          cursor.continue()
        } catch (error) { failure = error; transaction.abort() }
      }
      const summaries = transaction.objectStore('sessionSummaries').getAll()
      summaries.onsuccess = () => { backup.sessionTimes = (summaries.result as unknown[]).map(validateSessionSummary).map(summary => ({ id: summary.id, createdAtMs: summary.createdAtMs, savedAtMs: summary.savedAtMs })) }
      const current = transaction.objectStore('settings').get('current')
      current.onsuccess = () => { try { capturedPointer = parsePointer(current.result as unknown); backup.currentSessionId = capturedPointer?.id ?? null } catch (error) { failure = error; transaction.abort() } }
      const library = transaction.objectStore('settings').get('library')
      library.onsuccess = () => { try { state = readLibraryState(library.result as unknown) } catch (error) { failure = error; transaction.abort() } }
      const onboarding = transaction.objectStore('settings').get('onboarding')
      onboarding.onsuccess = () => { backup.onboardingStatus = onboarding.result === 'completed' || onboarding.result === 'skipped' ? onboarding.result : null }
      transaction.oncomplete = () => {
        if (!capturedPointer && backup.sessions.length) { reject(new Error('数据库包含练习但当前入口缺失，请保留原始数据并恢复入口。')); return }
        if (capturedPointer) {
          const head = backup.sessions.find(raw => raw && typeof raw === 'object' && 'id' in raw && raw.id === capturedPointer!.id)
          if (!head || typeof head !== 'object' || !('revision' in head) || head.revision !== capturedPointer.revision) {
            reject(new Error('当前练习索引与快照不一致，不能导出正常备份；原有数据保留。'))
            return
          }
        }
        backup.sessionTimes = backup.sessionTimes.filter(times => backup.sessions.some(raw => raw && typeof raw === 'object' && 'id' in raw && raw.id === times.id))
        resolve({ backup, state })
      }
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('读取完整备份失败，原有数据保留。'))
    })
  }
  function checkBackupSize(json: string): void {
    if (json.length > BACKUP_MAX_BYTES || new TextEncoder().encode(json).length > BACKUP_MAX_BYTES) throw new Error('备份超过 128 MiB 安全处理上限；没有省略任何数据。')
  }
  async function exportBackupJson(signal?: AbortSignal): Promise<string> {
    checkCancelled(signal)
    const { backup } = await captureLibrary()
    const json = JSON.stringify(backup)
    checkBackupSize(json)
    await validatePracticeBackup(backup, false, signal)
    checkCancelled(signal)
    return json
  }
  async function captureSessionBackup(sessionId: string, candidate?: PracticeSnapshot): Promise<PracticeBackup> {
    const database = await openDatabase()
    return new Promise<PracticeBackup>((resolve, reject) => {
      const transaction = database.transaction(['sessions', 'settings', 'historyChunks', 'datasets', 'annotations', 'observations', 'sessionSummaries'], 'readonly')
      const backup: PracticeBackup = { backupFormatVersion: 1, exportedAtMs: Date.now(), currentSessionId: sessionId,
        sessions: [], historyChunks: [], datasets: [], annotations: [], observations: [], trainingContexts: [], sessionTimes: [], onboardingStatus: null }
      let failure: unknown = null
      const session = transaction.objectStore('sessions').get(sessionId)
      session.onsuccess = () => {
        try {
          if (session.result !== undefined) backup.sessions = [session.result as unknown]
          const snapshot = candidate ?? session.result as PracticeSnapshot | undefined
          if (snapshot?.schemaVersion === 4) {
            const source = transaction.objectStore('datasets').get(snapshot.sourceState.datasetId)
            source.onsuccess = () => { if (source.result !== undefined) backup.datasets = [source.result as HistoryDataset] }
          }
        } catch (error) { failure = error; transaction.abort() }
      }
      const chunks = transaction.objectStore('historyChunks').getAll(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]))
      chunks.onsuccess = () => { backup.historyChunks = chunks.result as HistoryChunk[] }
      const annotations = transaction.objectStore('annotations').getAll(IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']))
      annotations.onsuccess = () => { backup.annotations = annotations.result as TradeAnnotation[] }
      const observations = transaction.objectStore('observations').openCursor()
      observations.onsuccess = () => {
        try {
          const cursor = observations.result
          if (!cursor) return
          const observation = validateSessionObservation(cursor.value as unknown)
          if (observation.sessionId === sessionId) backup.observations.push(observation)
          cursor.continue()
        } catch (error) { failure = error; transaction.abort() }
      }
      const context = transaction.objectStore('settings').get(['training', sessionId])
      context.onsuccess = () => {
        try { if (context.result !== undefined) backup.trainingContexts = [validateSessionTrainingContext(context.result as unknown)] }
        catch (error) { failure = error; transaction.abort() }
      }
      const summary = transaction.objectStore('sessionSummaries').get(sessionId)
      summary.onsuccess = () => {
        try {
          if (summary.result === undefined) return
          const saved = validateSessionSummary(summary.result as unknown)
          if (saved.errorMessage || saved.id !== sessionId) throw new Error('练习摘要损坏，不能导出正常备份；原有数据保留。')
          backup.sessionTimes = [{ id: sessionId, createdAtMs: saved.createdAtMs, savedAtMs: saved.savedAtMs }]
        } catch (error) { failure = error; transaction.abort() }
      }
      transaction.oncomplete = () => resolve(backup)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('读取练习备份材料失败，原有数据保留。'))
    })
  }
  async function exportRecoveryBackupJson(input: RecoveryBackupInput, signal?: AbortSignal): Promise<string> {
    checkCancelled(signal)
    const snapshot = copyPracticeSnapshot(input.snapshot)
    const committed = await captureSessionBackup(snapshot.id, snapshot)
    const backup: PracticeBackup = { ...committed, currentSessionId: snapshot.id, sessions: [snapshot], historyChunks: [],
      datasets: [], annotations: committed.annotations.filter(annotation => annotation.sessionId === snapshot.id
        && (snapshot.account.position?.id === annotation.tradeId || snapshot.trades.some(trade => trade.id === annotation.tradeId))),
      observations: committed.observations.filter(observation => observation.sessionId === snapshot.id
        && observation.frameIndex <= snapshot.sourceState.frameIndex),
      trainingContexts: committed.trainingContexts.filter(context => context.sessionId === snapshot.id),
      sessionTimes: committed.sessionTimes.filter(times => times.id === snapshot.id) }
    if (snapshot.schemaVersion === 4) {
      const dataset = input.dataset?.id === snapshot.sourceState.datasetId ? input.dataset
        : committed.datasets.find(source => source.id === snapshot.sourceState.datasetId)
      if (!dataset) throw new Error('故障备份缺少原始历史数据集；请保留当前窗口和原数据库。')
      backup.datasets = [dataset]
    } else {
      const chunks = new Map<number, HistoryChunk>()
      const frameCount = snapshot.sourceState.frameIndex + 1
      const legacy = committed.sessions.find(raw => raw && typeof raw === 'object' && 'id' in raw && raw.id === snapshot.id
        && 'schemaVersion' in raw && (raw.schemaVersion === 1 || raw.schemaVersion === 2))
      const prefix = legacy && typeof legacy === 'object' && 'frames' in legacy && Array.isArray(legacy.frames) ? legacy.frames as MarketFrame[] : null
      if (prefix) {
        for (let index = 0; index < Math.min(prefix.length, frameCount); index += SESSION_FRAME_WINDOW_SIZE) {
          chunks.set(index / SESSION_FRAME_WINDOW_SIZE, { sessionId: snapshot.id, chunkIndex: index / SESSION_FRAME_WINDOW_SIZE,
            frames: structuredClone(prefix.slice(index, Math.min(index + SESSION_FRAME_WINDOW_SIZE, frameCount))) })
        }
      } else {
        for (const chunk of committed.historyChunks) {
          if (chunk.sessionId === snapshot.id && chunk.chunkIndex * SESSION_FRAME_WINDOW_SIZE < frameCount) {
            chunks.set(chunk.chunkIndex, { ...chunk, frames: chunk.frames.slice(0, frameCount - chunk.chunkIndex * SESSION_FRAME_WINDOW_SIZE) })
          }
        }
      }
      for (let index = 0; index < snapshot.frames.length; index += 1) {
        const frameIndex = snapshot.frameStartIndex + index
        const chunkIndex = Math.floor(frameIndex / SESSION_FRAME_WINDOW_SIZE)
        const chunk = chunks.get(chunkIndex) ?? { sessionId: snapshot.id, chunkIndex, frames: [] }
        chunk.frames[frameIndex % SESSION_FRAME_WINDOW_SIZE] = snapshot.frames[index]!
        chunks.set(chunkIndex, chunk)
        if (index % 128 === 0) { checkCancelled(signal); await yieldToEventLoop() }
      }
      backup.historyChunks = [...chunks.values()].sort((left, right) => left.chunkIndex - right.chunkIndex)
    }
    if (input.annotation) {
      const pending = input.annotation
      const prior = backup.annotations.find(annotation => annotation.tradeId === pending.tradeId) ?? null
      const saved = committed.sessions.find(raw => raw && typeof raw === 'object' && 'id' in raw && raw.id === snapshot.id) as PracticeSnapshot | undefined
      const annotation = reviseTradeAnnotation(snapshot.id, pending.tradeId, prior, pending,
        snapshot.account.position?.id === pending.tradeId && saved?.account.position?.id !== pending.tradeId)
      backup.annotations = [...backup.annotations.filter(item => item.tradeId !== pending.tradeId), annotation]
    }
    if (input.trainingContext) backup.trainingContexts = [createSessionTrainingContext(snapshot.id, input.trainingContext)]
    checkCancelled(signal)
    const json = JSON.stringify(backup)
    checkBackupSize(json)
    await validatePracticeBackup(backup, false, signal)
    checkCancelled(signal)
    return json
  }
  async function exportSessionBackupJson(id: string, signal?: AbortSignal): Promise<string> {
    checkCancelled(signal)
    const backup = await captureSessionBackup(id)
    if (!backup.sessions.length) throw new Error('练习不存在，无法导出备份。')
    const json = JSON.stringify(backup)
    checkBackupSize(json)
    await validatePracticeBackup(backup, false, signal)
    checkCancelled(signal)
    return json
  }
  async function previewBackup(json: string, signal?: AbortSignal): Promise<BackupPreview> {
    const requestGeneration = ++backupRequestGeneration
    pendingBackups.clear()
    const checkRequest = (): void => {
      checkCancelled(signal)
      if (requestGeneration !== backupRequestGeneration) throw new DOMException('此恢复预览已被新的操作替代。', 'AbortError')
    }
    checkRequest()
    checkBackupSize(json)
    let raw: unknown
    try { raw = JSON.parse(json) as unknown } catch { throw new Error('备份不是有效 JSON，原有数据保留。') }
    const backup = await validatePracticeBackup(raw, true, signal)
    checkRequest()
    const captured = await captureLibrary()
    checkRequest()
    const existingIds = new Set(captured.backup.datasets.map(dataset => dataset.id))
    for (const dataset of backup.datasets) {
      checkRequest()
      if (existingIds.has(dataset.id)) {
        try {
          const local = await loadDataset(dataset.id)
          if (!local || local.fingerprint !== dataset.fingerprint) throw new Error('内容不一致。')
        } catch (error) { throw new Error(`本机同标识历史数据已损坏或冲突，不能追加覆盖：${error instanceof Error ? error.message : '校验失败。'}`) }
        checkRequest()
      }
    }
    checkRequest()
    if (!sameState(captured.state, await currentState())) throw new Error('校验期间本机数据库已变化，请重新预览。')
    checkRequest()
    const isEmpty = !captured.backup.sessions.length && !captured.backup.datasets.length && !captured.backup.historyChunks.length
      && !captured.backup.annotations.length && !captured.backup.observations.length && !captured.backup.trainingContexts.length
    const preview: BackupPreview = { id: crypto.randomUUID(), mode: isEmpty ? 'empty' : 'append', sessionCount: backup.sessions.length,
      datasetCount: backup.datasets.length, tradeCount: backup.sessions.reduce((count, snapshot) => count + snapshot.trades.length, 0),
      currentSessionId: backup.currentSessionId, createdAtMs: Date.now() }
    pendingBackups.set(preview.id, { backup, state: captured.state, mode: preview.mode, localCurrentSessionId: captured.backup.currentSessionId })
    return preview
  }
  function discardBackupPreview(id: string): void { pendingBackups.delete(id) }
  async function restoreBackup(preview: BackupPreview, options: { openRestoredSession?: boolean; signal?: AbortSignal } = {}): Promise<RestoreResult> {
    checkCancelled(options.signal)
    const candidate = pendingBackups.get(preview.id)
    if (!candidate) throw new Error('恢复预览已失效，请重新选择备份。')
    const { backup, state, mode } = candidate
    const ids = new Map(backup.sessions.map(snapshot => [snapshot.id, mode === 'append' ? crypto.randomUUID() : snapshot.id]))
    const sessions = backup.sessions.map(snapshot => ({ ...copyPracticeSnapshot(snapshot), id: ids.get(snapshot.id)! }))
    const chunks = backup.historyChunks.map(chunk => ({ ...structuredClone(chunk), sessionId: ids.get(chunk.sessionId)! }))
    const annotations = backup.annotations.map(annotation => ({ ...structuredClone(annotation), sessionId: ids.get(annotation.sessionId)! }))
    const observations = backup.observations.map(observation => ({ ...structuredClone(observation), id: mode === 'append' ? crypto.randomUUID() : observation.id, sessionId: ids.get(observation.sessionId)! }))
    const trainingContexts = backup.trainingContexts.map(context => ({ ...structuredClone(context), sessionId: ids.get(context.sessionId)!,
      sourceSessionId: context.sourceSessionId === null ? null : ids.get(context.sourceSessionId) ?? context.sourceSessionId, isImportedClaim: true }))
    const restoredCurrentId = backup.currentSessionId ? ids.get(backup.currentSessionId)! : null
    const shouldOpen = restoredCurrentId !== null && (mode === 'empty' || options.openRestoredSession === true || candidate.localCurrentSessionId === null)
    let currentSessionId: string | null = null
    const committedState = await writeTransaction(['sessions', 'historyChunks', 'datasets', 'datasetSummaries', 'sessionSummaries', 'annotations', 'observations'], (transaction, abort) => {
      const current = transaction.objectStore('settings').get('current')
      current.onsuccess = () => { try { currentSessionId = shouldOpen ? restoredCurrentId : parsePointer(current.result as unknown)?.id ?? null } catch (error) { abort(error) } }
      for (const snapshot of sessions) {
        transaction.objectStore('sessions').add(snapshot)
        const previousTimes = backup.sessionTimes.find(times => ids.get(times.id) === snapshot.id)
        transaction.objectStore('sessionSummaries').add(createSessionSummary(snapshot, mode === 'append' ? Date.now() : previousTimes?.createdAtMs ?? null, Date.now()))
      }
      for (const chunk of chunks) transaction.objectStore('historyChunks').add(chunk)
      for (const annotation of annotations) transaction.objectStore('annotations').add(annotation)
      for (const observation of observations) transaction.objectStore('observations').add(observation)
      for (const context of trainingContexts) transaction.objectStore('settings').add(context, ['training', context.sessionId])
      for (const dataset of backup.datasets) {
        const request = transaction.objectStore('datasets').count(dataset.id)
        request.onsuccess = () => {
          if (request.result === 0) {
            transaction.objectStore('datasets').add(dataset)
            transaction.objectStore('datasetSummaries').add({ id: dataset.id, summary: validateHistoryDatasetSummary(dataset), errorMessage: null })
          }
        }
      }
      if (shouldOpen && restoredCurrentId) {
        const selected = sessions.find(snapshot => snapshot.id === restoredCurrentId)!
        transaction.objectStore('settings').put({ id: selected.id, revision: selected.revision }, 'current')
      }
      if (mode === 'empty' && backup.onboardingStatus) transaction.objectStore('settings').put(backup.onboardingStatus, 'onboarding')
    }, { expectedState: state, activate: shouldOpen, signal: options.signal })
    pendingBackups.delete(preview.id)
    invalidateArchiveCheckpoint()
    verifiedDataset = null
    let loadedSession: LoadedSession | null = null
    if (shouldOpen && restoredCurrentId) {
      const selected = sessions.find(snapshot => snapshot.id === restoredCurrentId)!
      const dataset = selected.schemaVersion === 4 ? backup.datasets.find(source => source.id === selected.sourceState.datasetId)! : null
      loadedSession = { snapshot: copyPracticeSnapshot(selected), dataset }
      baseline = { id: selected.id, revision: selected.revision }
      baselineState = committedState
      verifiedHead = copyPracticeSnapshot(selected)
      verifiedDataset = dataset
      pendingMigrationFrames = null
    } else if (shouldOpen) { baseline = null; baselineState = committedState; verifiedHead = null; pendingMigrationFrames = null }
    return { sessionIds: [...ids.values()], currentSessionId, loadedSession }
  }

  return {
    loadCurrent, loadCurrentWithSource, loadSession, activateSession, listSessions, importDataset, listDatasets, listDatasetEntries, loadDataset,
    getTradeAnnotation, getTrainingContext, listTradeAnnotations, saveTradeAnnotation, readSessionFrames, deleteSession, deleteDataset,
    storageHealth, requestPersistentStorage, getOnboardingStatus, setOnboardingStatus, listSessionObservations, recordSessionObservation,
    exportBackupJson, exportSessionBackupJson, exportRecoveryBackupJson, previewBackup, discardBackupPreview, restoreBackup,
    save(snapshot, annotation, trainingContext) { return isHistoricalSnapshot(snapshot) ? saveHistorical(snapshot, annotation, trainingContext) : saveSimulation(snapshot, annotation, trainingContext) },
    close() {
      if (databasePromise) void databasePromise.then(database => database.close(), () => undefined)
      databasePromise = null
      baseline = undefined
      verifiedHead = null
      verifiedDataset = null
      pendingMigrationFrames = null
      baselineState = null
      pendingBackups.clear()
      backupRequestGeneration += 1
      invalidateArchiveCheckpoint()
    },
  }
}
