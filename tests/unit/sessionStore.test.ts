import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as execution from '../../src/engine/execution'
import { advanceSimulation } from '../../src/engine/simulationSource'
import { MAX_SIMULATION_TIMESTAMP_MS } from '../../src/engine/simulationParameters'
import { useSessionStore } from '../../src/stores/useSessionStore'
import { SessionLoadError } from '../../src/storage/sessionRepository'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { validateSessionSnapshot, validateSessionTransition, SESSION_FRAME_WINDOW_SIZE } from '../../src/storage/sessionSnapshot'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'
import type { PracticeSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { extendSession, makeLegacySession, makeSession } from './sessionFixture'

function memoryRepository(initial: unknown | null = null) {
  let saved: unknown | null = initial
  let verified: SessionSnapshot | null = null
  let rejectNextSave = false
  const repository: SessionRepository = {
    loadCurrent: vi.fn(async () => {
      if (saved === null) return null
      if (verified) return structuredClone(verified)
      try {
        verified = validateSessionSnapshot(saved)
        return structuredClone(verified)
      } catch (error) {
        throw new SessionLoadError(error instanceof Error ? error.message : '读取失败', structuredClone(saved))
      }
    }),
    save: vi.fn(async (snapshot: SessionSnapshot) => {
      if (rejectNextSave) { rejectNextSave = false; throw new Error('QuotaExceededError') }
      verified = verified?.id === snapshot.id
        ? validateSessionTransition(verified, snapshot)
        : validateSessionSnapshot(snapshot)
      saved = structuredClone(verified)
    }),
    close: vi.fn(),
    importDataset: vi.fn(async () => { throw new Error('本测试仓库仅提供模拟练习。') }),
    listDatasets: vi.fn(async () => []),
    loadDataset: vi.fn(async () => null),
    loadCurrentWithSource: vi.fn(async () => {
      const snapshot = await repository.loadCurrent()
      return snapshot ? { snapshot, dataset: null } : null
    }),
    loadSession: vi.fn(async () => null),
    activateSession: vi.fn(async () => { throw new Error('本测试不提供会话列表。') }),
    listSessions: vi.fn(async () => []),
    listDatasetEntries: vi.fn(async () => []),
    exportBackupJson: vi.fn(async () => { throw new Error('本测试不提供完整备份。') }),
    previewBackup: vi.fn(async () => { throw new Error('本测试不提供备份恢复。') }),
    discardBackupPreview: vi.fn(),
    restoreBackup: vi.fn(async () => { throw new Error('本测试不提供备份恢复。') }),
    deleteSession: vi.fn(async () => { throw new Error('本测试不提供删除。') }),
    deleteDataset: vi.fn(async () => { throw new Error('本测试不提供删除。') }),
    getTradeAnnotation: vi.fn(async () => null),
    listTradeAnnotations: vi.fn(async () => []),
    saveTradeAnnotation: vi.fn(async () => { throw new Error('本测试不提供备注。') }),
    readSessionFrames: vi.fn(async () => verified?.frames ?? []),
    storageHealth: vi.fn(async () => ({ usageBytes: null, quotaBytes: null, isPersistent: null })),
    requestPersistentStorage: vi.fn(async () => false),
    getOnboardingStatus: vi.fn(async () => null),
    getTrainingContext: vi.fn(async () => null),
    setOnboardingStatus: vi.fn(async () => {}),
    listSessionObservations: vi.fn(async () => []),
    recordSessionObservation: vi.fn(async () => { throw new Error('本测试不提供观察备注。') }),
  }
  return { repository, failSave: () => { rejectNextSave = true }, read: () => saved }
}

let store: ReturnType<typeof useSessionStore>
function simulationOnly(snapshot: PracticeSnapshot | null): SessionSnapshot {
  if (snapshot?.schemaVersion !== 3) throw new Error('预期模拟练习。')
  return snapshot
}
beforeEach(() => {
  setActivePinia(createPinia())
  store = useSessionStore()
})
afterEach(() => { store.dispose(); vi.useRealTimers() })

describe('session store', () => {
  it('starts a saved, paused EUR/USD practice exposing only its first completed minute', async () => {
    const memory = memoryRepository()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.snapshot?.pair).toBe('EUR/USD')
    expect(store.snapshot?.frames).toHaveLength(1)
    expect(store.snapshot?.sourceState.maxFrames).toBeNull()
    expect(store.accountMetrics?.balanceUsd).toBe('10000.00')
    expect(store.isPlaying).toBe(false)
    expect(store.isReady).toBe(true)
    expect(store.canOperate).toBe(true)
    expect(store.saveStatus).toBe('saved')
  })

  it('restores an open position and exact random continuation while remaining paused', async () => {
    const memory = memoryRepository()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('short', '1000')
    await store.next()
    const previous = structuredClone(store.snapshot)
    store.dispose()
    setActivePinia(createPinia())
    store = useSessionStore()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.snapshot).toEqual(previous)
    expect(store.isPlaying).toBe(false)
    const expected = advanceSimulation(simulationOnly(previous).sourceState)
    await store.next()
    expect(store.currentQuote).toEqual(expected!.frame.quote)
    expect(store.snapshot?.sourceState).toEqual(expected!.state)
  })

  it('holds a failed close in memory, blocks further operations and retries without duplicate settlement', async () => {
    const memory = memoryRepository()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('long', '1000')
    memory.failSave()
    await store.closeTrade()
    const pending = structuredClone(store.snapshot)
    expect(store.saveStatus).toBe('error')
    expect(store.isPlaying).toBe(false)
    expect(store.canOperate).toBe(false)
    expect(store.snapshot?.trades).toHaveLength(1)
    expect((memory.read() as SessionSnapshot).account.position).not.toBeNull()
    await store.closeTrade()
    await store.next()
    expect(store.snapshot).toEqual(pending)
    expect(JSON.parse(store.exportSnapshotJson()!)).toEqual(pending)
    await store.retrySave()
    expect(store.saveStatus).toBe('saved')
    expect(store.snapshot).toEqual(pending)
    expect(memory.read()).toEqual(pending)
  })

  it('disables concurrent trading before the first save resolves', async () => {
    const memory = memoryRepository()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    let resolveSave: (() => void) | undefined
    vi.mocked(memory.repository.save).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve }))
    const opening = store.openTrade('long', '1000')
    await store.openTrade('short', '500')
    await store.closeTrade()
    await store.next()
    expect(store.isBusy).toBe(true)
    expect(store.snapshot?.account.position?.direction).toBe('long')
    expect(store.snapshot?.frames).toHaveLength(1)
    resolveSave!()
    await opening
    expect(store.isBusy).toBe(false)
    expect(memory.repository.save).toHaveBeenCalledTimes(2)
  })

  it('preserves a malformed loaded record for export and does not replace it with a new practice', async () => {
    const damaged = { schemaVersion: 99, secret: '原始练习记录' }
    const memory = memoryRepository(damaged)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.loadStatus).toBe('error')
    expect(store.snapshot).toBeNull()
    expect(JSON.parse(store.exportSnapshotJson()!)).toEqual(damaged)
    expect(memory.repository.save).not.toHaveBeenCalled()
    await store.retryLoad()
    expect(store.loadStatus).toBe('error')
    expect(memory.read()).toEqual(damaged)
  })

  it('plays at the selected speed, ends paused, allows closing at the final quote and cleans timers', async () => {
    vi.useFakeTimers()
    const memory = memoryRepository(makeSession('EUR/USD', 8))
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('long', '1000')
    store.setSpeed(5)
    store.play()
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.snapshot?.frames).toHaveLength(6)
    store.pause()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.snapshot?.frames).toHaveLength(6)
    store.setSpeed(10)
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.snapshot?.frames).toHaveLength(8)
    expect(store.isPlaying).toBe(false)
    expect(store.isEnded).toBe(true)
    expect(store.canAdvance).toBe(false)
    await store.closeTrade()
    expect(store.snapshot?.trades).toHaveLength(1)
    store.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(store.canOperate).toBe(false)
  })

  it('keeps the old practice before switching to an independent balance and stops the old timer', async () => {
    vi.useFakeTimers()
    const memory = memoryRepository()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('long', '1000')
    const previousId = store.snapshot!.id
    store.play()
    await store.switchPair('GBP/USD')
    expect(store.snapshot?.id).not.toBe(previousId)
    expect(store.snapshot?.pair).toBe('GBP/USD')
    expect(store.snapshot?.account).toEqual({ balanceUsd: '10000', position: null })
    expect(store.isPlaying).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const calls = vi.mocked(memory.repository.save).mock.calls
    expect(calls.at(-2)![0].id).toBe(previousId)
    expect(calls.at(-2)![0].account.position).not.toBeNull()
  })

  it('checks every intermediate accelerated frame and stops at the first depletion frame', async () => {
    vi.useFakeTimers()
    const initial = makeSession('EUR/USD', 20)
    const memory = memoryRepository(initial)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('long', '1000')
    // Inject an extreme loss result to isolate orchestration from the engine's separately tested calculations.
    const checkedTimes: number[] = []
    vi.spyOn(execution, 'settleDepletedAccount').mockImplementation((account, quote) => {
      checkedTimes.push(quote.timestampMs)
      if (quote.timestampMs !== initial.frames[0]!.quote.timestampMs + 120_000) return null
      return {
        account: { balanceUsd: '-1.00', position: null },
        trade: {
          ...account.position!,
          closedAtMs: quote.timestampMs,
          exitPrice: quote.bidPrice,
          realizedPnlUsd: '-10001.00',
          reason: 'equity-depleted',
        },
      }
    })
    vi.mocked(memory.repository.save).mockResolvedValue(undefined)
    store.setSpeed(10)
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    expect(checkedTimes).toEqual([
      initial.frames[0]!.quote.timestampMs + 60_000,
      initial.frames[0]!.quote.timestampMs + 120_000,
    ])
    expect(store.snapshot?.frames).toHaveLength(3)
    expect(store.snapshot?.trades).toHaveLength(1)
    expect(store.accountMetrics?.balanceUsd).toBe('-1.00')
    expect(store.isPlaying).toBe(false)
    expect(store.saveStatus).toBe('saved')
    expect(store.errorMessage).toContain('训练权益已耗尽')
    expect(store.canAdvance).toBe(false)
    await store.next()
    expect(store.snapshot?.frames).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('migrates an existing practice in memory, preserves its trades and position, and saves only the next operation', async () => {
    const legacy = makeLegacySession()
    const memory = memoryRepository(legacy)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.snapshot).toMatchObject({ schemaVersion: 3, frameStartIndex: 0, frames: legacy.frames, account: legacy.account, trades: legacy.trades })
    expect(store.snapshot?.sourceState).toMatchObject({ version: 2, originFrameIndex: 4, frameIndex: 3 })
    expect(store.isPlaying).toBe(false)
    expect(store.scenario).toBe('standard')
    expect(memory.read()).toEqual(legacy)
    expect(memory.repository.save).not.toHaveBeenCalled()
    const expected = advanceSimulation(simulationOnly(store.snapshot).sourceState)!
    await store.next()
    expect(store.snapshot?.sourceState).toEqual(expected.state)
    expect(store.snapshot?.revision).toBe(legacy.revision + 1)
    expect(store.snapshot?.frames.slice(0, 4)).toEqual(legacy.frames)
    expect(memory.read()).toEqual(store.snapshot)
    const saved = structuredClone(store.snapshot)
    store.dispose()
    setActivePinia(createPinia())
    store = useSessionStore()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.snapshot).toEqual(saved)
    expect(store.isPlaying).toBe(false)
    await store.next()
    expect(store.snapshot?.sourceState).toEqual(advanceSimulation(simulationOnly(saved).sourceState)!.state)
  })

  it('keeps a damaged old practice intact and available for export instead of replacing it', async () => {
    const legacy = makeLegacySession()
    legacy.frames[1]!.lowPrice = '2'
    const memory = memoryRepository(legacy)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.loadStatus).toBe('error')
    expect(store.snapshot).toBeNull()
    expect(JSON.parse(store.exportSnapshotJson()!)).toEqual(legacy)
    expect(memory.read()).toEqual(legacy)
    expect(memory.repository.save).not.toHaveBeenCalled()
  })

  it('retains the saved old practice if its first new-model advance cannot be stored', async () => {
    const legacy = makeLegacySession()
    const memory = memoryRepository(legacy)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    memory.failSave()
    await store.next()
    const candidate = structuredClone(store.snapshot)
    expect(store.saveStatus).toBe('error')
    expect(memory.read()).toEqual(legacy)
    await store.retrySave()
    expect(store.snapshot).toEqual(candidate)
    expect(memory.read()).toEqual(candidate)
    expect(store.snapshot?.frames).toHaveLength(5)
    expect(store.snapshot?.trades).toEqual(legacy.trades)
  })

  it('changes scenario by starting an independent practice and retains that scenario when changing pairs', async () => {
    const memory = memoryRepository(makeSession())
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    await store.openTrade('long', '1000')
    const previous = structuredClone(store.snapshot)!
    await store.startNewSession('EUR/USD', 'eventful')
    expect(store.scenario).toBe('eventful')
    expect(store.snapshot?.id).not.toBe(previous.id)
    expect(store.snapshot?.account.position).toBeNull()
    expect(store.snapshot?.frames).toHaveLength(1)
    expect(vi.mocked(memory.repository.save).mock.calls.at(-2)![0]).toEqual(previous)
    await store.switchPair('GBP/USD')
    expect(store.scenario).toBe('eventful')
    expect(store.snapshot?.pair).toBe('GBP/USD')
    expect(store.isPlaying).toBe(false)
  })

  it('saves an event and its price in one candidate and retries without drawing another event', async () => {
    let initial = makeSession('EUR/USD', 1440, 'eventful', Date.UTC(2024, 2, 4, 7, 55))
    let eventStep = advanceSimulation(initial.sourceState)!
    while (eventStep.state.lastEvent?.id === initial.sourceState.lastEvent?.id) {
      initial = extendSession(initial)
      const next = advanceSimulation(initial.sourceState)
      if (!next) throw new Error('eventful fixture did not produce an event')
      eventStep = next
    }
    const memory = memoryRepository(initial)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    memory.failSave()
    await store.next()
    const candidate = structuredClone(store.snapshot)!
    expect(candidate.sourceState).toEqual(eventStep.state)
    expect(candidate.frames.at(-1)).toEqual(eventStep.frame)
    expect(store.lastEvent).toEqual(eventStep.state.lastEvent)
    expect(memory.read()).toEqual(initial)
    await store.next()
    expect(store.snapshot).toEqual(candidate)
    await store.retrySave()
    expect(store.snapshot).toEqual(candidate)
    expect(memory.read()).toEqual(candidate)
    expect(memory.repository.save).toHaveBeenCalledTimes(2)
  })

  it.each([1, 5, 10] as const)('advances the same ten source steps at replay speed %s', async (speed) => {
    vi.useFakeTimers()
    const initial = makeSession('EUR/USD', 30, 'eventful')
    const memory = memoryRepository(initial)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    store.setSpeed(speed)
    store.play()
    await vi.advanceTimersByTimeAsync(10_000 / speed)
    store.pause()
    const expected = extendSession(initial, 10)
    expect(store.snapshot?.sourceState).toEqual(expected.sourceState)
    expect(store.snapshot?.frames).toEqual(expected.frames)
  })

  it('continues past 1440 frames with a bounded window and restores the same next quote', async () => {
    vi.useFakeTimers()
    const initial = extendSession(makeSession('EUR/USD', null), 1438)
    const memory = memoryRepository(initial)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    store.setSpeed(10)
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    store.pause()
    const expected = extendSession(initial, 10)
    expect(store.progressedFrameCount).toBe(1449)
    expect(store.snapshot?.frames).toHaveLength(SESSION_FRAME_WINDOW_SIZE)
    expect(store.snapshot?.frameStartIndex).toBe(9)
    expect(store.snapshot?.sourceState).toEqual(expected.sourceState)
    expect(store.isEnded).toBe(false)
    expect(store.canAdvance).toBe(true)
    const previous = structuredClone(store.snapshot)!
    store.dispose()
    setActivePinia(createPinia())
    store = useSessionStore()
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    expect(store.isPlaying).toBe(false)
    expect(store.snapshot).toEqual(previous)
    await store.next()
    expect(store.currentQuote).toEqual(advanceSimulation(simulationOnly(previous).sourceState)!.frame.quote)
  })

  it('excludes the previous seed when a new practice random draw repeats it', async () => {
    const memory = memoryRepository(makeSession())
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    const previous = simulationOnly(store.snapshot).sourceState.seed
    vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((array) => {
      if (array instanceof Uint32Array) array[0] = previous
      return array
    })
    await store.startNewSession()
    expect(simulationOnly(store.snapshot).sourceState.seed).not.toBe(previous)
    expect(store.snapshot?.sourceState.maxFrames).toBeNull()
    expect(store.progressedFrameCount).toBe(1)
  })

  it('saves the last supported minute and pauses even when a speed batch exceeds the calendar edge', async () => {
    vi.useFakeTimers()
    const initial = makeSession('EUR/USD', null, 'standard', MAX_SIMULATION_TIMESTAMP_MS - 120_000)
    const memory = memoryRepository(initial)
    store.setRepositoryForTesting(memory.repository)
    await store.initialize()
    store.setSpeed(10)
    store.play()
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.progressedFrameCount).toBe(3)
    expect(store.currentQuote?.timestampMs).toBe(MAX_SIMULATION_TIMESTAMP_MS)
    expect(store.saveStatus).toBe('saved')
    expect(store.isPlaying).toBe(false)
    expect(store.isCalendarEnded).toBe(true)
    expect(store.canAdvance).toBe(false)
    expect(memory.read()).toEqual(store.snapshot)
  })
})
