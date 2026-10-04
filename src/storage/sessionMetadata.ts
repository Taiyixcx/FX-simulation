import type { CurrencyPair } from '../engine/types'
import type { PracticeSnapshot } from './historicalSessionSnapshot'

export const TRADE_ANNOTATION_MAX_LENGTH = 2000

export interface SessionSummary {
  id: string
  pair: CurrencyPair | null
  mode: 'simulation' | 'historical' | null
  revision: number | null
  currentTimestampMs: number | null
  progressedFrameCount: number | null
  tradeCount: number | null
  hasOpenPosition: boolean
  balanceUsd: string | null
  datasetId: string | null
  createdAtMs: number | null
  savedAtMs: number | null
  isCurrent: boolean
  errorMessage: string | null
}

export interface TradePlan { entryReason: string; exitPlan: string }
export interface TradeAnnotation {
  sessionId: string
  tradeId: string
  revision: number
  firstPlan: TradePlan | null
  planRevisions: { revision: number; recordedAtMs: number; plan: TradePlan; isBeforeEntry: boolean }[]
  exitNote: string
  updatedAtMs: number
}
export interface TradeAnnotationInput {
  expectedRevision: number | null
  entryReason?: string
  exitPlan?: string
  exitNote?: string
}
export interface PendingTradeAnnotation extends TradeAnnotationInput { tradeId: string }
export interface SessionTrainingContext {
  sessionId: string
  kind: 'repeat' | 'unseen'
  /** A source may have been deleted; this reference then remains a declaration. */
  sourceSessionId: string | null
  sourceFingerprint: string
  ruleVersion: string
  recordedAtMs: number
  /** External backup labels never certify that the user has not seen a fragment. */
  isImportedClaim?: boolean
}
export type TrainingContextInput = Pick<SessionTrainingContext, 'kind' | 'sourceSessionId' | 'sourceFingerprint' | 'ruleVersion'>

export function validateSessionTrainingContext(input: unknown): SessionTrainingContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('训练对照信息格式无效。')
  const context = input as SessionTrainingContext
  const identifier = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)
  if (Object.keys(context).some(key => !['sessionId', 'kind', 'sourceSessionId', 'sourceFingerprint', 'ruleVersion', 'recordedAtMs', 'isImportedClaim'].includes(key))
    || !identifier(context.sessionId) || !['repeat', 'unseen'].includes(context.kind)
    || (context.sourceSessionId !== null && !identifier(context.sourceSessionId))
    || context.sourceSessionId === context.sessionId || (context.kind === 'repeat' && context.sourceSessionId === null)
    || typeof context.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(context.sourceFingerprint)
    || typeof context.ruleVersion !== 'string' || !context.ruleVersion.trim() || context.ruleVersion.length > 200
    || !Number.isSafeInteger(context.recordedAtMs) || context.recordedAtMs < 0
    || (context.isImportedClaim !== undefined && typeof context.isImportedClaim !== 'boolean')) throw new Error('训练对照标识、来源指纹或规则版本无效。')
  return { sessionId: context.sessionId, kind: context.kind, sourceSessionId: context.sourceSessionId,
    sourceFingerprint: context.sourceFingerprint, ruleVersion: context.ruleVersion, recordedAtMs: context.recordedAtMs,
    ...(context.isImportedClaim !== undefined ? { isImportedClaim: context.isImportedClaim } : {}) }
}

export function createSessionTrainingContext(sessionId: string, input: TrainingContextInput): SessionTrainingContext {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['kind', 'sourceSessionId', 'sourceFingerprint', 'ruleVersion'].includes(key))) throw new Error('新练习的训练对照信息只能包含类型、来源和规则版本。')
  return validateSessionTrainingContext({ ...input, sessionId, recordedAtMs: Date.now() })
}

export interface LibraryState { epoch: string; sequence: number; generation: number }
export type OnboardingStatus = 'completed' | 'skipped'
export interface SessionObservation { id: string; sessionId: string; recordedAtMs: number; timestampMs: number; frameIndex: number; reason: string }
export function validateSessionObservation(input: unknown): SessionObservation {
  if (!input || typeof input !== 'object') throw new Error('观察记录格式无效。')
  const observation = input as SessionObservation
  if (![observation.id, observation.sessionId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))
    || ![observation.recordedAtMs, observation.timestampMs, observation.frameIndex].every(item => Number.isSafeInteger(item) && item >= 0)) throw new Error('观察记录标识或进度无效。')
  return { id: observation.id, sessionId: observation.sessionId, recordedAtMs: observation.recordedAtMs,
    timestampMs: observation.timestampMs, frameIndex: observation.frameIndex, reason: text(observation.reason) }
}

export function readLibraryState(input: unknown): LibraryState {
  if (!input || typeof input !== 'object' || !('epoch' in input) || typeof input.epoch !== 'string'
    || !('sequence' in input) || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0
    || !('generation' in input) || !Number.isSafeInteger(input.generation) || Number(input.generation) < 0) {
    throw new Error('数据库状态索引损坏。原有数据没有被覆盖。')
  }
  return { epoch: input.epoch, sequence: Number(input.sequence), generation: Number(input.generation) }
}

export function createSessionSummary(input: unknown, createdAtMs: number | null = null, savedAtMs: number | null = null, fallbackId = ''): SessionSummary {
  const unavailable: SessionSummary = {
    id: fallbackId, pair: null, mode: null, revision: null, currentTimestampMs: null, progressedFrameCount: null,
    tradeCount: null, hasOpenPosition: false, balanceUsd: null, datasetId: null, createdAtMs, savedAtMs, isCurrent: false,
    errorMessage: '练习摘要无法读取；原记录保留，请尝试读取或导出恢复材料。',
  }
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') return unavailable
  const snapshot = input as PracticeSnapshot
  unavailable.id = snapshot.id
  const lastFrame = Array.isArray(snapshot.frames) ? snapshot.frames.at(-1) : null
  const currentTimestampMs = snapshot.sourceState?.currentTimestampMs ?? lastFrame?.quote?.timestampMs
  if (!['EUR/USD', 'GBP/USD'].includes(snapshot.pair) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !snapshot.sourceState || !Number.isSafeInteger(snapshot.sourceState.frameIndex) || snapshot.sourceState.frameIndex < 0
    || !Number.isSafeInteger(currentTimestampMs) || !Array.isArray(snapshot.trades)
    || !snapshot.account || typeof snapshot.account.balanceUsd !== 'string' || ![1, 2, 3, 4].includes(snapshot.schemaVersion)) return unavailable
  const start = 'historyStart' in snapshot && snapshot.historyStart && typeof snapshot.historyStart === 'object'
    && 'startFrameIndex' in snapshot.historyStart && typeof snapshot.historyStart.startFrameIndex === 'number' ? snapshot.historyStart.startFrameIndex : 0
  return {
    ...unavailable, pair: snapshot.pair, mode: snapshot.schemaVersion === 4 ? 'historical' : 'simulation', revision: snapshot.revision,
    currentTimestampMs, progressedFrameCount: snapshot.sourceState.frameIndex - start + 1,
    tradeCount: snapshot.trades.length, hasOpenPosition: snapshot.account.position !== null, balanceUsd: snapshot.account.balanceUsd,
    datasetId: snapshot.schemaVersion === 4 ? snapshot.sourceState.datasetId : null, errorMessage: null,
  }
}

export function validateSessionSummary(input: unknown): SessionSummary {
  const fallbackId = input && typeof input === 'object' && 'id' in input ? String(input.id) : 'unknown'
  const unavailable = createSessionSummary(null, null, null, fallbackId)
  if (!input || typeof input !== 'object') return unavailable
  const summary = input as SessionSummary
  if (typeof summary.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(summary.id)
    || ![summary.createdAtMs, summary.savedAtMs].every(time => time === null || (Number.isSafeInteger(time) && Number(time) >= 0))) return unavailable
  if (summary.errorMessage !== null) return { ...unavailable, createdAtMs: summary.createdAtMs, savedAtMs: summary.savedAtMs }
  if (!['EUR/USD', 'GBP/USD'].includes(summary.pair ?? '') || !['simulation', 'historical'].includes(summary.mode ?? '')
    || ![summary.revision, summary.currentTimestampMs, summary.tradeCount].every(value => Number.isSafeInteger(value) && Number(value) >= 0)
    || !Number.isSafeInteger(summary.progressedFrameCount) || Number(summary.progressedFrameCount) < 1
    || typeof summary.hasOpenPosition !== 'boolean' || typeof summary.balanceUsd !== 'string'
    || (summary.datasetId !== null && typeof summary.datasetId !== 'string')) return unavailable
  return { ...summary, isCurrent: false }
}

function text(input: unknown): string {
  if (typeof input !== 'string' || input.length > TRADE_ANNOTATION_MAX_LENGTH) throw new Error('计划和备注须为不超过 2,000 字的文本。')
  return input
}
function plan(input: unknown): TradePlan {
  if (!input || typeof input !== 'object' || !('entryReason' in input) || !('exitPlan' in input)) throw new Error('交易计划格式无效。')
  return { entryReason: text(input.entryReason), exitPlan: text(input.exitPlan) }
}
export function validateTradeAnnotation(input: unknown): TradeAnnotation {
  if (!input || typeof input !== 'object') throw new Error('交易备注格式无效。')
  const annotation = input as TradeAnnotation
  if (![annotation.sessionId, annotation.tradeId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))
    || !Number.isSafeInteger(annotation.revision) || annotation.revision < 0 || !Number.isSafeInteger(annotation.updatedAtMs)
    || annotation.updatedAtMs < 0 || !Array.isArray(annotation.planRevisions) || annotation.planRevisions.length > 10_000) throw new Error('交易备注标识或版本无效。')
  const revisions = annotation.planRevisions.map((item, index) => {
    if (!item || !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision > annotation.revision
      || (index > 0 && item.revision <= annotation.planRevisions[index - 1]!.revision)
      || !Number.isSafeInteger(item.recordedAtMs) || item.recordedAtMs < 0 || typeof item.isBeforeEntry !== 'boolean'
      || (index > 0 && item.isBeforeEntry)) throw new Error('交易计划修订无效。')
    return { revision: item.revision, recordedAtMs: item.recordedAtMs, plan: plan(item.plan), isBeforeEntry: item.isBeforeEntry }
  })
  const firstPlan = annotation.firstPlan === null ? null : plan(annotation.firstPlan)
  if ((firstPlan !== null) !== (revisions[0]?.isBeforeEntry === true)
    || (firstPlan && JSON.stringify(firstPlan) !== JSON.stringify(revisions[0]!.plan))) throw new Error('首次计划与修订记录不一致。')
  return { sessionId: annotation.sessionId, tradeId: annotation.tradeId, revision: annotation.revision, firstPlan,
    planRevisions: revisions, exitNote: text(annotation.exitNote), updatedAtMs: annotation.updatedAtMs }
}

export function reviseTradeAnnotation(sessionId: string, tradeId: string, prior: TradeAnnotation | null, input: TradeAnnotationInput, isBeforeEntry: boolean): TradeAnnotation {
  if (input.expectedRevision !== (prior?.revision ?? null)) throw new Error('另一窗口已修改这笔备注，请重新读取后再保存；原备注没有被覆盖。')
  const updatedAtMs = Date.now()
  const revision = prior ? prior.revision + 1 : 0
  const previousPlan = prior?.planRevisions.at(-1)?.plan ?? { entryReason: '', exitPlan: '' }
  const nextPlan = { entryReason: input.entryReason === undefined ? previousPlan.entryReason : text(input.entryReason),
    exitPlan: input.exitPlan === undefined ? previousPlan.exitPlan : text(input.exitPlan) }
  const hasChangedPlan = JSON.stringify(nextPlan) !== JSON.stringify(previousPlan)
  const planRevisions = prior?.planRevisions.map(item => ({ ...item, plan: { ...item.plan } })) ?? []
  if (hasChangedPlan) planRevisions.push({ revision, recordedAtMs: updatedAtMs, plan: nextPlan, isBeforeEntry: !prior && isBeforeEntry })
  return validateTradeAnnotation({ sessionId, tradeId, revision,
    firstPlan: prior?.firstPlan ?? (!prior && isBeforeEntry && hasChangedPlan ? nextPlan : null), planRevisions,
    exitNote: input.exitNote === undefined ? prior?.exitNote ?? '' : text(input.exitNote), updatedAtMs })
}
