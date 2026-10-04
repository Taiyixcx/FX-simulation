import { validateHistoryDataset, validateHistoryDatasetSummary } from '../engine/historySource'
import type { HistoryDataset } from '../engine/historyTypes'
import type { MarketFrame } from '../engine/types'
import { createSessionHistoryValidator, SESSION_FRAME_WINDOW_SIZE, validateSessionSnapshot } from './sessionSnapshot'
import { validateHistoricalSnapshot } from './historicalSessionSnapshot'
import type { PracticeSnapshot } from './historicalSessionSnapshot'
import { validateTradeAnnotation, validateSessionObservation, validateSessionTrainingContext } from './sessionMetadata'
import type { SessionSummary, TradeAnnotation, OnboardingStatus, SessionObservation, SessionTrainingContext } from './sessionMetadata'
import { yieldToEventLoop } from '../yieldToEventLoop'

export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_MAX_BYTES = 128 * 1024 * 1024
export interface HistoryChunk { sessionId: string; chunkIndex: number; frames: MarketFrame[] }
export interface BackupPreview {
  id: string
  mode: 'empty' | 'append'
  sessionCount: number
  datasetCount: number
  tradeCount: number
  currentSessionId: string | null
  createdAtMs: number
}
export interface PracticeBackup {
  backupFormatVersion: 1
  exportedAtMs: number
  currentSessionId: string | null
  sessions: unknown[]
  historyChunks: HistoryChunk[]
  datasets: HistoryDataset[]
  annotations: TradeAnnotation[]
  observations: SessionObservation[]
  /** Older format-1 backups omitted this field; they restore without a label. */
  trainingContexts: SessionTrainingContext[]
  sessionTimes: Pick<SessionSummary, 'id' | 'createdAtMs' | 'savedAtMs'>[]
  onboardingStatus: OnboardingStatus | null
}
export interface ValidatedBackup extends Omit<PracticeBackup, 'sessions'> { sessions: PracticeSnapshot[] }

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('操作已取消，原有数据保留。', 'AbortError')
}
function array(input: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) throw new Error(`${label}格式或数量无效。`)
  return input
}
function nullableTime(input: unknown): number | null {
  if (input === null) return null
  if (!Number.isSafeInteger(input) || Number(input) < 0) throw new Error('练习保存时间无效。')
  return Number(input)
}

/** JSON/file content is never trusted, even if it claims to have been verified. */
export async function validatePracticeBackup(input: unknown, external = true, signal?: AbortSignal): Promise<ValidatedBackup> {
  checkCancelled(signal)
  if (!input || typeof input !== 'object' || !('backupFormatVersion' in input) || input.backupFormatVersion !== BACKUP_FORMAT_VERSION) throw new Error('不支持此备份格式版本，原有数据保留。')
  const backup = input as PracticeBackup
  if (!Number.isSafeInteger(backup.exportedAtMs) || backup.exportedAtMs < 0 || (backup.currentSessionId !== null && typeof backup.currentSessionId !== 'string')) throw new Error('备份时间或当前练习入口无效。')
  if (backup.onboardingStatus !== null && backup.onboardingStatus !== 'completed' && backup.onboardingStatus !== 'skipped') throw new Error('引导状态无效。')
  const rawSessions = array(backup.sessions, '练习', 1000)
  const rawDatasets = array(backup.datasets, '数据集', 50)
  const rawChunks = array(backup.historyChunks, '行情块', 10_000)
  const rawAnnotations = array(backup.annotations, '备注', 100_000)
  const rawObservations = array(backup.observations, '观察记录', 100_000)
  const rawTrainingContexts = array(backup.trainingContexts === undefined ? [] : backup.trainingContexts, '训练对照信息', 1000)
  const rawTimes = array(backup.sessionTimes, '练习时间', 1000)
  const datasets = new Map<string, HistoryDataset>()
  for (const raw of rawDatasets) {
    checkCancelled(signal)
    const dataset = structuredClone(raw) as HistoryDataset
    validateHistoryDatasetSummary(dataset)
    if (external && dataset?.metadata) {
      const claimedVerified = dataset.metadata.verified === true
      dataset.metadata.verified = false
      if (claimedVerified) dataset.metadata.restoredVerificationClaim = true
    }
    await validateHistoryDataset(dataset, { signal, yieldControl: yieldToEventLoop })
    if (datasets.has(dataset.id)) throw new Error('备份包含重复数据集标识。')
    datasets.set(dataset.id, dataset)
    await yieldToEventLoop()
  }
  const chunks = new Map<string, HistoryChunk[]>()
  const chunkKeys = new Set<string>()
  for (const raw of rawChunks) {
    if (!raw || typeof raw !== 'object') throw new Error('行情块格式无效。')
    const chunk = raw as HistoryChunk
    if (typeof chunk.sessionId !== 'string' || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0
      || !Array.isArray(chunk.frames) || chunk.frames.length < 1 || chunk.frames.length > SESSION_FRAME_WINDOW_SIZE) throw new Error('行情块标识或数量无效。')
    const key = `${chunk.sessionId}:${chunk.chunkIndex}`
    if (chunkKeys.has(key)) throw new Error('备份包含重复行情块。')
    chunkKeys.add(key)
    const list = chunks.get(chunk.sessionId) ?? []
    list.push(structuredClone(chunk))
    chunks.set(chunk.sessionId, list)
  }
  const sessions = new Map<string, PracticeSnapshot>()
  const normalizedChunks: HistoryChunk[] = []
  for (const raw of rawSessions) {
    checkCancelled(signal)
    if (!raw || typeof raw !== 'object' || !('schemaVersion' in raw) || !('id' in raw) || typeof raw.id !== 'string') throw new Error('练习格式无效。')
    const storedChunks = chunks.get(raw.id) ?? []
    let snapshot: PracticeSnapshot
    if (raw.schemaVersion === 4) {
      if (!('sourceState' in raw) || !raw.sourceState || typeof raw.sourceState !== 'object' || !('datasetId' in raw.sourceState)) throw new Error('历史练习数据集引用无效。')
      const dataset = datasets.get(String(raw.sourceState.datasetId))
      if (!dataset) throw new Error('备份缺少历史练习所需的完整数据集。')
      if (storedChunks.length) throw new Error('历史练习不能附带模拟行情块。')
      snapshot = validateHistoricalSnapshot(raw, dataset)
    } else if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
      if (storedChunks.length) throw new Error('旧格式练习附带了不支持的归档块。')
      snapshot = validateSessionSnapshot(raw)
      if (!('frames' in raw) || !Array.isArray(raw.frames)) throw new Error('旧格式练习行情缺失。')
      const frames = raw.frames as MarketFrame[]
      for (let index = 0; index < frames.length; index += SESSION_FRAME_WINDOW_SIZE) normalizedChunks.push({ sessionId: snapshot.id, chunkIndex: index / SESSION_FRAME_WINDOW_SIZE, frames: structuredClone(frames.slice(index, index + SESSION_FRAME_WINDOW_SIZE)) })
    } else if (raw.schemaVersion === 3) {
      const validator = createSessionHistoryValidator(raw)
      const snapshotInput = raw as PracticeSnapshot
      const count = snapshotInput.sourceState.frameIndex + 1
      storedChunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
      if (storedChunks.length !== Math.ceil(count / SESSION_FRAME_WINDOW_SIZE)) throw new Error('备份归档行情块缺失或数量不一致。')
      for (let index = 0; index < storedChunks.length; index += 1) {
        const chunk = storedChunks[index]!
        if (chunk.chunkIndex !== index || chunk.frames.length !== Math.min(SESSION_FRAME_WINDOW_SIZE, count - index * SESSION_FRAME_WINDOW_SIZE)) throw new Error('备份行情块次序或长度不一致。')
        for (const frame of chunk.frames) validator.pushFrame(frame)
        normalizedChunks.push(chunk)
        checkCancelled(signal)
        await yieldToEventLoop()
      }
      snapshot = validator.finish()
    } else throw new Error('不支持此练习格式版本。')
    if (sessions.has(snapshot.id)) throw new Error('备份包含重复练习标识。')
    sessions.set(snapshot.id, snapshot)
  }
  if ([...chunks.keys()].some(id => !sessions.has(id))) throw new Error('行情块引用了不存在的练习。')
  if (backup.currentSessionId !== null && !sessions.has(backup.currentSessionId)) throw new Error('备份当前入口引用了不存在的练习。')
  if (sessions.size && backup.currentSessionId === null) throw new Error('备份包含练习但缺少有效当前入口。')
  const annotations = rawAnnotations.map(validateTradeAnnotation)
  const annotationKeys = new Set<string>()
  for (const annotation of annotations) {
    const snapshot = sessions.get(annotation.sessionId)
    if (!snapshot || (snapshot.account.position?.id !== annotation.tradeId && !snapshot.trades.some(trade => trade.id === annotation.tradeId))) throw new Error('备注引用了不存在的交易。')
    const key = `${annotation.sessionId}:${annotation.tradeId}`
    if (annotationKeys.has(key)) throw new Error('备份包含重复交易备注。')
    annotationKeys.add(key)
  }
  const timeIds = new Set<string>()
  const trainingOwners = new Set<string>()
  const trainingContexts = rawTrainingContexts.map(validateSessionTrainingContext).map(context => {
    const snapshot = sessions.get(context.sessionId)
    if (!snapshot || trainingOwners.has(context.sessionId)) throw new Error('训练对照信息引用了不存在或重复的练习。')
    if (snapshot.schemaVersion === 4 && context.sourceFingerprint !== snapshot.sourceState.fingerprint) throw new Error('训练对照来源指纹与历史练习不一致。')
    trainingOwners.add(context.sessionId)
    // Missing source owners are allowed: deletion cannot turn a repeat into unseen.
    return external ? { ...context, isImportedClaim: true } : context
  })
  const observationIds = new Set<string>()
  const observations = rawObservations.map(validateSessionObservation)
  for (const observation of observations) {
    const snapshot = sessions.get(observation.sessionId)
    const start = snapshot && 'historyStart' in snapshot && snapshot.historyStart && typeof snapshot.historyStart === 'object'
      && 'startFrameIndex' in snapshot.historyStart && typeof snapshot.historyStart.startFrameIndex === 'number' ? snapshot.historyStart.startFrameIndex : 0
    if (!snapshot || observation.frameIndex < start || observation.frameIndex > snapshot.sourceState.frameIndex
      || observation.timestampMs > snapshot.sourceState.currentTimestampMs || observationIds.has(observation.id)) throw new Error('观察记录引用了不存在或未推进的练习。')
    observationIds.add(observation.id)
    const quote = snapshot.schemaVersion === 4 ? datasets.get(snapshot.sourceState.datasetId)?.frames[observation.frameIndex]?.quote
      : normalizedChunks.find(chunk => chunk.sessionId === snapshot.id && chunk.chunkIndex === Math.floor(observation.frameIndex / SESSION_FRAME_WINDOW_SIZE))?.frames[observation.frameIndex % SESSION_FRAME_WINDOW_SIZE]?.quote
    if (!quote || quote.timestampMs !== observation.timestampMs) throw new Error('观察记录时间与已发生行情不一致。')
  }
  const sessionTimes = rawTimes.map(raw => {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !sessions.has(raw.id) || timeIds.has(raw.id)
      || !('createdAtMs' in raw) || !('savedAtMs' in raw)) throw new Error('备份练习时间关联无效。')
    timeIds.add(raw.id)
    return { id: raw.id, createdAtMs: nullableTime(raw.createdAtMs), savedAtMs: nullableTime(raw.savedAtMs) }
  })
  checkCancelled(signal)
  return { backupFormatVersion: 1, exportedAtMs: backup.exportedAtMs, currentSessionId: backup.currentSessionId,
    sessions: [...sessions.values()], historyChunks: normalizedChunks, datasets: [...datasets.values()], annotations, observations, trainingContexts, sessionTimes, onboardingStatus: backup.onboardingStatus }
}
