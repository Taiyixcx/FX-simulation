<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { formatUsd, formatPrice, formatPnl, getPnlTone, formatTimestamp } from '../../priceFormatting'
import Icon from '../../components/Icon.vue'
import PracticeStatisticsPanel from './PracticeStatisticsPanel.vue'
import TradeAnnotationEditor from './TradeAnnotationEditor.vue'
import type { TradeRecord } from '../../engine/types'
import type { TradeAnnotationInput } from '../../storage/sessionMetadata'

const session = useSessionStore()
const emit = defineEmits<{ 'review-trade': [trade: TradeRecord, action?: 'open' | 'close'] }>()
const selectedTradeId = ref<string | null>(null)
const selectedTrade = computed(() => session.snapshot?.trades.find(trade => trade.id === selectedTradeId.value))
const annotationEditor = ref<InstanceType<typeof TradeAnnotationEditor> | null>(null)
const annotationMessage = ref('')
const annotationHasError = ref(false)
const isSavingAnnotation = ref(false)
function reviewTrade(trade: TradeRecord) { selectedTradeId.value = trade.id; annotationMessage.value = ''; annotationHasError.value = false; emit('review-trade', trade) }
async function saveAnnotation(input: TradeAnnotationInput) {
  if (!selectedTrade.value || isSavingAnnotation.value) return
  const tradeId = selectedTrade.value.id
  isSavingAnnotation.value = true
  annotationMessage.value = ''
  annotationHasError.value = false
  try {
    const saved = await session.saveTradeAnnotation(tradeId, input)
    if (selectedTrade.value?.id !== tradeId) return
    if (saved) {
      annotationMessage.value = '备注已保存到本机。'
      await nextTick()
      annotationEditor.value?.reload()
    } else { annotationHasError.value = true; annotationMessage.value = session.libraryErrorMessage || '备注没有保存，当前输入保留。' }
  } finally { isSavingAnnotation.value = false }
}
async function reloadAnnotation() {
  const tradeId = selectedTrade.value?.id
  isSavingAnnotation.value = true
  annotationHasError.value = false
  try {
    const loaded = await session.refreshCurrentMetadata()
    await nextTick()
    if (selectedTrade.value?.id !== tradeId) return
    if (loaded) { annotationEditor.value?.reload(); annotationMessage.value = '已读取保存版本。' }
    else { annotationHasError.value = true; annotationMessage.value = session.libraryErrorMessage || '读取失败，当前输入保留。' }
  }
  catch (error) { annotationHasError.value = true; annotationMessage.value = error instanceof Error ? error.message : '读取失败，当前输入保留。' }
  finally { isSavingAnnotation.value = false }
}
const currentPage = ref(1)
const PAGE_SIZE = 20
const tradeCount = computed(() => session.snapshot?.trades.length ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(tradeCount.value / PAGE_SIZE)))
const trades = computed(() => {
  const endIndex = tradeCount.value - (currentPage.value - 1) * PAGE_SIZE
  return (session.snapshot?.trades ?? []).slice(Math.max(0, endIndex - PAGE_SIZE), endIndex).reverse()
})
watch([() => session.snapshot?.id, tradeCount], () => { currentPage.value = 1 })
watch(() => session.snapshot?.id, () => { selectedTradeId.value = null; annotationMessage.value = '' })
</script>

<template>
  <section id="trade-journal" class="trade-journal" aria-labelledby="journal-title" tabindex="-1">
    <div class="journal-heading">
      <div class="journal-title"><h2 id="journal-title">成交记录</h2><span class="trade-count number">{{ tradeCount }}</span></div>
      <span class="section-label">本次练习 · 已平仓</span>
    </div>
    <div v-if="!trades.length" class="empty-journal">
      <span class="empty-icon"><Icon name="activity" :size="22" /></span>
      <div><strong>暂无成交记录</strong><p>平仓后，成交价与盈亏会显示在这里</p></div>
    </div>
    <template v-else>
      <div class="table-scroll" tabindex="0" role="region" aria-label="成交记录表，可横向滚动">
        <table aria-label="本次练习已平仓成交记录">
          <thead><tr><th scope="col">方向</th><th scope="col" class="numeric-cell">交易金额</th><th scope="col" class="numeric-cell">开仓价 / 时间</th><th scope="col" class="numeric-cell">平仓价 / 时间</th><th scope="col" class="numeric-cell">已结算盈亏</th><th scope="col">平仓原因</th></tr></thead>
          <tbody>
            <tr v-for="trade in trades" :key="trade.id">
              <td><span class="direction-tag" :class="trade.direction === 'long' ? 'long-tag' : 'short-tag'"><Icon :name="trade.direction === 'long' ? 'arrow-up-right' : 'arrow-down-right'" :size="14" />{{ trade.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span></td>
              <td class="numeric-cell number">{{ formatUsd(trade.notionalUsd) }}</td>
              <td class="numeric-cell number"><span class="cell-primary">{{ formatPrice(trade.entryPrice) }}</span><span class="cell-secondary">{{ formatTimestamp(trade.openedAtMs) }}</span></td>
              <td class="numeric-cell number"><span class="cell-primary">{{ formatPrice(trade.exitPrice) }}</span><span class="cell-secondary">{{ formatTimestamp(trade.closedAtMs) }}</span></td>
              <td class="numeric-cell number realized-pnl" :class="getPnlTone(trade.realizedPnlUsd)">{{ formatPnl(trade.realizedPnlUsd) }}</td>
              <td class="close-reason">{{ trade.reason === 'manual' ? '手动平仓' : '权益耗尽' }}<button type="button" class="review-trade-button button-quiet" :aria-label="`复盘${formatTimestamp(trade.openedAtMs)}的交易`" @click="reviewTrade(trade)">复盘 / 备注</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mobile-trades">
        <details v-for="trade in trades" :key="trade.id" class="mobile-trade">
          <summary>
            <span class="trade-overview"><span class="direction-tag" :class="trade.direction === 'long' ? 'long-tag' : 'short-tag'"><Icon :name="trade.direction === 'long' ? 'arrow-up-right' : 'arrow-down-right'" :size="14" />{{ trade.direction === 'long' ? '买涨 · 做多' : '买跌 · 做空' }}</span><span class="number trade-notional">{{ formatUsd(trade.notionalUsd) }}</span></span>
            <span class="trade-result"><strong class="number" :class="getPnlTone(trade.realizedPnlUsd)">{{ formatPnl(trade.realizedPnlUsd) }}</strong><span class="expand-icon"><Icon name="chevron-down" :size="16" /></span></span>
            <span class="sr-only">查看成交详情</span>
          </summary>
          <dl class="trade-details number"><div><dt>开仓价</dt><dd>{{ formatPrice(trade.entryPrice) }}</dd></div><div><dt>平仓价</dt><dd>{{ formatPrice(trade.exitPrice) }}</dd></div><div><dt>开仓时间</dt><dd>{{ formatTimestamp(trade.openedAtMs) }}</dd></div><div><dt>平仓时间</dt><dd>{{ formatTimestamp(trade.closedAtMs) }}</dd></div><div><dt>平仓原因</dt><dd>{{ trade.reason === 'manual' ? '手动平仓' : '权益耗尽' }}</dd></div></dl>
          <button type="button" class="review-trade-button button-outline" :aria-label="`复盘${formatTimestamp(trade.openedAtMs)}的交易`" @click="reviewTrade(trade)">复盘 / 备注</button>
        </details>
      </div>
      <nav v-if="pageCount > 1" class="journal-pagination" aria-label="成交记录分页">
        <button type="button" class="button-outline" :disabled="currentPage === 1" @click="currentPage -= 1">上一页</button>
        <span class="number" role="status">第 {{ currentPage }} / {{ pageCount }} 页</span>
        <button type="button" class="button-outline" :disabled="currentPage === pageCount" @click="currentPage += 1">下一页</button>
      </nav>
    </template>
    <section v-if="selectedTrade" class="trade-review" aria-label="选中交易复盘">
      <div class="review-heading"><h3>{{ selectedTrade.direction === 'long' ? '买涨' : '买跌' }} · {{ formatTimestamp(selectedTrade.openedAtMs) }}</h3><div class="review-actions"><button type="button" class="button-quiet" @click="emit('review-trade', selectedTrade, 'open')">定位开仓</button><button type="button" class="button-quiet" @click="emit('review-trade', selectedTrade, 'close')">定位平仓</button><button type="button" class="button-quiet" @click="selectedTradeId = null">收起备注</button></div></div>
      <p class="review-outcome">结果：<strong :class="getPnlTone(selectedTrade.realizedPnlUsd)">{{ formatPnl(selectedTrade.realizedPnlUsd) }}</strong></p>
      <p class="review-note">本笔按 {{ selectedTrade.direction === 'long' ? 'Ask 买入' : 'Bid 卖出' }} {{ formatPrice(selectedTrade.entryPrice) }} 开仓，按 {{ selectedTrade.direction === 'long' ? 'Bid 卖出' : 'Ask 买入' }} {{ formatPrice(selectedTrade.exitPrice) }} 平仓。持仓数量固定为 {{ selectedTrade.quantityBaseUnits }} {{ selectedTrade.pair.split('/')[0] }}；USD 盈亏按实际报价结算到分。</p>
      <p class="review-note">过程：回看当时信息与事前计划，再记录实际退出原因。盈亏不等于是否遵守计划；买涨按 Ask 入、Bid 出，买跌按 Bid 入、Ask 出，点差不再另外扣费。</p>
      <TradeAnnotationEditor :key="selectedTrade.id" ref="annotationEditor" :trade-id="selectedTrade.id" :annotation="session.tradeAnnotations[selectedTrade.id] ?? null" :disabled="isSavingAnnotation || !session.canOperate" :is-closed="true" :message="annotationMessage" :has-error="annotationHasError" @save="saveAnnotation" @reload="reloadAnnotation" />
    </section>
    <PracticeStatisticsPanel :statistics="session.practiceStatistics" :is-loading="session.isStatisticsLoading" :error="session.statisticsError" :selected-trade-id="selectedTradeId ?? undefined" @request="session.loadPracticeStatistics()" />
  </section>
</template>

<style scoped>
.trade-journal { padding: 22px 24px 24px; border-top: 1px solid var(--line); min-width: 0; scroll-margin-top: 24px; }
.review-trade-button { display: block; margin-top: 5px; min-height: 36px; font-size: .8125rem; padding: 5px 8px; }
.trade-review { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 12px; }
.review-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.review-heading h3 { margin: 0; font-size: .9375rem; }
.review-heading button { min-height: 44px; font-size: .8125rem; }
.review-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.review-outcome { margin: 8px 0; font-size: .875rem; }
.review-note { color: var(--muted); font-size: .8125rem; line-height: 1.7; overflow-wrap: anywhere; }
.journal-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 16px; color: var(--muted); font-size: .875rem; }
.journal-pagination button { min-height: 44px; }
.journal-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.journal-title { display: flex; align-items: center; gap: 8px; }
.journal-title h2 { font-weight: 700; letter-spacing: -.015em; }
.trade-count { display: inline-grid; place-items: center; min-width: 24px; min-height: 24px; padding: 0 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--blue-soft); color: var(--muted); font-size: .75rem; font-weight: 600; }
.empty-journal { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 28px 0 12px; }
.empty-icon { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--muted); }
.empty-journal strong { color: var(--text); font-size: .875rem; font-weight: 600; }
.empty-journal p { margin-top: 4px; color: var(--muted); font-size: .8125rem; line-height: 1.7; }
.table-scroll { overflow-x: auto; margin-top: 18px; border-top: 1px solid var(--line); }
table { width: 100%; min-width: 760px; border-collapse: collapse; white-space: nowrap; font-size: .875rem; font-variant-numeric: tabular-nums; text-align: left; }
th { font-size: .8125rem; font-weight: 600; color: var(--muted); background: var(--surface-soft); letter-spacing: 0; }
th, td { padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th:first-child, td:first-child { padding-left: 12px; }
th:last-child, td:last-child { padding-right: 12px; }
td { height: 68px; transition: background-color 140ms var(--ease, ease); }
tbody tr:hover td { background: var(--surface-soft); }
.numeric-cell { text-align: right; }
.cell-primary, .cell-secondary { display: block; }
.cell-primary { font-weight: 600; }
.cell-secondary { margin-top: 4px; color: var(--muted); font-size: .8125rem; letter-spacing: 0; }
.close-reason { color: var(--muted); font-size: .8125rem; }
.realized-pnl { font-weight: 600; }
.direction-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 5px; font-size: .8125rem; font-weight: 600; white-space: nowrap; }
.direction-tag :deep(svg) { flex: none; }
.long-tag { color: var(--green); background: var(--green-soft); }
.short-tag { color: var(--red); background: var(--red-soft); }
.mobile-trades { display: none; margin-top: 16px; }
.mobile-trade { border-top: 1px solid var(--line); }
.mobile-trade:last-child { border-bottom: 1px solid var(--line); }
.mobile-trade summary { cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 12px; min-height: 76px; padding: 16px 0; list-style: none; }
.mobile-trade summary::-webkit-details-marker { display: none; }
.trade-overview { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; min-width: 0; }
.trade-result { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.trade-notional { color: var(--muted); font-size: .8125rem; line-height: 1.5; overflow-wrap: anywhere; }
.trade-result strong { min-width: 0; overflow-wrap: anywhere; text-align: right; font-size: .875rem; font-weight: 600; }
.expand-icon { display: inline-flex; flex: none; color: var(--muted); transition: transform 160ms var(--ease, ease); }
.mobile-trade[open] .expand-icon { transform: rotate(180deg); }
.trade-details { display: grid; gap: 12px; padding: 0 0 18px; margin: 0; font-size: .8125rem; line-height: 1.6; letter-spacing: 0; }
.trade-details div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
dt { color: var(--muted); }
dd { min-width: 0; max-width: 100%; margin: 0; text-align: right; font-weight: 500; overflow-wrap: anywhere; }
@media (max-width: 960px) { .trade-journal { padding: 24px 20px; } }
@media (max-width: 700px) { .table-scroll { display: none; } .mobile-trades { display: block; } .empty-journal { justify-content: flex-start; } }
@media (max-width: 480px) { .trade-journal { padding: 24px 16px; } }
@media (max-width: 380px) { .mobile-trade summary { grid-template-columns: minmax(0, 1fr); } .trade-overview { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; } .trade-result { justify-content: space-between; } .trade-result strong { text-align: left; } }
@media (prefers-reduced-motion: reduce) { td, .expand-icon { transition: none; } }
</style>
