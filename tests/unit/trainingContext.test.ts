import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { createHistoricalSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { createSessionRepository } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { validateSessionTrainingContext } from '../../src/storage/sessionMetadata'
import type { SessionTrainingContext, TrainingContextInput } from '../../src/storage/sessionMetadata'
import { extendSession, makeSession } from './sessionFixture'

const repositories: SessionRepository[] = []
function repository(name = `training-context-${crypto.randomUUID()}`): SessionRepository {
  const created = createSessionRepository(name)
  repositories.push(created)
  return created
}
afterEach(() => { repositories.splice(0).forEach(created => created.close()); vi.restoreAllMocks() })

const SOURCE_FINGERPRINT = 'a'.repeat(64)
const REPEAT_CONTEXT: TrainingContextInput = { kind: 'repeat', sourceSessionId: 'practice-source', sourceFingerprint: SOURCE_FINGERPRINT, ruleVersion: 'nominal-usd-v1;simulation-v2-p1' }
async function createComparison(original: SessionRepository) {
  await original.loadCurrent()
  const source = { ...makeSession(), id: 'practice-source' }
  const repeated = { ...makeSession(), id: 'practice-repeat' }
  await original.save(source)
  await original.save(repeated, undefined, REPEAT_CONTEXT)
  return { source, repeated }
}

describe('atomic and immutable practice comparison context', () => {
  it('creates a native label with its independent practice and preserves the original account', async () => {
    const original = repository()
    const { source, repeated } = await createComparison(original)
    const context = await original.getTrainingContext(repeated.id)
    expect(context).toMatchObject({ ...REPEAT_CONTEXT, sessionId: repeated.id, recordedAtMs: expect.any(Number) })
    expect(context?.isImportedClaim).toBeUndefined()
    expect(await original.getTrainingContext(source.id)).toBeNull()
    expect((await original.loadSession(source.id))?.snapshot).toEqual(source)
    await expect(original.save(repeated, undefined, { ...REPEAT_CONTEXT, kind: 'unseen' })).rejects.toThrow('新练习创建')
    expect(await original.getTrainingContext(repeated.id)).toEqual(context)
    await original.save(extendSession(repeated))
    expect(await original.getTrainingContext(repeated.id)).toEqual(context)
  })

  it('rolls back the new head, archive, context and current entrance together when the context write aborts', async () => {
    const original = repository()
    await original.loadCurrent()
    const source = { ...makeSession(), id: 'practice-source' }
    const repeated = { ...makeSession(), id: 'practice-repeat' }
    await original.save(source)
    const nativeAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = nativeAdd.call(this, input, key)
      if (this.name === 'settings' && Array.isArray(key) && key[0] === 'training') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(original.save(repeated, undefined, REPEAT_CONTEXT)).rejects.toThrow()
    expect(await original.getTrainingContext(repeated.id)).toBeNull()
    expect(await original.loadSession(repeated.id)).toBeNull()
    expect(await original.loadCurrent()).toEqual(source)
    expect((JSON.parse(await original.exportBackupJson()) as { trainingContexts: unknown[] }).trainingContexts).toEqual([])
    vi.restoreAllMocks()
    await original.save(repeated, undefined, REPEAT_CONTEXT)
    expect((await original.getTrainingContext(repeated.id))?.kind).toBe('repeat')
  })

  it('rejects caller-assigned ownership, dates or imported certification on native creation', async () => {
    const original = repository()
    await original.loadCurrent()
    const snapshot = makeSession()
    for (const extra of [{ sessionId: snapshot.id }, { recordedAtMs: 0 }, { isImportedClaim: false }]) {
      await expect(original.save(snapshot, undefined, { ...REPEAT_CONTEXT, ...extra } as TrainingContextInput)).rejects.toThrow('只能包含')
    }
    expect(await original.loadCurrent()).toBeNull()
  })

  it('requires a historical label to name the actual dataset fingerprint', async () => {
    const original = repository()
    await original.loadCurrent()
    const dataset = await parseHistoryCsv('timestamp,open,high,low,close,ask\n2024-03-04T08:01:00Z,1,1,1,1,1.0001', 'EUR/USD')
    await original.importDataset(dataset)
    const snapshot = createHistoricalSnapshot(dataset, 'unseen-history')
    const context: TrainingContextInput = { kind: 'unseen', sourceSessionId: null, sourceFingerprint: dataset.fingerprint, ruleVersion: 'nominal-usd-v1;m1-close' }
    await expect(original.save(snapshot, undefined, { ...context, sourceFingerprint: SOURCE_FINGERPRINT })).rejects.toThrow('指纹')
    await original.save(snapshot, undefined, context)
    expect(await original.getTrainingContext(snapshot.id)).toMatchObject(context)
  })

  it('keeps a repeat declaration when its source is deleted and removes context only with its owner', async () => {
    const original = repository()
    const { source, repeated } = await createComparison(original)
    await original.deleteSession(source.id, source.revision)
    expect((await original.getTrainingContext(repeated.id))?.sourceSessionId).toBe(source.id)
    const json = await original.exportBackupJson()
    const target = repository()
    await target.restoreBackup(await target.previewBackup(json))
    expect(await target.getTrainingContext(repeated.id)).toMatchObject({ kind: 'repeat', sourceSessionId: source.id, isImportedClaim: true })
    await original.save({ ...makeSession(), id: 'practice-other' })
    await original.deleteSession(repeated.id, repeated.revision)
    expect(await original.getTrainingContext(repeated.id)).toBeNull()
    expect((JSON.parse(await original.exportBackupJson()) as { trainingContexts: unknown[] }).trainingContexts).toEqual([])
  })
})

describe('comparison labels in complete backups', () => {
  it('restores every external label as a claim and remaps both ends of package-internal comparisons on append', async () => {
    const original = repository()
    const { source, repeated } = await createComparison(original)
    const json = await original.exportBackupJson()
    const serialized = JSON.parse(json) as { sessions: { id: string }[]; trainingContexts: SessionTrainingContext[] }
    expect(serialized.trainingContexts[0]!.isImportedClaim).toBeUndefined()
    const target = repository()
    await target.restoreBackup(await target.previewBackup(json))
    expect((await target.getTrainingContext(repeated.id))?.isImportedClaim).toBe(true)
    const appended = await target.restoreBackup(await target.previewBackup(json))
    const copiedSourceId = appended.sessionIds[serialized.sessions.findIndex(snapshot => snapshot.id === source.id)]!
    const copiedRepeatId = appended.sessionIds[serialized.sessions.findIndex(snapshot => snapshot.id === repeated.id)]!
    expect(copiedRepeatId).not.toBe(repeated.id)
    expect(copiedSourceId).not.toBe(source.id)
    expect(await target.getTrainingContext(copiedRepeatId)).toMatchObject({ kind: 'repeat', sessionId: copiedRepeatId, sourceSessionId: copiedSourceId, sourceFingerprint: SOURCE_FINGERPRINT, isImportedClaim: true })
    expect((await target.getTrainingContext(repeated.id))?.sourceSessionId).toBe(source.id)
  })

  it('accepts old backups without labels and refuses invalid owners, duplicates and malformed claims before writing', async () => {
    const original = repository()
    const { repeated } = await createComparison(original)
    const json = await original.exportBackupJson()
    const oldBackup = JSON.parse(json) as { trainingContexts?: unknown }
    delete oldBackup.trainingContexts
    const oldTarget = repository()
    await oldTarget.restoreBackup(await oldTarget.previewBackup(JSON.stringify(oldBackup)))
    expect(await oldTarget.getTrainingContext(repeated.id)).toBeNull()
    const invalidTarget = repository()
    const context = (JSON.parse(json) as { trainingContexts: SessionTrainingContext[] }).trainingContexts[0]!
    const invalidCollections = [null, [{ ...context, sessionId: 'missing-owner' }], [context, context], [{ ...context, sourceFingerprint: 'short' }], [{ ...context, ruleVersion: ' ' }], [{ ...context, isImportedClaim: 'yes' }]]
    for (const trainingContexts of invalidCollections) {
      await expect(invalidTarget.previewBackup(JSON.stringify({ ...JSON.parse(json), trainingContexts }))).rejects.toThrow()
    }
    expect(await invalidTarget.listSessions()).toEqual([])
  })

  it('validates source ownership, rule text, timestamp and the true/false claim type without treating a label as proof', () => {
    const context: SessionTrainingContext = { ...REPEAT_CONTEXT, sessionId: 'practice-repeat', recordedAtMs: 0 }
    expect(validateSessionTrainingContext({ ...context, isImportedClaim: false }).isImportedClaim).toBe(false)
    expect(validateSessionTrainingContext({ ...context, isImportedClaim: true }).isImportedClaim).toBe(true)
    for (const changed of [{ kind: 'winner' }, { sourceSessionId: null }, { sourceSessionId: context.sessionId }, { recordedAtMs: -1 }, { ruleVersion: 'x'.repeat(201) }]) {
      expect(() => validateSessionTrainingContext({ ...context, ...changed })).toThrow()
    }
  })

  it('refuses a damaged namespace key instead of silently omitting its label from a complete export', async () => {
    const name = `training-context-damaged-${crypto.randomUUID()}`
    const original = repository(name)
    const { repeated } = await createComparison(original)
    const context = (await original.getTrainingContext(repeated.id))!
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const transaction = database.transaction('settings', 'readwrite')
      transaction.objectStore('settings').put(context, ['training', 5])
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
    } finally { database.close() }
    await expect(original.exportBackupJson()).rejects.toThrow('索引与练习标识')
    expect(await original.getTrainingContext(repeated.id)).toEqual(context)
    expect((await original.loadCurrent())?.id).toBe(repeated.id)
  })
})

describe('import cancellation at the transaction boundary', () => {
  it('aborts dataset and summary writes when a real AbortSignal fires during their requests', async () => {
    const original = repository()
    await original.loadCurrent()
    const snapshot = makeSession()
    await original.save(snapshot)
    const dataset = await parseHistoryCsv('timestamp,open,high,low,close,ask\n2024-03-04T08:01:00Z,1,1,1,1,1.0001', 'EUR/USD')
    const controller = new AbortController()
    const nativeAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, input: unknown, key?: IDBValidKey) {
      const request = nativeAdd.call(this, input, key)
      if (this.name === 'datasets') request.addEventListener('success', () => controller.abort())
      return request
    })
    await expect(original.importDataset(dataset, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(await original.listDatasets()).toEqual([])
    expect(await original.loadDataset(dataset.id)).toBeNull()
    expect(await original.loadCurrent()).toEqual(snapshot)
  })
})
