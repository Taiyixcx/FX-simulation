<script setup lang="ts">
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPnl, getPnlTone } from '../../priceFormatting'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
</script>

<template>
  <section v-if="session.accountMetrics" class="account-summary" aria-label="账户概况">
    <div class="account-metric equity-metric">
      <span class="metric-label">账户权益 <InfoTip label="了解账户权益">权益是账户余额加上当前持仓盈亏。平仓后，盈亏会结算到余额。</InfoTip></span>
      <strong class="number"><span>{{ formatUsd(session.accountMetrics.equityUsd).replace(' USD', '') }}</span><small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">账户余额</span>
      <strong class="number" data-testid="balance"><span>{{ formatUsd(session.accountMetrics.balanceUsd).replace(' USD', '') }}</span><small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">可用资金</span>
      <strong class="number"><span>{{ formatUsd(session.accountMetrics.availableFundsUsd).replace(' USD', '') }}</span><small>USD</small></strong>
    </div>
    <div class="account-metric">
      <span class="metric-label">资金占用 <InfoTip label="了解资金占用">本练习按交易金额占用资金，平仓后释放。资金占用不表示最大亏损。</InfoTip></span>
      <strong class="number"><span>{{ formatUsd(session.accountMetrics.reservedFundsUsd).replace(' USD', '') }}</span><small>USD</small></strong>
    </div>
    <div class="account-metric pnl-metric">
      <span class="metric-label">持仓盈亏</span>
      <strong class="number" :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)"><span>{{ formatPnl(session.accountMetrics.unrealizedPnlUsd).replace(' USD', '') }}</span><small>USD</small></strong>
    </div>
  </section>
</template>

<style scoped>
.account-summary { display: grid; grid-template-columns: minmax(0, 1.35fr) repeat(4, minmax(0, 1fr)); gap: 20px 0; align-items: center; padding: 22px 28px; border-bottom: 1px solid var(--line); }
.account-metric { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 0 24px; border-left: 1px solid var(--line); }
.account-metric:first-child { padding-left: 0; border-left: 0; }
.account-metric:last-child { padding-right: 0; }
.metric-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 1.5rem; color: var(--muted); font-size: .875rem; }
.account-metric strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font-size: 1.25rem; font-weight: 550; line-height: 1.3; letter-spacing: -.035em; }
.account-metric strong > span { min-width: 0; overflow-wrap: anywhere; }
.account-metric strong small { font-size: .8125rem; font-weight: 500; letter-spacing: .01em; color: var(--muted); }
.equity-metric strong { font-size: 2rem; font-weight: 600; letter-spacing: -.045em; }
@media (max-width: 1200px) { .account-metric { padding: 0 16px; } }
@media (max-width: 800px) {
  .account-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; padding: 22px 24px; }
  .account-metric { padding: 0; border: 0; gap: 5px; }
  .equity-metric { grid-column: 1 / -1; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
}
@media (max-width: 600px) { .account-summary { gap: 16px 12px; padding: 20px 16px; } }
@container workspace (max-width: 50rem) {
  .account-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; }
  .account-metric { padding: 0; border: 0; gap: 5px; }
  .equity-metric { grid-column: 1 / -1; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
}
@container workspace (max-width: 19rem) { .account-summary { grid-template-columns: minmax(0, 1fr); } }
</style>
