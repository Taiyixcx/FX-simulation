<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { parseHistoryCsv, HistoryCsvError, HISTORY_CSV_MAX_BYTES } from '../../engine/historyCsv'
import type { HistoryDataset, HistoryProcessingControls } from '../../engine/historyTypes'
import type { CurrencyPair } from '../../engine/types'
import { useSessionStore } from '../../stores/useSessionStore'
import { formatTimestamp } from '../../priceFormatting'
import { loadLocalHistorySample, readLocalHistorySamples } from './localHistorySamples'
import type { LocalHistorySample } from './localHistorySamples'
import { yieldToEventLoop } from '../../yieldToEventLoop'

const session = useSessionStore()
const csvPair = ref<CurrencyPair>(session.snapshot?.pair ?? 'EUR/USD')
const sourceName = ref('')
const sourceUrl = ref('')
const originalTimezone = ref('ISO 8601（逐行明确时区）')
const csvFile = ref<File | null>(null)
const selectedDatasetId = ref('')
const selectedSamplePath = ref('')
const localSamples = ref<LocalHistorySample[]>([])
const localSampleError = ref('')
const isImporting = ref(false)
const importProgress = ref(0)
const importPhase = ref('读取文件')
const startDatetime = ref('')
const warmupFrameCount = ref(60)
let importController: AbortController | null = null
const importErrors = ref<string[]>([])
const importMessage = ref('')
const errorList = ref<HTMLElement | null>(null)
const selectedDataset = computed(() => session.historyDatasets.find(dataset => dataset.id === selectedDatasetId.value))
const canImport = computed(() => session.canOperate && !isImporting.value)

watch(() => session.historyDatasets, (datasets) => {
  if (!datasets.some(dataset => dataset.id === selectedDatasetId.value)) selectedDatasetId.value = datasets.at(-1)?.id ?? ''
}, { immediate: true })
watch(selectedDatasetId, () => { startDatetime.value = '' })

function localDatetime(timestampMs: number): string { return new Date(timestampMs + 8 * 3_600_000).toISOString().slice(0, 16) }

async function startHistory() {
  try {
    const startTimestampMs = startDatetime.value ? Date.parse(`${startDatetime.value}:00+08:00`) : undefined
    if (startTimestampMs !== undefined && !Number.isFinite(startTimestampMs)) throw new Error('请选择有效的开始时间。')
    await session.startHistorySession(selectedDatasetId.value, { startTimestampMs, warmupFrameCount: warmupFrameCount.value })
  } catch (error) { session.historyErrorMessage = error instanceof Error ? error.message : '开始时间无效。' }
}

function selectFile(event: Event) {
  csvFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  importErrors.value = []
  importMessage.value = ''
}

function cancelImport() { importController?.abort() }

async function importDataset(load: (controls: HistoryProcessingControls) => Promise<HistoryDataset>) {
  if (!canImport.value) return
  session.pause()
  isImporting.value = true
  importErrors.value = []
  importMessage.value = ''
  session.historyErrorMessage = ''
  importProgress.value = 0
  importPhase.value = '读取文件'
  importController = new AbortController()
  const controller = importController
  const controls: HistoryProcessingControls = {
    signal: controller.signal,
    yieldControl: yieldToEventLoop,
    onProgress: (processed, total, phase) => {
      importProgress.value = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0
      importPhase.value = ({ reading: '读取 CSV', validating: '核对完整行情', fingerprint: '核对内容指纹' })[phase]
    },
  }
  try {
    const dataset = await load(controls)
    if (controller.signal.aborted) throw new DOMException('校验已取消，原数据保留。', 'AbortError')
    if (await session.importHistoryDataset(dataset, controls)) {
      selectedDatasetId.value = dataset.id
      importMessage.value = `已保存 ${dataset.metadata.recordCount.toLocaleString('zh-CN')} 根到本机。选择“开始历史练习”后回放。`
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      importMessage.value = '已取消导入，当前练习和已有数据保留。'
    } else if (error instanceof HistoryCsvError) {
      importErrors.value = error.issues.map(issue => `第 ${issue.line} 行 · ${issue.field}：${issue.message}`)
      if (error.issueCount > error.issues.length) importErrors.value.push(`共 ${error.issueCount} 行校验失败，仅显示前 ${error.issues.length} 条提示。`)
    } else importErrors.value = [error instanceof Error ? error.message : '导入失败，请检查文件。']
  } finally {
    if (importController === controller) importController = null
    isImporting.value = false
    if (importErrors.value.length || session.historyErrorMessage) {
      requestAnimationFrame(() => errorList.value?.focus())
    }
  }
}

async function importCsv() {
  const file = csvFile.value
  if (!file) { importErrors.value = ['请选择 CSV 文件。']; return }
  await importDataset(async (controls) => {
    if (file.size > HISTORY_CSV_MAX_BYTES) throw new Error('CSV 文件不能超过 20 MiB。')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
    return parseHistoryCsv(text, csvPair.value, {
      label: file.name, sourceName: sourceName.value.trim() || '用户导入', sourceUrl: sourceUrl.value.trim(),
      originalTimezone: originalTimezone.value.trim(), verified: false,
      licenseNotes: '由用户提供；来源真实性和使用许可未独立核实。',
    }, controls)
  })
}

async function importLocalSample() {
  const sample = localSamples.value.find(item => item.path === selectedSamplePath.value)
  if (sample) await importDataset(() => loadLocalHistorySample(sample))
}

onMounted(async () => {
  try {
    localSamples.value = await readLocalHistorySamples()
    selectedSamplePath.value = localSamples.value[0]?.path ?? ''
  } catch (error) { localSampleError.value = error instanceof Error ? error.message : '本机样本目录读取失败。' }
})
onBeforeUnmount(() => importController?.abort())
</script>

<template>
  <details class="history-panel" aria-label="历史数据管理">
    <summary>历史数据</summary>
    <div class="history-content">
      <p class="description">导入完成的 Bid 分钟行情，或载入本机样本。导入只增加数据集；开始回放会创建独立资金的练习，旧记录保留。</p>
      <form class="csv-form" @submit.prevent="importCsv">
        <div class="import-fields file-fields">
          <div class="import-field"><label for="history-csv-pair">CSV 货币对</label><select id="history-csv-pair" v-model="csvPair" :disabled="!canImport"><option>EUR/USD</option><option>GBP/USD</option></select></div>
          <div class="import-field file-field"><label for="history-csv-file">CSV 文件</label><input id="history-csv-file" type="file" accept=".csv,text/csv" :disabled="!canImport" @change="selectFile" /></div>
        </div>
        <div class="import-fields source-fields">
          <div class="import-field"><label for="history-source-name">来源名称</label><input id="history-source-name" v-model="sourceName" maxlength="200" placeholder="可选，例如数据提供方" :disabled="!canImport" /></div>
          <div class="import-field"><label for="history-source-url">来源链接</label><input id="history-source-url" v-model="sourceUrl" type="url" maxlength="2000" placeholder="可选，https://…" :disabled="!canImport" /></div>
          <div class="import-field"><label for="history-source-timezone">原始时区</label><input id="history-source-timezone" v-model="originalTimezone" maxlength="200" required :disabled="!canImport" /></div>
        </div>
        <div class="import-actions"><button class="button-outline" type="submit" :disabled="!canImport || !csvFile">{{ isImporting ? '校验与保存中…' : '导入 CSV' }}</button><a href="/data/csv-template.csv" download>下载 CSV 模板</a></div>
        <div v-if="isImporting" class="import-progress"><span role="status">{{ importPhase }} · {{ importProgress }}%</span><button type="button" class="button-quiet" @click="cancelImport">取消导入</button></div>
        <p class="description">表头 timestamp,open,high,low,close[,ask]；时间须带时区并表示分钟完成时刻。Ask 缺失时使用训练点差。最大 20 MiB / 200,000 根；模板为生成示例。</p>
      </form>
      <div v-if="localSamples.length" class="dataset-actions local-samples">
        <div class="dataset-field"><label for="history-local-sample">本机样本</label><select id="history-local-sample" v-model="selectedSamplePath" :disabled="!canImport"><option v-for="sample in localSamples" :key="sample.path" :value="sample.path">{{ sample.label }}</option></select></div>
        <button class="button-outline" :disabled="!canImport || !selectedSamplePath" @click="importLocalSample">载入本机样本</button>
      </div>
      <p v-else-if="localSampleError" class="description">{{ localSampleError }}</p>
      <div v-if="importErrors.length || session.historyErrorMessage" ref="errorList" class="import-errors" tabindex="-1" aria-label="历史数据导入错误">
        <p role="alert">{{ session.historyErrorMessage || 'CSV 校验未通过，当前练习和已有数据保留。' }}</p>
        <ul v-if="importErrors.length"><li v-for="(error, index) in importErrors" :key="index">{{ error }}</li></ul>
      </div>
      <p v-if="importMessage" class="import-message" role="status">{{ importMessage }}</p>
      <div class="dataset-actions">
        <div class="dataset-field"><label for="history-dataset">历史数据集</label><select id="history-dataset" v-model="selectedDatasetId" :disabled="!canImport || !session.historyDatasets.length"><option value="" disabled>请先导入或载入样本</option><option v-for="dataset in session.historyDatasets" :key="dataset.id" :value="dataset.id">{{ dataset.pair }} · {{ dataset.metadata.label }}</option></select></div>
        <button class="button-primary" :disabled="!canImport || !selectedDatasetId" @click="startHistory">开始历史练习</button>
      </div>
      <div v-if="selectedDataset" class="practice-start"><div class="import-field"><label for="history-start-time">开始时间（UTC+8，可留空从首根开始）</label><input id="history-start-time" v-model="startDatetime" type="datetime-local" step="60" :min="localDatetime(selectedDataset.metadata.startTimestampMs)" :max="localDatetime(selectedDataset.metadata.endTimestampMs)" :disabled="!canImport" /></div><div class="import-field"><label for="history-warmup">此前观察根数</label><select id="history-warmup" v-model.number="warmupFrameCount" :disabled="!canImport"><option :value="0">不预热</option><option :value="60">最多 60 根</option><option :value="240">最多 240 根</option></select></div></div>
      <p v-if="selectedDataset" class="description">账户从所选完成分钟开始；此前行情只作观察，不参与成交。缺口按下一条现有报价开始，不补假分钟。</p>
      <p v-if="selectedDataset" class="description dataset-description">{{ selectedDataset.metadata.recordCount.toLocaleString('zh-CN') }} 根 · {{ formatTimestamp(selectedDataset.metadata.startTimestampMs) }} 至 {{ formatTimestamp(selectedDataset.metadata.endTimestampMs) }}（UTC+8） · {{ selectedDataset.metadata.verified ? '来源已核对' : '真实性未核实' }}</p>
    </div>
  </details>
</template>

<style scoped>
.history-panel { margin-top: 16px; border-block: 1px solid var(--line); font-size: .875rem; }
.import-progress { display: flex; align-items: flex-start; gap: 12px; margin-top: 10px; }
.import-progress > span { flex: 1; min-width: 0; }
.import-progress button { flex: none; min-height: 44px; }
.practice-start { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; margin-top: 12px; }
@media (max-width: 600px) { .practice-start { grid-template-columns: minmax(0, 1fr); } }
.history-panel summary { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 9px 0; cursor: pointer; list-style: none; color: var(--text); font-size: .8125rem; font-weight: 500; }
.history-panel summary::-webkit-details-marker { display: none; }
.history-panel summary::before { content: ''; flex: none; width: 6px; height: 6px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
.history-panel[open] summary::before { transform: rotate(45deg); }
.history-content { padding: 0 0 16px; min-width: 0; }
.description { margin: 8px 0; color: var(--muted); font-size: .8125rem; line-height: 1.65; overflow-wrap: anywhere; }
.csv-form { margin-top: 12px; }
.import-fields { display: grid; gap: 12px; }
.file-fields { grid-template-columns: 9rem minmax(0, 1fr); }
.source-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.25fr); margin-top: 12px; }
.import-field, .dataset-field { display: grid; gap: 6px; min-width: 0; }
label { min-width: 0; color: var(--muted); font-size: .8125rem; font-weight: 500; }
input, select { min-width: 0; width: 100%; min-height: 40px; font-size: .875rem; line-height: 1.4; }
select { padding-right: 2.25rem; text-overflow: ellipsis; }
input[type="file"] { padding: 4px; overflow: hidden; color: var(--muted); font-size: .8125rem; }
input[type="file"]::file-selector-button { min-height: 30px; margin-right: 9px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text); font: inherit; font-weight: 500; cursor: pointer; }
input[type="file"]:disabled::file-selector-button { cursor: default; }
.import-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-top: 12px; }
.import-actions a { display: inline-flex; align-items: center; min-height: 40px; color: var(--blue); font-size: .8125rem; }
.dataset-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.dataset-actions button { min-width: 8rem; white-space: nowrap; }
.dataset-actions .button-primary { font-weight: 600; }
button { min-height: 40px; padding: 8px 12px; font-size: .8125rem; font-weight: 500; }
.import-errors { margin-top: 12px; padding: 10px 12px; border-radius: 6px; color: var(--red); background: var(--red-soft); font-size: .8125rem; line-height: 1.65; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.import-errors ul { margin: 8px 0 0; padding-left: 22px; }
.import-errors li { padding-block: 3px; }
.import-message { margin-top: 12px; color: var(--green); font-size: .8125rem; line-height: 1.65; }
@media (max-width: 600px) {
  .import-fields, .dataset-actions { grid-template-columns: minmax(0, 1fr); }
  input, select, button, .history-panel summary, .import-actions a { min-height: 44px; }
  input[type="file"]::file-selector-button { min-height: 34px; }
  .dataset-actions button { width: 100%; }
}
</style>
