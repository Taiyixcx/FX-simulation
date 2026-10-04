<script setup lang="ts">
interface ComparisonContext {
  kind: 'repeat' | 'unseen'
  sourceSessionId?: string
  ruleVersion?: string
  sourceFingerprint?: string
}
defineProps<{ canOperate: boolean; isHistorical: boolean; context?: ComparisonContext | null }>()
const emit = defineEmits<{ 'repeat-current': []; 'start-unseen': [] }>()
</script>

<template>
  <details class="practice-comparison">
    <summary>对照练习<span v-if="context"> · {{ context.kind === 'repeat' ? '重练已见' : '本机未见检验' }}</span></summary>
    <p>复制当前练习后，用独立资金重新判断；原练习和成交账本保留。重练已见走势和本机未见片段分别标记，比较理由与执行过程。</p>
    <div class="comparison-actions"><button type="button" class="button-outline" :disabled="!canOperate" @click="emit('repeat-current')">重练已见片段</button><button v-if="isHistorical" type="button" class="button-outline" :disabled="!canOperate" @click="emit('start-unseen')">本机未见片段检验</button></div>
    <p class="comparison-note">“本机未见”只根据本机保留的练习进度判断；你可能在其他地方见过走势。记住答案、单次盈利或前后成绩变化不能证明能力提升，也不代表实盘表现。</p>
    <details v-if="context" class="comparison-context"><summary>本次对照标记</summary><dl><div><dt>用途</dt><dd>{{ context.kind === 'repeat' ? '重练已见走势，允许回看原决策' : '本机尚未推进片段，独立查看结果' }}</dd></div><div v-if="context.sourceSessionId"><dt>原练习</dt><dd>{{ context.sourceSessionId }}</dd></div><div v-if="context.ruleVersion"><dt>训练规则版本</dt><dd>{{ context.ruleVersion }}</dd></div><div v-if="context.sourceFingerprint"><dt>来源指纹</dt><dd>{{ context.sourceFingerprint }}</dd></div></dl></details>
  </details>
</template>

<style scoped>
.practice-comparison { margin-top: 12px; border-top: 1px solid var(--line); font-size: .8125rem; line-height: 1.7; min-width: 0; }
summary { min-height: 44px; padding: 10px 0; cursor: pointer; font-weight: 500; }
summary span { color: var(--blue); }
.comparison-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.comparison-actions button { min-height: 44px; font-size: .8125rem; }
.comparison-note { color: var(--muted); }
.comparison-context { margin-top: 8px; }
dl { margin: 0; } dl div { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 6px 0; } dt { color: var(--muted); flex: 0 0 7em; } dd { margin: 0; min-width: 0; flex: 1 1 12rem; overflow-wrap: anywhere; }
</style>
