<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { parseHistoryCsv, HistoryCsvError, HISTORY_CSV_MAX_BYTES } from '../../engine/historyCsv'
import type { HistoryDataset } from '../../engine/historyTypes'
import type { CurrencyPair } from '../../engine/types'
import { useSessionStore } from '../../stores/useSessionStore'
import { formatTimestamp } from '../../priceFormatting'
import { loadLocalHistorySample, readLocalHistorySamples } from './localHistorySamples'
import type { LocalHistorySample } from './localHistorySamples'

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
const importErrors = ref<string[]>([])
const importMessage = ref('')
const errorList = ref<HTMLElement | null>(null)
const selectedDataset = computed(() => session.historyDatasets.find(dataset => dataset.id === selectedDatasetId.value))
const canImport = computed(() => session.canOperate && !isImporting.value)

watch(() => session.historyDatasets, (datasets) => {
  if (!datasets.some(dataset => dataset.id === selectedDatasetId.value)) selectedDatasetId.value = datasets.at(-1)?.id ?? ''
}, { immediate: true })

function selectFile(event: Event) {
  csvFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  importErrors.value = []
  importMessage.value = ''
}

async function importDataset(load: () => Promise<HistoryDataset>) {
  if (!canImport.value) return
  session.pause()
  isImporting.value = true
  importErrors.value = []
  importMessage.value = ''
  session.historyErrorMessage = ''
  try {
    const dataset = await load()
    if (await session.importHistoryDataset(dataset)) {
      selectedDatasetId.value = dataset.id
      importMessage.value = `已保存 ${dataset.metadata.recordCount.toLocaleString('zh-CN')} 根到本机。选择“开始历史练习”后回放。`
    }
  } catch (error) {
    if (error instanceof HistoryCsvError) {
      importErrors.value = error.issues.map(issue => `第 ${issue.line} 行 · ${issue.field}：${issue.message}`)
      if (error.issueCount > error.issues.length) importErrors.value.push(`共 ${error.issueCount} 行校验失败，仅显示前 ${error.issues.length} 条提示。`)
    } else importErrors.value = [error instanceof Error ? error.message : '导入失败，请检查文件。']
  } finally {
    isImporting.value = false
    if (importErrors.value.length || session.historyErrorMessage) {
      requestAnimationFrame(() => errorList.value?.focus())
    }
  }
}

async function importCsv() {
  const file = csvFile.value
  if (!file) { importErrors.value = ['请选择 CSV 文件。']; return }
  await importDataset(async () => {
    if (file.size > HISTORY_CSV_MAX_BYTES) throw new Error('CSV 文件不能超过 20 MiB。')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
    return parseHistoryCsv(text, csvPair.value, {
      label: file.name, sourceName: sourceName.value.trim() || '用户导入', sourceUrl: sourceUrl.value.trim(),
      originalTimezone: originalTimezone.value.trim(), verified: false,
      licenseNotes: '由用户提供；来源真实性和使用许可未独立核实。',
    })
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
</script>

<template>
  <details class="history-panel" aria-label="历史数据管理">
    <summary>历史数据</summary>
    <div class="history-content">
      <p class="description">导入完成的 Bid 分钟行情，或载入本机样本。导入只增加数据集；开始回放会创建独立资金的练习，旧记录保留。</p>
      <form class="csv-form" @submit.prevent="importCsv">
        <div class="import-fields">
          <label>CSV 货币对<select v-model="csvPair" :disabled="!canImport"><option>EUR/USD</option><option>GBP/USD</option></select></label>
          <label class="file-field">CSV 文件<input type="file" accept=".csv,text/csv" :disabled="!canImport" @change="selectFile" /></label>
          <label>来源名称<input v-model="sourceName" maxlength="200" placeholder="可选，例如数据提供方" :disabled="!canImport" /></label>
          <label>来源链接<input v-model="sourceUrl" type="url" maxlength="2000" placeholder="可选，https://…" :disabled="!canImport" /></label>
          <label>原始时区<input v-model="originalTimezone" maxlength="200" required :disabled="!canImport" /></label>
        </div>
        <div class="import-actions"><button class="button-outline" type="submit" :disabled="!canImport || !csvFile">{{ isImporting ? '校验与保存中…' : '导入 CSV' }}</button><a href="/data/csv-template.csv" download>下载 CSV 模板</a></div>
        <p class="description">表头 timestamp,open,high,low,close[,ask]；时间须带时区并表示分钟完成时刻。Ask 缺失时使用训练点差。最大 20 MiB / 200,000 根；模板为生成示例。</p>
      </form>
      <div v-if="localSamples.length" class="dataset-actions local-samples">
        <label>本机样本<select v-model="selectedSamplePath" :disabled="!canImport"><option v-for="sample in localSamples" :key="sample.path" :value="sample.path">{{ sample.label }}</option></select></label>
        <button class="button-outline" :disabled="!canImport || !selectedSamplePath" @click="importLocalSample">载入本机样本</button>
      </div>
      <p v-else-if="localSampleError" class="description">{{ localSampleError }}</p>
      <div v-if="importErrors.length || session.historyErrorMessage" ref="errorList" class="import-errors" tabindex="-1" aria-label="历史数据导入错误">
        <p role="alert">{{ session.historyErrorMessage || 'CSV 校验未通过，当前练习和已有数据保留。' }}</p>
        <ul v-if="importErrors.length"><li v-for="(error, index) in importErrors" :key="index">{{ error }}</li></ul>
      </div>
      <p v-if="importMessage" class="import-message" role="status">{{ importMessage }}</p>
      <div class="dataset-actions">
        <label>历史数据集<select v-model="selectedDatasetId" :disabled="!canImport || !session.historyDatasets.length"><option value="" disabled>请先导入或载入样本</option><option v-for="dataset in session.historyDatasets" :key="dataset.id" :value="dataset.id">{{ dataset.pair }} · {{ dataset.metadata.label }}</option></select></label>
        <button class="button-primary" :disabled="!canImport || !selectedDatasetId" @click="session.startHistorySession(selectedDatasetId)">开始历史练习</button>
      </div>
      <p v-if="selectedDataset" class="description dataset-description">{{ selectedDataset.metadata.recordCount.toLocaleString('zh-CN') }} 根 · {{ formatTimestamp(selectedDataset.metadata.startTimestampMs) }} 至 {{ formatTimestamp(selectedDataset.metadata.endTimestampMs) }}（UTC+8） · {{ selectedDataset.metadata.verified ? '来源已核对' : '真实性未核实' }}</p>
    </div>
  </details>
</template>

<style scoped>
.history-panel { margin-top: 18px; border-block: 1px solid var(--line); font-size: .875rem; }
.history-panel summary { padding: 12px 0; cursor: pointer; width: fit-content; font-weight: 500; }
.history-content { padding: 0 0 16px; min-width: 0; }
.description { margin: 8px 0; color: var(--muted); font-size: .8125rem; line-height: 1.7; overflow-wrap: anywhere; }
.csv-form { margin-top: 14px; }
.import-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: grid; gap: 6px; min-width: 0; color: var(--muted); font-size: .8125rem; }
input, select { min-width: 0; width: 100%; min-height: 40px; font-size: .875rem; }
input[type="file"] { padding: 7px; overflow: hidden; }
.file-field { min-width: 0; }
.import-actions, .dataset-actions { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
.import-actions a { padding-block: 10px; color: var(--blue); }
.dataset-actions { padding-top: 14px; border-top: 1px solid var(--line); }
.dataset-actions label { flex: 1 1 220px; }
button { min-height: 40px; padding: 8px 12px; font-size: .875rem; }
.import-errors { margin-top: 14px; padding: 12px; color: var(--red); background: var(--red-soft); overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.import-errors ul { margin: 8px 0 0; padding-left: 22px; }
.import-errors li { padding-block: 3px; }
.import-message { margin-top: 12px; color: var(--green); line-height: 1.7; }
@media (max-width: 600px) {
  .import-fields { grid-template-columns: minmax(0, 1fr); }
  input, select, button { min-height: 44px; }
  .dataset-actions button { width: 100%; }
}
</style>
