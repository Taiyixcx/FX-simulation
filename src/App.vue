<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Decimal from 'decimal.js'
import AccountSummary from './features/trading/AccountSummary.vue'
import TradePanel from './features/trading/TradePanel.vue'
import ReplayControls from './features/replay/ReplayControls.vue'
import SimulationScenario from './features/replay/SimulationScenario.vue'
import SimulationEventNotice from './features/replay/SimulationEventNotice.vue'
import HistoryDataPanel from './features/replay/HistoryDataPanel.vue'
import TradeJournal from './features/journal/TradeJournal.vue'
import MarketChart from './features/chart/MarketChart.vue'
import SessionLibrary from './features/sessions/SessionLibrary.vue'
import FirstUseGuide from './features/help/FirstUseGuide.vue'
import ConceptPractice from './features/help/ConceptPractice.vue'
import PracticeComparison from './features/replay/PracticeComparison.vue'
import Icon from './components/Icon.vue'
import InfoTip from './components/InfoTip.vue'
import { useSessionStore } from './stores/useSessionStore'
import type { CurrencyPair, TradeRecord } from './engine/types'
import type { OnboardingStatus } from './storage/sessionMetadata'
import { formatPrice } from './priceFormatting'

const session = useSessionStore()
const chartType = ref<'line' | 'candlestick'>('line')
const recoveryExportError = ref('')
const downloadUrls = new Set<string>()
let reviewOrigin: HTMLElement | null = null
const formattedBid = computed(() => session.currentQuote ? formatPrice(session.currentQuote.bidPrice) : '')
const saveLabel = computed(() => ({ idle: '等待保存', saving: '保存中…', saved: '已保存到本机', error: '保存失败' })[session.saveStatus])
const spreadPips = computed(() => session.currentQuote
  ? new Decimal(session.currentQuote.askPrice).minus(session.currentQuote.bidPrice).div('0.0001').toFixed(1)
  : '')

function changePair(event: Event) {
  const pair = (event.target as HTMLSelectElement).value as CurrencyPair
  void session.switchPair(pair)
}

function downloadJson(json: string, filename: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }))
  downloadUrls.add(url)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url) }, 1_000)
}

function exportSnapshot() {
  const snapshotJson = session.exportSnapshotJson()
  if (snapshotJson) downloadJson(snapshotJson, `fx-snapshot-${session.snapshot?.id ?? 'recovery'}.json`)
}

async function exportRecoveryBackup() {
  recoveryExportError.value = ''
  const backupJson = await session.exportRecoveryBackupJson()
  if (backupJson) downloadJson(backupJson, `fx-recovery-backup-${session.snapshot?.id ?? 'recovery'}.json`)
  else recoveryExportError.value = session.libraryErrorMessage || '故障备份未生成，请保留当前窗口并重试，或导出当前快照。'
}

function warnUnsavedSnapshot(event: BeforeUnloadEvent) {
  if (session.saveStatus === 'saving' || session.saveStatus === 'error') {
    event.preventDefault()
    event.returnValue = ''
  }
}

function focusJournal() {
  const journal = document.getElementById('trade-journal')
  journal?.focus({ preventScroll: true })
  journal?.scrollIntoView({ block: 'start' })
}

function focusLibrary() {
  const library = document.getElementById('session-library') as HTMLDetailsElement | null
  if (!library) return
  library.open = true
  const heading = library.querySelector<HTMLElement>('h2')
  heading?.focus({ preventScroll: true })
  library.scrollIntoView({ block: 'start' })
  void session.refreshLibrary()
}

function recordObservation(input: { reason: string }) { void session.recordObservation(input.reason) }

function openGuide() {
  const guide = document.getElementById('first-use-guide') as HTMLDetailsElement | null
  if (!guide) return
  guide.open = true
  guide.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  guide.scrollIntoView({ block: 'nearest' })
}

async function finishGuide(status: OnboardingStatus) {
  await session.setOnboardingStatus(status)
  if (session.onboardingStatus === status) { await nextTick(); focusTrade() }
}

async function showTradeReview(trade: TradeRecord, action: 'open' | 'close' = 'open') {
  if (!session.isReviewing) reviewOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await session.selectReviewTrade(trade, action)
  await nextTick()
  const target = document.querySelector<HTMLElement>(session.isReviewing ? '[data-testid="market-chart"]' : '#review-error')
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'center' })
}

async function exitReview() {
  session.exitReview()
  await nextTick()
  const target = reviewOrigin?.isConnected ? reviewOrigin : document.getElementById('trade-journal')
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'nearest' })
  reviewOrigin = null
}

function focusTrade() {
  const target = document.getElementById(session.snapshot?.account.position ? 'position-title' : 'notional-usd')
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'center' })
}

function focusRecovery() {
  const banner = document.getElementById('session-error')
  banner?.focus({ preventScroll: true })
  banner?.scrollIntoView({ block: 'nearest' })
}

onMounted(() => {
  void session.initialize()
  window.addEventListener('beforeunload', warnUnsavedSnapshot)
})
onBeforeUnmount(() => {
  for (const url of downloadUrls) URL.revokeObjectURL(url)
  downloadUrls.clear()
  window.removeEventListener('beforeunload', warnUnsavedSnapshot)
  session.dispose()
  reviewOrigin = null
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
      <div class="header-actions">
        <a v-if="session.snapshot && session.onboardingStatus === null" class="library-link" href="#first-use-guide" @click.prevent="openGuide">三步引导</a>
        <a class="library-link" href="#session-library" @click.prevent="focusLibrary">练习与备份</a>
        <a v-if="session.snapshot" class="journal-link" href="#trade-journal" @click.prevent="focusJournal"><Icon name="activity" :size="16" />成交记录</a>
        <span class="save-status" role="status" :class="{ 'error-text': session.saveStatus === 'error', 'is-saving': session.saveStatus === 'saving' }" data-testid="save-status"><Icon :name="session.saveStatus === 'saved' ? 'check' : session.saveStatus === 'error' ? 'info' : 'clock'" :size="16" />{{ saveLabel }}</span>
      </div>
    </header>
    <div v-if="session.loadStatus === 'loading'" class="loading" role="status"><span class="loading-symbol"><Icon name="activity" :size="28" /></span><strong>正在读取本机练习</strong><span class="muted">准备行情与账户…</span></div>
    <section v-if="session.errorMessage" id="session-error" class="error-banner" aria-label="操作提示" tabindex="-1">
      <p role="alert"><Icon name="info" />{{ session.errorMessage }}</p>
      <div class="recovery-actions">
        <button v-if="session.loadStatus === 'error'" class="button-outline" :disabled="session.isBusy" @click="session.retryLoad()"><Icon name="refresh" :size="16" />重试读取</button>
        <button v-if="session.saveStatus === 'error'" class="button-outline" :disabled="session.isBusy" @click="session.retrySave()"><Icon name="refresh" :size="16" />重试保存</button>
        <button v-if="session.saveStatus === 'error'" class="button-outline" :disabled="session.isBusy || session.isLibraryBusy" @click="exportRecoveryBackup"><Icon name="download" :size="16" />导出可恢复故障备份</button>
        <button v-if="session.saveStatus === 'error' || session.rawRecoveryJson" class="button-outline" @click="exportSnapshot"><Icon name="download" :size="16" />导出当前快照</button>
      </div>
      <p v-if="recoveryExportError" role="alert">{{ recoveryExportError }}</p>
    </section>
    <section v-if="session.libraryErrorMessage && !session.errorMessage" class="error-banner" aria-label="资料操作提示"><p role="status">{{ session.libraryErrorMessage }}</p><button class="button-outline" @click="focusLibrary">查看练习与备份</button></section>
    <template v-if="session.snapshot && session.currentQuote">
      <AccountSummary />
      <div class="trading-workspace">
        <section class="market-panel" aria-labelledby="market-title">
          <div class="market-heading">
            <div class="market-identity">
              <span class="pair-mark" aria-hidden="true">{{ session.snapshot.pair === 'EUR/USD' ? '€' : '£' }}<span>$</span></span>
              <div class="pair-select"><label for="currency-pair" class="sr-only">货币对</label><select id="currency-pair" :value="session.snapshot.pair" :disabled="!session.canOperate || session.isHistorical" @change="changePair"><option value="EUR/USD">EUR / USD</option><option value="GBP/USD">GBP / USD</option></select><h2 id="market-title" class="sr-only">行情图表</h2></div>
              <span class="source-label"><span class="status-dot" />{{ session.isHistorical ? '历史回放' : `模拟行情 · ${session.scenario === 'eventful' ? '事件练习' : '常规练习'}` }} · 1 分钟</span>
              <InfoTip v-if="!session.isHistorical" label="模拟行情说明">行情由本机生成，每根代表一分钟，不是真实历史价格。图表只展示已经推进的行情。{{ session.snapshot.schemaVersion === 3 && session.snapshot.sourceState.parameterVersion === 2 ? '普通波动尺度和点差基准参考2024年历史样本估计；事件、波动持续与时段形状仍是训练设定，未完成全面市场验证。' : '此练习保留原训练参数，尚未按历史样本校准。' }}练习表现不代表实盘表现。</InfoTip>
              <InfoTip v-else label="历史回放说明">图表只展示已经推进的完成分钟，成交使用当前末组 Bid/Ask。分钟回放不复现分钟内逐笔成交；源文件提供 Ask 的行直接使用，缺失行使用训练点差。CSV 的真实性由来源核验单独说明。</InfoTip>
            </div>
            <div class="market-tools">
              <div class="chart-types" role="group" aria-label="图表类型">
                <button :aria-pressed="chartType === 'line'" @click="chartType = 'line'"><Icon name="chart-line" :size="16" />折线</button>
                <button :aria-pressed="chartType === 'candlestick'" @click="chartType = 'candlestick'"><Icon name="candles" :size="16" />K 线</button>
              </div>
              <SimulationScenario v-if="!session.isHistorical" />
              <template v-else>
                <button class="button-quiet history-action" :disabled="!session.canOperate" @click="session.snapshot.schemaVersion === 4 && session.startHistorySession(session.snapshot.sourceState.datasetId)">从头练习</button>
                <button class="button-quiet history-action" :disabled="!session.canOperate" @click="session.startNewSession()">切回模拟练习</button>
              </template>
            </div>
          </div>
          <p v-if="session.isHistorical && session.historyMetadata" class="history-source" data-testid="history-source">{{ session.historyMetadata.sourceName }} · {{ session.historyMetadata.verified ? '来源已核对' : '用户导入，真实性未核实' }} · {{ session.currentQuote.askSource === 'source' ? '源文件 Ask' : '训练 Ask' }}<InfoTip label="历史数据来源">{{ session.historyMetadata.label }}。原始时区：{{ session.historyMetadata.originalTimezone }}。{{ session.historyMetadata.conversionNotes }} {{ session.historyMetadata.licenseNotes }} {{ session.historyMetadata.sourceUrl }}</InfoTip></p>
          <div class="quote-row tabular">
            <div class="quote main-quote"><span class="quote-label">卖出价 <span>Bid</span></span><strong data-testid="bid-price">{{ formattedBid.slice(0, -2) }}<span class="quote-tail">{{ formattedBid.slice(-2) }}</span></strong></div>
            <div class="quote secondary-quote"><span class="quote-label">买入价 <span>Ask</span></span><strong data-testid="ask-price">{{ formatPrice(session.currentQuote.askPrice) }}</strong></div>
            <div class="spread"><span class="spread-label">点差<InfoTip label="点差说明">Ask 是买入报价，Bid 是卖出报价。模拟点差会随时段、波动和事件变化；历史回放使用源文件 Ask，缺失时才加训练点差。开仓后立即显示小幅亏损，是买卖报价不同的结果，系统不会重复扣除点差。</InfoTip></span><strong>{{ spreadPips }} <small>pip</small></strong></div>
          </div>
          <SimulationEventNotice />
          <p v-if="session.isHistorical && session.currentGapMinutes > 1" class="history-gap" role="status" data-testid="history-gap">本次跨越 {{ session.currentGapMinutes.toLocaleString('zh-CN') }} 分钟（含休市或数据缺口），按下一条现有报价推进。</p>
          <p v-if="session.isReviewLoading" class="frame-window-note" role="status">正在读取成交附近的已发生行情…</p>
          <p v-if="session.reviewError" id="review-error" class="error-text" role="alert" tabindex="-1">{{ session.reviewError }}</p>
          <MarketChart :frames="session.chartFrames" :position="session.isReviewing ? null : session.snapshot.account.position" :trades="session.snapshot.trades" :session-id="session.snapshot.id" :chart-type="chartType" :is-reviewing="session.isReviewing" :selected-timestamp-ms="session.reviewTimestampMs ?? undefined" @exit-review="exitReview"><template #replay-controls><ReplayControls compact /></template></MarketChart>
          <HistoryDataPanel />
          <PracticeComparison :can-operate="session.canOperate" :is-historical="session.isHistorical" :context="session.comparisonContext" @repeat-current="session.repeatCurrentPractice()" @start-unseen="session.startUnseenHistoryPractice()" />
          <p v-if="session.trainingContext?.isImportedClaim" class="frame-window-note">对照标记来自备份声明，未重新核验未见状态。</p>
          <p v-if="session.snapshot.frameStartIndex > 0" class="frame-window-note">图表显示最近 {{ session.snapshot.frames.length.toLocaleString('zh-CN') }} 根，较早行情仍保存在本机。</p>
          <a class="trade-jump" href="#trade-amount" @click.prevent="focusTrade">{{ session.snapshot.account.position ? '查看持仓与平仓' : '去下单' }}<Icon name="arrow-right" :size="16" /></a>
          <p v-if="session.isEnded" class="end-message" role="status"><Icon name="check" :size="16" />{{ session.isCalendarEnded ? '已达到模拟时钟支持范围' : '本轮行情已结束' }}，仍可按最后报价平仓。</p>
        </section>
        <TradePanel @request-recovery-focus="focusRecovery" />
      </div>
      <details v-if="session.onboardingStatus === null" id="first-use-guide" class="onboarding-panel" aria-label="新手三步引导"><summary>第一次练习？查看三步引导（可跳过）</summary><FirstUseGuide @complete="finishGuide('completed')" @skip="finishGuide('skipped')" /></details>
      <TradeJournal @review-trade="showTradeReview" />
      <ConceptPractice :is-saving-observation="session.isBusy" :observation-message="session.libraryMessage" @record-observation="recordObservation" />
    </template>
    <SessionLibrary />
  </main>
</template>

<style scoped>
.workspace { max-width: 1520px; margin: 24px auto; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; container: workspace / inline-size; }
.frame-window-note { margin: 8px 0 0; color: var(--muted); font-size: .8125rem; line-height: 1.6; }
.history-action { min-height: 40px; padding: 8px 10px; font-size: .875rem; font-weight: 500; }
.history-source { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 12px; color: var(--muted); font-size: .8125rem; line-height: 1.7; overflow-wrap: anywhere; }
.history-gap { color: var(--muted); font-size: .8125rem; line-height: 1.7; margin-bottom: 8px; }
.workspace-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 14px 24px; min-height: 68px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.brand-mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; color: #fff; background: var(--blue); }
.brand-mark svg { width: 28px; height: 28px; }
.workspace-name { border-left: 1px solid var(--line); margin-left: 8px; padding-left: 20px; color: var(--muted); font-size: .875rem; }
.header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; max-width: 100%; }
.journal-link { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; font-size: .875rem; color: var(--muted); text-decoration: none; }
.journal-link:hover { color: var(--text); }
.library-link { display: inline-flex; align-items: center; min-height: 40px; color: var(--blue); font-size: .875rem; text-decoration: none; }
.library-link:hover { text-decoration: underline; }
.onboarding-panel { border-bottom: 1px solid var(--line); font-size: .875rem; }
.onboarding-panel > summary { min-height: 44px; padding: 10px 24px; color: var(--blue); cursor: pointer; line-height: 1.7; }
@media (max-width: 600px) { .onboarding-panel > summary { padding-inline: 16px; } }
.save-status { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 6px; background: var(--blue-soft); color: var(--blue); font-size: .8125rem; min-width: 9.5em; justify-content: center; }
.save-status .icon { color: var(--green); }
.save-status.error-text, .save-status.error-text .icon { color: var(--red); }
.save-status.is-saving .icon { color: var(--muted); }
.trading-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 336px; }
.market-panel { padding: 20px 24px; min-width: 0; }
.market-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.market-identity { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pair-mark { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: none; margin-right: 2px; border: 1px solid var(--line); border-radius: 50%; background: var(--blue-soft); color: var(--blue); font-size: 1rem; font-weight: 600; }
.pair-mark > span { margin-left: -2px; color: var(--muted); font-size: .8125rem; }
.pair-select { position: relative; }
.pair-select select { min-height: 40px; font-size: 1.125rem; font-weight: 600; padding: .4rem 2.375rem .4rem .75rem; border-radius: 8px; background-color: var(--surface); }
.pair-select select:disabled { opacity: 1; color: var(--text); border-color: var(--line); background-color: var(--surface-soft); }
.source-label { display: flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 8px; border-radius: 5px; color: var(--blue); background: var(--blue-soft); font-size: .8125rem; font-weight: 500; line-height: 1.6; }
.status-dot { width: 5px; height: 5px; flex: none; background: var(--blue); border-radius: 50%; }
.market-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.chart-types { display: flex; padding: 3px; gap: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
.chart-types button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; border: 0; padding: .35rem .7rem; font-size: .875rem; color: var(--muted); background: transparent; border-radius: 5px; }
.chart-types button[aria-pressed="true"] { background: var(--surface); color: var(--blue); box-shadow: inset 0 0 0 1px var(--line); }
.quote-row { display: flex; flex-wrap: wrap; align-items: center; gap: 20px 28px; margin: 20px 0 12px; }
.quote { display: grid; gap: 5px; min-width: 0; }
.quote-label { display: flex; align-items: baseline; gap: 8px; font-size: .875rem; color: var(--muted); letter-spacing: 0; }
.main-quote strong { font-size: 2.5rem; font-weight: 600; line-height: 1.15; letter-spacing: -.035em; }
.quote-tail { color: var(--blue); }
.secondary-quote { padding-left: 24px; border-left: 1px solid var(--line); }
.secondary-quote strong { font-size: 1.375rem; font-weight: 600; line-height: 1.4; letter-spacing: -.02em; }
.spread { display: grid; gap: 4px; min-width: 0; }
.spread-label { display: flex; align-items: center; gap: 2px; color: var(--muted); font-size: .875rem; }
.spread strong { font-size: 1rem; font-weight: 500; line-height: 1.5; }
.spread small { font-size: .875rem; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.trade-jump { display: none; }
.error-banner { padding: 16px 24px; background: var(--red-soft); border-bottom: 1px solid #edc5d0; color: var(--red); font-size: .875rem; }
.error-banner p { display: flex; align-items: flex-start; gap: 8px; overflow-wrap: anywhere; }
.error-banner p .icon { margin-top: 2px; }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.recovery-actions button { display: flex; align-items: center; gap: 6px; font-size: .875rem; }
.recovery-actions:has(button) { margin-top: 10px; }
.loading { display: grid; place-items: center; align-content: center; gap: 12px; min-height: 540px; padding: 40px 28px; }
.loading-symbol { display: grid; place-items: center; color: var(--blue); background: var(--blue-soft); border-radius: 10px; width: 56px; height: 56px; }
.loading strong { font-size: 1rem; font-weight: 500; }
.loading > span:last-child { font-size: .875rem; }
.end-message { display: flex; align-items: flex-start; gap: 6px; margin-top: 12px; color: var(--muted); font-size: .875rem; }
@media (max-width: 1568px) { .workspace { margin-inline: 24px; } }
@media (max-width: 1200px) { .market-panel { padding-inline: 24px; } .market-tools { gap: 8px; } .quote-row { gap: 20px; } .secondary-quote { padding-left: 20px; } }
@media (max-width: 1100px) {
  .trading-workspace { grid-template-columns: minmax(0, 1fr); }
  .trade-jump { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line-strong); border-radius: 7px; color: var(--text); font-size: .875rem; text-decoration: none; }
  .trade-jump:hover { background: var(--surface-soft); }
}
@media (max-width: 600px) {
  .workspace { margin: 0; border: 0; border-radius: 0; }
  .workspace-header, .market-panel, .error-banner { padding: 16px; }
  .workspace-header { gap: 10px 12px; }
  .brand { gap: 8px; }
  .brand-mark { width: 32px; height: 32px; }
  .workspace-name, .journal-link { display: none; }
  .header-actions { gap: 0; }
  .market-heading { gap: 14px; }
  .market-identity, .market-tools { flex: 1 1 100%; }
  .market-tools { justify-content: space-between; }
  .pair-select select { min-height: 44px; font-size: 1.125rem; }
  .pair-mark { width: 34px; height: 34px; }
  .chart-types button { min-height: 44px; }
  .history-action { min-height: 44px; }
  .quote-row { gap: 16px 20px; margin-top: 22px; }
  .main-quote strong { font-size: 2.125rem; }
  .secondary-quote { padding-left: 16px; }
  .secondary-quote strong { font-size: 1.25rem; }
  .save-status { font-size: .8125rem; }
  .trade-jump { display: flex; }
}
</style>
