import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionRepository } from '../../src/storage/sessionRepository'
import { useSessionStore } from '../../src/stores/useSessionStore'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { advanceSimulation } from '../../src/engine/simulationSource'

const stores: ReturnType<typeof useSessionStore>[] = []
async function fixture() {
  setActivePinia(createPinia())
  const repository = createSessionRepository(`comparison-${crypto.randomUUID()}`)
  const store = useSessionStore()
  store.setRepositoryForTesting(repository)
  stores.push(store)
  await store.initialize()
  return { store, repository }
}
async function history(store: ReturnType<typeof useSessionStore>) {
  const rows = Array.from({ length: 8 }, (_, index) => {
    const timestamp = new Date(Date.UTC(2024, 2, 4, 8, index + 1)).toISOString()
    return `${timestamp},1.1,1.1,1.1,1.1,1.1001`
  })
  const dataset = await parseHistoryCsv(['timestamp,open,high,low,close,ask', ...rows].join('\n'), 'EUR/USD')
  await store.importHistoryDataset(dataset)
  return dataset
}
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.restoreAllMocks() })

describe('training comparison coordination', () => {
  it('repeats a deterministic simulation while preserving the original position, progress and next price', async () => {
    const { store, repository } = await fixture()
    const first = structuredClone(store.snapshot)!
    await store.openTrade('short', '1000')
    await store.next()
    const original = structuredClone(store.snapshot)!
    expect(await store.repeatCurrentPractice()).toBe(true)
    expect(store.snapshot!.id).not.toBe(original.id)
    expect(store.snapshot!.frames[0]).toEqual(first.frames[0])
    expect(store.snapshot!.account.position).toBeNull()
    expect(store.trainingContext?.kind).toBe('repeat')
    expect(store.trainingContext?.sourceSessionId).toBe(original.id)
    expect((await repository.loadSession(original.id))!.snapshot).toEqual(original)
    if (first.schemaVersion !== 3) throw new Error('simulation fixture required')
    const next = advanceSimulation(first.sourceState)!
    await store.next()
    expect(store.currentQuote).toEqual(next.frame.quote)
    expect(store.isPlaying).toBe(false)
  })

  it('repeats a history practice at its original start and warmup with an independent account', async () => {
    const { store, repository } = await fixture()
    const dataset = await history(store)
    await store.startHistorySession(dataset.id, { startTimestampMs: dataset.frames[2]!.quote.timestampMs, warmupFrameCount: 2 })
    const first = structuredClone(store.snapshot)!
    await store.openTrade('long', '500')
    await store.next()
    const original = structuredClone(store.snapshot)!
    expect(await store.repeatCurrentPractice()).toBe(true)
    expect(store.snapshot!.frames).toEqual(first.frames)
    expect(store.snapshot!.sourceState).toEqual(first.sourceState)
    expect(store.progressedFrameCount).toBe(1)
    expect(store.trainingContext?.sourceFingerprint).toBe(dataset.fingerprint)
    expect((await repository.loadSession(original.id))!.snapshot.account).toEqual(original.account)
  })

  it('chooses a local unseen start beyond all saved progress rather than beyond the current practice only', async () => {
    const { store, repository } = await fixture()
    const dataset = await history(store)
    await store.startHistorySession(dataset.id)
    const progressedId = store.snapshot!.id
    for (let index = 0; index < 5; index++) await store.next()
    await store.startHistorySession(dataset.id)
    expect(store.snapshot!.sourceState.frameIndex).toBe(0)
    expect(await store.startUnseenHistoryPractice()).toBe(true)
    expect(store.snapshot!.sourceState.frameIndex).toBe(6)
    expect(store.progressedFrameCount).toBe(1)
    expect(store.trainingContext?.kind).toBe('unseen')
    expect((await repository.loadSession(progressedId))!.snapshot.sourceState.frameIndex).toBe(5)
    await store.next()
    const before = structuredClone(store.snapshot)!
    const count = (await repository.listSessions()).length
    expect(await store.startUnseenHistoryPractice()).toBe(false)
    expect(store.snapshot).toEqual(before)
    expect((await repository.listSessions()).length).toBe(count)
    expect(store.libraryErrorMessage).toContain('已没有')
  })

  it('does not classify a committed comparison as a failed save when reading its label fails', async () => {
    const { store, repository } = await fixture()
    vi.spyOn(repository, 'getTrainingContext').mockRejectedValueOnce(new Error('metadata read unavailable'))
    expect(await store.repeatCurrentPractice()).toBe(true)
    expect(store.saveStatus).toBe('saved')
    expect(store.libraryErrorMessage).toContain('标记已保存')
    expect((await repository.loadCurrent())!.id).toBe(store.snapshot!.id)
    expect(await store.refreshCurrentMetadata()).toBe(true)
    expect(store.trainingContext?.kind).toBe('repeat')
  })

  it('keeps account readiness when only the onboarding preference cannot be read', async () => {
    setActivePinia(createPinia())
    const repository = createSessionRepository(`guide-${crypto.randomUUID()}`)
    vi.spyOn(repository, 'getOnboardingStatus').mockRejectedValueOnce(new Error('preference read unavailable'))
    const store = useSessionStore()
    store.setRepositoryForTesting(repository)
    stores.push(store)
    await store.initialize()
    expect(store.isReady).toBe(true)
    expect(store.saveStatus).toBe('saved')
    expect(store.canOperate).toBe(true)
    expect(store.libraryErrorMessage).toContain('练习已正常恢复')
  })
})
