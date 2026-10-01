import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as execution from '../../src/engine/execution'
import { advanceSimulation } from '../../src/engine/simulationSource'
import { useSessionStore } from '../../src/stores/useSessionStore'
import type { SessionRepository } from '../../src/storage/sessionRepository'
import { validateSessionSnapshot } from '../../src/storage/sessionSnapshot'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'
import { makeSession } from './sessionFixture'

function memoryRepository(initial: unknown | null = null) {
  let saved: unknown | null = initial
  let rejectNextSave = false
  const repository: SessionRepository = {
    loadCurrent: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (snapshot: SessionSnapshot) => {
      if (rejectNextSave) { rejectNextSave = false; throw new Error('QuotaExceededError') }
      saved = structuredClone(validateSessionSnapshot(snapshot))
    }),
    close: vi.fn(),
  }
  return { repository, failSave: () => { rejectNextSave = true }, read: () => saved }
}

let store: ReturnType<typeof useSessionStore>
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
    const expected = advanceSimulation(previous!.sourceState)
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
})
