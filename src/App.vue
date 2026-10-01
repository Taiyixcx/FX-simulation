<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Decimal from 'decimal.js'
import AccountSummary from './features/trading/AccountSummary.vue'
import TradePanel from './features/trading/TradePanel.vue'
import ReplayControls from './features/replay/ReplayControls.vue'
import TradeJournal from './features/journal/TradeJournal.vue'
import MarketChart from './features/chart/MarketChart.vue'
import Icon from './components/Icon.vue'
import InfoTip from './components/InfoTip.vue'
import { useSessionStore } from './stores/useSessionStore'
import type { CurrencyPair } from './engine/types'
import { formatPrice } from './priceFormatting'

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
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="M6 20V8h7M6 14h6M15 20l7-12M16 8l6 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
        <h1>FX 练习室</h1>
        <span class="workspace-name">交易工作台</span>
      </div>
      <span class="save-status" role="status" :class="{ 'error-text': session.saveStatus === 'error', 'is-saving': session.saveStatus === 'saving' }" data-testid="save-status"><Icon :name="session.saveStatus === 'saved' ? 'check' : session.saveStatus === 'error' ? 'info' : 'clock'" :size="16" />{{ saveLabel }}</span>
    </header>
    <div v-if="session.loadStatus === 'loading'" class="loading" role="status"><span class="loading-symbol"><Icon name="activity" :size="28" /></span><strong>正在读取本机练习</strong><span class="muted">准备行情与账户…</span></div>
    <section v-if="session.errorMessage" class="error-banner" aria-label="操作提示">
      <p role="alert"><Icon name="info" />{{ session.errorMessage }}</p>
      <div class="recovery-actions">
        <button v-if="session.loadStatus === 'error'" class="button-outline" :disabled="session.isBusy" @click="session.retryLoad()"><Icon name="refresh" :size="16" />重试读取</button>
        <button v-if="session.saveStatus === 'error'" class="button-outline" :disabled="session.isBusy" @click="session.retrySave()"><Icon name="refresh" :size="16" />重试保存</button>
        <button v-if="session.saveStatus === 'error' || session.rawRecoveryJson" class="button-outline" @click="exportSnapshot"><Icon name="download" :size="16" />导出当前快照</button>
      </div>
    </section>
    <template v-if="session.snapshot && session.currentQuote">
      <AccountSummary />
      <div class="trading-workspace">
        <section class="market-panel" aria-labelledby="market-title">
          <div class="market-heading">
            <div class="market-identity">
              <div class="pair-select"><label for="currency-pair" class="sr-only">货币对</label><select id="currency-pair" :value="session.snapshot.pair" :disabled="!session.canOperate" @change="changePair"><option>EUR/USD</option><option>GBP/USD</option></select><Icon name="chevron-down" :size="16" /><h2 id="market-title" class="sr-only">行情图表</h2></div>
              <span class="source-label"><span class="status-dot" />模拟行情</span>
              <InfoTip label="模拟行情说明">行情由本机生成，每根代表一分钟，不是真实历史价格。图表只展示已经推进的行情。新练习会保留旧记录，并使用独立训练资金。</InfoTip>
            </div>
            <div class="market-tools">
              <div class="chart-types" role="group" aria-label="图表类型">
                <button :aria-pressed="chartType === 'line'" @click="chartType = 'line'"><Icon name="chart-line" :size="16" />折线</button>
                <button :aria-pressed="chartType === 'candlestick'" @click="chartType = 'candlestick'"><Icon name="candles" :size="16" />K 线</button>
              </div>
              <button class="new-session button-quiet" :disabled="!session.canOperate" @click="session.startNewSession()"><Icon name="plus" :size="16" />新练习</button>
            </div>
          </div>
          <div class="quote-row tabular">
            <div class="quote"><span class="quote-label">卖出价 <span>Bid</span></span><strong data-testid="bid-price">{{ formatPrice(session.currentQuote.bidPrice) }}</strong></div>
            <div class="quote"><span class="quote-label">买入价 <span>Ask</span></span><strong data-testid="ask-price">{{ formatPrice(session.currentQuote.askPrice) }}</strong></div>
            <div class="spread"><span class="spread-label">点差<InfoTip label="点差说明">Ask 是买入报价，Bid 是卖出报价。两者之差为点差；开仓后立即显示小幅亏损，是买卖报价不同的结果，系统不会重复扣除点差。</InfoTip></span><strong>{{ spreadPips }} <small>pip</small></strong></div>
          </div>
          <MarketChart :frames="session.snapshot.frames" :position="session.snapshot.account.position" :trades="session.snapshot.trades" :session-id="session.snapshot.id" :chart-type="chartType" />
          <ReplayControls />
          <p v-if="session.isEnded" class="end-message" role="status"><Icon name="check" :size="16" />本轮行情已结束，仍可按最后报价平仓。</p>
        </section>
        <TradePanel />
      </div>
      <TradeJournal />
    </template>
  </main>
</template>

<style scoped>
.workspace { max-width: 1600px; margin: 24px auto; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: 0 8px 32px #202a3d05; min-width: 0; }
.workspace-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 28px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; color: #fff; background: var(--blue); }
.brand-mark svg { width: 28px; height: 28px; }
.workspace-name { border-left: 1px solid var(--line-strong); margin-left: 12px; padding-left: 24px; color: var(--muted); font-size: .875rem; }
.save-status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: .875rem; min-width: 9.5em; justify-content: flex-end; }
.save-status .icon { color: var(--green); }
.save-status.error-text { color: var(--negative); }
.save-status.error-text .icon { color: var(--red); }
.save-status.is-saving .icon { color: var(--muted); }
.trading-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 320px; }
.market-panel { padding: 24px 28px 20px; min-width: 0; }
.market-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.market-identity { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pair-select { position: relative; }
.pair-select select { font-size: 1.125rem; font-weight: 600; padding: .45rem 2rem .45rem 0; border-color: transparent; border-radius: 6px; appearance: none; background: transparent; }
.pair-select .icon { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--muted); }
.source-label { display: flex; align-items: center; gap: 6px; color: var(--blue); font-size: .875rem; font-weight: 500; white-space: nowrap; }
.status-dot { width: 6px; height: 6px; background: var(--blue); border-radius: 50%; }
.market-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.chart-types { display: flex; padding: 3px; gap: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
.chart-types button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 2rem; border: 0; padding: .35rem .65rem; font-size: .875rem; color: var(--muted); background: transparent; border-radius: 5px; }
.chart-types button[aria-pressed="true"] { background: #fff; color: var(--blue); box-shadow: 0 1px 4px #202a3d10; }
.new-session { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: .875rem; padding-inline: .5rem; }
.quote-row { display: flex; flex-wrap: wrap; align-items: end; gap: 32px; margin: 24px 0 16px; }
.quote { display: grid; gap: 4px; }
.quote-label { display: flex; align-items: baseline; gap: 8px; font-size: .875rem; color: var(--muted); letter-spacing: 0; }
.quote-label > span { font-size: .875rem; }
.quote-row strong { font-size: 2rem; font-weight: 500; line-height: 1.2; letter-spacing: -.045em; }
.spread { display: grid; gap: 4px; padding-left: 28px; border-left: 1px solid var(--line); }
.spread-label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: .875rem; }
.quote-row .spread strong { font-size: 1.125rem; line-height: 1.5; }
.quote-row small { font-size: .875rem; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.error-banner { padding: 16px 28px; background: #fff6f5; border-bottom: 1px solid #f0d6d2; color: var(--negative); font-size: .875rem; }
.error-banner p { display: flex; align-items: flex-start; gap: 8px; overflow-wrap: anywhere; }
.error-banner p .icon { margin-top: 2px; }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.recovery-actions button { display: flex; align-items: center; gap: 6px; font-size: .875rem; }
.recovery-actions:has(button) { margin-top: 10px; }
.loading { display: grid; place-items: center; align-content: center; gap: 12px; min-height: 540px; padding: 40px 28px; }
.loading-symbol { display: grid; place-items: center; color: var(--blue); background: var(--blue-soft); border-radius: 12px; width: 56px; height: 56px; }
.loading strong { font-size: 1rem; font-weight: 500; }
.loading > span:last-child { font-size: .875rem; }
.end-message { display: flex; align-items: flex-start; gap: 6px; margin-top: 12px; color: var(--muted); font-size: .875rem; }
@media(max-width: 1660px) { .workspace { margin: 24px; } }
@media(max-width: 1200px) { .market-panel { padding-inline: 24px; } .market-tools { gap: 8px; } .quote-row { gap: 24px; } .spread { padding-left: 24px; } }
@media(max-width: 960px) { .trading-workspace { grid-template-columns: 1fr; } .workspace-header, .market-panel, .error-banner { padding: 20px; } }
@media(max-width: 600px) {
  .workspace { margin: 0; border: 0; border-radius: 0; box-shadow: none; }
  .workspace-header, .market-panel, .error-banner { padding: 16px; }
  .workspace-header { gap: 12px; }
  .workspace-name { display: none; }
  .market-heading { gap: 16px; }
  .market-identity, .market-tools { flex: 1 1 100%; }
  .market-tools { justify-content: space-between; }
  .quote-row { gap: 16px 24px; margin-top: 24px; }
  .quote-row strong { font-size: 1.875rem; }
  .spread { border: 0; padding-left: 0; }
  .save-status { font-size: .875rem; }
}
</style>
