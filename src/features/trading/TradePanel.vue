<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { openPosition } from '../../engine/execution'
import type { TradeDirection } from '../../engine/types'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
const emit = defineEmits<{ 'request-recovery-focus': [] }>()
const notionalUsd = ref('1000')
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
  await session.openTrade(direction, notionalUsd.value)
  const openedPosition = position.value
  if (session.saveStatus === 'saved' && openedPosition && openedPosition.id !== previousPositionId) {
    showFeedback(`已${direction === 'long' ? '买涨' : '买跌'} · 成交价 ${formatPrice(openedPosition.entryPrice)}`)
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
onBeforeUnmount(clearFeedback)
</script>

<template>
  <aside class="trade-panel" aria-labelledby="trade-title">
    <section id="trade-amount" class="order-section" aria-labelledby="trade-title">
      <div class="panel-heading"><h2 id="trade-title">下单</h2><span class="panel-caption">市价成交<InfoTip label="了解买涨和买跌">买涨（做多）按 Ask 买入、按 Bid 平仓；买跌（做空）按 Bid 卖出、按 Ask 平仓。平仓时结算盈亏。</InfoTip></span></div>
      <div class="amount-label"><label for="notional-usd">交易金额<span class="sr-only">（USD）</span></label><InfoTip label="了解交易金额">本练习按交易金额占用资金，平仓后释放。这个金额不表示最大亏损。</InfoTip></div>
      <div class="amount-input" :class="{ 'has-error': !!inputError, 'is-disabled': !session.canOperate || !!position }">
        <input id="notional-usd" ref="amountInput" v-model="notionalUsd" type="text" inputmode="decimal" autocomplete="off" :disabled="!session.canOperate || !!position" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'amount-error order-note' : 'order-note'" />
        <span aria-hidden="true">USD</span>
      </div>
      <div class="quick-amounts" aria-label="快捷交易金额"><button v-for="amount in ['100', '500', '1000']" :key="amount" :aria-pressed="notionalUsd === amount" :disabled="!session.canOperate || !!position" @click="notionalUsd = amount">{{ amount }}</button></div>
      <p v-if="inputError" id="amount-error" class="amount-error error-text" role="alert">{{ inputError }}</p>
      <div class="order-buttons">
        <button class="order-button buy-button" aria-label="买涨（做多）" :aria-describedby="position || session.saveStatus === 'error' ? 'order-note' : undefined" :disabled="!canOpen" @click="placeOrder('long')">
          <span class="order-direction"><Icon name="arrow-up-right" :size="18" />买涨 <small>做多</small></span>
          <span v-if="session.currentQuote" class="order-price number"><span>Ask</span><span>{{ formatPrice(session.currentQuote.askPrice) }}</span></span>
        </button>
        <button class="order-button sell-button" aria-label="买跌（做空）" :aria-describedby="position || session.saveStatus === 'error' ? 'order-note' : undefined" :disabled="!canOpen" @click="placeOrder('short')">
          <span class="order-direction"><Icon name="arrow-down-right" :size="18" />买跌 <small>做空</small></span>
          <span v-if="session.currentQuote" class="order-price number"><span>Bid</span><span>{{ formatPrice(session.currentQuote.bidPrice) }}</span></span>
        </button>
      </div>
      <p id="order-note" class="order-note" :class="{ 'is-restricted': !!position || session.saveStatus === 'error' }">{{ orderNote }}</p>
    </section>
    <section class="position-section" aria-labelledby="position-title">
      <div class="panel-heading"><h2 id="position-title" ref="positionTitle" tabindex="-1">当前持仓</h2><span v-if="position" class="position-count">1 笔</span></div>
      <template v-if="position && session.accountMetrics">
        <div class="position-direction"><strong>{{ position.pair }}</strong><span class="direction-tag" :class="position.direction === 'long' ? 'long-tag' : 'short-tag'">{{ position.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span></div>
        <div class="position-profit" :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)">
          <span class="profit-label">浮动盈亏 <InfoTip label="了解持仓盈亏与点差">持仓盈亏按当前平仓报价计算。刚开仓时的浮亏来自 Bid 与 Ask 的点差，未额外扣费。</InfoTip></span>
          <strong class="number" data-testid="position-pnl"><span>{{ formatPnl(session.accountMetrics.unrealizedPnlUsd).replace(' USD', '') }}</span><small>USD</small></strong>
        </div>
        <dl class="tabular">
          <div><dt>开仓价</dt><dd>{{ formatPrice(position.entryPrice) }}</dd></div>
          <div><dt>资金占用</dt><dd>{{ formatUsd(position.notionalUsd) }}</dd></div>
          <div><dt>开仓时间</dt><dd>{{ formatTimestamp(position.openedAtMs) }}</dd></div>
        </dl>
        <button class="close-position" aria-label="平仓" :aria-describedby="session.currentQuote ? 'close-quote' : undefined" :disabled="!session.canOperate" @click="closeOrder"><span>平仓</span><span class="close-action-detail"><span v-if="session.currentQuote" id="close-quote" class="number">{{ position.direction === 'long' ? 'Bid' : 'Ask' }} {{ formatPrice(position.direction === 'long' ? session.currentQuote.bidPrice : session.currentQuote.askPrice) }}</span><Icon name="arrow-right" :size="16" /></span></button>
      </template>
      <div v-else class="empty-position"><span class="empty-position-icon"><Icon name="activity" :size="22" /></span><strong>暂无持仓</strong><p>选择买涨或买跌<br />在这里查看持仓与盈亏</p></div>
      <p class="action-feedback" role="status" aria-live="polite"><Icon v-if="successFeedback" name="check" :size="14" /><span>{{ successFeedback }}<template v-if="settledPnlUsd !== null"> · <span :class="getPnlTone(settledPnlUsd)">{{ formatPnl(settledPnlUsd) }}</span></template></span></p>
    </section>
  </aside>
</template>

<style scoped>
.trade-panel { padding: 20px; border-left: 1px solid var(--line); min-width: 0; background: var(--surface-soft); }
.order-section { min-width: 0; container: order-section / inline-size; scroll-margin-top: 24px; }
.panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.panel-heading h2 { font-size: 1rem; line-height: 1.5; }
.panel-caption { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: .875rem; }
.amount-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 12px 0 6px; font-size: .875rem; font-weight: 500; }
.amount-input { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); transition: border-color 140ms var(--ease); }
.amount-input:focus-within { border-color: var(--blue); outline: 2px solid var(--blue); outline-offset: 2px; }
.amount-input.has-error { border-color: var(--red); }
.amount-input input { width: 100%; min-width: 0; min-height: 54px; padding: 11px 14px; border: 0; background: transparent; border-radius: 8px; font-size: 1.25rem; font-weight: 550; font-variant-numeric: tabular-nums; }
.amount-input input:focus-visible { outline: none; }
.amount-input > span { color: var(--muted); margin-right: 14px; font-size: .875rem; font-weight: 500; }
.amount-input.is-disabled { background: var(--surface-soft); }
.amount-input input:disabled { color: var(--muted); }
.quick-amounts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
.quick-amounts button { min-width: 0; min-height: 36px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); font-size: .875rem; font-variant-numeric: tabular-nums; }
.quick-amounts button[aria-pressed="true"] { color: var(--blue); border-color: var(--blue); background: var(--blue-soft); }
.quick-amounts button:disabled { opacity: .65; }
.amount-error { margin-top: 8px; font-size: .875rem; overflow-wrap: anywhere; }
.order-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.order-button { min-width: 0; display: flex; align-items: center; flex-direction: column; gap: 5px; min-height: 68px; padding: 10px 6px; border: 1px solid transparent; border-radius: 8px; }
.buy-button { color: var(--green); background: var(--green-soft); border-color: #cce5dc; }
.sell-button { color: var(--red); background: var(--red-soft); border-color: #f0d4d3; }
.buy-button:disabled, .sell-button:disabled { opacity: .65; }
.order-direction { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px; font-size: 1rem; font-weight: 600; }
.order-direction small { font-size: .875rem; font-weight: 400; }
.order-price { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; font-size: .875rem; line-height: 1.4; }
.order-note { min-height: 1.4em; margin-top: 8px; color: var(--muted); font-size: .875rem; line-height: 1.4; overflow-wrap: anywhere; }
.order-note.is-restricted { color: var(--text); }
.position-section { min-width: 0; border-top: 1px solid var(--line); margin-top: 18px; padding-top: 18px; }
.position-count { padding: 2px 7px; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; background: var(--surface); font-size: .875rem; }
.position-direction { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.position-direction strong { font-size: 1rem; font-weight: 600; }
.direction-tag { padding: 3px 7px; border-radius: 5px; font-size: .875rem; font-weight: 500; }
.long-tag { color: var(--green); background: var(--green-soft); }
.short-tag { color: var(--red); background: var(--red-soft); }
.position-profit { display: grid; gap: 3px; margin-top: 12px; padding-left: 12px; border-left: 2px solid var(--line-strong); }
.position-profit.positive { border-color: var(--green); }
.position-profit.negative { border-color: var(--red); }
.profit-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--muted); font-size: .875rem; }
.position-profit strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font-size: 2rem; line-height: 1.25; font-weight: 550; letter-spacing: -.04em; }
.position-profit strong > span { min-width: 0; overflow-wrap: anywhere; }
.position-profit strong small { color: var(--muted); font-size: .875rem; font-weight: 500; letter-spacing: 0; }
dl { display: grid; gap: 4px; margin: 12px 0; font-size: .875rem; }
dl div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; }
dt { color: var(--muted); } dd { min-width: 0; margin: 0; text-align: right; overflow-wrap: anywhere; }
.close-position { width: 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 10px 12px; color: #fff; background: var(--text); border-color: var(--text); font-size: .875rem; }
.close-action-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: .875rem; font-weight: 400; }
.close-action-detail .number { overflow-wrap: anywhere; }
.close-position:hover:not(:disabled) { color: #fff; background: #28364a; border-color: #28364a; }
.close-position:active:not(:disabled) { background: #0c1522; border-color: #0c1522; }
.empty-position { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 28px 0 20px; }
.empty-position-icon { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--muted); }
.empty-position strong { margin-top: 12px; font-size: .875rem; font-weight: 500; }
.empty-position p { margin-top: 6px; color: var(--muted); font-size: .875rem; line-height: 1.6; }
.action-feedback { display: flex; align-items: flex-start; gap: 6px; min-height: 1.4em; margin-top: 8px; color: var(--muted); font-size: .875rem; line-height: 1.4; overflow-wrap: anywhere; }
.action-feedback .icon { margin-top: 3px; }
.action-feedback span { min-width: 0; }
.action-feedback:has(.icon) { animation: feedback-in 160ms var(--ease); }
@keyframes feedback-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@media (hover: hover) {
  .buy-button:hover:not(:disabled) { color: var(--green); background: #dceee5; border-color: var(--green); }
  .sell-button:hover:not(:disabled) { color: var(--red); background: #ffe5e3; border-color: var(--red); }
}
.buy-button:active:not(:disabled) { color: var(--green); background: #d1e8dd; border-color: var(--green); }
.sell-button:active:not(:disabled) { color: var(--red); background: #ffdcd9; border-color: var(--red); }
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
