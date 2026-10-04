<script setup lang="ts">
import { nextTick, ref } from 'vue'

withDefaults(defineProps<{ visible?: boolean }>(), { visible: true })
const emit = defineEmits<{ complete: []; skip: [] }>()
const step = ref(0)
const heading = ref<HTMLElement | null>(null)
const steps = [
  { title: '先分清买入与卖出报价', text: 'Ask 是买入价，Bid 是卖出价。图表画 Bid；每根代表已经发生的分钟。先看报价、点差和行情来源，再决定是否交易。', target: '对应：图表上方的 Bid / Ask / 点差' },
  { title: '用小金额理解开仓与点差', text: '买涨按 Ask 开仓、Bid 平仓；买跌反过来。开仓后的即时浮亏通常来自点差。交易金额是资金占用，不是最大亏损；风险预览不会替你下单。', target: '对应：下单区的金额、方向和风险预览' },
  { title: '暂停、平仓，再回看理由', text: '播放或下一根推进已经发生的行情；暂停后也能平仓。结算结果在成交记录中，点击复盘查看当时走势。盈亏与是否遵守计划分开判断。', target: '对应：回放控制、当前持仓和成交记录' },
]
async function next() {
  if (step.value === steps.length - 1) { emit('complete'); return }
  step.value++
  await nextTick()
  heading.value?.focus({ preventScroll: true })
}
</script>

<template>
  <section v-if="visible" class="first-use-guide" aria-labelledby="first-use-title">
    <div class="guide-heading"><h2 id="first-use-title" ref="heading" tabindex="-1">{{ steps[step]!.title }}</h2><span>{{ step + 1 }} / 3</span></div>
    <p>{{ steps[step]!.text }}</p>
    <p class="muted guide-target">{{ steps[step]!.target }}</p>
    <div class="guide-actions"><button type="button" class="button-quiet" @click="emit('skip')">跳过引导</button><button type="button" class="button-primary" @click="next">{{ step === 2 ? '知道了，开始练习' : '下一步' }}</button></div>
  </section>
</template>

<style scoped>
.first-use-guide { padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--blue-soft); font-size: .875rem; line-height: 1.7; }
.guide-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.guide-heading span { color: var(--muted); font-size: .8125rem; }
.guide-target { margin-top: 7px; font-size: .8125rem; }
.guide-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.guide-actions button { min-height: 44px; font-size: .875rem; }
@media (max-width: 600px) { .first-use-guide { padding: 16px; } }
</style>
