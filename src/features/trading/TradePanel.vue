<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { openPosition } from '../../engine/execution'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'

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
</script>

<template>
  <aside class="trade-panel" aria-labelledby="trade-title">
    <h2 id="trade-title">下单</h2>
    <p class="trade-intro muted">选择方向，按当前报价成交。</p>
    <label for="notional-usd">交易金额（USD）</label>
    <input id="notional-usd" v-model="notionalUsd" type="text" inputmode="decimal" autocomplete="off" :disabled="!session.canOperate || !!position" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'amount-error' : 'amount-help'" />
    <div class="quick-amounts" aria-label="快捷交易金额"><button v-for="amount in ['100', '500', '1000']" :key="amount" :disabled="!session.canOperate || !!position" @click="notionalUsd = amount">{{ amount }}</button></div>
    <p v-if="inputError" id="amount-error" class="error-text" role="alert">{{ inputError }}</p>
    <p id="amount-help" class="muted small">资金占用按交易金额计算；这不是最大亏损。</p>
    <div class="order-buttons">
      <button class="primary" :disabled="!canOpen" @click="session.openTrade('long', notionalUsd)">买涨（做多）</button>
      <button :disabled="!canOpen" @click="session.openTrade('short', notionalUsd)">买跌（做空）</button>
    </div>
    <p v-if="session.currentQuote" class="muted small">做多按 Ask {{ formatPrice(session.currentQuote.askPrice) }} 买入；做空按 Bid {{ formatPrice(session.currentQuote.bidPrice) }} 卖出。</p>
    <section class="position-section" aria-labelledby="position-title">
      <h2 id="position-title">当前持仓</h2>
      <template v-if="position && session.accountMetrics">
        <p class="position-direction">{{ position.direction === 'long' ? '买涨（做多）' : '买跌（做空）' }} <span class="muted">{{ position.pair }}</span></p>
        <dl class="tabular">
          <div><dt>开仓价</dt><dd>{{ formatPrice(position.entryPrice) }}</dd></div>
          <div><dt>资金占用</dt><dd>{{ formatUsd(position.notionalUsd) }}</dd></div>
          <div><dt>开仓时间</dt><dd>{{ formatTimestamp(position.openedAtMs) }}</dd></div>
          <div><dt>当前盈亏</dt><dd :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)" data-testid="position-pnl">{{ formatPnl(session.accountMetrics.unrealizedPnlUsd) }}</dd></div>
        </dl>
        <p class="muted small">开仓后的点差浮亏来自买卖报价差，未额外扣费。</p>
        <button class="close-position" :disabled="!session.canOperate" @click="session.closeTrade()">平仓</button>
        <p v-if="session.currentQuote" class="muted small">按{{ position.direction === 'long' ? ' Bid ' : ' Ask ' }}{{ formatPrice(position.direction === 'long' ? session.currentQuote.bidPrice : session.currentQuote.askPrice) }} 平仓。</p>
      </template>
      <p v-else class="empty-position muted">暂无持仓。可先开仓，再推进行情观察盈亏。</p>
    </section>
  </aside>
</template>

<style scoped>
.trade-panel { padding: 24px; border-left: 1px solid var(--line); min-width: 0; }
.trade-intro { margin: 4px 0 20px; font-size: 0.875rem; }
label { display: block; margin-bottom: 8px; font-size: 0.875rem; }
input { width: 100%; font-size: 1.25rem; font-variant-numeric: tabular-nums; padding: 10px 12px; }
.quick-amounts { display: flex; gap: 8px; margin: 10px 0; }
.quick-amounts button { flex: 1; min-width: 0; }
.small, .error-text { font-size: 0.875rem; overflow-wrap: anywhere; }
.order-buttons { display: grid; gap: 10px; margin: 20px 0 12px; }
.position-section { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 22px; }
.position-direction { margin-top: 12px; font-weight: 600; }
.position-direction span { font-size: 0.875rem; font-weight: 400; }
dl { font-size: 0.875rem; margin: 14px 0; }
dl div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.close-position { width: 100%; margin: 14px 0 8px; border-color: #7190c4; color: #1c4b9e; }
.empty-position { padding-top: 16px; font-size: 0.875rem; }
@media(max-width: 960px) { .trade-panel { border-left: 0; border-top: 1px solid var(--line); padding: 20px; } .order-buttons { grid-template-columns: repeat(2, 1fr); } }
@media(max-width: 480px) { .trade-panel { padding: 16px; } .order-buttons { grid-template-columns: 1fr; } }
</style>
