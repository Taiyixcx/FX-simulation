<script setup lang="ts">
import { useSessionStore } from '../../stores/useSessionStore'

defineProps<{ chartType: 'line' | 'candlestick' }>()
const emit = defineEmits<{ 'update:chartType': [chartType: 'line' | 'candlestick'] }>()
const session = useSessionStore()

function changeSpeed(event: Event) {
  const speed = Number((event.target as HTMLSelectElement).value)
  if (speed === 1 || speed === 5 || speed === 10) session.setSpeed(speed)
}
</script>

<template>
  <div class="replay-controls" aria-label="行情回放控制">
    <button v-if="session.isPlaying" class="primary" @click="session.pause()">暂停</button>
    <button v-else class="primary" :disabled="!session.canAdvance" @click="session.play()">播放</button>
    <button :disabled="!session.canAdvance || session.isPlaying" @click="session.next()">下一根</button>
    <label>速度 <select :value="session.speed" :disabled="!session.isReady" @change="changeSpeed"><option :value="1">1 根/秒</option><option :value="5">5 根/秒</option><option :value="10">10 根/秒</option></select></label>
    <span class="progress muted" data-testid="progress">{{ session.snapshot?.frames.length ?? 0 }} / {{ session.snapshot?.sourceState.maxFrames ?? 0 }} 根 · {{ session.isEnded ? '已结束' : session.isPlaying ? '播放中' : '已暂停' }}</span>
    <div class="chart-types" aria-label="图表类型">
      <button :aria-pressed="chartType === 'line'" @click="emit('update:chartType', 'line')">折线</button>
      <button :aria-pressed="chartType === 'candlestick'" @click="emit('update:chartType', 'candlestick')">K 线</button>
    </div>
  </div>
</template>

<style scoped>
.replay-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 18px 0 6px; border-top: 1px solid var(--line); }
label { display: flex; gap: 8px; align-items: center; }
.progress { font-size: 0.875rem; }
.chart-types { display: flex; gap: 4px; margin-left: auto; }
.chart-types [aria-pressed="true"] { background: #e9effb; color: #1c4b9e; border-color: #7190c4; }
@media(max-width: 480px) { .progress { flex-basis: 100%; order: 2; } }
</style>
