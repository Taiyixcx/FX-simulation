<script setup lang="ts">
import { computed } from 'vue'
import type { PracticeStatistics } from '../../engine/tradeStatistics'
import { formatPnl, formatUsd, getPnlTone } from '../../priceFormatting'
import AccountCurve from './AccountCurve.vue'

const props = defineProps<{ statistics: PracticeStatistics | null; isLoading: boolean; error: string; selectedTradeId?: string }>()
const emit = defineEmits<{ request: [] }>()
const selectedExcursion = computed(() => props.statistics?.excursions.find(item => item.tradeId === props.selectedTradeId))
</script>

<template>
  <details class="statistics-panel">
    <summary>本次练习统计</summary>
    <div class="statistics-actions"><p>仅统计当前练习已发生的行情与已结算交易。</p><button type="button" class="button-outline" :disabled="isLoading" @click="emit('request')">{{ isLoading ? '读取完整行情中…' : statistics ? '刷新统计' : '计算统计' }}</button></div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <template v-if="statistics">
      <dl class="statistics-grid">
        <div><dt>已结算笔数</dt><dd>{{ statistics.trades.tradeCount }}</dd></div>
        <div><dt>净已结算盈亏</dt><dd :class="getPnlTone(statistics.trades.netRealizedPnlUsd)">{{ formatPnl(statistics.trades.netRealizedPnlUsd) }}</dd></div>
        <div><dt>平均盈利</dt><dd>{{ statistics.trades.averageProfitUsd === null ? '无盈利样本' : formatPnl(statistics.trades.averageProfitUsd) }}</dd></div>
        <div><dt>平均亏损</dt><dd>{{ statistics.trades.averageLossUsd === null ? '无亏损样本' : formatPnl(statistics.trades.averageLossUsd) }}</dd></div>
        <div><dt>余额最大回撤</dt><dd>{{ formatUsd(statistics.balanceDrawdown.maximumUsd) }}</dd></div>
        <div><dt>权益最大回撤</dt><dd>{{ formatUsd(statistics.equityDrawdown.maximumUsd) }}</dd></div>
      </dl>
      <p class="result-distribution">结果分布：盈利 {{ statistics.trades.winningTradeCount }} 笔 / 亏损 {{ statistics.trades.losingTradeCount }} 笔 / 持平 {{ statistics.trades.flatTradeCount }} 笔。</p>
      <p class="statistics-note">余额回撤仅反映结算；权益回撤还包含浮动盈亏。权益按 {{ statistics.curve.length.toLocaleString('zh-CN') }} 个已发生分钟及交易操作计算，不推断缺口内风险。{{ statistics.equityDrawdown.hasNonPositiveEquity ? '样本中存在非正权益，请结合绝对金额理解。' : '' }}少量样本和盈利结果不能证明实盘能力。</p>
      <AccountCurve :curve="statistics.curve" />
      <div v-if="selectedExcursion" class="trade-excursion"><strong>当前复盘交易 · 分钟采样</strong><dl><div><dt>最大浮盈</dt><dd>{{ formatPnl(selectedExcursion.maximumFavorablePnlUsd) }}</dd></div><div><dt>最大浮亏</dt><dd>{{ formatPnl(selectedExcursion.maximumAdversePnlUsd) }}</dd></div><div><dt>可平仓报价采样</dt><dd>{{ selectedExcursion.sampleCount }} 根</dd></div></dl><p class="statistics-note">含入场点差成本，采用持仓方向对应的 Bid/Ask；不代表分钟内逐笔极值。{{ selectedExcursion.hasGap ? '持仓期间含时间缺口，其间波动无法还原。' : '' }}</p></div>
    </template>
  </details>
</template>

<style scoped>
.statistics-panel { border-top: 1px solid var(--line); margin-top: 16px; font-size: .8125rem; line-height: 1.7; }
summary { cursor: pointer; min-height: 44px; padding: 10px 0; font-weight: 600; }
.statistics-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); }
.statistics-actions button { min-height: 44px; font-size: .8125rem; }
.statistics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: 12px 24px; margin: 16px 0; }
dt { color: var(--muted); }
dd { margin: 4px 0 0; font-size: .9375rem; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.statistics-note { color: var(--muted); margin: 8px 0; }
.result-distribution { font-weight: 500; }
.trade-excursion { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; }
.trade-excursion dl { display: flex; flex-wrap: wrap; gap: 12px 28px; }
</style>
