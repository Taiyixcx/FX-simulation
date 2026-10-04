import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { calculateAccount } from '../engine/account'
import { MoneyDecimal } from '../engine/decimal'
import { closePosition, prepareOpenPosition, settleDepletedAccount } from '../engine/execution'
import { advanceSimulation, createSimulation } from '../engine/simulationSource'
import { advanceHistory, findHistoryStartIndex, sha256Text } from '../engine/historySource'
import type { HistoryDataset, HistoryDatasetSummary, HistoryProcessingControls } from '../engine/historyTypes'
import { MAX_SIMULATION_TIMESTAMP_MS, nextSimulationTimestamp } from '../engine/simulationParameters'
import type { CurrencyPair, MarketFrame, SimulationScenario, TradeDirection, TradeRecord } from '../engine/types'
import { createSessionRepository, SessionLoadError } from '../storage/sessionRepository'
import type { DatasetListEntry, LoadedSession, SessionRepository, StorageHealth } from '../storage/sessionRepository'
import type { BackupPreview } from '../storage/sessionBackup'
import type { OnboardingStatus, PendingTradeAnnotation, SessionObservation, SessionSummary, SessionTrainingContext, TrainingContextInput, TradeAnnotation, TradeAnnotationInput, TradePlan } from '../storage/sessionMetadata'
import { calculatePracticeStatisticsAsync } from '../engine/tradeStatistics'
import type { PracticeStatistics } from '../engine/tradeStatistics'
import { createSimulationConfig, SESSION_FRAME_WINDOW_SIZE } from '../storage/sessionSnapshot'
import type { SessionSnapshot } from '../storage/sessionSnapshot'
import { createHistoricalSnapshot, getHistoryPracticeStart } from '../storage/historicalSessionSnapshot'
import type { PracticeSnapshot } from '../storage/historicalSessionSnapshot'
import { yieldToEventLoop } from '../yieldToEventLoop'

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
  const savedSessions = shallowRef<SessionSummary[]>([])
  const datasetEntries = shallowRef<DatasetListEntry[]>([])
  const tradeAnnotations = shallowRef<Record<string, TradeAnnotation>>({})
  const sessionObservations = shallowRef<SessionObservation[]>([])
  const trainingContext = shallowRef<SessionTrainingContext | null>(null)
  const comparisonContext = computed(() => trainingContext.value ? { ...trainingContext.value, sourceSessionId: trainingContext.value.sourceSessionId ?? undefined } : null)
  const libraryErrorMessage = ref('')
  const libraryMessage = ref('')
  const storageHealth = shallowRef<StorageHealth | null>(null)
  const onboardingStatus = ref<OnboardingStatus | null>(null)
  const backupPreview = shallowRef<BackupPreview | null>(null)
  const isLibraryBusy = ref(false)
  const practiceStatistics = shallowRef<PracticeStatistics | null>(null)
  const isStatisticsLoading = ref(false)
  const statisticsError = ref('')
  const reviewFrames = shallowRef<MarketFrame[] | null>(null)
  const reviewTrade = shallowRef<TradeRecord | null>(null)
  const reviewTimestampMs = ref<number | null>(null)
  const isReviewLoading = ref(false)
  const reviewError = ref('')
  let pendingAnnotation: PendingTradeAnnotation | undefined
  let pendingTrainingContext: TrainingContextInput | undefined
  let statisticsRequest = 0
  let reviewRequest = 0
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
  const canOperate = computed(() => isReady.value && !isBusy.value && !isLibraryBusy.value && saveStatus.value === 'saved' && !isDisposed.value)
  const isCalendarEnded = computed(() => snapshot.value?.schemaVersion === 3 && nextSimulationTimestamp(snapshot.value.sourceState.currentTimestampMs) > MAX_SIMULATION_TIMESTAMP_MS)
  const isEnded = computed(() => isCalendarEnded.value || (snapshot.value !== null && snapshot.value.sourceState.maxFrames !== null && snapshot.value.sourceState.frameIndex >= snapshot.value.sourceState.maxFrames - 1))
  const historyStartIndex = computed(() => snapshot.value?.schemaVersion === 4 ? getHistoryPracticeStart(snapshot.value).startFrameIndex : 0)
  const progressedFrameCount = computed(() => (snapshot.value?.sourceState.frameIndex ?? -1) + 1 - historyStartIndex.value)
  const totalPracticeFrameCount = computed(() => snapshot.value?.sourceState.maxFrames === null ? null : (snapshot.value?.sourceState.maxFrames ?? 0) - historyStartIndex.value)
  const isReviewing = computed(() => reviewFrames.value !== null)
  const chartFrames = computed(() => reviewFrames.value ?? snapshot.value?.frames ?? [])
  const canAdvance = computed(() => canOperate.value && !isEnded.value && accountMetrics.value !== null && new MoneyDecimal(accountMetrics.value.equityUsd).gt(0))

  function pause(): void {
    isPlaying.value = false
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  async function persist(nextSnapshot: PracticeSnapshot, annotation?: PendingTradeAnnotation, context?: TrainingContextInput): Promise<boolean> {
    snapshot.value = nextSnapshot
    pendingAnnotation = annotation
    pendingTrainingContext = context
    practiceStatistics.value = null
    statisticsRequest += 1
    isStatisticsLoading.value = false
    saveStatus.value = 'saving'
    try {
      await repository.save(nextSnapshot, annotation, context)
      saveStatus.value = 'saved'
      pendingAnnotation = undefined
      pendingTrainingContext = undefined
      if (context) {
        try { trainingContext.value = await repository.getTrainingContext(nextSnapshot.id) }
        catch (error) { libraryErrorMessage.value = `练习与对照标记已保存，读取标记失败：${errorText(error)}` }
      }
      if (annotation) {
        try {
          const saved = await repository.getTradeAnnotation(nextSnapshot.id, annotation.tradeId)
          if (saved) tradeAnnotations.value = { ...tradeAnnotations.value, [saved.tradeId]: saved }
        } catch (error) { libraryErrorMessage.value = `成交已保存，读取计划失败：${errorText(error)}` }
      }
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
      const loaded = await repository.loadCurrentWithSource()
      if (loaded !== null) {
        applyLoadedSession(loaded)
        saveStatus.value = 'saved'
        rawRecoveryJson.value = null
        if (accountMetrics.value && new MoneyDecimal(accountMetrics.value.equityUsd).lte(0)) {
          errorMessage.value = '训练资金已耗尽，当前练习已暂停。可创建新练习继续。'
        }
      } else {
        await persist(createSnapshot('EUR/USD'))
      }
      loadStatus.value = 'ready'
      await Promise.all([refreshHistoryDatasets(), refreshSavedSessions(), refreshCurrentMetadata(), refreshStorageHealth()])
      try { onboardingStatus.value = await repository.getOnboardingStatus() }
      catch (error) { libraryErrorMessage.value = `引导状态读取失败：${errorText(error)} 练习已正常恢复。` }
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

  async function operate(action: (current: PracticeSnapshot) => PracticeSnapshot, annotation?: PendingTradeAnnotation): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    isBusy.value = true
    errorMessage.value = ''
    try {
      await persist(action(snapshot.value), annotation)
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

  async function openTrade(direction: TradeDirection, notionalUsd: string, plan?: TradePlan): Promise<void> {
    const tradeId = crypto.randomUUID()
    await operate((current) => ({
      ...current,
      revision: current.revision + 1,
      account: prepareOpenPosition(current.account, current.frames.at(-1)!.quote, current.pair, direction, notionalUsd, tradeId),
    }), plan ? { tradeId, expectedRevision: null, ...plan } : undefined)
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
        exitReview()
        tradeAnnotations.value = {}
        sessionObservations.value = []
        trainingContext.value = null
        await persist(createSnapshot(pair, nextScenario, previousSeed))
        await refreshSavedSessions()
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
    try {
      datasetEntries.value = await repository.listDatasetEntries()
      historyDatasets.value = datasetEntries.value.flatMap(entry => entry.summary ? [entry.summary] : [])
    }
    catch (error) { historyErrorMessage.value = `读取历史数据列表失败：${errorText(error)}` }
  }

  async function importHistoryDataset(dataset: HistoryDataset, controls?: HistoryProcessingControls): Promise<boolean> {
    if (!canOperate.value) return false
    pause()
    isBusy.value = true
    historyErrorMessage.value = ''
    try {
      await repository.importDataset(dataset, controls)
      historyDatasets.value = [...historyDatasets.value, {
        id: dataset.id, pair: dataset.pair, fingerprint: dataset.fingerprint, metadata: { ...dataset.metadata },
      }]
      await refreshHistoryDatasets()
      return true
    } catch (error) {
      historyErrorMessage.value = `导入失败：${errorText(error)} 当前练习和已有数据保留。`
      return false
    } finally { isBusy.value = false }
  }

  async function startHistorySession(datasetId: string, options: { startTimestampMs?: number; warmupFrameCount?: number } = {}): Promise<void> {
    if (!canOperate.value || !snapshot.value) return
    pause()
    isBusy.value = true
    historyErrorMessage.value = ''
    errorMessage.value = ''
    try {
      const dataset = await repository.loadDataset(datasetId)
      if (!dataset) throw new Error('历史数据集不存在。')
      const startFrameIndex = options.startTimestampMs === undefined ? 0 : findHistoryStartIndex(dataset, options.startTimestampMs)
      const nextSnapshot = createHistoricalSnapshot(dataset, undefined, { startFrameIndex, warmupFrameCount: options.warmupFrameCount ?? 0 })
      if (await persist(snapshot.value)) {
        activeHistoryDataset = dataset
        exitReview()
        tradeAnnotations.value = {}
        sessionObservations.value = []
        trainingContext.value = null
        await persist(nextSnapshot)
        await refreshSavedSessions()
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
    try { await persist(snapshot.value, pendingAnnotation, pendingTrainingContext) } finally { isBusy.value = false }
  }

  async function retryLoad(): Promise<void> {
    if (loadStatus.value === 'error') await initialize()
  }

  function exitReview(): void {
    reviewRequest += 1
    reviewFrames.value = null
    reviewTrade.value = null
    reviewTimestampMs.value = null
    reviewError.value = ''
    isReviewLoading.value = false
  }

  function applyLoadedSession(loaded: LoadedSession): void {
    activeHistoryDataset = loaded.dataset
    snapshot.value = loaded.snapshot
    pendingAnnotation = undefined
    pendingTrainingContext = undefined
    trainingContext.value = null
    practiceStatistics.value = null
    statisticsRequest += 1
    isStatisticsLoading.value = false
    statisticsError.value = ''
    exitReview()
    tradeAnnotations.value = {}
    sessionObservations.value = []
  }

  async function refreshSavedSessions(): Promise<void> {
    try { savedSessions.value = await repository.listSessions() }
    catch (error) { libraryErrorMessage.value = `读取已保存练习失败：${errorText(error)}` }
  }

  async function refreshCurrentMetadata(): Promise<boolean> {
    const id = snapshot.value?.id
    if (!id) return false
    try {
      const [annotations, observations, context] = await Promise.all([repository.listTradeAnnotations(id), repository.listSessionObservations(id), repository.getTrainingContext(id)])
      if (snapshot.value?.id !== id) return false
      tradeAnnotations.value = Object.fromEntries(annotations.map(annotation => [annotation.tradeId, annotation]))
      sessionObservations.value = observations
      trainingContext.value = context
      if (/^(?:读取练习备注失败|备注保存失败)/.test(libraryErrorMessage.value)) libraryErrorMessage.value = ''
      return true
    } catch (error) {
      libraryErrorMessage.value = `读取练习备注失败：${errorText(error)} 原记录保留。`
      return false
    }
  }

  async function refreshStorageHealth(): Promise<void> {
    try { storageHealth.value = await repository.storageHealth() }
    catch { storageHealth.value = null }
  }

  async function refreshLibrary(): Promise<void> {
    await Promise.all([refreshSavedSessions(), refreshHistoryDatasets(), refreshStorageHealth(), refreshCurrentMetadata()])
  }

  async function activateSavedSession(id: string): Promise<boolean> {
    if (!canOperate.value || !snapshot.value) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    libraryMessage.value = ''
    try {
      if (!await persist(snapshot.value)) return false
      const loaded = await repository.activateSession(id)
      applyLoadedSession(loaded)
      saveStatus.value = 'saved'
      errorMessage.value = accountMetrics.value && new MoneyDecimal(accountMetrics.value.equityUsd).lte(0)
        ? '训练资金已耗尽，已暂停恢复。若仍有旧持仓，可按当前报价主动平仓。' : ''
      await refreshLibrary()
      libraryMessage.value = '已打开原练习，行情保持暂停。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `打开练习失败：${errorText(error)} 原练习保留。`
      return false
    } finally { isBusy.value = false }
  }

  async function saveTradeAnnotation(tradeId: string, input: TradeAnnotationInput): Promise<boolean> {
    if (!canOperate.value || !snapshot.value) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    try {
      const saved = await repository.saveTradeAnnotation(snapshot.value.id, tradeId, input)
      tradeAnnotations.value = { ...tradeAnnotations.value, [tradeId]: saved }
      return true
    } catch (error) {
      libraryErrorMessage.value = `备注保存失败：${errorText(error)}`
      return false
    } finally { isBusy.value = false }
  }

  async function recordObservation(reason: string): Promise<boolean> {
    if (!canOperate.value || !snapshot.value || !currentQuote.value) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    try {
      const observation = await repository.recordSessionObservation(snapshot.value.id, {
        reason, timestampMs: currentQuote.value.timestampMs, frameIndex: snapshot.value.sourceState.frameIndex,
      })
      sessionObservations.value = [...sessionObservations.value, observation]
      libraryMessage.value = '已记录本次选择不交易及理由。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `记录保存失败：${errorText(error)}`
      return false
    } finally { isBusy.value = false }
  }

  async function setOnboardingStatus(status: OnboardingStatus): Promise<void> {
    try {
      await repository.setOnboardingStatus(status)
      onboardingStatus.value = status
    } catch (error) { libraryErrorMessage.value = `引导状态未能保存：${errorText(error)}` }
  }

  async function selectReviewTrade(input: TradeRecord, action: 'open' | 'close' = 'open'): Promise<void> {
    if (!snapshot.value || isDisposed.value) return
    const current = snapshot.value
    const selected = current.trades.find(trade => trade.id === input.id)
    if (!selected) return
    pause()
    const request = ++reviewRequest
    isReviewLoading.value = true
    reviewError.value = ''
    const center = action === 'close' ? selected.closedAtMs : selected.openedAtMs
    try {
      const frames = await repository.readSessionFrames(current.id, {
        fromTimestampMs: Math.max(0, center - 60 * 60_000),
        toTimestampMs: Math.min(current.sourceState.currentTimestampMs, center + 120 * 60_000),
      })
      if (request !== reviewRequest || snapshot.value?.id !== current.id || isDisposed.value) return
      const visible = frames.filter(frame => frame.quote.timestampMs <= current.sourceState.currentTimestampMs).slice(0, SESSION_FRAME_WINDOW_SIZE)
      if (!visible.some(frame => frame.quote.timestampMs === center)) throw new Error('对应行情缺失，请保留原记录。')
      reviewFrames.value = visible
      reviewTrade.value = selected
      reviewTimestampMs.value = center
    } catch (error) { if (request === reviewRequest) reviewError.value = `复盘行情读取失败：${errorText(error)}` }
    finally { if (request === reviewRequest) isReviewLoading.value = false }
  }

  async function loadPracticeStatistics(): Promise<void> {
    if (!snapshot.value || isStatisticsLoading.value || isDisposed.value) return
    pause()
    const current = snapshot.value
    const request = ++statisticsRequest
    isStatisticsLoading.value = true
    statisticsError.value = ''
    try {
      const frames = await repository.readSessionFrames(current.id)
      const startIndex = current.schemaVersion === 4 ? getHistoryPracticeStart(current).startFrameIndex : 0
      const startTimestampMs = current.schemaVersion === 4 && activeHistoryDataset
        ? activeHistoryDataset.frames[startIndex]!.quote.timestampMs : 0
      const quotes = frames.filter(frame => frame.quote.timestampMs >= startTimestampMs && frame.quote.timestampMs <= current.sourceState.currentTimestampMs).map(frame => frame.quote)
      const statistics = await calculatePracticeStatisticsAsync(quotes, current.trades, current.account.position, '10000.00', {
        signal: { get aborted() { return request !== statisticsRequest || isDisposed.value } },
        yieldControl: yieldToEventLoop,
      })
      if (request === statisticsRequest && snapshot.value?.id === current.id && !isDisposed.value) practiceStatistics.value = statistics
    } catch (error) { if (request === statisticsRequest) statisticsError.value = `统计未完成：${errorText(error)}` }
    finally { if (request === statisticsRequest) isStatisticsLoading.value = false }
  }

  async function exportBackupJson(signal?: AbortSignal): Promise<string | null> {
    if (isBusy.value || isLibraryBusy.value || isDisposed.value) return null
    pause()
    isLibraryBusy.value = true
    libraryErrorMessage.value = ''
    libraryMessage.value = ''
    try {
      const hadUnsavedState = saveStatus.value === 'error'
      const json = await repository.exportBackupJson(signal)
      libraryMessage.value = hadUnsavedState
        ? '已导出最近成功提交的完整数据。当前未保存状态请另行导出故障快照。'
        : '已生成包含全部练习、行情和备注的完整备份。'
      return json
    } catch (error) {
      libraryErrorMessage.value = `备份未完成：${errorText(error)}`
      return null
    } finally { isLibraryBusy.value = false }
  }

  async function prepareBackupRestore(json: string, signal?: AbortSignal): Promise<boolean> {
    if (isBusy.value || isLibraryBusy.value || isDisposed.value) return false
    pause()
    isLibraryBusy.value = true
    backupPreview.value = null
    libraryErrorMessage.value = ''
    libraryMessage.value = ''
    try {
      backupPreview.value = await repository.previewBackup(json, signal)
      return true
    } catch (error) {
      libraryErrorMessage.value = `备份校验未通过：${errorText(error)} 原数据保留。`
      return false
    } finally { isLibraryBusy.value = false }
  }

  function cancelBackupRestore(): void {
    if (backupPreview.value) repository.discardBackupPreview(backupPreview.value.id)
    backupPreview.value = null
  }

  async function restoreBackup(openRestoredSession = false): Promise<boolean> {
    if (!backupPreview.value || isBusy.value || isLibraryBusy.value || saveStatus.value === 'error' || isDisposed.value) return false
    pause()
    isLibraryBusy.value = true
    libraryErrorMessage.value = ''
    const previewId = backupPreview.value.id
    try {
      const result = await repository.restoreBackup(backupPreview.value, { openRestoredSession: openRestoredSession })
      backupPreview.value = null
      if (result.loadedSession) {
        applyLoadedSession(result.loadedSession)
        saveStatus.value = 'saved'
        loadStatus.value = 'ready'
        errorMessage.value = ''
      }
      await refreshLibrary()
      const hasLoadedMetadata = result.loadedSession ? await refreshCurrentMetadata() : true
      libraryMessage.value = `已恢复 ${result.sessionIds.length} 个独立练习，原数据保留，行情暂停。`
      if (!hasLoadedMetadata) libraryMessage.value += ' 账户与成交已保存，备注及训练标记读取失败，可重试读取。'
      return true
    } catch (error) {
      repository.discardBackupPreview(previewId)
      libraryErrorMessage.value = `恢复失败：${errorText(error)} 原数据保留，请重新校验备份。`
      backupPreview.value = null
      return false
    } finally { isLibraryBusy.value = false }
  }

  async function deleteSavedSession(id: string, expectedRevision: number): Promise<boolean> {
    if (!canOperate.value || id === snapshot.value?.id) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    try {
      await repository.deleteSession(id, expectedRevision)
      await refreshLibrary()
      libraryMessage.value = '已删除所选旧练习及其记录，其他练习保留。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `删除未完成：${errorText(error)}`
      return false
    } finally { isBusy.value = false }
  }

  async function deleteHistoryDataset(id: string): Promise<boolean> {
    if (!canOperate.value) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    try {
      await repository.deleteDataset(id)
      await refreshHistoryDatasets()
      await refreshStorageHealth()
      libraryMessage.value = '已删除所选未使用数据集。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `删除未完成：${errorText(error)}`
      return false
    } finally { isBusy.value = false }
  }

  async function requestPersistentStorage(): Promise<void> {
    try {
      const approved = await repository.requestPersistentStorage()
      await refreshStorageHealth()
      libraryMessage.value = approved ? '浏览器已启用持久存储。请继续保留外部备份。' : '浏览器未批准持久存储，现有数据保留，请使用完整备份。'
    } catch (error) { libraryErrorMessage.value = `申请未完成：${errorText(error)}` }
  }

  async function repeatCurrentPractice(): Promise<boolean> {
    if (!canOperate.value || !snapshot.value) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    const original = snapshot.value
    try {
      if (!await persist(original)) return false
      let repeated: PracticeSnapshot
      let sourceFingerprint: string
      if (original.schemaVersion === 4) {
        const dataset = activeHistoryDataset ?? await repository.loadDataset(original.sourceState.datasetId)
        if (!dataset) throw new Error('原历史数据集缺失。')
        const start = getHistoryPracticeStart(original)
        repeated = createHistoricalSnapshot(dataset, undefined, start)
        activeHistoryDataset = dataset
        sourceFingerprint = dataset.fingerprint
      } else {
        const config = original.simulationConfig
        // A migrated practice can repeat its current-model suffix; the retained
        // prefix remains in the original session and its old algorithm is not run.
        const simulation = createSimulation(original.pair, config.seed, {
          ...config,
          originFrameIndex: 0,
          startTimestampMs: nextSimulationTimestamp(config.initialTimestampMs),
          maxFrames: config.maxFrames === null ? null : config.maxFrames - config.originFrameIndex,
        })
        repeated = {
          schemaVersion: 3, retainedPrefixKind: null, id: crypto.randomUUID(), revision: 0, pair: original.pair,
          sourceState: simulation.state, simulationConfig: createSimulationConfig(simulation.state),
          frameStartIndex: 0, frames: [simulation.frame], account: { balanceUsd: '10000.00', position: null }, trades: [],
        }
        activeHistoryDataset = null
        sourceFingerprint = await sha256Text(JSON.stringify([original.pair, original.simulationConfig]))
      }
      exitReview()
      tradeAnnotations.value = {}
      sessionObservations.value = []
      trainingContext.value = null
      const ruleVersion = original.schemaVersion === 3 ? `execution-v1/simulation-v2/parameters-v${original.sourceState.parameterVersion}` : 'execution-v1/history-completed-m1'
      if (!await persist(repeated, undefined, { kind: 'repeat', sourceSessionId: original.id, sourceFingerprint, ruleVersion })) return false
      await refreshSavedSessions()
      libraryMessage.value = original.schemaVersion === 3 && original.retainedPrefixKind
        ? '已从当前模拟模型的衔接段重练。旧算法行情和成交仍保留在原练习。'
        : '已创建同来源、同起点的独立重练。原账户与成交保留；本次标为已见走势。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `对照练习未完成：${errorText(error)} 原记录保留。`
      return false
    } finally { isBusy.value = false }
  }

  async function startUnseenHistoryPractice(): Promise<boolean> {
    if (!canOperate.value || !snapshot.value || snapshot.value.schemaVersion !== 4 || !activeHistoryDataset) return false
    pause()
    isBusy.value = true
    libraryErrorMessage.value = ''
    const original = snapshot.value
    const dataset = activeHistoryDataset
    try {
      if (!await persist(original)) return false
      const sessions = await repository.listSessions()
      if (sessions.some(item => item.errorMessage)) throw new Error('有无法核对的练习记录，暂不能确认未见范围。请先备份并核对记录。')
      let lastSeenIndex = original.sourceState.frameIndex
      for (const item of sessions) {
        if (item.id === original.id || item.datasetId !== dataset.id) continue
        const loaded = await repository.loadSession(item.id)
        if (!loaded || loaded.snapshot.schemaVersion !== 4) throw new Error('相关练习无法核对。')
        lastSeenIndex = Math.max(lastSeenIndex, loaded.snapshot.sourceState.frameIndex)
      }
      const startFrameIndex = lastSeenIndex + 1
      if (startFrameIndex >= dataset.frames.length) throw new Error('这个数据集已没有可确认的本机未见片段，请另选数据集。')
      const nextSnapshot = createHistoricalSnapshot(dataset, undefined, { startFrameIndex, warmupFrameCount: Math.min(60, startFrameIndex) })
      activeHistoryDataset = dataset
      exitReview()
      tradeAnnotations.value = {}
      sessionObservations.value = []
      trainingContext.value = null
      if (!await persist(nextSnapshot, undefined, { kind: 'unseen', sourceSessionId: original.id, sourceFingerprint: dataset.fingerprint, ruleVersion: 'execution-v1/history-completed-m1' })) return false
      await refreshSavedSessions()
      libraryMessage.value = '已从本机保留记录之后的片段开始检验，账户独立且暂停。此标记不能证明你在其他地方没见过走势。'
      return true
    } catch (error) {
      libraryErrorMessage.value = `未见片段未能开始：${errorText(error)} 原练习保留。`
      return false
    } finally { isBusy.value = false }
  }

  function exportSnapshotJson(): string | null {
    return snapshot.value ? JSON.stringify(snapshot.value, null, 2) : rawRecoveryJson.value
  }

  function dispose(): void {
    pause()
    statisticsRequest += 1
    reviewRequest += 1
    isDisposed.value = true
    activeHistoryDataset = null
    reviewFrames.value = null
    practiceStatistics.value = null
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
    progressedFrameCount, totalPracticeFrameCount, historyStartIndex, accountMetrics, isPlaying, speed, isBusy, isReady, canOperate,
    savedSessions, datasetEntries, tradeAnnotations, sessionObservations, trainingContext, comparisonContext, libraryErrorMessage, libraryMessage, storageHealth, onboardingStatus, backupPreview, isLibraryBusy,
    practiceStatistics, isStatisticsLoading, statisticsError, reviewFrames, reviewTrade, reviewTimestampMs, isReviewLoading, reviewError, isReviewing, chartFrames,
    isEnded, isCalendarEnded, canAdvance, saveStatus, loadStatus, errorMessage, rawRecoveryJson,
    initialize, setSpeed, next, play, pause, openTrade, closeTrade, switchPair,
    startNewSession, startHistorySession, importHistoryDataset, refreshHistoryDatasets,
    activateSavedSession, refreshLibrary, refreshCurrentMetadata, saveTradeAnnotation, recordObservation, setOnboardingStatus,
    selectReviewTrade, exitReview, loadPracticeStatistics, exportBackupJson, prepareBackupRestore, cancelBackupRestore, restoreBackup,
    deleteSavedSession, deleteHistoryDataset, refreshStorageHealth, requestPersistentStorage,
    repeatCurrentPractice, startUnseenHistoryPractice,
    retrySave, retryLoad, exportSnapshotJson, dispose, setRepositoryForTesting,
  }
})
