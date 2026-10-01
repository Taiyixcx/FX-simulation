<script setup lang="ts">
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'

const session = useSessionStore()
</script>

<template>
  <section class="trade-journal" aria-labelledby="journal-title">
    <div class="journal-heading"><h2 id="journal-title">成交记录</h2><span class="muted">本次练习 · {{ session.snapshot?.trades.length ?? 0 }} 笔已平仓</span></div>
    <p v-if="!session.snapshot?.trades.length" class="empty-journal muted">平仓后，可在这里查看成交价和已结算盈亏。</p>
    <div v-else class="table-scroll" tabindex="0" role="region" aria-label="成交记录表，可横向滚动">
      <table>
        <thead><tr><th>方向</th><th>交易金额</th><th>开仓价</th><th>平仓价</th><th>已结算盈亏</th><th>开仓时间</th><th>平仓时间</th><th>平仓原因</th></tr></thead>
        <tbody><tr v-for="trade in [...session.snapshot.trades].reverse()" :key="trade.id">
          <td>{{ trade.direction === 'long' ? '买涨（做多）' : '买跌（做空）' }}</td><td>{{ formatUsd(trade.notionalUsd) }}</td><td>{{ formatPrice(trade.entryPrice) }}</td><td>{{ formatPrice(trade.exitPrice) }}</td>
          <td :class="getPnlTone(trade.realizedPnlUsd)">{{ formatPnl(trade.realizedPnlUsd) }}</td><td>{{ formatTimestamp(trade.openedAtMs) }}</td><td>{{ formatTimestamp(trade.closedAtMs) }}</td><td>{{ trade.reason === 'manual' ? '手动平仓' : '权益耗尽' }}</td>
        </tr></tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.trade-journal { padding: 24px 28px 30px; border-top: 1px solid var(--line); min-width: 0; }
.journal-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; }
.journal-heading span { font-size: 0.875rem; }
.empty-journal { padding-top: 22px; font-size: 0.875rem; }
.table-scroll { overflow-x: auto; margin-top: 18px; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: 0.875rem; font-variant-numeric: tabular-nums; text-align: left; }
th { font-weight: 500; color: var(--muted); background: #f7f9fc; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { padding-left: 0; }
@media(max-width: 960px) { .trade-journal { padding: 20px; } }
@media(max-width: 480px) { .trade-journal { padding: 16px; } }
</style>
