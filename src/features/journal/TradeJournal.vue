<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'
import Icon from '../../components/Icon.vue'

const session = useSessionStore()
const trades = computed(() => [...(session.snapshot?.trades ?? [])].reverse())
</script>

<template>
  <section class="trade-journal" aria-labelledby="journal-title">
    <div class="journal-heading"><div class="journal-title"><h2 id="journal-title">成交记录</h2><span class="trade-count number">{{ trades.length }}</span></div><span class="section-label">本次练习 · 已平仓</span></div>
    <div v-if="!trades.length" class="empty-journal"><span class="empty-icon"><Icon name="activity" :size="20" /></span><div><strong>暂无成交记录</strong><p>平仓后，成交价与盈亏会显示在这里</p></div></div>
    <template v-else>
      <div class="table-scroll" tabindex="0" role="region" aria-label="成交记录表，可横向滚动">
        <table>
          <thead><tr><th scope="col">方向</th><th scope="col" class="numeric-cell">交易金额</th><th scope="col" class="numeric-cell">开仓价</th><th scope="col" class="numeric-cell">平仓价</th><th scope="col" class="numeric-cell">已结算盈亏</th><th scope="col">开仓时间</th><th scope="col">平仓时间</th><th scope="col">平仓原因</th></tr></thead>
          <tbody><tr v-for="trade in trades" :key="trade.id">
            <td><span class="direction-tag" :class="trade.direction === 'long' ? 'long-tag' : 'short-tag'"><Icon :name="trade.direction === 'long' ? 'arrow-up-right' : 'arrow-down-right'" :size="14" />{{ trade.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span></td>
            <td class="numeric-cell number">{{ formatUsd(trade.notionalUsd) }}</td><td class="numeric-cell number">{{ formatPrice(trade.entryPrice) }}</td><td class="numeric-cell number">{{ formatPrice(trade.exitPrice) }}</td>
            <td class="numeric-cell number realized-pnl" :class="getPnlTone(trade.realizedPnlUsd)">{{ formatPnl(trade.realizedPnlUsd) }}</td><td class="number muted">{{ formatTimestamp(trade.openedAtMs) }}</td><td class="number muted">{{ formatTimestamp(trade.closedAtMs) }}</td><td class="muted">{{ trade.reason === 'manual' ? '手动平仓' : '权益耗尽' }}</td>
          </tr></tbody>
        </table>
      </div>
      <div class="mobile-trades">
        <details v-for="trade in trades" :key="trade.id" class="mobile-trade">
          <summary><span class="trade-overview"><span class="direction-tag" :class="trade.direction === 'long' ? 'long-tag' : 'short-tag'">{{ trade.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span><span class="number trade-notional">{{ formatUsd(trade.notionalUsd) }}</span></span><span class="trade-result"><strong class="number" :class="getPnlTone(trade.realizedPnlUsd)">{{ formatPnl(trade.realizedPnlUsd) }}</strong><span class="expand-icon"><Icon name="chevron-down" :size="16" /></span></span><span class="sr-only">查看成交详情</span></summary>
          <dl class="trade-details number"><div><dt>开仓价</dt><dd>{{ formatPrice(trade.entryPrice) }}</dd></div><div><dt>平仓价</dt><dd>{{ formatPrice(trade.exitPrice) }}</dd></div><div><dt>开仓时间</dt><dd>{{ formatTimestamp(trade.openedAtMs) }}</dd></div><div><dt>平仓时间</dt><dd>{{ formatTimestamp(trade.closedAtMs) }}</dd></div><div><dt>平仓原因</dt><dd>{{ trade.reason === 'manual' ? '手动平仓' : '权益耗尽' }}</dd></div></dl>
        </details>
      </div>
    </template>
  </section>
</template>

<style scoped>
.trade-journal { padding: 24px 28px; border-top: 1px solid var(--line); min-width: 0; }
.journal-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.journal-title { display: flex; align-items: center; gap: 8px; }
.trade-count { display: inline-grid; place-items: center; min-width: 24px; min-height: 24px; padding: 0 7px; border-radius: 6px; background: var(--surface-soft); color: var(--muted); font-size: .875rem; }
.empty-journal { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 24px 0 8px; }
.empty-icon { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 8px; background: var(--surface-soft); color: #95a4b8; }
.empty-journal strong { color: var(--muted); font-size: .875rem; font-weight: 500; }
.empty-journal p { margin-top: 3px; color: var(--muted); font-size: .875rem; }
.table-scroll { overflow-x: auto; margin-top: 20px; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: .875rem; font-variant-numeric: tabular-nums; text-align: left; }
th { font-weight: 500; color: var(--muted); background: var(--surface-soft); }
th, td { padding: 12px; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { padding-left: 12px; }
td { height: 56px; }
tbody tr:hover { background: var(--surface-soft); }
.numeric-cell { text-align: right; }
.realized-pnl { font-weight: 500; }
.direction-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 5px; font-size: .875rem; font-weight: 500; }
.long-tag { color: var(--green); background: #eaf6f1; }
.short-tag { color: var(--red); background: #fff0f0; }
.mobile-trades { display: none; margin-top: 16px; }
.mobile-trade { border-top: 1px solid var(--line); }
.mobile-trade:last-child { border-bottom: 1px solid var(--line); }
.mobile-trade summary { cursor: pointer; display: grid; gap: 12px; padding: 16px 0; list-style: none; }
.mobile-trade summary::-webkit-details-marker { display: none; }
.trade-overview, .trade-result { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.trade-notional { color: var(--muted); font-size: .875rem; overflow-wrap: anywhere; }
.trade-result strong { min-width: 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 500; }
.expand-icon { display: inline-flex; color: var(--muted); transition: transform 160ms; }
.mobile-trade[open] .expand-icon { transform: rotate(180deg); }
.trade-details { display: grid; gap: 12px; padding: 0 0 16px; margin: 0; font-size: .875rem; }
.trade-details div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 960px) { .trade-journal { padding: 24px 20px; } }
@media (max-width: 700px) { .table-scroll { display: none; } .mobile-trades { display: block; } .empty-journal { justify-content: flex-start; } }
@media (max-width: 480px) { .trade-journal { padding: 24px 16px; } }
</style>
