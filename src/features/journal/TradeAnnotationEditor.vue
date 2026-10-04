<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { TradeAnnotation, TradeAnnotationInput } from '../../storage/sessionMetadata'
import { TRADE_ANNOTATION_MAX_LENGTH } from '../../storage/sessionMetadata'
import { formatTimestamp } from '../../priceFormatting'

const props = defineProps<{ annotation: TradeAnnotation | null; tradeId: string; disabled: boolean; isClosed: boolean; message?: string; hasError?: boolean }>()
const emit = defineEmits<{ save: [input: TradeAnnotationInput]; reload: [] }>()
const entryReason = ref('')
const exitPlan = ref('')
const exitNote = ref('')
const expectedRevision = ref<number | null>(null)
const hasExternalChange = ref(false)
const messageElement = ref<HTMLElement | null>(null)
const lengthErrorElement = ref<HTMLElement | null>(null)
const isTooLong = computed(() => [entryReason.value, exitPlan.value, exitNote.value].some(text => text.length > TRADE_ANNOTATION_MAX_LENGTH))
function loadAnnotation() {
  const latest = props.annotation?.planRevisions.at(-1)?.plan
  entryReason.value = latest?.entryReason ?? ''
  exitPlan.value = latest?.exitPlan ?? ''
  exitNote.value = props.annotation?.exitNote ?? ''
  expectedRevision.value = props.annotation?.revision ?? null
  hasExternalChange.value = false
}
watch(() => props.tradeId, loadAnnotation, { immediate: true })
watch(() => props.annotation?.revision, (revision) => {
  if ((revision ?? null) !== expectedRevision.value) hasExternalChange.value = true
})
async function save() {
  if (isTooLong.value) { await nextTick(); lengthErrorElement.value?.focus(); return }
  emit('save', { expectedRevision: expectedRevision.value, entryReason: entryReason.value, exitPlan: exitPlan.value, exitNote: exitNote.value })
}
watch([() => props.message, () => props.hasError], async () => {
  if (!props.hasError || !props.message) return
  await nextTick()
  messageElement.value?.focus({ preventScroll: true })
  messageElement.value?.scrollIntoView({ block: 'nearest' })
})
defineExpose({ reload: loadAnnotation })
</script>

<template>
  <section class="annotation-editor" aria-label="交易计划与复盘备注">
    <details class="original-plan"><summary>下单前首次计划</summary><dl><div><dt>进场理由</dt><dd>{{ annotation?.firstPlan?.entryReason || '未记录事前理由' }}</dd></div><div><dt>计划退出</dt><dd>{{ annotation?.firstPlan?.exitPlan || '未记录事前退出条件' }}</dd></div></dl></details>
    <p class="annotation-note">以下编辑保留修订，不能倒填成下单前判断；不改变成交或账户。</p>
    <form @submit.prevent="save">
      <p :id="`annotation-limit-${tradeId}`" class="annotation-note">每项最多 {{ TRADE_ANNOTATION_MAX_LENGTH.toLocaleString('zh-CN') }} 字符，按纯文本保存。</p>
      <label :for="`entry-reason-${tradeId}`">进场理由 / 后续修订（可选）</label>
      <textarea :id="`entry-reason-${tradeId}`" v-model="entryReason" rows="2" :maxlength="TRADE_ANNOTATION_MAX_LENGTH" :disabled="disabled" :aria-invalid="entryReason.length > TRADE_ANNOTATION_MAX_LENGTH" :aria-describedby="`annotation-limit-${tradeId}`" />
      <label :for="`exit-plan-${tradeId}`">计划退出条件（可选）</label>
      <textarea :id="`exit-plan-${tradeId}`" v-model="exitPlan" rows="2" :maxlength="TRADE_ANNOTATION_MAX_LENGTH" :disabled="disabled" :aria-invalid="exitPlan.length > TRADE_ANNOTATION_MAX_LENGTH" :aria-describedby="`annotation-limit-${tradeId}`" />
      <template v-if="isClosed"><label :for="`exit-note-${tradeId}`">实际退出说明（可选）</label><textarea :id="`exit-note-${tradeId}`" v-model="exitNote" rows="2" :maxlength="TRADE_ANNOTATION_MAX_LENGTH" :disabled="disabled" :aria-invalid="exitNote.length > TRADE_ANNOTATION_MAX_LENGTH" :aria-describedby="`annotation-limit-${tradeId}`" /></template>
      <p v-if="isTooLong" ref="lengthErrorElement" class="error-text" role="alert" tabindex="-1">文本超过 {{ TRADE_ANNOTATION_MAX_LENGTH.toLocaleString('zh-CN') }} 字符，当前输入保留，请缩短后保存。</p>
      <div class="annotation-actions"><button type="submit" class="button-outline" :disabled="disabled || hasExternalChange || isTooLong">保存备注</button><button v-if="annotation || message" type="button" class="button-quiet" :disabled="disabled" @click="emit('reload')">读取保存版本并替换输入</button></div>
    </form>
    <p v-if="hasExternalChange" class="annotation-note" role="status">已有新的保存版本。当前输入保留；读取已保存版本后再修改。</p>
    <p v-if="message" ref="messageElement" :role="hasError ? 'alert' : 'status'" :class="{ 'error-text': hasError }" tabindex="-1">{{ message }}</p>
    <details v-if="annotation?.planRevisions.length" class="revision-history"><summary>计划修订记录（{{ annotation.planRevisions.length }}）</summary><ol><li v-for="revision in annotation.planRevisions" :key="revision.revision"><strong>{{ revision.isBeforeEntry ? '下单前' : '下单后修订' }} · {{ formatTimestamp(revision.recordedAtMs) }}</strong><p>理由：{{ revision.plan.entryReason || '未填写' }}</p><p>退出：{{ revision.plan.exitPlan || '未填写' }}</p></li></ol></details>
  </section>
</template>

<style scoped>
.annotation-editor { font-size: .8125rem; line-height: 1.7; min-width: 0; }
summary { min-height: 44px; padding: 9px 0; cursor: pointer; font-weight: 600; }
.annotation-note { margin: 8px 0; color: var(--muted); }
form { display: grid; gap: 7px; }
textarea { width: 100%; min-width: 0; max-width: 100%; resize: vertical; font: inherit; color: var(--text); line-height: 1.6; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); }
textarea:disabled { opacity: .65; }
.annotation-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 5px 0; }
.annotation-actions button { min-height: 44px; font-size: .8125rem; }
dl { margin: 0 0 10px; } dl div { margin-top: 6px; } dt { color: var(--muted); } dd { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.revision-history { border-top: 1px solid var(--line); margin-top: 12px; }
ol { padding-left: 20px; margin: 0; }
li { margin-bottom: 12px; }
li p { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
