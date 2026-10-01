<script setup lang="ts">
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPnl, getPnlTone } from '../../priceFormatting'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
</script>

<template>
  <section v-if="session.accountMetrics" class="account-summary" aria-label="账户概况">
    <div class="account-metric">
      <span class="metric-label">账户余额</span>
      <strong class="number" data-testid="balance">{{ formatUsd(session.accountMetrics.balanceUsd).replace(' USD', '') }}<small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">账户权益 <InfoTip label="了解账户权益">权益是账户余额加上当前持仓盈亏。平仓后，盈亏会结算到余额。</InfoTip></span>
      <strong class="number">{{ formatUsd(session.accountMetrics.equityUsd).replace(' USD', '') }}<small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">可用资金</span>
      <strong class="number">{{ formatUsd(session.accountMetrics.availableFundsUsd).replace(' USD', '') }}<small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">资金占用 <InfoTip label="了解资金占用">本练习按交易金额占用资金，平仓后释放。资金占用不表示最大亏损。</InfoTip></span>
      <strong class="number">{{ formatUsd(session.accountMetrics.reservedFundsUsd).replace(' USD', '') }}<small>USD</small></strong>
    </div>
    <div class="account-metric pnl-metric">
      <span class="metric-label">持仓盈亏</span>
      <strong class="number" :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)">{{ formatPnl(session.accountMetrics.unrealizedPnlUsd).replace(' USD', '') }}<small>USD</small></strong>
    </div>
  </section>
</template>

<style scoped>
.account-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); row-gap: 20px; padding: 24px 28px; border-bottom: 1px solid var(--line); }
.account-metric { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 0 20px; border-left: 1px solid var(--line); }
.account-metric:first-child { padding-left: 0; border-left: 0; }
.account-metric:last-child { padding-right: 0; }
.metric-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 1.75rem; color: var(--muted); font-size: 0.875rem; }
.account-metric strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 1.625rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.045em; overflow-wrap: anywhere; }
.account-metric strong small { font-size: 0.875rem; font-weight: 500; letter-spacing: 0.02em; color: var(--muted); }
@media (max-width: 1200px) { .account-metric { padding: 0 12px; } }
@media (max-width: 800px) {
  .account-summary { gap: 18px 24px; padding: 22px 20px; }
  .account-metric { padding: 0; border: 0; gap: 5px; }
  .pnl-metric { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; justify-content: space-between; align-items: center; border-top: 1px solid var(--line); padding-top: 14px; gap: 12px; }
  .pnl-metric .metric-label { flex: none; }
}
@media (max-width: 480px) { .account-summary { gap: 16px 12px; padding: 20px 16px; } }
</style>
