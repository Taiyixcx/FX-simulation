<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
const frameCount = computed(() => session.snapshot ? session.snapshot.sourceState.frameIndex + 1 : 0)
const maxFrames = computed(() => session.snapshot?.sourceState.maxFrames ?? null)
const isContinuous = computed(() => maxFrames.value === null)
const progressPercent = computed(() => maxFrames.value ? frameCount.value / maxFrames.value * 100 : 0)
const playbackState = computed(() => session.isEnded ? '已结束' : session.isPlaying ? '播放中' : '已暂停')
const isIncrementalProgress = ref(false)

watch(frameCount, (count, previousCount) => {
  isIncrementalProgress.value = count === previousCount + 1
})

function changeSpeed(event: Event) {
  const speed = Number((event.target as HTMLSelectElement).value)
  if (speed === 1 || speed === 5 || speed === 10) session.setSpeed(speed)
}

function togglePlayback() {
  if (session.isPlaying) session.pause()
  else session.play()
}
</script>

<template>
  <div class="replay-controls" aria-label="行情回放控制">
    <div class="replay-toolbar">
      <div class="playback-actions">
        <button class="playback-toggle button-primary" :aria-label="session.isPlaying ? '暂停' : '播放'" :disabled="!session.isPlaying && !session.canAdvance" @click="togglePlayback"><Icon :name="session.isPlaying ? 'pause' : 'play'" :size="16" /><span>{{ session.isPlaying ? '暂停' : '播放' }}</span></button>
        <button class="next-frame button-outline" aria-label="下一根" :disabled="!session.canAdvance || session.isPlaying" @click="session.next()"><Icon name="step" :size="17" /><span>下一根</span></button>
      </div>
      <div class="speed-control">
        <label for="replay-speed">速度</label>
        <select id="replay-speed" :value="session.speed" :disabled="!session.isReady" @change="changeSpeed"><option :value="1">1 根/秒</option><option :value="5">5 根/秒</option><option :value="10">10 根/秒</option></select>
        <InfoTip label="了解行情回放">模拟练习持续生成，历史回放按数据集的分钟报价推进；下一根只推进一次。速度表示每秒推进的分钟根数，跨休市或数据缺口时保留实际时间间隔。暂停或数据结束后可按当前报价平仓，刷新后保留进度并暂停。</InfoTip>
      </div>
      <span class="progress number" data-testid="progress"><span v-if="isContinuous">已推进 {{ frameCount }} 根</span><span v-else>{{ frameCount }} / {{ maxFrames }} 根</span><span class="playback-state" :class="{ 'is-playing': session.isPlaying }"> · {{ playbackState }}</span></span>
    </div>
    <div v-if="maxFrames !== null" class="progress-track" role="progressbar" aria-label="已推进行情" :aria-valuenow="frameCount" :aria-valuemin="0" :aria-valuemax="maxFrames" :aria-valuetext="`${frameCount} / ${maxFrames} 根，${playbackState}`"><span :class="{ 'is-incremental': isIncrementalProgress }" :style="{ width: `${progressPercent}%` }" /></div>
  </div>
</template>

<style scoped>
.replay-controls { border-top: 1px solid var(--line); padding: 14px 0 0; }
.replay-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding-bottom: 14px; }
.playback-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.playback-actions button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; min-height: 40px; padding: 8px 13px; border-radius: 6px; font-size: .875rem; }
.playback-actions :deep(svg) { flex: none; }
.playback-toggle { min-width: 5.5rem; }
.next-frame { color: var(--text); }
.speed-control { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.speed-control label { color: var(--muted); font-size: .8125rem; }
.speed-control select { min-height: 40px; padding: 7px 26px 7px 10px; border-color: var(--line-strong); border-radius: 6px; font-size: .875rem; background: var(--surface-soft); }
.progress { display: flex; flex-wrap: wrap; align-items: center; margin-left: auto; color: var(--muted); font-size: .8125rem; line-height: 1.6; }
.playback-state { white-space: nowrap; }
.playback-state.is-playing { color: var(--blue); }
.progress-track { height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
.progress-track span { display: block; height: 100%; background: var(--blue); }
.progress-track span.is-incremental { transition: width 100ms linear; }
@media (max-width: 600px) { .replay-toolbar { gap: 12px 16px; } .playback-actions button, .speed-control select { min-height: 44px; } .progress { flex-basis: 100%; margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { .progress-track span.is-incremental { transition: none; } }
</style>
