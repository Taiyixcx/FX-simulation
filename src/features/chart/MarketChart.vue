<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type {
  AutoscaleInfoProvider,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesMarker,
  Time,
} from 'lightweight-charts'
import type { MarketFrame, Position, TradeRecord } from '../../engine/types'
import {
  buildTradeMarkers,
  formatChartPrice,
  formatChartTime,
  formatTimeAxisTick,
  includeVisibleTradePrices,
  toCandlestickPoint,
  toLinePoint,
  toTimeSec,
} from './chartData'

const props = defineProps<{
  frames: MarketFrame[]
  position: Position | null
  trades: TradeRecord[]
  sessionId: string
  chartType: 'line' | 'candlestick'
}>()

const chartElement = ref<HTMLDivElement | null>(null)
const hoveredFrame = shallowRef<MarketFrame | null>(null)
const detailFrame = computed(() => hoveredFrame.value ?? props.frames.at(-1))
const detailTime = computed(() => detailFrame.value
  ? formatChartTime(toTimeSec(detailFrame.value.quote.timestampMs))
  : '暂无行情')

let chart: IChartApi | null = null
let series: ISeriesApi<'Line' | 'Candlestick'> | null = null
let seriesMarkers: ISeriesMarkersPluginApi<Time> | null = null
let entryPriceLine: IPriceLine | null = null
let resizeObserver: ResizeObserver | null = null
let renderedSessionId: string | null = null
let renderedChartType: 'line' | 'candlestick' | null = null
let renderedFrameCount = 0
let renderedFirstTimestampMs: number | undefined
let renderedLastTimestampMs: number | undefined
let tradeMarkers: SeriesMarker<Time>[] = []
const framesByTimeSec = new Map<number, MarketFrame>()

function handleCrosshairMove(event: MouseEventParams<Time>): void {
  hoveredFrame.value = typeof event.time === 'number'
    ? framesByTimeSec.get(event.time) ?? null
    : null
}

function updateTradeAnnotations(): void {
  if (!series) return
  tradeMarkers = buildTradeMarkers(props.frames, props.position, props.trades)
  seriesMarkers?.setMarkers(tradeMarkers)
  if (entryPriceLine) {
    series.removePriceLine(entryPriceLine)
    entryPriceLine = null
  }
  if (props.position) {
    entryPriceLine = series.createPriceLine({
      price: Number(props.position.entryPrice),
      color: props.position.direction === 'long' ? '#176b56' : '#a64237',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
    })
  }
}

function replaceSeries(): void {
  if (!chart) return
  seriesMarkers?.detach()
  seriesMarkers = null
  entryPriceLine = null
  if (series) chart.removeSeries(series)
  const autoscaleInfoProvider: AutoscaleInfoProvider = (getDefault) => {
    const scale = getDefault()
    if (!scale?.priceRange) return scale
    return {
      ...scale,
      priceRange: includeVisibleTradePrices(
        scale.priceRange,
        tradeMarkers,
        chart?.timeScale().getVisibleRange() ?? null,
        props.position?.entryPrice ?? null,
      ),
    }
  }
  const commonOptions = {
    priceFormat: { type: 'price' as const, precision: 5, minMove: 0.00001 },
    priceLineVisible: false,
    autoscaleInfoProvider,
  }
  series = props.chartType === 'line'
    ? chart.addSeries(LineSeries, { ...commonOptions, color: '#2561a6', lineWidth: 2 })
    : chart.addSeries(CandlestickSeries, {
      ...commonOptions,
      upColor: '#237c67',
      downColor: '#b9554a',
      borderUpColor: '#237c67',
      borderDownColor: '#b9554a',
      wickUpColor: '#237c67',
      wickDownColor: '#b9554a',
    })
  seriesMarkers = createSeriesMarkers(series, [], { autoScale: true })
}

function syncChart(): void {
  if (!chart) return
  const isNewSession = renderedSessionId !== props.sessionId
  const isTypeChanged = renderedChartType !== props.chartType
  const firstTimestampMs = props.frames[0]?.quote.timestampMs
  const isPrefixChanged = firstTimestampMs !== renderedFirstTimestampMs
    || props.frames.length < renderedFrameCount
    || (renderedFrameCount > 0
      && props.frames[renderedFrameCount - 1]?.quote.timestampMs !== renderedLastTimestampMs)
  const shouldReplaceData = isNewSession || isTypeChanged || isPrefixChanged || !series
  const previousRange = !isNewSession ? chart.timeScale().getVisibleLogicalRange() : null

  if (isTypeChanged || !series) replaceSeries()
  if (!series) return
  if (shouldReplaceData) {
    series.setData(props.chartType === 'line'
      ? props.frames.map(toLinePoint)
      : props.frames.map(toCandlestickPoint))
    framesByTimeSec.clear()
    for (const frame of props.frames) framesByTimeSec.set(toTimeSec(frame.quote.timestampMs), frame)
    hoveredFrame.value = null
    if (isNewSession) {
      chart.timeScale().setVisibleLogicalRange({ from: -20, to: Math.max(20, props.frames.length + 3) })
    } else if (previousRange) {
      chart.timeScale().setVisibleLogicalRange(previousRange)
    }
  } else {
    // Completed minutes are immutable. Only append the newly revealed prefix.
    for (let index = renderedFrameCount; index < props.frames.length; index += 1) {
      const frame = props.frames[index]
      if (!frame) continue
      series.update(props.chartType === 'line' ? toLinePoint(frame) : toCandlestickPoint(frame))
      framesByTimeSec.set(toTimeSec(frame.quote.timestampMs), frame)
    }
  }
  renderedSessionId = props.sessionId
  renderedChartType = props.chartType
  renderedFrameCount = props.frames.length
  renderedFirstTimestampMs = firstTimestampMs
  renderedLastTimestampMs = props.frames.at(-1)?.quote.timestampMs
  updateTradeAnnotations()
}

function scrollToLatest(): void {
  chart?.timeScale().scrollToRealTime()
}

onMounted(() => {
  if (!chartElement.value) return
  const container = chartElement.value
  chart = createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: '#ffffff' },
      textColor: '#526073',
      fontSize: 14,
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
      attributionLogo: true,
    },
    grid: { vertLines: { color: '#edf0f3' }, horzLines: { color: '#edf0f3' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#dce2e8', scaleMargins: { top: 0.18, bottom: 0.16 } },
    timeScale: {
      borderColor: '#dce2e8',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      tickMarkFormatter: formatTimeAxisTick,
      shiftVisibleRangeOnNewBar: true,
    },
    localization: { locale: 'zh-CN', timeFormatter: formatChartTime },
    handleScroll: { vertTouchDrag: false },
  })
  chart.subscribeCrosshairMove(handleCrosshairMove)
  resizeObserver = new ResizeObserver(() => {
    const fontSize = Number.parseFloat(getComputedStyle(container).fontSize)
    chart?.applyOptions({
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { fontSize: Number.isFinite(fontSize) ? fontSize : 14 },
    })
  })
  resizeObserver.observe(container)
  syncChart()
})

watch([
  () => props.sessionId,
  () => props.chartType,
  () => props.frames,
  () => props.frames.length,
], syncChart, { flush: 'post' })
watch([() => props.position, () => props.trades, () => props.trades.length], updateTradeAnnotations, {
  flush: 'post',
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.unsubscribeCrosshairMove(handleCrosshairMove)
  seriesMarkers?.detach()
  seriesMarkers = null
  chart?.remove()
  chart = null
  series = null
  entryPriceLine = null
  tradeMarkers = []
  framesByTimeSec.clear()
})
</script>

<template>
  <section class="market-chart" aria-label="已推进的 Bid 行情图表">
    <div class="chart-details">
      <div class="chart-legend">
        <span>{{ hoveredFrame ? '十字线' : '最新行情' }} {{ detailTime }}（UTC+8）</span>
        <template v-if="detailFrame">
          <span v-if="chartType === 'line'">Bid {{ formatChartPrice(detailFrame.quote.bidPrice) }}</span>
          <template v-else>
            <span>开 {{ formatChartPrice(detailFrame.openPrice) }}</span>
            <span>高 {{ formatChartPrice(detailFrame.highPrice) }}</span>
            <span>低 {{ formatChartPrice(detailFrame.lowPrice) }}</span>
            <span>收 {{ formatChartPrice(detailFrame.closePrice) }}</span>
          </template>
        </template>
        <span v-if="position" class="entry-legend">
          开仓线：{{ position.direction === 'long' ? '做多 Ask' : '做空 Bid' }}
          {{ formatChartPrice(position.entryPrice) }}
        </span>
      </div>
      <button type="button" class="latest-button" @click="scrollToLatest">回到最新</button>
    </div>
    <div ref="chartElement" class="chart-canvas" data-testid="market-chart" />
    <p v-if="chartType === 'candlestick'" class="chart-explanation">
      每根 K 线表示一分钟的 Bid 开盘、最高、最低和收盘价。
    </p>
    <p class="chart-attribution">
      TradingView Lightweight Charts™<br>
      Copyright (с) 2025 TradingView, Inc.
      <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">https://www.tradingview.com/</a>
    </p>
  </section>
</template>

<style scoped>
.market-chart {
  min-width: 0;
}

.chart-details {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 0;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  color: #526073;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}

.latest-button {
  flex: 0 0 auto;
  padding: 0.2rem 0.4rem;
  border: 0;
  background: transparent;
  color: #2561a6;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}

.entry-legend {
  color: #33465e;
}

.latest-button:focus-visible {
  outline: 2px solid #2561a6;
  outline-offset: 2px;
}

.chart-canvas {
  width: 100%;
  height: clamp(18rem, 40vw, 29rem);
  font-size: 0.875rem;
}

.chart-explanation,
.chart-attribution {
  margin: 0.5rem 0 0;
  color: #526073;
  font-size: 0.875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.chart-attribution a {
  color: #2561a6;
}

@media (max-width: 520px) {
  .chart-details {
    flex-wrap: wrap;
  }

  .chart-canvas {
    height: 20rem;
  }
}
</style>
