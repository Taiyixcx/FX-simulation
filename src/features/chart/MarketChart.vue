<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { init, use } from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import { CandlestickChart, LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { CandlestickSeriesOption, EChartsOption, LineSeriesOption } from 'echarts'
import Icon from '../../components/Icon.vue'
import InfoTip from '../../components/InfoTip.vue'
import type { MarketFrame, Position, TradeRecord } from '../../engine/types'
import {
  advanceViewport,
  buildTradeMarkers,
  clampViewport,
  formatChartPrice,
  formatChartTime,
  formatTimeAxisTick,
  getVisiblePriceRange,
  initialViewport,
  toCandlestickPoint,
  toLinePoint,
  toTimestampKey,
} from './chartData'
import type { ChartViewport, TradeMarker } from './chartData'

use([LineChart, CandlestickChart, GridComponent, TooltipComponent, DataZoomComponent, MarkPointComponent, MarkLineComponent, CanvasRenderer])

const props = defineProps<{
  frames: MarketFrame[]
  position: Position | null
  trades: TradeRecord[]
  sessionId: string
  chartType: 'line' | 'candlestick'
}>()

const chartElement = ref<HTMLDivElement | null>(null)
const hoveredFrame = shallowRef<MarketFrame | null>(null)
const viewport = ref<ChartViewport>({ from: 0, to: 0 })
const isFollowingLatest = ref(true)
const markers = shallowRef<TradeMarker[]>([])
const priceRange = ref({ minValue: 0, maxValue: 1 })
const instanceId = ref('')
const detailFrame = computed(() => hoveredFrame.value ?? props.frames.at(-1))
const detailTime = computed(() => detailFrame.value
  ? formatChartTime(detailFrame.value.quote.timestampMs)
  : '等待行情')
const markerPrices = computed(() => markers.value.map(marker => marker.price.toFixed(5)).join(','))

let chart: EChartsType | null = null
let resizeObserver: ResizeObserver | null = null
let renderedSessionId: string | null = null
let renderedChartType: 'line' | 'candlestick' | null = null
let renderedFrameCount = 0
let renderedFirstTimestampMs: number | undefined
let renderedLastTimestampMs: number | undefined
let timestampKeys: string[] = []
let linePoints: number[] = []
let candlePoints: [number, number, number, number][] = []

function updatePriceRange(): void {
  priceRange.value = getVisiblePriceRange(
    props.frames, viewport.value, props.chartType, markers.value, props.position?.entryPrice ?? null,
  )
}

function createSeries(): LineSeriesOption | CandlestickSeriesOption {
  const fromTimestampMs = props.frames[viewport.value.from]?.quote.timestampMs ?? 0
  const toTimestampMs = props.frames[viewport.value.to]?.quote.timestampMs ?? 0
  const visibleMarkers = markers.value.filter(marker => marker.timestampMs >= fromTimestampMs && marker.timestampMs <= toTimestampMs)
  const rightInsetIndex = viewport.value.to - Math.ceil((viewport.value.to - viewport.value.from) * .2)
  const nearRightTimestampMs = viewport.value.to > viewport.value.from
    ? props.frames[rightInsetIndex]?.quote.timestampMs ?? Infinity : Infinity
  const availablePlotWidth = (chartElement.value?.clientWidth ?? 0) - chartFontSize() * 6.2 - 20
  // At enlarged text sizes the actual marker already names this same entry price.
  const hasVisibleEntryMarker = visibleMarkers.some(marker => marker.id === `${props.position?.id}-open`)
  const canShowEntryLabel = availablePlotWidth > chartFontSize() * (hasVisibleEntryMarker ? 14 : 8)
  const common = {
    id: 'market-price',
    name: 'Bid',
    animation: false,
    clip: true,
    markPoint: {
      animation: false,
      symbol: 'triangle',
      symbolSize: 12,
      data: visibleMarkers.map(marker => ({
        name: marker.text,
        coord: [marker.timestampKey, marker.price],
        value: marker.price,
        symbolRotate: marker.isBuying ? 0 : 180,
        itemStyle: { color: marker.isBuying ? '#177b67' : '#b34e4a', borderColor: '#fff', borderWidth: 1 },
        label: {
          show: visibleMarkers.length <= 6,
          position: marker.isBuying ? 'top' as const : 'bottom' as const,
          align: marker.timestampMs >= nearRightTimestampMs ? 'right' as const : 'center' as const,
          offset: marker.timestampMs >= nearRightTimestampMs ? [-10, 0] : [0, 0],
          distance: 8,
          formatter: `${marker.isBuying ? '买' : '卖'} ${formatChartPrice(marker.price)}`,
          color: marker.isBuying ? '#177b67' : '#b34e4a',
          fontSize: chartFontSize(),
          backgroundColor: '#fff',
          padding: [2, 4],
          borderRadius: 3,
        },
      })),
    },
    markLine: {
      silent: true,
      animation: false,
      // Its default precision of 2 would round an FX entry out of the visible range.
      precision: 5,
      symbol: 'none',
      lineStyle: { color: props.position?.direction === 'long' ? '#177b67' : '#b34e4a', type: 'dashed' as const, width: 1 },
      label: {
        show: canShowEntryLabel,
        position: 'insideStartTop' as const,
        formatter: props.position ? `开仓 ${formatChartPrice(props.position.entryPrice)}` : '',
        color: props.position?.direction === 'long' ? '#177b67' : '#b34e4a',
        fontSize: chartFontSize(),
        backgroundColor: '#fff',
        padding: [2, 4],
      },
      data: props.position ? [{ yAxis: Number(props.position.entryPrice) }] : [],
    },
  }
  return props.chartType === 'line'
    ? { ...common, type: 'line', data: linePoints, smooth: false, showSymbol: props.frames.length === 1, symbolSize: 7, lineStyle: { color: '#4263eb', width: 2 }, itemStyle: { color: '#4263eb' }, emphasis: { disabled: true } }
    : { ...common, type: 'candlestick', data: candlePoints, barMaxWidth: 12, itemStyle: { color: '#177b67', color0: '#b34e4a', borderColor: '#177b67', borderColor0: '#b34e4a' }, emphasis: { disabled: true } }
}

function chartFontSize(): number {
  return chartElement.value ? Number.parseFloat(getComputedStyle(chartElement.value).fontSize) || 14 : 14
}

function viewOption(): EChartsOption {
  return {
    yAxis: { min: priceRange.value.minValue, max: priceRange.value.maxValue },
    dataZoom: [{ id: 'market-window', startValue: viewport.value.from, endValue: viewport.value.to }],
  }
}

function applyViewport(nextViewport: ChartViewport): void {
  if (!chart) return
  viewport.value = clampViewport(nextViewport, props.frames.length)
  isFollowingLatest.value = viewport.value.to === props.frames.length - 1
  updatePriceRange()
  chart.setOption({ ...viewOption(), series: [createSeries()] })
}

function handleDataZoom(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const payload = event as { start?: number; end?: number; batch?: { start?: number; end?: number }[] }
  const range = payload.batch?.[0] ?? payload
  if (typeof range.start !== 'number' || typeof range.end !== 'number') return
  const lastIndex = Math.max(0, props.frames.length - 1)
  // ECharts emits percentages; immediately store absolute indices before any append.
  applyViewport({ from: range.start * lastIndex / 100, to: range.end * lastIndex / 100 })
}

function handleAxisPointer(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const payload = event as { axesInfo?: { axisDim?: string; value?: string | number }[] }
  const axisValue = payload.axesInfo?.find(axis => axis.axisDim === 'x')?.value
  const index = typeof axisValue === 'string'
    ? timestampKeys.indexOf(axisValue)
    : typeof axisValue === 'number' ? Math.round(axisValue) : -1
  hoveredFrame.value = props.frames[index] ?? null
}

function clearHover(): void { hoveredFrame.value = null }

function syncChart(): void {
  if (!chart) return
  const isNewSession = renderedSessionId !== props.sessionId
  const isTypeChanged = renderedChartType !== props.chartType
  const firstTimestampMs = props.frames[0]?.quote.timestampMs
  const isPrefixChanged = firstTimestampMs !== renderedFirstTimestampMs
    || props.frames.length < renderedFrameCount
    || (renderedFrameCount > 0 && props.frames[renderedFrameCount - 1]?.quote.timestampMs !== renderedLastTimestampMs)
  if (isNewSession || isPrefixChanged) {
    timestampKeys = []
    linePoints = []
    candlePoints = []
    renderedFrameCount = 0
    viewport.value = initialViewport(props.frames.length)
    isFollowingLatest.value = true
    hoveredFrame.value = null
  } else if (renderedFrameCount !== props.frames.length) {
    viewport.value = advanceViewport(viewport.value, renderedFrameCount, props.frames.length, isFollowingLatest.value)
  }
  // Completed frames are immutable; adapt only newly progressed minutes.
  for (let index = renderedFrameCount; index < props.frames.length; index += 1) {
    const frame = props.frames[index]!
    timestampKeys.push(toTimestampKey(frame.quote.timestampMs))
    linePoints.push(toLinePoint(frame))
    candlePoints.push(toCandlestickPoint(frame))
  }
  markers.value = buildTradeMarkers(props.frames, props.position, props.trades)
  updatePriceRange()
  chart.setOption({
    ...viewOption(),
    xAxis: { data: timestampKeys },
    series: [createSeries()],
  }, { replaceMerge: isTypeChanged ? ['series'] : undefined })
  renderedSessionId = props.sessionId
  renderedChartType = props.chartType
  renderedFrameCount = props.frames.length
  renderedFirstTimestampMs = firstTimestampMs
  renderedLastTimestampMs = props.frames.at(-1)?.quote.timestampMs
}

function scrollToLatest(): void {
  hoveredFrame.value = null
  applyViewport(initialViewport(props.frames.length))
}

function handleChartKeydown(event: KeyboardEvent): void {
  const visibleCount = viewport.value.to - viewport.value.from + 1
  const lastIndex = Math.max(0, props.frames.length - 1)
  let nextViewport: ChartViewport | null = null
  if (event.key === 'End') {
    event.preventDefault()
    scrollToLatest()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const step = Math.max(1, Math.round(visibleCount / 5)) * (event.key === 'ArrowLeft' ? -1 : 1)
    const from = Math.max(0, Math.min(Math.max(0, lastIndex - visibleCount + 1), viewport.value.from + step))
    nextViewport = { from, to: from + visibleCount - 1 }
  } else if (event.key === '+' || event.key === '=' || event.key === '-') {
    const nextCount = Math.min(props.frames.length, Math.max(2, Math.round(visibleCount * (event.key === '-' ? 1.5 : 0.7))))
    const center = (viewport.value.from + viewport.value.to) / 2
    const from = Math.max(0, Math.min(Math.max(0, lastIndex - nextCount + 1), Math.round(center - (nextCount - 1) / 2)))
    nextViewport = { from, to: from + nextCount - 1 }
  }
  if (nextViewport) {
    event.preventDefault()
    clearHover()
    applyViewport(nextViewport)
  }
}

function resizeChart(): void {
  if (!chart || !chartElement.value) return
  chart.resize()
  const fontSize = chartFontSize()
  chart.setOption({
    textStyle: { fontSize },
    grid: { left: chartElement.value.clientWidth < 500 ? 8 : 20, right: fontSize * 6.2, top: 20, bottom: fontSize * 2.6 },
    xAxis: { axisLabel: { fontSize }, axisPointer: { label: { fontSize } } },
    yAxis: { axisLabel: { fontSize }, axisPointer: { label: { fontSize } } },
    series: [createSeries()],
  })
}

onMounted(() => {
  if (!chartElement.value) return
  chart = init(chartElement.value, undefined, { renderer: 'canvas' })
  instanceId.value = chart.id
  chart.setOption({
    animation: false,
    textStyle: { fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif', fontSize: chartFontSize(), color: '#637188' },
    grid: { left: 20, right: 87, top: 20, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      showContent: false,
      axisPointer: { type: 'cross', lineStyle: { color: '#a3b0c5', type: 'dashed' }, crossStyle: { color: '#a3b0c5', type: 'dashed' }, label: { backgroundColor: '#637188' } },
    },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: [],
      axisLine: { lineStyle: { color: '#e7ecf3' } },
      axisTick: { show: false },
      axisLabel: { color: '#7a879a', margin: 14, hideOverlap: true, formatter: formatTimeAxisTick },
      splitLine: { show: false },
      axisPointer: { label: { formatter: (params: { value: unknown }) => formatTimeAxisTick(String(params.value)) } },
    },
    yAxis: {
      type: 'value',
      position: 'right',
      scale: true,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#7a879a', margin: 12, formatter: (price: number) => formatChartPrice(price) },
      splitLine: { lineStyle: { color: '#edf1f6', width: 1 } },
      axisPointer: { label: { formatter: (params: { value: unknown }) => formatChartPrice(Number(params.value)) } },
    },
    dataZoom: [{
      id: 'market-window',
      type: 'inside',
      xAxisIndex: 0,
      filterMode: 'none',
      rangeMode: ['value', 'value'],
      zoomOnMouseWheel: true,
      moveOnMouseMove: true,
      moveOnMouseWheel: false,
      preventDefaultMouseMove: false,
      throttle: 30,
    }],
  })
  chart.on('datazoom', handleDataZoom)
  chart.on('updateAxisPointer', handleAxisPointer)
  chart.getZr().on('globalout', clearHover)
  resizeObserver = new ResizeObserver(resizeChart)
  resizeObserver.observe(chartElement.value)
  syncChart()
  resizeChart()
})

watch([
  () => props.sessionId,
  () => props.chartType,
  () => props.frames,
  () => props.frames.length,
  () => props.position,
  () => props.trades,
  () => props.trades.length,
], syncChart, { flush: 'post' })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.off('datazoom', handleDataZoom)
  chart?.off('updateAxisPointer', handleAxisPointer)
  chart?.getZr().off('globalout', clearHover)
  chart?.dispose()
  chart = null
})
</script>

<template>
  <section class="market-chart" aria-label="已推进的 Bid 行情图表">
    <div class="chart-details">
      <div class="chart-readout" data-testid="chart-readout">
        <div class="chart-time tabular" data-testid="chart-time">
          <span class="chart-mode">{{ hoveredFrame ? '十字线' : '最新' }}</span>
          {{ detailTime }} <span class="timezone">UTC+8</span>
          <InfoTip label="图表操作说明">图表只显示已推进的一分钟 Bid 行情。K 线的开、高、低、收分别表示该分钟的开盘价、最高价、最低价和收盘价。移动指针查看时间与价格，滚轮缩放、拖动平移。聚焦图表后，左右方向键平移，+ / − 缩放，End 回到最新。买卖标记位于实际成交价格；虚线表示当前持仓的开仓价。</InfoTip>
        </div>
        <div v-if="detailFrame && chartType === 'candlestick'" class="ohlc-readout tabular">
          <span><span class="muted">开</span> {{ formatChartPrice(detailFrame.openPrice) }}</span>
          <span><span class="muted">高</span> {{ formatChartPrice(detailFrame.highPrice) }}</span>
          <span><span class="muted">低</span> {{ formatChartPrice(detailFrame.lowPrice) }}</span>
          <span><span class="muted">收</span> {{ formatChartPrice(detailFrame.closePrice) }}</span>
        </div>
        <span v-else-if="hoveredFrame" class="hover-price tabular">Bid {{ formatChartPrice(hoveredFrame.quote.bidPrice) }}</span>
      </div>
      <button type="button" class="latest-button button-quiet" :class="{ 'is-following': isFollowingLatest }" @click="scrollToLatest"><Icon name="arrow-right" :size="16" />回到最新</button>
    </div>
    <div class="chart-stage">
      <div
        ref="chartElement"
        class="chart-canvas"
        data-testid="market-chart"
        :data-chart-instance-id="instanceId"
        :data-frame-count="frames.length"
        :data-viewport-from="viewport.from"
        :data-viewport-to="viewport.to"
        :data-price-min="priceRange.minValue"
        :data-price-max="priceRange.maxValue"
        :data-marker-count="markers.length"
        :data-marker-prices="markerPrices"
        role="img"
        aria-label="已推进的行情。方向键平移，加减键缩放，End 回到最新。"
        tabindex="0"
        @keydown="handleChartKeydown"
      />
      <span v-if="frames.length === 1" class="initial-state"><span class="initial-dot" />首根行情 · 待推进</span>
    </div>
  </section>
</template>

<style scoped>
.market-chart { min-width: 0; }
.chart-details { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 8px 0 0; min-height: 3.25rem; }
.chart-readout { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; min-width: 0; color: var(--muted); font-size: .875rem; }
.chart-time { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.chart-mode { color: var(--text); font-weight: 500; margin-right: 2px; }
.timezone { color: #7a879a; }
.ohlc-readout { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text); }
.hover-price { color: var(--text); }
.latest-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; min-height: 2rem; padding: 4px 8px; font-size: .875rem; }
.latest-button.is-following { color: var(--blue); }
.chart-stage { position: relative; }
.chart-canvas { width: 100%; height: 24.375rem; font-size: .875rem; touch-action: pan-y; }
.chart-canvas:focus-visible { outline-offset: -3px; }
.initial-state { position: absolute; bottom: 3.5rem; left: 24px; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .875rem; pointer-events: none; }
.initial-dot { width: 6px; height: 6px; border-radius: 50%; background: #a3b0c5; }
@media (max-width: 600px) {
  .chart-details { flex-wrap: wrap; padding: 8px 0 0; gap: 4px 12px; }
  .chart-canvas { height: 20.625rem; }
  .initial-state { left: 16px; }
}
</style>
