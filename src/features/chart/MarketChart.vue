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
import { aggregateValidatedMarketFrames } from '../../engine/frameAggregation'
import {
  advanceViewport,
  buildTradeMarkers,
  clampViewport,
  formatChartPrice,
  formatChartTime,
  formatTimeAxisTick,
  getVisiblePriceRange,
  initialViewport,
  mapTradeMarkersToFrames,
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
  isReviewing?: boolean
  selectedTimestampMs?: number
}>()
const emit = defineEmits<{ 'exit-review': [] }>()
const timeframe = ref<'M1' | 'M5' | 'H1'>('M1')
const displayFrames = computed(() => aggregateValidatedMarketFrames(props.frames, timeframe.value))

const chartElement = ref<HTMLDivElement | null>(null)
const hoveredFrame = shallowRef<MarketFrame | null>(null)
const selectedFrameTimestampMs = ref<number | null>(null)
const selectedFrame = computed(() => displayFrames.value.find(frame => frame.quote.timestampMs === selectedFrameTimestampMs.value) ?? null)
const viewport = ref<ChartViewport>({ from: 0, to: 0 })
const isFollowingLatest = ref(true)
const markers = shallowRef<TradeMarker[]>([])
const priceRange = ref({ minValue: 0, maxValue: 1 })
const instanceId = ref('')
const detailFrame = computed(() => hoveredFrame.value ?? selectedFrame.value ?? displayFrames.value.at(-1))
const detailTime = computed(() => detailFrame.value
  ? formatChartTime(detailFrame.value.quote.timestampMs)
  : '等待行情')
const markerPrices = computed(() => markers.value.map(marker => marker.price.toFixed(5)).join(','))
const tablePage = ref(1)
const TABLE_PAGE_SIZE = 20
const tablePageCount = computed(() => Math.max(1, Math.ceil(displayFrames.value.length / TABLE_PAGE_SIZE)))
const tableFrames = computed(() => displayFrames.value.slice((tablePage.value - 1) * TABLE_PAGE_SIZE, tablePage.value * TABLE_PAGE_SIZE))
const readoutIndex = computed(() => displayFrames.value.findIndex(frame => frame.quote.timestampMs === detailFrame.value?.quote.timestampMs))
watch(tablePageCount, count => { tablePage.value = Math.min(tablePage.value, count) })

const MARKET_COLOR = '#39866d'
const BUY_GREEN = '#146747'
const SELL_RED = '#9e304c'

let chart: EChartsType | null = null
let resizeObserver: ResizeObserver | null = null
let renderedSessionId: string | null = null
let renderedChartType: 'line' | 'candlestick' | null = null
let renderedTimeframe: 'M1' | 'M5' | 'H1' | null = null
let renderedIsReviewing = false
let renderedIntervalStarts: number[] = []
let renderedFrameCount = 0
let renderedFirstTimestampMs: number | undefined
let renderedLastTimestampMs: number | undefined
let timestampKeys: string[] = []
let linePoints: number[] = []
let candlePoints: [number, number, number, number][] = []

function updatePriceRange(): void {
  priceRange.value = getVisiblePriceRange(
    displayFrames.value, viewport.value, props.chartType, markers.value, props.position?.entryPrice ?? null,
  )
}

function createSeries(): LineSeriesOption | CandlestickSeriesOption {
  const fromTimestampMs = displayFrames.value[viewport.value.from]?.quote.timestampMs ?? 0
  const toTimestampMs = displayFrames.value[viewport.value.to]?.quote.timestampMs ?? 0
  const visibleMarkers = markers.value.filter(marker => Number(marker.timestampKey) >= fromTimestampMs && Number(marker.timestampKey) <= toTimestampMs)
  const rightInsetIndex = viewport.value.to - Math.ceil((viewport.value.to - viewport.value.from) * .2)
  const nearRightTimestampMs = viewport.value.to > viewport.value.from
    ? displayFrames.value[rightInsetIndex]?.quote.timestampMs ?? Infinity : Infinity
  const availablePlotWidth = getPlotWidth()
  const latestPrice = getCurrentPrice()
  const canShowMarkerLabels = visibleMarkers.length <= 6
  // A labelled entry marker already gives the price; avoid overlapping duplicate text.
  const hasVisibleEntryMarker = visibleMarkers.some(marker => marker.id === `${props.position?.id}-open`)
  const canShowEntryLabel = !(hasVisibleEntryMarker && canShowMarkerLabels) && availablePlotWidth > chartFontSize() * 8
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
        itemStyle: { color: marker.isBuying ? BUY_GREEN : SELL_RED, borderColor: '#fff', borderWidth: 1.5 },
        label: {
          show: canShowMarkerLabels,
          position: marker.isBuying ? 'top' as const : 'bottom' as const,
          align: Number(marker.timestampKey) >= nearRightTimestampMs ? 'right' as const : 'center' as const,
          offset: Number(marker.timestampKey) >= nearRightTimestampMs ? [-10, 0] : [0, 0],
          distance: 8,
          formatter: `${marker.isBuying ? '买' : '卖'} ${formatChartPrice(marker.price)}`,
          color: marker.isBuying ? BUY_GREEN : SELL_RED,
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
      lineStyle: { color: props.position?.direction === 'long' ? BUY_GREEN : SELL_RED, type: 'dashed' as const, width: 1 },
      label: {
        show: canShowEntryLabel,
        position: 'insideStartTop' as const,
        formatter: props.position ? `开仓 ${formatChartPrice(props.position.entryPrice)}` : '',
        color: props.position?.direction === 'long' ? BUY_GREEN : SELL_RED,
        fontSize: chartFontSize(),
        backgroundColor: '#fff',
        padding: [2, 4],
      },
      data: [
        ...(props.position ? [{ yAxis: Number(props.position.entryPrice) }] : []),
        ...(latestPrice === null ? [] : [{
          yAxis: latestPrice,
          lineStyle: { color: MARKET_COLOR, type: 'dashed' as const, width: 1, opacity: .35 },
          label: {
            show: true,
            position: 'end' as const,
            distance: 8,
            formatter: formatChartPrice(latestPrice),
            color: '#fff',
            backgroundColor: '#2f765f',
            // ECharts otherwise uses the price reference line's low opacity.
            opacity: 1,
            fontSize: chartFontSize(),
            fontWeight: 600,
            padding: [4, 6],
            borderRadius: 4,
          },
        }]),
      ],
    },
  }
  return props.chartType === 'line'
    ? { ...common, type: 'line', data: linePoints, smooth: false, showSymbol: displayFrames.value.length === 1, symbolSize: 7, lineStyle: { color: MARKET_COLOR, width: 2 }, areaStyle: { color: '#f1f8f3', opacity: 1 }, itemStyle: { color: MARKET_COLOR }, emphasis: { disabled: true } }
    : { ...common, type: 'candlestick', data: candlePoints, barMaxWidth: 12, itemStyle: { color: BUY_GREEN, color0: SELL_RED, borderColor: BUY_GREEN, borderColor0: SELL_RED }, emphasis: { disabled: true } }
}

function chartFontSize(): number {
  return chartElement.value ? Number.parseFloat(getComputedStyle(chartElement.value).fontSize) || 14 : 14
}

function getChartGrid(): { left: number; right: number; top: number; bottom: number } {
  const fontSize = chartFontSize()
  return {
    left: (chartElement.value?.clientWidth ?? 0) < 500 ? 8 : 20,
    right: fontSize * 6.5,
    top: Math.max(20, fontSize),
    bottom: fontSize * 2.8,
  }
}

function getPlotWidth(): number {
  const grid = getChartGrid()
  return Math.max(0, (chartElement.value?.clientWidth ?? 0) - grid.left - grid.right)
}

// The latest quote belongs beside the axis only while its minute is in view.
function getCurrentPrice(): number | null {
  return displayFrames.value.length > 0 && viewport.value.to === displayFrames.value.length - 1
    ? Number(displayFrames.value.at(-1)!.quote.bidPrice) : null
}

function formatPriceAxisTick(price: number): string {
  const latestPrice = getCurrentPrice()
  if (latestPrice !== null) {
    const grid = getChartGrid()
    const plotHeight = Math.max(1, (chartElement.value?.clientHeight ?? 0) - grid.top - grid.bottom)
    const pixelsApart = Math.abs(price - latestPrice) / (priceRange.value.maxValue - priceRange.value.minValue) * plotHeight
    // Leave room for both a normal tick and the padded current-price badge.
    if (pixelsApart < chartFontSize() + 10) return ''
  }
  return formatChartPrice(price)
}

function createTimeAxisInterval(): (index: number) => boolean {
  const visibleCount = viewport.value.to - viewport.value.from + 1
  const labelCount = Math.max(2, Math.floor(getPlotWidth() / (chartFontSize() * 5.5)))
  const step = Math.max(1, Math.ceil((visibleCount - 1) / (labelCount - 1)))
  const firstIndex = viewport.value.from
  const lastIndex = viewport.value.to
  return index => index === lastIndex || (index - firstIndex) % step === 0
}

function viewOption(): EChartsOption {
  return {
    xAxis: { axisLabel: { interval: createTimeAxisInterval() } },
    yAxis: { min: priceRange.value.minValue, max: priceRange.value.maxValue, axisLabel: { formatter: formatPriceAxisTick } },
    dataZoom: [{ id: 'market-window', startValue: viewport.value.from, endValue: viewport.value.to }],
  }
}

function applyViewport(nextViewport: ChartViewport): void {
  if (!chart) return
  viewport.value = clampViewport(nextViewport, displayFrames.value.length)
  isFollowingLatest.value = viewport.value.to === displayFrames.value.length - 1
  updatePriceRange()
  chart.setOption({ ...viewOption(), series: [createSeries()] })
}

function handleDataZoom(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const payload = event as { start?: number; end?: number; batch?: { start?: number; end?: number }[] }
  const range = payload.batch?.[0] ?? payload
  if (typeof range.start !== 'number' || typeof range.end !== 'number') return
  const lastIndex = Math.max(0, displayFrames.value.length - 1)
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
  hoveredFrame.value = displayFrames.value[index] ?? null
}

function clearHover(): void { hoveredFrame.value = null }

function syncChart(): void {
  if (!chart) return
  const frames = displayFrames.value
  const isNewSession = renderedSessionId !== props.sessionId || renderedIsReviewing !== !!props.isReviewing
  const isTypeChanged = renderedChartType !== props.chartType
  const isTimeframeChanged = renderedTimeframe !== timeframe.value
  const previousFromTimestampMs = renderedIntervalStarts[viewport.value.from] === undefined
    ? Number(timestampKeys[viewport.value.from]) : renderedIntervalStarts[viewport.value.from]! + 1
  const previousToTimestampMs = Number(timestampKeys[viewport.value.to])
  const firstTimestampMs = frames[0]?.quote.timestampMs
  const removedFrameCount = firstTimestampMs === undefined ? -1 : timestampKeys.indexOf(toTimestampKey(firstTimestampMs))
  const isRollingWindow = !isNewSession && removedFrameCount > 0
    && frames[renderedFrameCount - removedFrameCount - 1]?.quote.timestampMs === renderedLastTimestampMs
  const isPrefixChanged = firstTimestampMs !== renderedFirstTimestampMs
    || frames.length < renderedFrameCount
    || (renderedFrameCount > 0 && frames[renderedFrameCount - 1]?.quote.timestampMs !== renderedLastTimestampMs)
  if (!isNewSession && (isTimeframeChanged || timeframe.value !== 'M1')) {
    const findIndexAtTime = (timestampMs: number) => frames.findIndex(frame => timestampMs <= frame.intervalEndMs)
    if (isFollowingLatest.value && !isTimeframeChanged) {
      viewport.value = advanceViewport(viewport.value, renderedFrameCount, frames.length, true)
    } else {
      const from = findIndexAtTime(previousFromTimestampMs)
      const to = findIndexAtTime(previousToTimestampMs)
      viewport.value = from >= 0 && to >= from ? { from, to } : initialViewport(frames.length)
    }
    timestampKeys = []
    linePoints = []
    candlePoints = []
    renderedFrameCount = 0
    hoveredFrame.value = null
  } else if (isNewSession || (isPrefixChanged && !isRollingWindow)) {
    timestampKeys = []
    linePoints = []
    candlePoints = []
    renderedFrameCount = 0
    viewport.value = initialViewport(frames.length)
    isFollowingLatest.value = true
    hoveredFrame.value = null
    selectedFrameTimestampMs.value = null
    tablePage.value = 1
  } else if (isRollingWindow) {
    viewport.value = advanceViewport(viewport.value, renderedFrameCount, frames.length, isFollowingLatest.value, removedFrameCount)
    timestampKeys.splice(0, removedFrameCount)
    linePoints.splice(0, removedFrameCount)
    candlePoints.splice(0, removedFrameCount)
    renderedFrameCount -= removedFrameCount
    if (hoveredFrame.value && hoveredFrame.value.quote.timestampMs < firstTimestampMs!) hoveredFrame.value = null
  } else if (renderedFrameCount !== frames.length) {
    viewport.value = advanceViewport(viewport.value, renderedFrameCount, frames.length, isFollowingLatest.value)
  }
  // Completed frames are immutable; adapt only newly progressed minutes.
  for (let index = renderedFrameCount; index < frames.length; index += 1) {
    const frame = frames[index]!
    timestampKeys.push(toTimestampKey(frame.quote.timestampMs))
    linePoints.push(toLinePoint(frame))
    candlePoints.push(toCandlestickPoint(frame))
  }
  markers.value = mapTradeMarkersToFrames(buildTradeMarkers(props.frames, props.position, props.trades), frames)
  updatePriceRange()
  chart.setOption({
    ...viewOption(),
    xAxis: { data: timestampKeys, axisLabel: { interval: createTimeAxisInterval() } },
    series: [createSeries()],
  }, { replaceMerge: isTypeChanged ? ['series'] : undefined })
  renderedSessionId = props.sessionId
  renderedChartType = props.chartType
  renderedTimeframe = timeframe.value
  renderedIsReviewing = !!props.isReviewing
  renderedIntervalStarts = frames.map(frame => frame.intervalStartMs)
  renderedFrameCount = frames.length
  renderedFirstTimestampMs = firstTimestampMs
  renderedLastTimestampMs = frames.at(-1)?.quote.timestampMs
}

function scrollToLatest(): void {
  hoveredFrame.value = null
  selectedFrameTimestampMs.value = null
  applyViewport(initialViewport(displayFrames.value.length))
}

function selectFrame(index: number): void {
  const frame = displayFrames.value[index]
  if (!frame) return
  hoveredFrame.value = null
  selectedFrameTimestampMs.value = frame.quote.timestampMs
  if (index < viewport.value.from || index > viewport.value.to) {
    const count = viewport.value.to - viewport.value.from + 1
    const from = Math.max(0, index - Math.floor(count / 2))
    applyViewport({ from, to: Math.min(displayFrames.value.length - 1, from + count - 1) })
  }
}

function stepReadout(delta: number): void {
  const index = displayFrames.value.findIndex(frame => frame.quote.timestampMs === detailFrame.value?.quote.timestampMs)
  selectFrame(Math.max(0, Math.min(displayFrames.value.length - 1, index + delta)))
}

function handleChartKeydown(event: KeyboardEvent): void {
  const visibleCount = viewport.value.to - viewport.value.from + 1
  const lastIndex = Math.max(0, displayFrames.value.length - 1)
  let nextViewport: ChartViewport | null = null
  if (event.key === 'End') {
    event.preventDefault()
    scrollToLatest()
    return
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    stepReadout(event.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const step = Math.max(1, Math.round(visibleCount / 5)) * (event.key === 'ArrowLeft' ? -1 : 1)
    const from = Math.max(0, Math.min(Math.max(0, lastIndex - visibleCount + 1), viewport.value.from + step))
    nextViewport = { from, to: from + visibleCount - 1 }
  } else if (event.key === '+' || event.key === '=' || event.key === '-') {
    const nextCount = Math.min(displayFrames.value.length, Math.max(2, Math.round(visibleCount * (event.key === '-' ? 1.5 : 0.7))))
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
    grid: getChartGrid(),
    xAxis: { axisLabel: { fontSize, interval: createTimeAxisInterval() }, axisPointer: { label: { fontSize } } },
    yAxis: { axisLabel: { fontSize, formatter: formatPriceAxisTick }, axisPointer: { label: { fontSize } } },
    series: [createSeries()],
  })
}

onMounted(() => {
  if (!chartElement.value) return
  chart = init(chartElement.value, undefined, { renderer: 'canvas' })
  instanceId.value = chart.id
  chart.setOption({
    animation: false,
    textStyle: { fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif', fontSize: chartFontSize(), color: '#546f69' },
    grid: getChartGrid(),
    tooltip: {
      trigger: 'axis',
      showContent: false,
      axisPointer: { type: 'cross', lineStyle: { color: '#91aaa0', type: 'dashed' }, crossStyle: { color: '#91aaa0', type: 'dashed' }, label: { backgroundColor: '#48695f' } },
    },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: [],
      axisLine: { lineStyle: { color: '#e2ede6' } },
      axisTick: { show: false },
      axisLabel: { color: '#546f69', margin: 14, hideOverlap: true, formatter: formatTimeAxisTick },
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
      axisLabel: { color: '#546f69', margin: 12, hideOverlap: true, formatter: formatPriceAxisTick },
      splitLine: { lineStyle: { color: '#e2ede6', width: 1 } },
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
  () => timeframe.value,
  () => props.isReviewing,
], syncChart, { flush: 'post' })

watch([() => props.selectedTimestampMs, () => props.frames], () => {
  if (props.selectedTimestampMs === undefined) return
  const index = displayFrames.value.findIndex(frame => props.selectedTimestampMs! > frame.intervalStartMs && props.selectedTimestampMs! <= frame.intervalEndMs)
  if (index >= 0) selectFrame(index)
}, { flush: 'post' })

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
    <div class="chart-toolbar">
      <div class="timeframe-selector" role="group" aria-label="观察周期">
        <button v-for="interval in (['M1', 'M5', 'H1'] as const)" :key="interval" type="button" :aria-pressed="timeframe === interval" @click="timeframe = interval">{{ interval }}</button>
      </div>
      <template v-if="isReviewing"><strong class="review-label">复盘观察</strong><button type="button" class="button-outline" @click="emit('exit-review')">返回当前行情</button></template>
      <span v-if="timeframe !== 'M1'" class="aggregation-note">只聚合已发生分钟；末组可能未完成</span>
    </div>
    <div class="chart-details">
      <div class="chart-readout" data-testid="chart-readout" :aria-live="selectedFrame ? 'polite' : 'off'" aria-atomic="true">
        <div class="chart-time tabular" data-testid="chart-time">
          <span class="chart-mode">{{ hoveredFrame ? '十字线' : selectedFrame ? '选中' : isReviewing ? '观察末根' : '最新' }}</span>
          {{ detailTime }} <span class="timezone">UTC+8</span>
          <InfoTip label="图表操作说明">图表只显示已发生的 Bid 行情。M5/H1 聚合窗口内已发生分钟，未完成组和缺口不补未来价格。开、高、低、收描述该组已见范围。移动指针查看时间与价格，滚轮缩放、拖动平移。聚焦图表后左右键平移，上下键逐根读数，+ / − 缩放，End 回到末根。下方行情表提供同样的时间和报价。复盘观察不改变账户或交易进度；标记仍采用实际成交价格。</InfoTip>
        </div>
        <div v-if="detailFrame" class="ohlc-readout tabular">
          <span><span class="muted">开</span> {{ formatChartPrice(detailFrame.openPrice) }}</span>
          <span><span class="muted">高</span> {{ formatChartPrice(detailFrame.highPrice) }}</span>
          <span><span class="muted">低</span> {{ formatChartPrice(detailFrame.lowPrice) }}</span>
          <span><span class="muted">收</span> {{ formatChartPrice(detailFrame.closePrice) }}</span>
        </div>
      </div>
      <button type="button" class="latest-button button-quiet" :class="{ 'is-following': isFollowingLatest }" @click="scrollToLatest"><Icon name="arrow-right" :size="16" />{{ isReviewing ? '观察末根' : '回到最新' }}</button>
    </div>
    <div class="chart-stage">
      <div
        ref="chartElement"
        class="chart-canvas"
        data-testid="market-chart"
        :data-chart-instance-id="instanceId"
        :data-frame-count="frames.length"
        :data-timeframe="timeframe"
        :data-aggregated-frame-count="displayFrames.length"
        :data-first-timestamp="frames[0]?.quote.timestampMs"
        :data-last-timestamp="frames.at(-1)?.quote.timestampMs"
        :data-viewport-start-time="displayFrames[viewport.from]?.quote.timestampMs"
        :data-viewport-end-time="displayFrames[viewport.to]?.quote.timestampMs"
        :data-viewport-from="viewport.from"
        :data-viewport-to="viewport.to"
        :data-price-min="priceRange.minValue"
        :data-price-max="priceRange.maxValue"
        :data-marker-count="markers.length"
        :data-marker-prices="markerPrices"
        role="img"
        aria-label="已发生的行情。左右键平移，上下键逐根读数，加减键缩放，End 回到末根。等价行情表在图表下方。"
        tabindex="0"
        @keydown="handleChartKeydown"
      />
      <span v-if="frames.length === 1" class="initial-state"><span class="initial-dot" />首根行情 · 待推进</span>
    </div>
    <div class="chart-accessibility-tools">
    <slot name="replay-controls" />
    <div class="readout-navigation" role="group" aria-label="逐根行情读数">
      <button type="button" class="button-quiet" :disabled="readoutIndex <= 0" @click="stepReadout(-1)">前一条读数</button>
      <span class="muted">{{ readoutIndex + 1 }} / {{ displayFrames.length }}</span>
      <button type="button" class="button-quiet" :disabled="readoutIndex >= displayFrames.length - 1" @click="stepReadout(1)">后一条读数</button>
    </div>
    <details class="quote-table-panel">
      <summary>已发生行情表 · {{ timeframe }}</summary>
      <p class="table-note">时间为组内最后已见分钟（UTC+8）；Ask 是该分钟可用买入报价。表格仅包含此观察窗口。</p>
      <div class="quote-table-scroll" tabindex="0" role="region" aria-label="已发生行情表，可横向滚动">
        <table><caption class="sr-only">{{ timeframe }} 已发生的报价及 OHLC</caption><thead><tr><th scope="col">时间 / 读数</th><th scope="col">开</th><th scope="col">高</th><th scope="col">低</th><th scope="col">收 / Bid</th><th scope="col">Ask</th><th scope="col">状态</th></tr></thead><tbody>
          <tr v-for="frame in tableFrames" :key="frame.quote.timestampMs" :class="{ 'selected-quote': frame.quote.timestampMs === selectedFrameTimestampMs }">
            <th scope="row"><button type="button" class="button-quiet" @click="selectFrame(displayFrames.indexOf(frame))">{{ formatChartTime(frame.quote.timestampMs) }}</button></th>
            <td>{{ formatChartPrice(frame.openPrice) }}</td><td>{{ formatChartPrice(frame.highPrice) }}</td><td>{{ formatChartPrice(frame.lowPrice) }}</td><td>{{ formatChartPrice(frame.closePrice) }}</td><td>{{ formatChartPrice(frame.quote.askPrice) }}</td>
            <td>{{ frame.isComplete ? '完成' : '已发生部分' }}{{ frame.hasGap ? ' · 含缺口' : '' }}{{ frame.quote.askSource === 'training' ? ' · 训练 Ask' : '' }}</td>
          </tr>
        </tbody></table>
      </div>
      <nav v-if="tablePageCount > 1" class="quote-table-pagination" aria-label="行情表分页"><button type="button" :disabled="tablePage === 1" @click="tablePage--">上一页</button><span>第 {{ tablePage }} / {{ tablePageCount }} 页</span><button type="button" :disabled="tablePage === tablePageCount" @click="tablePage++">下一页</button></nav>
    </details>
    </div>
  </section>
</template>

<style scoped>
.market-chart { min-width: 0; }
.chart-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 4px; font-size: .8125rem; }
.timeframe-selector { display: flex; gap: 3px; }
.timeframe-selector button { min-height: 36px; padding: 5px 9px; font-size: .8125rem; }
.timeframe-selector button[aria-pressed="true"] { color: var(--blue); border-color: var(--blue); background: var(--blue-soft); }
.aggregation-note, .table-note { color: var(--muted); line-height: 1.6; }
.review-label { color: var(--blue); }
.chart-accessibility-tools { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 16px; margin-top: 4px; border-top: 1px solid var(--line); }
.chart-accessibility-tools :deep(.replay-controls) { flex: 1 1 30rem; min-width: 0; }
.readout-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: .8125rem; }
.readout-navigation button { padding: 4px 8px; min-height: 36px; font-size: .8125rem; }
.quote-table-panel { flex: 1 1 10rem; min-width: 0; font-size: .8125rem; }
.quote-table-panel[open] { flex-basis: 100%; }
.quote-table-panel summary { min-height: 44px; padding: 10px 0; cursor: pointer; }
.table-note { margin-bottom: 8px; }
.quote-table-scroll { overflow-x: auto; max-width: 100%; }
.quote-table-scroll table { width: 100%; border-collapse: collapse; white-space: nowrap; font-variant-numeric: tabular-nums; }
.quote-table-scroll th, .quote-table-scroll td { text-align: right; border-bottom: 1px solid var(--line); padding: 7px 9px; }
.quote-table-scroll th:first-child { text-align: left; }
.quote-table-scroll th button { font-size: inherit; padding: 4px; font-weight: 500; }
.selected-quote { background: var(--blue-soft); }
.quote-table-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin: 10px 0; }
.chart-details { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 8px 0 0; min-height: 3.25rem; }
.chart-readout { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; min-width: 0; color: var(--muted); font-size: .875rem; }
.chart-time { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.chart-mode { color: var(--text); font-weight: 600; margin-right: 2px; }
.timezone { color: var(--muted); }
.ohlc-readout { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text); }
.hover-price { color: var(--text); }
.latest-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; min-height: 2.5rem; padding: 6px 10px; font-size: .875rem; }
.latest-button.is-following { color: var(--blue); }
.chart-stage { position: relative; }
.chart-canvas { width: 100%; height: 21.875rem; font-size: .875rem; touch-action: pan-y; }
.chart-canvas:focus-visible { outline-offset: -3px; }
.initial-state { position: absolute; bottom: 3.5rem; left: 24px; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .875rem; pointer-events: none; }
.initial-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
@media (max-width: 600px) {
  .timeframe-selector button, .readout-navigation button { min-height: 44px; }
  .chart-details { flex-wrap: wrap; padding: 8px 0 0; gap: 4px 12px; }
  .latest-button { min-width: 44px; min-height: 44px; }
  .chart-canvas { height: 18.75rem; }
  .initial-state { left: 16px; }
}
</style>
