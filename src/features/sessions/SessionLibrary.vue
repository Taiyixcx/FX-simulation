<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { BACKUP_MAX_BYTES } from '../../storage/sessionBackup'
import { formatTimestamp, formatUsd } from '../../priceFormatting'
import type { SessionSummary } from '../../storage/sessionMetadata'

const session = useSessionStore()
const page = ref(0)
const pageSize = 10
const pages = computed(() => Math.max(1, Math.ceil(session.savedSessions.length / pageSize)))
const visibleSessions = computed(() => session.savedSessions.slice(page.value * pageSize, (page.value + 1) * pageSize))
const isWorking = computed(() => session.isBusy || session.isLibraryBusy || operation.value !== null)
const openRestoredSession = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const operation = shallowRef<AbortController | null>(null)
const objectUrls = new Set<string>()
watch(pages, count => { page.value = Math.min(page.value, count - 1) })

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  objectUrls.add(url)
  const link = document.createElement('a')
  link.href = url
  link.download = `fx-complete-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url) }, 1_000)
}

async function exportBackup() {
  operation.value = new AbortController()
  const json = await session.exportBackupJson(operation.value.signal)
  if (json) download(json)
  operation.value = null
}

async function readBackup(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  operation.value?.abort()
  operation.value = new AbortController()
  const controller = operation.value
  session.cancelBackupRestore()
  try {
    if (file.size > BACKUP_MAX_BYTES) throw new Error(`备份最大 ${BACKUP_MAX_BYTES / 1024 / 1024} MiB。`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    if (controller.signal.aborted) return
    await session.prepareBackupRestore(text, controller.signal)
    openRestoredSession.value = session.backupPreview?.mode === 'empty'
  } catch (error) {
    session.libraryErrorMessage = error instanceof Error ? error.message : '文件读取失败，原数据保留。'
  } finally {
    if (operation.value === controller) operation.value = null
    if (fileInput.value) fileInput.value.value = ''
  }
}

function cancelOperation() {
  operation.value?.abort()
  session.cancelBackupRestore()
}

async function deleteSession(item: SessionSummary) {
  if (item.revision === null || item.isCurrent || isWorking.value) return
  if (window.confirm(`删除这份 ${item.pair ?? '旧'} 练习及其成交、备注和模拟行情？其他练习保留。建议先导出完整备份。`)) {
    await session.deleteSavedSession(item.id, item.revision)
  }
}

async function deleteDataset(id: string, label: string) {
  if (window.confirm(`删除数据集“${label}”？正在被任何练习使用的数据集不会删除。`)) await session.deleteHistoryDataset(id)
}

onBeforeUnmount(() => {
  operation.value?.abort()
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls.clear()
})
</script>

<template>
  <details id="session-library" class="session-library" aria-label="练习与完整备份">
    <summary>练习与完整备份</summary>
    <div class="library-content">
      <div class="library-heading"><h2 tabindex="-1">已保存练习</h2><button class="button-quiet" :disabled="isWorking" @click="session.refreshLibrary()">刷新列表</button></div>
      <p class="explanation">打开原练习会恢复原账户、持仓与进度，并保持暂停。新练习使用独立资金。</p>
      <p v-if="session.libraryErrorMessage" class="error-text library-notice" role="alert">{{ session.libraryErrorMessage }}</p>
      <p v-if="session.libraryMessage" class="library-notice" role="status">{{ session.libraryMessage }}</p>
      <p v-if="!session.savedSessions.length" class="muted">暂无可列出的本机练习。</p>
      <ul v-else class="session-list">
        <li v-for="item in visibleSessions" :key="item.id" :class="{ 'is-current': item.isCurrent }">
          <div class="session-information">
            <strong>{{ item.pair ?? '记录待核对' }} · {{ item.mode === 'historical' ? '历史练习' : item.mode === 'simulation' ? '模拟练习' : '未知来源' }} <span v-if="item.isCurrent" class="current-label">当前</span></strong>
            <p v-if="item.errorMessage" class="error-text">{{ item.errorMessage }}</p>
            <template v-else>
              <p>{{ item.progressedFrameCount?.toLocaleString('zh-CN') }} 根 · {{ item.tradeCount }} 笔成交 · {{ item.hasOpenPosition ? '有未平持仓' : '无持仓' }} · 余额 {{ item.balanceUsd ? formatUsd(item.balanceUsd) : '未知' }} USD</p>
              <p class="muted">行情 {{ item.currentTimestampMs === null ? '未知' : formatTimestamp(item.currentTimestampMs) }}；最近保存 {{ item.savedAtMs === null ? '时间未记录' : formatTimestamp(item.savedAtMs) }}</p>
            </template>
          </div>
          <div class="session-actions">
            <button class="button-outline" :disabled="!session.canOperate || item.isCurrent || !!item.errorMessage" @click="session.activateSavedSession(item.id)">继续练习</button>
            <button v-if="!item.isCurrent" class="button-quiet delete-button" :disabled="!session.canOperate || item.revision === null" @click="deleteSession(item)">删除</button>
          </div>
        </li>
      </ul>
      <div v-if="pages > 1" class="pagination"><button class="button-quiet" :disabled="page === 0" @click="page--">上一页</button><span>{{ page + 1 }} / {{ pages }} 页</span><button class="button-quiet" :disabled="page === pages - 1" @click="page++">下一页</button></div>

      <section class="backup-section" aria-labelledby="complete-backup-title">
        <h2 id="complete-backup-title">完整备份与恢复</h2>
        <p class="explanation">备份包含全部练习、成交、备注、已发生模拟行情和完整历史数据集。请将文件保存在浏览器之外；它与故障时的当前快照不同。</p>
        <div class="backup-actions">
          <button class="button-outline" :disabled="isWorking" @click="exportBackup">导出完整备份</button>
          <label class="backup-file">选择备份文件<input ref="fileInput" type="file" accept=".json,application/json" :disabled="isWorking" @change="readBackup" /></label>
          <button v-if="operation" class="button-quiet" @click="cancelOperation">取消校验或导出</button>
        </div>
        <p v-if="session.isLibraryBusy" class="muted" role="status">正在校验或保存，请保留当前页面…</p>
        <p v-if="session.saveStatus === 'error'" class="explanation error-text">当前有未保存状态：完整备份只包含最近成功提交的数据。请另行导出故障快照，并先重试保存后再恢复。</p>
        <div v-if="session.backupPreview" class="restore-preview" aria-label="恢复预览">
          <p><strong>校验通过</strong> · {{ session.backupPreview.sessionCount }} 个练习 · {{ session.backupPreview.datasetCount }} 个数据集 · {{ session.backupPreview.tradeCount }} 笔成交</p>
          <p>{{ session.backupPreview.mode === 'empty' ? '将恢复到当前空库。' : '将追加为独立练习副本，不覆盖当前练习或已有记录。' }} 来源声明会保留，导入文件本身不认证行情来源。</p>
          <label v-if="session.backupPreview.mode === 'append' && session.backupPreview.sessionCount > 0" class="restore-choice"><input v-model="openRestoredSession" type="checkbox" />恢复后打开备份中的原练习（暂停）</label>
          <div class="backup-actions"><button class="button-primary" :disabled="isWorking || session.saveStatus === 'error'" @click="session.restoreBackup(openRestoredSession)">{{ session.backupPreview.mode === 'empty' ? '确认恢复' : '确认追加恢复' }}</button><button class="button-quiet" :disabled="isWorking" @click="session.cancelBackupRestore()">取消</button></div>
        </div>
      </section>

      <section class="storage-section" aria-labelledby="storage-health-title">
        <h2 id="storage-health-title">本机保存</h2>
        <p class="explanation">{{ session.storageHealth?.isPersistent === true ? '浏览器已启用持久存储。' : session.storageHealth?.isPersistent === false ? '当前使用浏览器默认存储。' : '此浏览器未提供持久存储状态。' }} 浏览器清理、更换浏览器或更换地址会影响数据，请保留外部备份。</p>
        <p v-if="session.storageHealth?.usageBytes !== null && session.storageHealth?.usageBytes !== undefined" class="muted">已用约 {{ (session.storageHealth.usageBytes / 1024 / 1024).toFixed(1) }} MiB<span v-if="session.storageHealth.quotaBytes !== null"> / 估算配额 {{ (session.storageHealth.quotaBytes / 1024 / 1024).toFixed(0) }} MiB</span>；估算不保证下一笔写入成功。</p>
        <button class="button-outline" :disabled="isWorking || session.storageHealth?.isPersistent === true" @click="session.requestPersistentStorage()">申请持久存储</button>
        <details v-if="session.datasetEntries.length" class="dataset-cleanup"><summary>历史数据集清理</summary><ul><li v-for="entry in session.datasetEntries" :key="entry.id"><span>{{ entry.summary?.metadata.label ?? entry.id }}<span v-if="entry.errorMessage" class="error-text"> · {{ entry.errorMessage }}</span></span><button class="button-quiet delete-button" :disabled="!session.canOperate" @click="deleteDataset(entry.id, entry.summary?.metadata.label ?? entry.id)">删除未使用数据集</button></li></ul><p class="explanation">只有未被任何已保存练习引用的数据集可以删除。</p></details>
      </section>
    </div>
  </details>
</template>

<style scoped>
.session-library { border-top: 1px solid var(--line); font-size: .875rem; }
summary { cursor: pointer; min-height: 44px; padding: 12px 24px; color: var(--blue); }
.library-content { padding: 0 24px 24px; }
h2 { font-size: 1rem; margin: 0; }
.library-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.explanation { line-height: 1.7; color: var(--muted); margin: 10px 0; overflow-wrap: anywhere; }
.library-notice { line-height: 1.7; margin: 12px 0; overflow-wrap: anywhere; }
.session-list, .dataset-cleanup ul { list-style: none; padding: 0; margin: 12px 0; }
.session-list > li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-top: 1px solid var(--line); padding: 12px 0; }
.session-information { flex: 1 1 280px; min-width: 0; overflow-wrap: anywhere; line-height: 1.7; }
.session-information p { margin: 4px 0 0; }
.session-information .muted { font-size: .8125rem; }
.current-label { color: var(--blue); margin-left: 6px; font-size: .8125rem; }
.session-actions, .backup-actions, .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
button { min-height: 44px; padding: 8px 12px; font-size: .875rem; }
.delete-button { color: var(--red); }
.pagination { justify-content: flex-end; }
.backup-section, .storage-section { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 20px; }
.backup-file { display: grid; gap: 6px; min-width: 0; max-width: 100%; }
.backup-file input { min-height: 44px; max-width: 100%; min-width: 0; }
.restore-preview { border-left: 3px solid var(--blue); padding: 12px 16px; margin-top: 16px; line-height: 1.7; background: var(--surface-soft); }
.restore-preview p { margin: 0 0 10px; }
.restore-choice { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.dataset-cleanup { margin-top: 16px; }
.dataset-cleanup summary { padding-inline: 0; }
.dataset-cleanup li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 0; }
.dataset-cleanup li > span { min-width: 0; overflow-wrap: anywhere; flex: 1 1 240px; }
@media (max-width: 600px) { summary { padding-inline: 16px; } .library-content { padding-inline: 16px; } .backup-actions { align-items: stretch; } .backup-file { flex: 1 1 100%; } }
</style>
