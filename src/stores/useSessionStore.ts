import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { calculateAccount } from '../engine/account'
import { MoneyDecimal } from '../engine/decimal'
import { closePosition, openPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulation } from '../engine/simulationSource'
import type { CurrencyPair, TradeDirection } from '../engine/types'
import { createSessionRepository, SessionLoadError } from '../storage/sessionRepository'
import type { SessionRepository } from '../storage/sessionRepository'
import { validateSessionSnapshot } from '../storage/sessionSnapshot'
import type { SessionSnapshot } from '../storage/sessionSnapshot'

export type ReplaySpeed = 1 | 5 | 10
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function createSnapshot(pair: CurrencyPair): SessionSnapshot {
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const simulation = createSimulation(pair, random[0]!)
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 0,
    pair,
    sourceState: simulation.state,
    frames: [simulation.frame],
    account: { balanceUsd: '10000', position: null },
    trades: [],
  }
}

export const useSessionStore = defineStore('session', () => {
  const snapshot = shallowRef<SessionSnapshot | null>(null)
  const isPlaying = ref(false)
  const speed = ref<ReplaySpeed>(1)
  const isBusy = ref(false)
  const saveStatus = ref<SaveStatus>('idle')
  const loadStatus = ref<LoadStatus>('idle')
  const errorMessage = ref('')
  const rawRecoveryJson = ref<string | null>(null)
  let repository: SessionRepository = createSessionRepository()
  let timer: ReturnType<typeof setInterval> | null = null
  const isDisposed = ref(false)

  const currentQuote = computed(() => snapshot.value?.frames.at(-1)?.quote ?? null)
  const accountMetrics = computed(() => snapshot.value && currentQuote.value ? calculateAccount(snapshot.value.account, currentQuote.value) : null)
  const isReady = computed(() => loadStatus.value === 'ready' && snapshot.value !== null)
  const canOperate = computed(() => isReady.value && !isBusy.value && saveStatus.value === 'saved' && !isDisposed.value)
  const isEnded = computed(() => snapshot.value !== null && snapshot.value.sourceState.frameIndex >= snapshot.value.sourceState.maxFrames - 1)
  const canAdvance = computed(() => canOperate.value && !isEnded.value && accountMetrics.value !== null && new MoneyDecimal(accountMetrics.value.equityUsd).gt(0))

  function pause(): void {
    isPlaying.value = false
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  async function persist(nextSnapshot: SessionSnapshot): Promise<boolean> {
    snapshot.value = nextSnapshot
    saveStatus.value = 'saving'
    try {
      await repository.save(nextSnapshot)
      saveStatus.value = 'saved'
      return true
    } catch (error) {
      pause()
      saveStatus.value = 'error'
      errorMessage.value = `本地保存失败：${errorText(error)} 未保存的练习仍保留在当前窗口，可重试保存或导出快照。`
      return false
    }
  }

  async function initialize(): Promise<void> {
    if (isBusy.value || loadStatus.value === 'ready' || isDisposed.value) return
    pause()
    isBusy.value = true
    loadStatus.value = 'loading'
    errorMessage.value = ''
    rawRecoveryJson.value = null
    try {
      const raw = await repository.loadCurrent()
      if (raw !== null) {
        try { rawRecoveryJson.value = JSON.stringify(raw, null, 2) } catch { /* A malformed cyclic record cannot be exported as JSON. */ }
        snapshot.value = validateSessionSnapshot(raw)
        saveStatus.value = 'saved'
        rawRecoveryJson.value = null
        if (accountMetrics.value && new MoneyDecimal(accountMetrics.value.equityUsd).lte(0)) {
          errorMessage.value = '训练资金已耗尽，当前练习已暂停。可创建新练习继续。'
        }
      } else {
        await persist(createSnapshot('EUR/USD'))
      }
      loadStatus.value = 'ready'
    } catch (error) {
      if (error instanceof SessionLoadError && error.rawSnapshot !== null) {
        try { rawRecoveryJson.value = JSON.stringify(error.rawSnapshot, null, 2) } catch { /* Preserve the original database when JSON export is unavailable. */ }
      }
      loadStatus.value = 'error'
      saveStatus.value = 'idle'
      errorMessage.value = `读取练习失败：${errorText(error)} ${rawRecoveryJson.value ? '可导出已读取的原始快照。' : '未能读取可导出的原始快照，请保留浏览器数据并重试读取。'}`
    } finally {
      isBusy.value = false
    }
  }

  async function operate(action: (current: SessionSnapshot) => SessionSnapshot): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    isBusy.value = true
    errorMessage.value = ''
    try {
      await persist(action(snapshot.value))
    } catch (error) {
      pause()
      errorMessage.value = errorText(error)
    } finally {
      isBusy.value = false
    }
  }

  async function advance(count: number): Promise<void> {
    if (!canAdvance.value) { if (isEnded.value || (accountMetrics.value && new MoneyDecimal(accountMetrics.value.equityUsd).lte(0))) pause(); return }
    await operate((current) => {
      let nextSnapshot = current
      for (let index = 0; index < count; index += 1) {
        const next = advanceSimulation(nextSnapshot.sourceState)
        if (!next) { pause(); break }
        const closed = settleDepletedAccount(nextSnapshot.account, next.frame.quote)
        nextSnapshot = {
          ...nextSnapshot,
          sourceState: next.state,
          frames: [...nextSnapshot.frames, next.frame],
          account: closed?.account ?? nextSnapshot.account,
          trades: closed ? [...nextSnapshot.trades, closed.trade] : nextSnapshot.trades,
        }
        if (closed) {
          errorMessage.value = '训练权益已耗尽，已按当前报价平仓并暂停。可创建新练习继续。'
          pause()
          break
        }
        if (next.state.frameIndex >= next.state.maxFrames - 1) { pause(); break }
      }
      return { ...nextSnapshot, revision: current.revision + 1 }
    })
  }

  async function next(): Promise<void> {
    pause()
    await advance(1)
  }

  function play(): void {
    if (!canAdvance.value || isPlaying.value) return
    isPlaying.value = true
    timer = setInterval(() => {
      if (isPlaying.value && canOperate.value) void advance(speed.value)
    }, 1000)
  }

  function setSpeed(nextSpeed: ReplaySpeed): void {
    if (nextSpeed === 1 || nextSpeed === 5 || nextSpeed === 10) speed.value = nextSpeed
  }

  async function openTrade(direction: TradeDirection, notionalUsd: string): Promise<void> {
    await operate((current) => ({
      ...current,
      revision: current.revision + 1,
      account: openPosition(current.account, current.frames.at(-1)!.quote, current.pair, direction, notionalUsd, crypto.randomUUID()),
    }))
  }

  async function closeTrade(): Promise<void> {
    await operate((current) => {
      const closed = closePosition(current.account, current.frames.at(-1)!.quote)
      return { ...current, revision: current.revision + 1, account: closed.account, trades: [...current.trades, closed.trade] }
    })
  }

  async function startNewSession(pair: CurrencyPair = snapshot.value?.pair ?? 'EUR/USD'): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    pause()
    isBusy.value = true
    errorMessage.value = ''
    try {
      if (await persist(snapshot.value)) await persist(createSnapshot(pair))
    } catch (error) {
      errorMessage.value = errorText(error)
    } finally {
      isBusy.value = false
    }
  }

  async function switchPair(pair: CurrencyPair): Promise<void> {
    if (snapshot.value?.pair !== pair) await startNewSession(pair)
  }

  async function retrySave(): Promise<void> {
    if (isBusy.value || saveStatus.value !== 'error' || !snapshot.value || isDisposed.value) return
    isBusy.value = true
    errorMessage.value = ''
    try { await persist(snapshot.value) } finally { isBusy.value = false }
  }

  async function retryLoad(): Promise<void> {
    if (loadStatus.value === 'error') await initialize()
  }

  function exportSnapshotJson(): string | null {
    return snapshot.value ? JSON.stringify(snapshot.value, null, 2) : rawRecoveryJson.value
  }

  function dispose(): void {
    pause()
    isDisposed.value = true
    repository.close()
  }

  /** Injection is for isolated storage tests; the production repository is IndexedDB. */
  function setRepositoryForTesting(nextRepository: SessionRepository): void {
    if (loadStatus.value !== 'idle') throw new Error('初始化后不能替换存储。')
    repository.close()
    repository = nextRepository
  }

  return {
    snapshot, currentQuote, accountMetrics, isPlaying, speed, isBusy, isReady, canOperate,
    isEnded, canAdvance, saveStatus, loadStatus, errorMessage, rawRecoveryJson,
    initialize, setSpeed, next, play, pause, openTrade, closeTrade, switchPair,
    startNewSession, retrySave, retryLoad, exportSnapshotJson, dispose, setRepositoryForTesting,
  }
})
