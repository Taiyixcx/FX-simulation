<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/useSessionStore'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'

const session = useSessionStore()
const frameCount = computed(() => session.snapshot?.frames.length ?? 0)
const maxFrames = computed(() => session.snapshot?.sourceState.maxFrames ?? 0)
const progressPercent = computed(() => maxFrames.value ? frameCount.value / maxFrames.value * 100 : 0)
const playbackState = computed(() => session.isEnded ? '已结束' : session.isPlaying ? '播放中' : '已暂停')

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
        <InfoTip label="了解行情回放">播放会持续推进已完成的分钟行情；下一根只推进一次。速度表示每秒推进的分钟根数，暂停后可继续按当前报价交易。</InfoTip>
      </div>
      <span class="progress number" data-testid="progress"><span>{{ frameCount }} / {{ maxFrames }} 根</span><span class="playback-state" :class="{ 'is-playing': session.isPlaying }"> · {{ playbackState }}</span></span>
    </div>
    <div class="progress-track" role="progressbar" aria-label="已推进行情" :aria-valuenow="frameCount" :aria-valuemin="0" :aria-valuemax="maxFrames" :aria-valuetext="`${frameCount} / ${maxFrames} 根，${playbackState}`"><span :style="{ width: `${progressPercent}%` }" /></div>
  </div>
</template>

<style scoped>
.replay-controls { border-top: 1px solid var(--line); padding: 16px 0 0; }
.replay-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding-bottom: 16px; }
.playback-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.playback-actions button { display: inline-flex; justify-content: center; align-items: center; gap: 8px; min-height: 40px; padding: 8px 14px; font-size: .875rem; }
.playback-toggle { min-width: 5.5rem; }
.speed-control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.speed-control label { color: var(--muted); font-size: .875rem; }
.speed-control select { min-height: 40px; padding: 8px 24px 8px 10px; font-size: .875rem; background: var(--surface-soft); }
.progress { display: flex; flex-wrap: wrap; align-items: center; margin-left: auto; color: var(--muted); font-size: .875rem; line-height: 1.6; }
.playback-state.is-playing { color: var(--blue); }
.progress-track { height: 3px; background: var(--line); overflow: hidden; }
.progress-track span { display: block; height: 100%; min-width: 3px; background: var(--blue); }
@media (max-width: 600px) { .replay-toolbar { gap: 12px 16px; } .progress { flex-basis: 100%; margin-left: 0; } }
</style>
