<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import Icon from './Icon.vue'

defineProps<{ label: string }>()
const id = useId()
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const isOpen = ref(false)
const placement = ref({ left: 16, top: 16 })
const panelStyle = computed(() => ({ left: `${placement.value.left}px`, top: `${placement.value.top}px` }))

function positionPanel() {
  if (!trigger.value || !panel.value) return
  const rect = trigger.value.getBoundingClientRect()
  const tip = panel.value.getBoundingClientRect()
  placement.value = {
    left: Math.max(16, Math.min(rect.left - 12, window.innerWidth - tip.width - 16)),
    top: Math.max(16, rect.bottom + tip.height + 12 <= window.innerHeight ? rect.bottom + 10 : rect.top - tip.height - 10),
  }
}
function close(restoreFocus = true) {
  isOpen.value = false
  if (restoreFocus) trigger.value?.focus()
}
async function toggle() {
  if (isOpen.value) return close()
  isOpen.value = true
  await nextTick()
  positionPanel()
  panel.value?.focus({ preventScroll: true })
}
function onPointerDown(event: PointerEvent) {
  if (isOpen.value && event.target instanceof Node && !panel.value?.contains(event.target) && !trigger.value?.contains(event.target)) close(false)
}
function onKeyDown(event: KeyboardEvent) {
  if (isOpen.value && event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}
function onFocusIn(event: FocusEvent) {
  if (isOpen.value && event.target instanceof Node && !panel.value?.contains(event.target) && !trigger.value?.contains(event.target)) close(false)
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('focusin', onFocusIn)
  window.addEventListener('resize', positionPanel)
  window.addEventListener('scroll', positionPanel, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('focusin', onFocusIn)
  window.removeEventListener('resize', positionPanel)
  window.removeEventListener('scroll', positionPanel, true)
})
</script>

<template>
  <span class="info-tip">
    <button ref="trigger" type="button" class="info-trigger" :aria-label="label" :aria-expanded="isOpen" :aria-controls="id" aria-haspopup="dialog" @click="toggle"><Icon name="info" :size="16" /></button>
    <Teleport to="body">
      <div v-if="isOpen" :id="id" ref="panel" class="info-panel" role="dialog" :aria-label="label" tabindex="-1" :style="panelStyle">
        <div class="info-heading"><strong>{{ label }}</strong><button type="button" class="info-close" aria-label="关闭说明" @click="close()"><Icon name="close" :size="16" /></button></div>
        <div class="info-content"><slot /></div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.info-tip { display: inline-flex; vertical-align: middle; }
.info-trigger { display: inline-flex; align-items: center; justify-content: center; width: 1.75rem; height: 1.75rem; min-height: 0; padding: 0; color: var(--muted); border: 0; background: transparent; border-radius: 6px; }
.info-trigger:hover, .info-trigger[aria-expanded="true"] { color: var(--blue); background: var(--blue-soft); }
.info-panel { position: fixed; z-index: 50; width: min(340px, calc(100vw - 32px)); padding: 18px; border: 1px solid var(--line-strong); border-radius: 10px; color: var(--text); background: var(--surface); box-shadow: 0 4px 12px #18212e08, 0 16px 40px #18212e12; font-size: .875rem; line-height: 1.75; max-height: calc(100vh - 32px); overflow: auto; animation: info-appear 140ms var(--ease, ease) both; }
.info-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
.info-heading strong { font-weight: 600; }
.info-close { display: grid; place-items: center; flex: none; border: 0; border-radius: 6px; background: transparent; min-height: 0; width: 1.75rem; height: 1.75rem; padding: 0; color: var(--muted); }
.info-content { color: var(--muted); }
@keyframes info-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 600px) { .info-trigger, .info-close { width: 44px; height: 44px; } }
@media (prefers-reduced-motion: reduce) { .info-panel { animation: none; } }
</style>
