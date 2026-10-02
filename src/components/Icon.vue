<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })

const paths: Record<string, string> = {
  play: 'M8 5l11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  step: 'M6 5l10 7-10 7V5ZM19 5v14',
  'chevron-down': 'm6 9 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  'arrow-up-right': 'M6 18 18 6M6 6h12v12',
  'arrow-down-right': 'm6 6 12 12M6 18h12V6',
  'arrow-right': 'M5 12h14m-6-6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6',
  info: 'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'm5 12 4 4L19 6',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4',
  refresh: 'M20 7V3m0 4h-4M4 17v4m0-4h4M20 7a9 9 0 0 0-15-1M4 17a9 9 0 0 0 15 1',
  'chart-line': 'M4 4v16h16M7 14l4-5 4 3 5-7',
  candles: 'M7 3v18M17 3v18M4 7h6v8H4V7Zm10-2h6v8h-6V5Z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path :d="paths[name] ?? paths.info" /></svg>
</template>

<style scoped>
.icon { display: inline-block; flex: none; vertical-align: middle; }
</style>
