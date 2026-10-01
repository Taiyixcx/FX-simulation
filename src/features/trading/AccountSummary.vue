<script setup lang="ts">
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPnl, getPnlTone } from '../../priceFormatting'

const session = useSessionStore()
</script>

<template>
  <section v-if="session.accountMetrics" class="account-summary" aria-label="账户概况">
    <div><span class="muted">余额</span><strong data-testid="balance">{{ formatUsd(session.accountMetrics.balanceUsd) }}</strong></div>
    <div><span class="muted">权益</span><strong>{{ formatUsd(session.accountMetrics.equityUsd) }}</strong></div>
    <div><span class="muted">可用资金</span><strong>{{ formatUsd(session.accountMetrics.availableFundsUsd) }}</strong></div>
    <div><span class="muted">持仓盈亏</span><strong :class="getPnlTone(session.accountMetrics.unrealizedPnlUsd)">{{ formatPnl(session.accountMetrics.unrealizedPnlUsd) }}</strong></div>
  </section>
</template>

<style scoped>
.account-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 24px 28px; border-bottom: 1px solid var(--line); }
.account-summary div { display: grid; gap: 3px; min-width: 0; }
.account-summary span { font-size: 0.875rem; }
.account-summary strong { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@media (max-width: 960px) { .account-summary { grid-template-columns: repeat(2, 1fr); padding: 20px; } }
@media (max-width: 480px) { .account-summary { gap: 16px 12px; padding: 16px; } .account-summary strong { font-size: 1.0625rem; } }
</style>
