<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { openPosition } from '../../engine/execution'
import type { TradeDirection } from '../../engine/types'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
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
const successFeedback = ref('')
const feedbackAction = ref<'open' | 'close' | null>(null)
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function clearFeedback() {
  if (feedbackTimer !== null) clearTimeout(feedbackTimer)
  feedbackTimer = null
  successFeedback.value = ''
  feedbackAction.value = null
}

function showFeedback(message: string, action: 'open' | 'close') {
  clearFeedback()
  successFeedback.value = message
  feedbackAction.value = action
  feedbackTimer = setTimeout(clearFeedback, 4000)
}

async function placeOrder(direction: TradeDirection) {
  const previousPositionId = position.value?.id
  clearFeedback()
  await session.openTrade(direction, notionalUsd.value)
  const openedPosition = position.value
  if (session.saveStatus === 'saved' && openedPosition && openedPosition.id !== previousPositionId) {
    showFeedback(`已${direction === 'long' ? '买涨' : '买跌'} · 成交价 ${formatPrice(openedPosition.entryPrice)}`, 'open')
  }
}

async function closeOrder() {
  const closingPositionId = position.value?.id
  clearFeedback()
  await session.closeTrade()
  const closedTrade = session.snapshot?.trades.at(-1)
  if (session.saveStatus === 'saved' && closedTrade && closedTrade.id === closingPositionId && !position.value) {
    showFeedback(`已平仓 · ${formatPnl(closedTrade.realizedPnlUsd)}`, 'close')
  }
}

watch(() => session.snapshot?.id, clearFeedback)
onBeforeUnmount(clearFeedback)
</script>

<template>
  <aside class="trade-panel" aria-labelledby="trade-title">
    <div class="panel-heading"><h2 id="trade-title">下单</h2><span class="panel-caption">市价成交<InfoTip label="了解买涨和买跌">买涨（做多）按 Ask 买入、按 Bid 平仓；买跌（做空）按 Bid 卖出、按 Ask 平仓。平仓时结算盈亏。</InfoTip></span></div>
    <div class="amount-label"><label for="notional-usd">交易金额<span class="sr-only">（USD）</span></label><InfoTip label="了解交易金额">本练习按交易金额占用资金，平仓后释放。这个金额不表示最大亏损。</InfoTip></div>
    <div class="amount-input" :class="{ 'has-error': !!inputError, 'is-disabled': !session.canOperate || !!position }">
      <input id="notional-usd" v-model="notionalUsd" type="text" inputmode="decimal" autocomplete="off" :disabled="!session.canOperate || !!position" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'amount-error' : undefined" />
      <span aria-hidden="true">USD</span>
    </div>
    <div class="quick-amounts" aria-label="快捷交易金额"><button v-for="amount in ['100', '500', '1000']" :key="amount" :aria-pressed="notionalUsd === amount" :disabled="!session.canOperate || !!position" @click="notionalUsd = amount">{{ amount }}</button></div>
    <p v-if="inputError" id="amount-error" class="amount-error error-text" role="alert">{{ inputError }}</p>
    <div class="order-buttons">
      <button class="order-button buy-button" aria-label="买涨（做多）" :disabled="!canOpen" @click="placeOrder('long')">
        <span class="order-direction"><Icon name="arrow-up-right" :size="18" />买涨 <small>做多</small></span>
        <span v-if="session.currentQuote" class="order-price number"><span>Ask</span><span>{{ formatPrice(session.currentQuote.askPrice) }}</span></span>
      </button>
      <button class="order-button sell-button" aria-label="买跌（做空）" :disabled="!canOpen" @click="placeOrder('short')">
        <span class="order-direction"><Icon name="arrow-down-right" :size="18" />买跌 <small>做空</small></span>
        <span v-if="session.currentQuote" class="order-price number"><span>Bid</span><span>{{ formatPrice(session.currentQuote.bidPrice) }}</span></span>
      </button>
    </div>
    <p class="action-feedback" role="status">{{ feedbackAction === 'open' ? successFeedback : '' }}</p>
    <section class="position-section" aria-labelledby="position-title">
      <div class="panel-heading"><h2 id="position-title">当前持仓</h2><span v-if="position" class="position-count">1 笔</span></div>
      <template v-if="position && session.accountMetrics">
        <div class="position-direction"><strong>{{ position.pair }}</strong><span class="direction-tag" :class="position.direction === 'long' ? 'long-tag' : 'short-tag'">{{ position.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span></div>
        <div class="position-profit">
          <span class="profit-label">浮动盈亏 <InfoTip label="了解持仓盈亏与点差">持仓盈亏按当前平仓报价计算。刚开仓时的浮亏来自 Bid 与 Ask 的点差，未额外扣费。</InfoTip></span>
          <strong class="number" :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)" data-testid="position-pnl">{{ formatPnl(session.accountMetrics.unrealizedPnlUsd) }}</strong>
        </div>
        <dl class="tabular">
          <div><dt>开仓价</dt><dd>{{ formatPrice(position.entryPrice) }}</dd></div>
          <div><dt>资金占用</dt><dd>{{ formatUsd(position.notionalUsd) }}</dd></div>
          <div><dt>开仓时间</dt><dd>{{ formatTimestamp(position.openedAtMs) }}</dd></div>
        </dl>
        <button class="close-position button-outline" :disabled="!session.canOperate" @click="closeOrder">平仓 <Icon name="arrow-right" :size="16" /></button>
        <p v-if="session.currentQuote" class="close-price number">平仓报价 {{ position.direction === 'long' ? 'Bid' : 'Ask' }} {{ formatPrice(position.direction === 'long' ? session.currentQuote.bidPrice : session.currentQuote.askPrice) }}</p>
      </template>
      <div v-else class="empty-position"><span class="empty-position-icon"><Icon name="activity" :size="22" /></span><strong>暂无持仓</strong><p>选择方向，开始这次练习</p></div>
      <p class="action-feedback close-feedback" role="status">{{ feedbackAction === 'close' ? successFeedback : '' }}</p>
    </section>
  </aside>
</template>

<style scoped>
.trade-panel { padding: 24px; border-left: 1px solid var(--line); min-width: 0; container: trade-panel / inline-size; background: var(--surface-soft); }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel-heading h2 { font-size: 1rem; }
.panel-caption { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 0.875rem; }
.amount-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 20px 0 8px; font-size: 0.875rem; }
.amount-input { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); transition: border-color 160ms, box-shadow 160ms; }
.amount-input:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgb(59 91 219 / 10%); }
.amount-input.has-error { border-color: var(--red); }
.amount-input input { width: 100%; min-width: 0; min-height: 54px; padding: 11px 14px; border: 0; background: transparent; border-radius: 8px; font-size: 1.25rem; font-weight: 500; font-variant-numeric: tabular-nums; }
.amount-input input:focus-visible { outline: none; }
.amount-input > span { color: var(--muted); margin-right: 14px; font-size: 0.875rem; font-weight: 500; }
.amount-input.is-disabled { opacity: 0.65; }
.quick-amounts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 9px; }
.quick-amounts button { min-width: 0; min-height: 36px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--muted); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
.quick-amounts button[aria-pressed="true"] { color: var(--blue); border-color: #cbd5f7; background: var(--blue-soft); }
.amount-error { margin-top: 8px; font-size: 0.875rem; overflow-wrap: anywhere; }
.order-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
.order-button { min-width: 0; display: flex; align-items: center; flex-direction: column; gap: 6px; min-height: 74px; padding: 12px 5px; border: 1px solid transparent; border-radius: 8px; }
.buy-button { color: #fff; background: var(--green); }
.sell-button { color: #fff; background: var(--red); }
.buy-button:hover:not(:disabled), .sell-button:hover:not(:disabled) { filter: brightness(0.94); background: var(--green); border-color: transparent; }
.sell-button:hover:not(:disabled) { background: var(--red); }
.order-direction { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px; font-size: 1rem; font-weight: 600; }
.order-direction small { font-size: 0.875rem; font-weight: 400; opacity: 0.9; }
.order-price { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; font-size: 0.875rem; line-height: 1.4; opacity: 0.95; }
.action-feedback { min-height: 1.4em; margin-top: 8px; color: var(--green); font-size: 0.875rem; line-height: 1.4; overflow-wrap: anywhere; }
.position-section { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 16px; }
.position-count { padding: 2px 8px; color: var(--muted); border-radius: 5px; background: var(--surface); font-size: 0.875rem; }
.position-direction { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }
.position-direction strong { font-size: 1rem; font-weight: 600; }
.direction-tag { padding: 3px 7px; border-radius: 5px; font-size: 0.875rem; font-weight: 500; }
.long-tag { color: var(--green); background: #eaf6f1; }
.short-tag { color: var(--red); background: #fff0f0; }
.position-profit { display: grid; gap: 5px; margin-top: 12px; }
.profit-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--muted); font-size: 0.875rem; }
.position-profit strong { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.035em; overflow-wrap: anywhere; }
dl { display: grid; gap: 8px; margin: 16px 0; font-size: 0.875rem; }
dl div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.close-position { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; }
.close-price { margin-top: 8px; text-align: center; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
.empty-position { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px 0 14px; }
.empty-position-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; background: var(--surface); color: #95a4b8; }
.empty-position strong { margin-top: 12px; font-size: 0.875rem; font-weight: 500; }
.empty-position p { margin-top: 4px; color: var(--muted); font-size: 0.875rem; }
.close-feedback { text-align: center; }
@container trade-panel (max-width: 16rem) { .order-buttons { grid-template-columns: minmax(0, 1fr); } .order-button { flex-direction: row; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 12px; } .quick-amounts { grid-template-columns: repeat(auto-fit, minmax(4rem, 1fr)); } }
@media(max-width: 960px) {
  .trade-panel { border-left: 0; border-top: 1px solid var(--line); padding: 24px 20px; }
}
@media(max-width: 480px) { .trade-panel { padding: 24px 16px; } .order-button { min-height: 72px; } }
</style>
