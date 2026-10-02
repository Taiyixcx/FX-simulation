<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'
import { useSessionStore } from '../../stores/useSessionStore'
import type { SimulationScenario } from '../../engine/types'

const session = useSessionStore()
const selectedScenario = ref<SimulationScenario>('standard')

watch(() => session.snapshot?.id, () => {
  selectedScenario.value = session.snapshot?.sourceState.scenario ?? 'standard'
}, { immediate: true })

function startNewSession() {
  void session.startNewSession(undefined, selectedScenario.value)
}
</script>

<template>
  <div class="scenario-controls">
      <div class="scenario-selection">
        <label for="simulation-scenario">新练习情景</label>
        <select id="simulation-scenario" v-model="selectedScenario" :disabled="!session.canOperate">
          <option value="standard">常规练习</option>
          <option value="eventful">事件练习</option>
        </select>
        <InfoTip label="练习情景说明">常规练习包含市场波动与偶发事件；事件练习提高公告和突发事件的频率，事件不表示下一根必涨或必跌。新练习默认持续生成，可随时暂停。选择情景后点击“新练习”，会换一条随机走势和独立训练资金，旧记录仍保留在本机；刷新会继续原练习并暂停。</InfoTip>
      </div>
      <button type="button" class="new-session button-quiet" :disabled="!session.canOperate" @click="startNewSession"><Icon name="plus" :size="16" />新练习</button>
  </div>
</template>

<style scoped>
.scenario-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.scenario-selection { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.scenario-selection label { color: var(--muted); font-size: .8125rem; }
.scenario-selection select { min-width: 0; max-width: 100%; min-height: 40px; padding: 7px 26px 7px 10px; border-color: var(--line-strong); border-radius: 6px; font-size: .875rem; background: var(--surface-soft); }
.new-session { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; font-size: .875rem; padding-inline: .5rem; }
@media (max-width: 600px) {
  .scenario-selection { flex: 1 1 auto; }
  .scenario-selection select, .new-session { min-height: 44px; }
}
</style>
