<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Decimal from 'decimal.js'
import AccountSummary from './features/trading/AccountSummary.vue'
import TradePanel from './features/trading/TradePanel.vue'
import ReplayControls from './features/replay/ReplayControls.vue'
import TradeJournal from './features/journal/TradeJournal.vue'
import MarketChart from './features/chart/MarketChart.vue'
import { useSessionStore } from './stores/useSessionStore'
import type { CurrencyPair } from './engine/types'
import { formatPrice, formatTimestamp } from './priceFormatting'

const session = useSessionStore()
const chartType = ref<'line' | 'candlestick'>('line')
const saveLabel = computed(() => ({ idle: '等待保存', saving: '保存中…', saved: '已保存到本机', error: '保存失败' })[session.saveStatus])
const spreadPips = computed(() => session.currentQuote
  ? new Decimal(session.currentQuote.askPrice).minus(session.currentQuote.bidPrice).div('0.0001').toFixed(1)
  : '')

function changePair(event: Event) {
  const pair = (event.target as HTMLSelectElement).value as CurrencyPair
  void session.switchPair(pair)
}

function exportSnapshot() {
  const snapshotJson = session.exportSnapshotJson()
  if (!snapshotJson) return
  const url = URL.createObjectURL(new Blob([snapshotJson], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `fx-snapshot-${session.snapshot?.id ?? 'recovery'}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function warnUnsavedSnapshot(event: BeforeUnloadEvent) {
  if (session.saveStatus === 'saving' || session.saveStatus === 'error') {
    event.preventDefault()
    event.returnValue = ''
  }
}

onMounted(() => {
  void session.initialize()
  window.addEventListener('beforeunload', warnUnsavedSnapshot)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnUnsavedSnapshot)
  session.dispose()
})
</script>

<template>
  <main class="workspace">
    <header class="workspace-header">
      <div class="brand"><h1>FX 练习室</h1><span class="mode-label">模拟行情</span></div>
      <span class="save-status" role="status" :class="{ 'error-text': session.saveStatus === 'error' }" data-testid="save-status">{{ saveLabel }}</span>
    </header>
    <div v-if="session.loadStatus === 'loading'" class="loading" role="status">正在读取本机练习…</div>
    <section v-if="session.errorMessage" class="error-banner" aria-label="操作提示">
      <p role="alert">{{ session.errorMessage }}</p>
      <div class="recovery-actions">
        <button v-if="session.loadStatus === 'error'" :disabled="session.isBusy" @click="session.retryLoad()">重试读取</button>
        <button v-if="session.saveStatus === 'error'" :disabled="session.isBusy" @click="session.retrySave()">重试保存</button>
        <button v-if="session.saveStatus === 'error' || session.rawRecoveryJson" @click="exportSnapshot">导出当前快照</button>
      </div>
    </section>
    <template v-if="session.snapshot && session.currentQuote">
      <AccountSummary />
      <div class="trading-workspace">
        <section class="market-panel" aria-labelledby="market-title">
          <div class="market-heading">
            <div class="pair-select"><label for="currency-pair" class="sr-only">货币对</label><select id="currency-pair" :value="session.snapshot.pair" :disabled="!session.canOperate" @change="changePair"><option>EUR/USD</option><option>GBP/USD</option></select><h2 id="market-title" class="sr-only">行情图表</h2></div>
            <span class="muted source-label">生成的分钟行情 · 训练点差</span>
            <button class="new-session" :disabled="!session.canOperate" @click="session.startNewSession()">新练习</button>
          </div>
          <div class="quote-row tabular">
            <div><span class="muted">卖出价 Bid</span><strong data-testid="bid-price">{{ formatPrice(session.currentQuote.bidPrice) }}</strong></div>
            <div><span class="muted">买入价 Ask</span><strong data-testid="ask-price">{{ formatPrice(session.currentQuote.askPrice) }}</strong></div>
            <div class="spread"><span class="muted">点差</span><strong>{{ spreadPips }} <small>pip</small></strong></div>
            <time class="quote-time muted">{{ formatTimestamp(session.currentQuote.timestampMs) }} <span>UTC+8</span></time>
          </div>
          <MarketChart :frames="session.snapshot.frames" :position="session.snapshot.account.position" :trades="session.snapshot.trades" :session-id="session.snapshot.id" :chart-type="chartType" />
          <ReplayControls v-model:chart-type="chartType" />
          <p v-if="session.isEnded" class="end-message">行情已结束，仍可按最后报价平仓。点击“新练习”重新开始。</p>
        </section>
        <TradePanel />
      </div>
      <TradeJournal />
      <footer class="workspace-footer muted">训练账户 · 行情为生成数据，交易按当前 Bid/Ask 成交。新练习会保留旧记录，并使用独立资金。</footer>
    </template>
  </main>
</template>

<style scoped>
.workspace { max-width: 1600px; margin: 28px auto; background: var(--surface); border: 1px solid var(--line); min-width: 0; }
.workspace-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 28px; border-bottom: 1px solid var(--line); }
.brand { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }
.mode-label { color: #3c5e8c; font-size: 0.875rem; padding-left: 18px; border-left: 1px solid var(--line); }
.save-status { color: var(--muted); font-size: 0.875rem; }
.save-status.error-text { color: var(--negative); }
.trading-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 300px; }
.market-panel { padding: 24px 28px 20px; min-width: 0; }
.market-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.pair-select select { font-size: 1.125rem; font-weight: 600; }
.source-label { font-size: 0.875rem; }
.new-session { margin-left: auto; font-size: 0.875rem; }
.quote-row { display: flex; flex-wrap: wrap; align-items: end; gap: 24px; margin: 22px 0 18px; }
.quote-row div { display: grid; gap: 2px; }
.quote-row div > span { font-size: 0.875rem; }
.quote-row strong { font-size: 1.5625rem; font-weight: 500; }
.quote-row .spread strong { font-size: 1.25rem; }
.quote-row small { font-size: 0.875rem; font-weight: 400; color: var(--muted); }
.quote-time { margin-left: auto; font-size: 0.875rem; }
.quote-time span { font-size: 0.875rem; }
.error-banner { padding: 16px 28px; background: #fff3f3; border-bottom: 1px solid #edcdd1; color: var(--negative); }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.recovery-actions:has(button) { margin-top: 10px; }
.loading { padding: 60px 28px; }
.end-message { margin-top: 12px; font-size: 0.875rem; }
.workspace-footer { padding: 16px 28px; border-top: 1px solid var(--line); font-size: 0.875rem; }
@media(min-width: 1600px) { .workspace { margin: 32px auto; } }
@media(max-width: 1599px) { .workspace { margin: 20px; } }
@media(max-width: 960px) { .trading-workspace { grid-template-columns: 1fr; } .workspace-header, .market-panel, .workspace-footer, .error-banner { padding: 20px; } }
@media(max-width: 480px) { .workspace { margin: 0; border-left: 0; border-right: 0; } .workspace-header, .market-panel, .workspace-footer, .error-banner { padding: 16px; } .quote-row { gap: 12px 22px; } .quote-row strong { font-size: 1.375rem; } .quote-time { margin-left: 0; flex-basis: 100%; } .brand { gap: 10px; } .mode-label { padding-left: 10px; } }
</style>
