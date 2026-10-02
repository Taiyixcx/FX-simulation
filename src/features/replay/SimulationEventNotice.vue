<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'
import { useSessionStore } from '../../stores/useSessionStore'
import { formatTimestamp } from '../../priceFormatting'

const session = useSessionStore()
const lastEvent = computed(() => session.lastEvent)
const upcomingEvent = computed(() => session.upcomingEvent)
</script>

<template>
  <div v-if="upcomingEvent || lastEvent" class="event-notices">
    <p v-if="lastEvent" role="status" data-testid="simulation-event"><Icon name="info" :size="15" /><span>{{ formatTimestamp(lastEvent.occurredAtMs) }} · {{ lastEvent.label }}</span><InfoTip label="已发生模拟事件">{{ lastEvent.detail }}</InfoTip></p>
    <p v-if="upcomingEvent" data-testid="scheduled-event"><Icon name="clock" :size="15" /><span>计划发布 · {{ formatTimestamp(upcomingEvent.timestampMs) }} · {{ upcomingEvent.label }}</span><InfoTip label="计划模拟事件">{{ upcomingEvent.expected }}。结果会随后续行情显示，可能与预期不同。</InfoTip></p>
  </div>
</template>

<style scoped>
.event-notices { display: flex; flex-wrap: wrap; gap: 0 18px; margin: 0 0 8px; min-width: 0; }
.event-notices p { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: .8125rem; line-height: 1.6; min-width: 0; }
.event-notices p > .icon { flex: none; }
.event-notices p > span { overflow-wrap: anywhere; }
</style>
