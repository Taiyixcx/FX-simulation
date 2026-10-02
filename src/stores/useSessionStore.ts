import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { calculateAccount } from '../engine/account'
import { MoneyDecimal } from '../engine/decimal'
import { closePosition, openPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulation } from '../engine/simulationSource'
import { advanceHistory } from '../engine/historySource'
import type { HistoryDataset, HistoryDatasetSummary } from '../engine/historyTypes'
import { MAX_SIMULATION_TIMESTAMP_MS, nextSimulationTimestamp } from '../engine/simulationParameters'
import type { CurrencyPair, SimulationScenario, TradeDirection } from '../engine/types'
import { createSessionRepository, SessionLoadError } from '../storage/sessionRepository'
import type { SessionRepository } from '../storage/sessionRepository'
import { createSimulationConfig, SESSION_FRAME_WINDOW_SIZE } from '../storage/sessionSnapshot'
import type { SessionSnapshot } from '../storage/sessionSnapshot'
import { createHistoricalSnapshot } from '../storage/historicalSessionSnapshot'
import type { PracticeSnapshot } from '../storage/historicalSessionSnapshot'

export type ReplaySpeed = 1 | 5 | 10
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function createSnapshot(pair: CurrencyPair, scenario: SimulationScenario = 'standard', previousSeed?: number): SessionSnapshot {
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  // Excluding the last seed keeps adjacent practices distinct even if a draw repeats.
  const seed = random[0] === previousSeed ? (random[0]! ^ 0x9e3779b9) >>> 0 : random[0]!
  const simulation = createSimulation(pair, seed, { scenario, maxFrames: null })
  return {
    schemaVersion: 3,
    retainedPrefixKind: null,
    id: crypto.randomUUID(),
    revision: 0,
    pair,
    frameStartIndex: 0,
    simulationConfig: createSimulationConfig(simulation.state),
    sourceState: simulation.state,
    frames: [simulation.frame],
    account: { balanceUsd: '10000', position: null },
    trades: [],
  }
}

export const useSessionStore = defineStore('session', () => {
  const snapshot = shallowRef<PracticeSnapshot | null>(null)
  const historyDatasets = shallowRef<HistoryDatasetSummary[]>([])
  const historyErrorMessage = ref('')
  let activeHistoryDataset: HistoryDataset | null = null
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
  const isHistorical = computed(() => snapshot.value?.schemaVersion === 4)
  const scenario = computed(() => snapshot.value?.schemaVersion === 3 ? snapshot.value.sourceState.scenario : 'standard')
  const lastEvent = computed(() => snapshot.value?.schemaVersion === 3 ? snapshot.value.sourceState.lastEvent : null)
  const upcomingEvent = computed(() => snapshot.value?.schemaVersion === 3 ? snapshot.value.sourceState.upcomingScheduledEvent : null)
  const historyMetadata = computed(() => {
    const current = snapshot.value
    return current?.schemaVersion === 4
      ? historyDatasets.value.find(dataset => dataset.id === current.sourceState.datasetId)?.metadata ?? null : null
  })
  const currentGapMinutes = computed(() => {
    if (!isHistorical.value || !snapshot.value || snapshot.value.frames.length < 2) return 0
    const frames = snapshot.value.frames
    return (frames.at(-1)!.quote.timestampMs - frames.at(-2)!.quote.timestampMs) / 60_000
  })
  const accountMetrics = computed(() => snapshot.value && currentQuote.value ? calculateAccount(snapshot.value.account, currentQuote.value) : null)
  const isReady = computed(() => loadStatus.value === 'ready' && snapshot.value !== null)
  const canOperate = computed(() => isReady.value && !isBusy.value && saveStatus.value === 'saved' && !isDisposed.value)
  const isCalendarEnded = computed(() => snapshot.value?.schemaVersion === 3 && nextSimulationTimestamp(snapshot.value.sourceState.currentTimestampMs) > MAX_SIMULATION_TIMESTAMP_MS)
  const isEnded = computed(() => isCalendarEnded.value || (snapshot.value !== null && snapshot.value.sourceState.maxFrames !== null && snapshot.value.sourceState.frameIndex >= snapshot.value.sourceState.maxFrames - 1))
  const progressedFrameCount = computed(() => (snapshot.value?.sourceState.frameIndex ?? -1) + 1)
  const canAdvance = computed(() => canOperate.value && !isEnded.value && accountMetrics.value !== null && new MoneyDecimal(accountMetrics.value.equityUsd).gt(0))

  function pause(): void {
    isPlaying.value = false
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  async function persist(nextSnapshot: PracticeSnapshot): Promise<boolean> {
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
        if (raw.schemaVersion === 4) {
          activeHistoryDataset = await repository.loadDataset(raw.sourceState.datasetId)
          if (!activeHistoryDataset) throw new Error('历史数据集缺失，请保留浏览器数据。')
        }
        snapshot.value = raw
        saveStatus.value = 'saved'
        rawRecoveryJson.value = null
        if (accountMetrics.value && new MoneyDecimal(accountMetrics.value.equityUsd).lte(0)) {
          errorMessage.value = '训练资金已耗尽，当前练习已暂停。可创建新练习继续。'
        }
      } else {
        await persist(createSnapshot('EUR/USD'))
      }
      loadStatus.value = 'ready'
      await refreshHistoryDatasets()
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

  async function operate(action: (current: PracticeSnapshot) => PracticeSnapshot): Promise<void> {
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
        let advanced: PracticeSnapshot
        if (nextSnapshot.schemaVersion === 4) {
          if (!activeHistoryDataset || activeHistoryDataset.id !== nextSnapshot.sourceState.datasetId) throw new Error('历史数据集尚未就绪。')
          const next = advanceHistory(nextSnapshot.sourceState, activeHistoryDataset)
          if (!next) { pause(); break }
          advanced = { ...nextSnapshot, sourceState: next.state }
          advanced.frames = [...nextSnapshot.frames, next.frame].slice(-SESSION_FRAME_WINDOW_SIZE)
        } else {
          const next = advanceSimulation(nextSnapshot.sourceState)
          if (!next) { pause(); break }
          advanced = { ...nextSnapshot, sourceState: next.state }
          advanced.frames = [...nextSnapshot.frames, next.frame].slice(-SESSION_FRAME_WINDOW_SIZE)
        }
        const closed = settleDepletedAccount(nextSnapshot.account, advanced.frames.at(-1)!.quote)
        nextSnapshot = {
          ...advanced,
          frameStartIndex: advanced.sourceState.frameIndex + 1 - advanced.frames.length,
          account: closed?.account ?? nextSnapshot.account,
          trades: closed ? [...nextSnapshot.trades, closed.trade] : nextSnapshot.trades,
        }
        if (closed) {
          errorMessage.value = '训练权益已耗尽，已按当前报价平仓并暂停。可创建新练习继续。'
          pause()
          break
        }
        if ((nextSnapshot.sourceState.maxFrames !== null && nextSnapshot.sourceState.frameIndex >= nextSnapshot.sourceState.maxFrames - 1)
          || (nextSnapshot.schemaVersion === 3 && nextSimulationTimestamp(nextSnapshot.sourceState.currentTimestampMs) > MAX_SIMULATION_TIMESTAMP_MS)) { pause(); break }
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

  async function startNewSession(
    pair: CurrencyPair = snapshot.value?.pair ?? 'EUR/USD',
    nextScenario: SimulationScenario = scenario.value,
  ): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    pause()
    isBusy.value = true
    errorMessage.value = ''
    try {
      const previousSeed = snapshot.value.schemaVersion === 3 ? snapshot.value.sourceState.seed : undefined
      if (await persist(snapshot.value)) {
        activeHistoryDataset = null
        await persist(createSnapshot(pair, nextScenario, previousSeed))
      }
    } catch (error) {
      errorMessage.value = errorText(error)
    } finally {
      isBusy.value = false
    }
  }

  async function switchPair(pair: CurrencyPair): Promise<void> {
    if (snapshot.value?.pair !== pair) await startNewSession(pair)
  }

  async function refreshHistoryDatasets(): Promise<void> {
    try { historyDatasets.value = await repository.listDatasets() }
    catch (error) { historyErrorMessage.value = `读取历史数据列表失败：${errorText(error)}` }
  }

  async function importHistoryDataset(dataset: HistoryDataset): Promise<boolean> {
    if (!canOperate.value) return false
    pause()
    isBusy.value = true
    historyErrorMessage.value = ''
    try {
      await repository.importDataset(dataset)
      historyDatasets.value = [...historyDatasets.value, {
        id: dataset.id, pair: dataset.pair, fingerprint: dataset.fingerprint, metadata: { ...dataset.metadata },
      }]
      return true
    } catch (error) {
      historyErrorMessage.value = `导入失败：${errorText(error)} 当前练习和已有数据保留。`
      return false
    } finally { isBusy.value = false }
  }

  async function startHistorySession(datasetId: string): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    pause()
    isBusy.value = true
    historyErrorMessage.value = ''
    errorMessage.value = ''
    try {
      const dataset = await repository.loadDataset(datasetId)
      if (!dataset) throw new Error('历史数据集不存在。')
      const nextSnapshot = createHistoricalSnapshot(dataset)
      if (await persist(snapshot.value)) {
        activeHistoryDataset = dataset
        await persist(nextSnapshot)
      }
    } catch (error) {
      historyErrorMessage.value = `开始历史练习失败：${errorText(error)} 原有数据保留。`
      errorMessage.value = historyErrorMessage.value
    } finally { isBusy.value = false }
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
    snapshot, currentQuote, scenario, lastEvent, upcomingEvent, isHistorical, historyDatasets, historyMetadata, historyErrorMessage, currentGapMinutes,
    progressedFrameCount, accountMetrics, isPlaying, speed, isBusy, isReady, canOperate,
    isEnded, isCalendarEnded, canAdvance, saveStatus, loadStatus, errorMessage, rawRecoveryJson,
    initialize, setSpeed, next, play, pause, openTrade, closeTrade, switchPair,
    startNewSession, startHistorySession, importHistoryDataset, refreshHistoryDatasets,
    retrySave, retryLoad, exportSnapshotJson, dispose, setRepositoryForTesting,
  }
})
