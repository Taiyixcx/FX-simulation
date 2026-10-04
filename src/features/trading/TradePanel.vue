<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { openPosition, previewPositionRisk, previewTradeRisk } from '../../engine/execution'
import type { PositionRiskPreview, TradeRiskPreview } from '../../engine/execution'
import Decimal from 'decimal.js'
import TradeAnnotationEditor from '../journal/TradeAnnotationEditor.vue'
import { TRADE_ANNOTATION_MAX_LENGTH } from '../../storage/sessionMetadata'
import type { TradeAnnotationInput } from '../../storage/sessionMetadata'
import type { TradeDirection } from '../../engine/types'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
const emit = defineEmits<{ 'request-recovery-focus': [] }>()
const notionalUsd = ref('1000')
const entryReason = ref('')
const exitPlan = ref('')
const riskDirection = ref<TradeDirection>('long')
const hypotheticalExitPrice = ref('')
const positionHypotheticalExitPrice = ref('')
const positionRiskResult = computed<{ preview: PositionRiskPreview | null; error: string }>(() => {
  if (!session.snapshot?.account.position || !session.currentQuote) return { preview: null, error: '' }
  try { return { preview: previewPositionRisk(session.snapshot.account, session.currentQuote, positionHypotheticalExitPrice.value), error: '' } }
  catch (error) { return { preview: null, error: error instanceof Error ? error.message : '请检查假设退出报价。' } }
})
const riskResult = computed<{ preview: TradeRiskPreview | null; error: string }>(() => {
  if (!session.snapshot || !session.currentQuote || session.snapshot.account.position) return { preview: null, error: '' }
  try { return { preview: previewTradeRisk(session.snapshot.account, session.currentQuote, session.snapshot.pair, riskDirection.value, notionalUsd.value, hypotheticalExitPrice.value), error: '' } }
  catch (error) { return { preview: null, error: error instanceof Error ? error.message : '请检查预览金额与报价。' } }
})
const riskError = computed(() => riskResult.value.error)
const riskPreview = computed(() => riskResult.value.preview)
function readAdmission(direction: TradeDirection): TradeRiskPreview | null {
  if (!session.snapshot || !session.currentQuote || session.snapshot.account.position) return null
  try { return previewTradeRisk(session.snapshot.account, session.currentQuote, session.snapshot.pair, direction, notionalUsd.value) }
  catch { return null }
}
const longAdmission = computed(() => readAdmission('long'))
const shortAdmission = computed(() => readAdmission('short'))
function canOpenDirection(direction: TradeDirection): boolean {
  return canOpen.value && (direction === 'long' ? longAdmission.value : shortAdmission.value)?.canOpen === true
}
function formatRiskNumber(input: string, decimalPlaces: number): string { return new Decimal(input).toFixed(decimalPlaces) }
const annotationEditor = ref<InstanceType<typeof TradeAnnotationEditor> | null>(null)
const annotationMessage = ref('')
const annotationHasError = ref(false)
const isSavingAnnotation = ref(false)
async function savePositionAnnotation(input: TradeAnnotationInput) {
  if (!position.value || isSavingAnnotation.value) return
  isSavingAnnotation.value = true
  annotationMessage.value = ''
  annotationHasError.value = false
  try {
    if (await session.saveTradeAnnotation(position.value.id, input)) { annotationMessage.value = '计划修订已保存到本机。'; await nextTick(); annotationEditor.value?.reload() }
    else { annotationHasError.value = true; annotationMessage.value = session.libraryErrorMessage || '计划未保存，当前输入保留。' }
  } finally { isSavingAnnotation.value = false }
}
async function reloadPositionAnnotation() {
  const positionId = position.value?.id
  isSavingAnnotation.value = true
  annotationHasError.value = false
  try {
    const loaded = await session.refreshCurrentMetadata()
    await nextTick()
    if (position.value?.id !== positionId) return
    if (loaded) { annotationEditor.value?.reload(); annotationMessage.value = '已读取保存版本。' }
    else { annotationHasError.value = true; annotationMessage.value = session.libraryErrorMessage || '读取失败，当前输入保留。' }
  }
  catch (error) { annotationHasError.value = true; annotationMessage.value = error instanceof Error ? error.message : '读取失败，当前输入保留。' }
  finally { isSavingAnnotation.value = false }
}
const inputError = computed(() => {
  if (!session.snapshot || !session.currentQuote || session.snapshot.account.position) return ''
  try {
    openPosition(session.snapshot.account, session.currentQuote, session.snapshot.pair, 'long', notionalUsd.value, 'preview')
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : '请检查交易金额。'
  }
})
const canOpen = computed(() => session.canOperate && !session.snapshot?.account.position && !inputError.value)
const position = computed(() => session.snapshot?.account.position)
const orderNote = computed(() => {
  if (session.saveStatus === 'error') return '请先重试本机保存，再继续交易。'
  if (position.value) return '当前已有持仓，请先平仓。'
  if (longAdmission.value?.rejectionMessage && shortAdmission.value?.rejectionMessage) return longAdmission.value.rejectionMessage
  if (longAdmission.value?.rejectionMessage) return `买涨不可用：${longAdmission.value.rejectionMessage}`
  if (shortAdmission.value?.rejectionMessage) return `买跌不可用：${shortAdmission.value.rejectionMessage}`
  return '资金按交易金额占用，平仓后释放。'
})
const amountInput = ref<HTMLInputElement | null>(null)
const positionTitle = ref<HTMLHeadingElement | null>(null)
const successFeedback = ref('')
const settledPnlUsd = ref<string | null>(null)
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function clearFeedback() {
  if (feedbackTimer !== null) clearTimeout(feedbackTimer)
  feedbackTimer = null
  successFeedback.value = ''
  settledPnlUsd.value = null
}

function showFeedback(message: string, realizedPnlUsd: string | null = null) {
  clearFeedback()
  successFeedback.value = message
  settledPnlUsd.value = realizedPnlUsd
  feedbackTimer = setTimeout(clearFeedback, 4000)
}

function focusVisibleControl(target: HTMLElement | null) {
  if (!target) return
  target.focus({ preventScroll: true })
  const bounds = target.getBoundingClientRect()
  if (bounds.top < 0 || bounds.bottom > window.innerHeight) target.scrollIntoView({ block: 'nearest' })
}

async function placeOrder(direction: TradeDirection) {
  const previousPositionId = position.value?.id
  clearFeedback()
  await session.openTrade(direction, notionalUsd.value, { entryReason: entryReason.value, exitPlan: exitPlan.value })
  const openedPosition = position.value
  if (session.saveStatus === 'saved' && openedPosition && openedPosition.id !== previousPositionId) {
    showFeedback(`已${direction === 'long' ? '买涨' : '买跌'} · 成交价 ${formatPrice(openedPosition.entryPrice)}`)
    entryReason.value = ''
    exitPlan.value = ''
    await nextTick()
    focusVisibleControl(positionTitle.value)
  } else if (session.saveStatus === 'error') {
    await nextTick()
    emit('request-recovery-focus')
  }
}

async function closeOrder() {
  const closingPositionId = position.value?.id
  clearFeedback()
  await session.closeTrade()
  const closedTrade = session.snapshot?.trades.at(-1)
  if (session.saveStatus === 'saved' && closedTrade && closedTrade.id === closingPositionId && !position.value) {
    showFeedback('已平仓', closedTrade.realizedPnlUsd)
    await nextTick()
    focusVisibleControl(amountInput.value)
  } else if (session.saveStatus === 'error') {
    await nextTick()
    emit('request-recovery-focus')
  }
}

watch(() => session.snapshot?.id, clearFeedback)
watch(() => session.snapshot?.id, () => { entryReason.value = ''; exitPlan.value = ''; hypotheticalExitPrice.value = ''; annotationMessage.value = '' })
watch(() => position.value?.id, () => { positionHypotheticalExitPrice.value = ''; annotationMessage.value = '' })
onBeforeUnmount(clearFeedback)
</script>

<template>
  <aside class="trade-panel" aria-labelledby="trade-title">
    <section id="trade-amount" class="order-section" aria-labelledby="trade-title">
      <div class="panel-heading"><h2 id="trade-title">下单</h2><span class="panel-caption">市价成交<InfoTip label="了解买涨和买跌">买涨（做多）按 Ask 买入、按 Bid 平仓；买跌（做空）按 Bid 卖出、按 Ask 平仓。平仓时结算盈亏。</InfoTip></span></div>
      <p v-if="session.isReviewing" class="learning-note">正在复盘旧行情；账户未回滚，下单和平仓仍按当前末根报价，不按图表选中时间成交。</p>
      <div class="amount-label"><label for="notional-usd">交易金额<span class="sr-only">（USD）</span></label><InfoTip label="了解交易金额">本练习按交易金额占用资金，平仓后释放。这个金额不表示最大亏损。</InfoTip></div>
      <div class="amount-input" :class="{ 'has-error': !!inputError, 'is-disabled': !session.canOperate || !!position }">
        <input id="notional-usd" ref="amountInput" v-model="notionalUsd" type="text" inputmode="decimal" autocomplete="off" :disabled="!session.canOperate || !!position" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'amount-error order-note' : 'order-note'" />
        <span aria-hidden="true">USD</span>
      </div>
      <div class="quick-amounts" aria-label="快捷交易金额"><button v-for="amount in ['100', '500', '1000']" :key="amount" :aria-pressed="notionalUsd === amount" :disabled="!session.canOperate || !!position" @click="notionalUsd = amount">{{ amount }}</button></div>
      <p v-if="inputError" id="amount-error" class="amount-error error-text" role="alert">{{ inputError }}</p>
      <div class="order-buttons">
          <button class="order-button buy-button" aria-label="买涨（做多）" :aria-describedby="position || session.saveStatus === 'error' ? 'order-note' : undefined" :disabled="!canOpenDirection('long')" @click="placeOrder('long')">
          <span class="order-direction"><Icon name="arrow-up-right" :size="18" />买涨 <small>做多</small></span>
          <span v-if="session.currentQuote" class="order-price number"><span>Ask</span><span>{{ formatPrice(session.currentQuote.askPrice) }}</span></span>
        </button>
        <button class="order-button sell-button" aria-label="买跌（做空）" :aria-describedby="position || session.saveStatus === 'error' ? 'order-note' : undefined" :disabled="!canOpenDirection('short')" @click="placeOrder('short')">
          <span class="order-direction"><Icon name="arrow-down-right" :size="18" />买跌 <small>做空</small></span>
          <span v-if="session.currentQuote" class="order-price number"><span>Bid</span><span>{{ formatPrice(session.currentQuote.bidPrice) }}</span></span>
        </button>
      </div>
      <p id="order-note" class="order-note" :class="{ 'is-restricted': !!position || session.saveStatus === 'error' }">{{ orderNote }}</p>
      <details v-if="!position" class="trade-learning">
        <summary>风险预览与事前计划（可跳过）</summary>
        <label for="risk-direction">预览方向</label><select id="risk-direction" v-model="riskDirection" :disabled="!session.canOperate"><option value="long">买涨 · 用 Bid 假设平仓</option><option value="short">买跌 · 用 Ask 假设平仓</option></select>
        <label for="hypothetical-exit">假设平仓 {{ riskDirection === 'long' ? 'Bid' : 'Ask' }} 报价</label><input id="hypothetical-exit" v-model="hypotheticalExitPrice" inputmode="decimal" type="text" placeholder="可选，例如 1.08500" :disabled="!session.canOperate" />
        <dl v-if="riskPreview" class="risk-readout">
          <div><dt>持仓数量（{{ session.snapshot?.pair.split('/')[0] }}）</dt><dd>{{ formatRiskNumber(riskPreview.quantityBaseUnits, 2) }}</dd></div>
          <div><dt>每 pip 美元变化</dt><dd>{{ formatRiskNumber(riskPreview.usdPerPip, 4) }} USD</dd></div>
          <div><dt>立即平仓结果</dt><dd :class="getPnlTone(riskPreview.immediateClosePnlUsd)">{{ formatPnl(riskPreview.immediateClosePnlUsd) }}</dd></div>
          <div v-if="riskPreview.hypotheticalPnlUsd !== null"><dt>假设平仓结果</dt><dd :class="getPnlTone(riskPreview.hypotheticalPnlUsd)">{{ formatPnl(riskPreview.hypotheticalPnlUsd) }}</dd></div>
        </dl>
        <p v-if="riskError || riskPreview?.rejectionMessage" class="error-text preview-error" role="status">{{ riskError || riskPreview?.rejectionMessage }}</p>
        <p class="learning-note">预览使用实际方向和报价关系，未另外扣点差。假设报价和计划价不是自动订单，不保证最大亏损。</p>
        <label for="planned-entry-reason">下单前进场理由（可选）</label><textarea id="planned-entry-reason" v-model="entryReason" rows="2" :maxlength="TRADE_ANNOTATION_MAX_LENGTH" :disabled="!session.canOperate" />
        <label for="planned-exit-condition">计划退出条件（可选）</label><textarea id="planned-exit-condition" v-model="exitPlan" rows="2" :maxlength="TRADE_ANNOTATION_MAX_LENGTH" :disabled="!session.canOperate" />
        <p class="learning-note">随本次开仓保存首次计划，之后修订单独保留。</p>
      </details>
    </section>
    <section class="position-section" aria-labelledby="position-title">
      <div class="panel-heading"><h2 id="position-title" ref="positionTitle" tabindex="-1">当前持仓</h2><span v-if="position" class="position-count">1 笔</span></div>
      <template v-if="position && session.accountMetrics">
        <div class="position-direction"><strong>{{ position.pair }}</strong><span class="direction-tag" :class="position.direction === 'long' ? 'long-tag' : 'short-tag'">{{ position.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span></div>
        <div class="position-profit" :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)">
          <span class="profit-label">浮动盈亏 <InfoTip label="了解持仓盈亏与点差">持仓盈亏按当前平仓报价计算。刚开仓时的浮亏来自 Bid 与 Ask 的点差，未额外扣费。</InfoTip></span>
          <strong class="number" data-testid="position-pnl"><span>{{ formatPnl(session.accountMetrics.unrealizedPnlUsd, false) }}</span><small>USD</small></strong>
        </div>
        <dl class="tabular">
          <div><dt>开仓价</dt><dd>{{ formatPrice(position.entryPrice) }}</dd></div>
          <div><dt>资金占用</dt><dd>{{ formatUsd(position.notionalUsd) }}</dd></div>
          <div><dt>开仓时间</dt><dd>{{ formatTimestamp(position.openedAtMs) }}</dd></div>
        </dl>
        <button class="close-position" aria-label="平仓" :aria-describedby="session.currentQuote ? 'close-quote' : undefined" :disabled="!session.canOperate" @click="closeOrder"><span>平仓</span><span class="close-action-detail"><span v-if="session.currentQuote" id="close-quote" class="number">{{ position.direction === 'long' ? 'Bid' : 'Ask' }} {{ formatPrice(position.direction === 'long' ? session.currentQuote.bidPrice : session.currentQuote.askPrice) }}</span><Icon name="arrow-right" :size="16" /></span></button>
        <details class="trade-learning"><summary>持仓金额与假设退出</summary>
          <label for="position-hypothetical-exit">假设平仓 {{ position.direction === 'long' ? 'Bid' : 'Ask' }} 报价</label><input id="position-hypothetical-exit" v-model="positionHypotheticalExitPrice" inputmode="decimal" type="text" placeholder="可选，输入可平仓一侧报价" />
          <dl v-if="positionRiskResult.preview"><div><dt>持仓数量（{{ position.pair.split('/')[0] }}）</dt><dd>{{ formatRiskNumber(positionRiskResult.preview.quantityBaseUnits, 2) }}</dd></div><div><dt>每 pip 美元变化</dt><dd>{{ formatRiskNumber(positionRiskResult.preview.usdPerPip, 4) }} USD</dd></div><div><dt>按当前报价平仓</dt><dd :class="getPnlTone(positionRiskResult.preview.immediateClosePnlUsd)">{{ formatPnl(positionRiskResult.preview.immediateClosePnlUsd) }}</dd></div><div v-if="positionRiskResult.preview.hypotheticalPnlUsd !== null"><dt>按假设报价平仓</dt><dd :class="getPnlTone(positionRiskResult.preview.hypotheticalPnlUsd)">{{ formatPnl(positionRiskResult.preview.hypotheticalPnlUsd) }}</dd></div></dl>
          <p v-if="positionRiskResult.error" class="error-text" role="status">{{ positionRiskResult.error }}</p><p class="learning-note">假设价只帮助理解结果，不会设置订单或保证退出报价。</p>
        </details>
        <details class="trade-learning"><summary>查看与修订本笔计划</summary><TradeAnnotationEditor :key="position.id" ref="annotationEditor" :trade-id="position.id" :annotation="session.tradeAnnotations[position.id] ?? null" :disabled="isSavingAnnotation || !session.canOperate" :is-closed="false" :message="annotationMessage" :has-error="annotationHasError" @save="savePositionAnnotation" @reload="reloadPositionAnnotation" /></details>
      </template>
      <div v-else class="empty-position"><span class="empty-position-icon"><Icon name="activity" :size="22" /></span><strong>暂无持仓</strong><p>选择买涨或买跌<br />在这里查看持仓与盈亏</p></div>
      <p class="action-feedback" role="status" aria-live="polite"><Icon v-if="successFeedback" name="check" :size="14" /><span>{{ successFeedback }}<template v-if="settledPnlUsd !== null"> · <span :class="getPnlTone(settledPnlUsd)">{{ formatPnl(settledPnlUsd) }}</span></template></span></p>
    </section>
  </aside>
</template>

<style scoped>
.trade-panel { padding: 24px; border-left: 1px solid var(--line); min-width: 0; background: var(--surface-soft); }
.trade-learning { font-size: .8125rem; line-height: 1.7; margin-top: 10px; border-top: 1px solid var(--line); }
.trade-learning summary { cursor: pointer; min-height: 44px; padding: 10px 0; font-weight: 500; }
.trade-learning > label { display: block; margin: 9px 0 5px; }
.trade-learning > input, .trade-learning > select, .trade-learning > textarea { display: block; width: 100%; min-width: 0; max-width: 100%; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: 8px 10px; }
.trade-learning > textarea { resize: vertical; line-height: 1.6; }
.learning-note { color: var(--muted); font-size: .8125rem; margin: 8px 0; }
.preview-error { margin: 8px 0; overflow-wrap: anywhere; }
.order-section { min-width: 0; container: order-section / inline-size; scroll-margin-top: 24px; }
.panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.panel-heading h2 { font-size: 1rem; font-weight: 700; line-height: 1.5; letter-spacing: -.015em; }
.panel-caption { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: .8125rem; }
.amount-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 16px 0 7px; font-size: .875rem; font-weight: 600; }
.amount-input { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); transition: border-color 140ms var(--ease); }
.amount-input:focus-within { border-color: var(--blue); outline: 2px solid var(--blue); outline-offset: 2px; }
.amount-input.has-error { border-color: var(--red); }
.amount-input input { width: 100%; min-width: 0; min-height: 50px; padding: 10px 12px; border: 0; background: transparent; border-radius: 8px; font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.amount-input input:focus-visible { outline: none; }
.amount-input > span { color: var(--muted); margin-right: 12px; font-size: .8125rem; font-weight: 600; letter-spacing: .02em; }
.amount-input.is-disabled { background: var(--surface-soft); }
.amount-input input:disabled { color: var(--muted); }
.quick-amounts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.quick-amounts button { min-width: 0; min-height: 36px; padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); color: var(--muted); font-size: .8125rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.quick-amounts button[aria-pressed="true"] { color: var(--blue); border-color: var(--blue); background: var(--blue-soft); }
.quick-amounts button:disabled { opacity: .65; }
.amount-error { margin-top: 8px; font-size: .875rem; overflow-wrap: anywhere; }
.order-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.order-button { min-width: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 6px; min-height: 72px; padding: 10px 6px; border: 1px solid transparent; border-radius: 8px; }
.buy-button { color: var(--green); background: #d8eddf; border-color: #9cc7ac; }
.sell-button { color: var(--red); background: #fbdee7; border-color: #e6aabd; }
.buy-button:disabled, .sell-button:disabled { opacity: .65; }
.order-direction { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px; font-size: 1rem; font-weight: 700; }
.order-direction small { font-size: .8125rem; font-weight: 500; }
.order-price { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; font-size: .8125rem; font-weight: 500; line-height: 1.4; letter-spacing: 0; }
.order-note { min-height: 1.5em; margin-top: 10px; color: var(--muted); font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.order-note.is-restricted { color: var(--text); }
.position-section { min-width: 0; border-top: 1px solid var(--line); margin-top: 20px; padding-top: 20px; }
.position-count { padding: 2px 7px; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; background: var(--surface); font-size: .75rem; font-weight: 600; }
.position-direction { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.position-direction strong { font-size: .9375rem; font-weight: 700; }
.direction-tag { padding: 4px 8px; border-radius: 5px; font-size: .8125rem; font-weight: 600; }
.long-tag { color: var(--green); background: var(--green-soft); }
.short-tag { color: var(--red); background: var(--red-soft); }
.position-profit { display: grid; gap: 4px; margin-top: 16px; padding-left: 12px; border-left: 2px solid var(--line-strong); }
.position-profit.positive { border-color: var(--green); }
.position-profit.negative { border-color: var(--red); }
.profit-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--muted); font-size: .8125rem; }
.position-profit strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font-size: 1.875rem; line-height: 1.25; font-weight: 600; letter-spacing: -.04em; }
.position-profit strong > span { min-width: 0; overflow-wrap: anywhere; }
.position-profit strong small { color: var(--muted); font-size: .8125rem; font-weight: 500; letter-spacing: 0; }
dl { display: grid; gap: 8px; margin: 16px 0; font-size: .8125rem; line-height: 1.5; letter-spacing: 0; }
dl div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; }
dt { color: var(--muted); } dd { min-width: 0; max-width: 100%; margin: 0; text-align: right; font-weight: 500; overflow-wrap: anywhere; }
.close-position { width: 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 10px 12px; color: #fff; background: var(--text); border-color: var(--text); font-size: .875rem; font-weight: 600; }
.close-action-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; font-size: .8125rem; font-weight: 500; }
.close-action-detail .number { overflow-wrap: anywhere; }
.close-position:hover:not(:disabled) { color: #fff; background: #345250; border-color: #345250; }
.close-position:active:not(:disabled) { background: #203331; border-color: #203331; }
.empty-position { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px 0 12px; }
.empty-position-icon { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--muted); }
.empty-position strong { margin-top: 10px; font-size: .875rem; font-weight: 600; }
.empty-position p { margin-top: 5px; color: var(--muted); font-size: .8125rem; line-height: 1.7; }
.action-feedback { display: flex; align-items: flex-start; gap: 6px; min-height: 1.5em; margin-top: 8px; color: var(--muted); font-size: .8125rem; line-height: 1.5; overflow-wrap: anywhere; }
.action-feedback .icon { margin-top: 3px; }
.action-feedback span { min-width: 0; }
.action-feedback:has(.icon) { animation: feedback-in 160ms var(--ease); }
@keyframes feedback-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@media (hover: hover) {
  .buy-button:hover:not(:disabled) { color: var(--green); background: #cce6d5; border-color: var(--green); }
  .sell-button:hover:not(:disabled) { color: var(--red); background: #f7cfdd; border-color: var(--red); }
}
.buy-button:active:not(:disabled) { color: var(--green); background: #c0dfca; border-color: var(--green); }
.sell-button:active:not(:disabled) { color: var(--red); background: #f4c3d4; border-color: var(--red); }
@container order-section (max-width: 16rem) { .order-buttons { grid-template-columns: minmax(0, 1fr); } .order-button { flex-direction: row; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 12px; } .quick-amounts { grid-template-columns: repeat(auto-fit, minmax(4rem, 1fr)); } }
@media (max-width: 1100px) {
  .trade-panel { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; border-left: 0; border-top: 1px solid var(--line); padding: 24px; }
  .position-section { border-top: 0; border-left: 1px solid var(--line); margin-top: 0; padding-top: 0; padding-left: 24px; }
}
@media (max-width: 600px) {
  .trade-panel { grid-template-columns: minmax(0, 1fr); gap: 24px; padding: 24px 16px; }
  .position-section { border-left: 0; border-top: 1px solid var(--line); padding: 24px 0 0; }
  .quick-amounts button { min-height: 44px; }
  .order-button { min-height: 76px; }
}
@media (prefers-reduced-motion: reduce) { .action-feedback:has(.icon) { animation: none; } }
</style>
