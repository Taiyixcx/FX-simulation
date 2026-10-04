<script setup lang="ts">
import { computed } from 'vue'
import type { AccountCurvePoint } from '../../engine/tradeStatistics'
import { formatChartTime } from '../chart/chartData'
import { formatUsd } from '../../priceFormatting'

const props = defineProps<{ curve: readonly AccountCurvePoint[] }>()
// These numeric conversions position pixels only; account and drawdown calculations stay in the engine.
const plot = computed(() => {
  if (!props.curve.length) return null
  let minimum = Infinity
  let maximum = -Infinity
  for (const point of props.curve) {
    minimum = Math.min(minimum, Number(point.balanceUsd), Number(point.equityUsd))
    maximum = Math.max(maximum, Number(point.balanceUsd), Number(point.equityUsd))
  }
  const padding = Math.max(.5, (maximum - minimum) * .08)
  minimum -= padding
  maximum += padding
  const span = maximum - minimum
  const step = Math.max(1, Math.ceil(props.curve.length / 400))
  const indices: number[] = []
  for (let index = 0; index < props.curve.length; index += step) indices.push(index)
  const lastIndex = props.curve.length - 1
  if (indices.at(-1) !== lastIndex) indices.push(lastIndex)
  const coordinates = (field: 'balanceUsd' | 'equityUsd') => indices.map(index => {
    const x = lastIndex ? 72 + index / lastIndex * 616 : 380
    const y = 22 + (maximum - Number(props.curve[index]![field])) / span * 150
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return { balance: coordinates('balanceUsd'), equity: coordinates('equityUsd'), minimum, maximum, pointCount: indices.length,
    first: props.curve[0]!, last: props.curve[lastIndex]! }
})
</script>

<template>
  <figure v-if="plot" class="account-curve">
    <figcaption><strong>余额与权益</strong><span><i class="balance-key" aria-hidden="true" />余额<i class="equity-key" aria-hidden="true" />权益</span></figcaption>
    <svg viewBox="0 0 720 212" role="img" aria-label="当前练习的余额与权益分钟曲线。余额只在结算时变化，权益含浮动盈亏。回撤指标由完整行情计算。">
      <line x1="72" y1="22" x2="688" y2="22" class="grid-line" /><line x1="72" y1="172" x2="688" y2="172" class="grid-line" />
      <text x="66" y="27" text-anchor="end">{{ formatUsd(String(plot.maximum), false) }}</text><text x="66" y="177" text-anchor="end">{{ formatUsd(String(plot.minimum), false) }}</text>
      <polyline :points="plot.balance" class="balance-line" /><polyline :points="plot.equity" class="equity-line" />
      <text x="72" y="200">{{ formatChartTime(plot.first.timestampMs) }}</text><text x="688" y="200" text-anchor="end">{{ formatChartTime(plot.last.timestampMs) }}</text>
    </svg>
    <p>{{ formatChartTime(plot.first.timestampMs) }} 至 {{ formatChartTime(plot.last.timestampMs) }}（UTC+8）</p>
    <p>USD · UTC+8 · 曲线显示 {{ plot.pointCount }} 个取样点，回撤使用全部 {{ curve.length.toLocaleString('zh-CN') }} 个已发生分钟及交易操作。图线不还原分钟内或缺口内走势。</p>
    <dl class="curve-latest"><div><dt>末根余额</dt><dd>{{ formatUsd(plot.last.balanceUsd) }}</dd></div><div><dt>末根权益</dt><dd>{{ formatUsd(plot.last.equityUsd) }}</dd></div></dl>
  </figure>
</template>

<style scoped>
.account-curve { margin: 16px 0; font-size: .8125rem; color: var(--muted); min-width: 0; }
figcaption { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
figcaption strong { color: var(--text); }
figcaption span { display: inline-flex; align-items: center; gap: 7px; }
figcaption i { display: inline-block; width: 18px; height: 0; border-top: 2px solid; }
.balance-key { color: #71857e; }
.equity-key { color: var(--blue); }
svg { display: block; width: 100%; min-height: 160px; overflow: visible; }
svg text { fill: var(--muted); font: 12px Inter, "Microsoft YaHei", sans-serif; }
.grid-line { stroke: var(--line); stroke-width: 1; }
.balance-line, .equity-line { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.balance-line { stroke: #71857e; stroke-dasharray: 5 3; }
.equity-line { stroke: var(--blue); }
p { font-size: .8125rem; line-height: 1.7; }
.curve-latest { display: flex; flex-wrap: wrap; gap: 12px 28px; margin: 8px 0 0; }
dd { margin: 2px 0 0; color: var(--text); font-variant-numeric: tabular-nums; }
@media (max-width: 600px) { svg text { display: none; } }
</style>
