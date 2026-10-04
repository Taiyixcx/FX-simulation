<script setup lang="ts">
import { computed, ref } from 'vue'
import { previewTradeRisk } from '../../engine/execution'
import { formatPnl, formatUsd } from '../../priceFormatting'

const props = withDefaults(defineProps<{ isSavingObservation?: boolean; observationMessage?: string }>(), { isSavingObservation: false, observationMessage: '' })
const emit = defineEmits<{ 'record-observation': [record: { reason: string }] }>()
const questionSet = ref<0 | 1>(0)
const examples = [
  { bidPrice: '1.00000', askPrice: '1.00020', notionalUsd: '1000.00', exitPrice: '1.00010' },
  { bidPrice: '1.25000', askPrice: '1.25030', notionalUsd: '1250.00', exitPrice: '1.25020' },
] as const
const example = computed(() => examples[questionSet.value])
const fixedExample = computed(() => previewTradeRisk({ balanceUsd: '10000.00', position: null }, {
  timestampMs: Date.UTC(2024, 0, 1, 0, 1), bidPrice: example.value.bidPrice, askPrice: example.value.askPrice, askSource: 'training',
}, 'EUR/USD', 'long', example.value.notionalUsd, example.value.exitPrice))
const trainingQuestions = [
  { title: '刚买涨就出现浮亏，最先应检查什么？', options: ['Bid / Ask 的点差', '是否需要立即加大金额', '下一根一定会不会上涨'], answer: 0, explanation: '买涨按 Ask 买入、按 Bid 估值。两侧报价不同会形成即时成本；这里不另扣一次点差费。' },
  { title: '输入 1,000 USD 交易金额，是否意味着最多亏 1,000 USD？', options: ['是，系统必定在此金额内止损', '不意味着，名义金额不是亏损上限', '取决于选择折线还是 K 线'], answer: 1, explanation: '交易金额用于资金占用和数量换算。计划退出价只作假设，不是自动止损单；价格缺口和退出报价仍可能改变结果。' },
  { title: '按原计划退出但这笔亏损，如何复盘？', options: ['只要亏损就说明决策一定错误', '用下一笔更大金额追回损失', '分别检查计划执行和盈亏结果'], answer: 2, explanation: '单笔盈亏不能证明决策能力。先核对当时可见信息和是否按计划，再累计足够样本查看结果。' },
  { title: '下面示例 Bid 上涨了 1 pip，为什么买涨平仓仍亏损？', options: ['点差被另外扣了两次', '1 pip 的上涨尚未覆盖入场买卖报价差', '方向按钮没有生效'], answer: 1, explanation: '按 Ask 1.00020 买入，按 Bid 1.00010 卖出；退出报价仍低于实际入场价。盈亏只用实际双边报价计算，没有另扣点差。' },
]
const checkQuestions = [
  { title: '买跌刚开仓就有小幅浮亏，哪项解释最合理？', options: ['做空不能产生盈利', '按 Bid 卖出、Ask 买回的报价差', '行情来源被自动换成未来数据'], answer: 1, explanation: '买跌按 Bid 卖出，按当前 Ask 估值和平仓。小幅浮亏可能就是点差成本，不表示系统另外重复收费。' },
  { title: '计划在某报价退出，能否保证亏损不超过计划中的金额？', options: ['不能，计划价并非自动订单或亏损保证', '只要填写了计划就有保证', '提高播放速度后有保证'], answer: 0, explanation: '计划文字与假设报价用于理解和复盘，不会自动提交止损。完成分钟的报价、缺口和实际退出时点都会影响结果。' },
  { title: '盈利了，但临时违背原退出计划，应只记为成功吗？', options: ['是，盈利可以证明任何决定正确', '应立即用更大金额重复交易', '应分别记录盈利结果和计划偏离'], answer: 2, explanation: '盈利结果和计划执行是两个问题。保留下单前判断及实际退出说明，才能回看偏离是否有当时依据；单笔盈利不是能力证明。' },
  { title: '下面另一组示例 Bid 上涨 2 pip，为何买涨仍亏损？', options: ['开仓 Ask 1.25030 仍高于退出 Bid 1.25020', '每 pip 金额一定为零', '还需要从结果再扣一次点差'], answer: 0, explanation: '本组入场买卖报价差为 3 pip，退出 Bid 只比入场 Bid 高 2 pip，尚未超过实际买入价。金额由同一成交引擎计算，不能重复扣点差。' },
]
const questions = computed(() => questionSet.value === 0 ? trainingQuestions : checkQuestions)
const questionIndex = ref(0)
const selectedAnswer = ref<number | null>(null)
const checked = ref(false)
const observationReason = ref('点差或风险尚不清楚，先观察')
const question = computed(() => questions.value[questionIndex.value]!)
function nextQuestion() { questionIndex.value = (questionIndex.value + 1) % questions.value.length; selectedAnswer.value = null; checked.value = false }
function changeQuestionSet(set: 0 | 1) { questionSet.value = set; questionIndex.value = 0; selectedAnswer.value = null; checked.value = false }
function recordObservation() { if (observationReason.value.trim() && !props.isSavingObservation) emit('record-observation', { reason: observationReason.value.trim() }) }
</script>

<template>
  <details class="concept-practice">
    <summary>报价与风险小练习</summary>
    <p class="practice-note">概念题不使用未来行情，也不改变账户。可以只观察而不下单。</p>
    <div class="question-sets" role="group" aria-label="概念题组"><button type="button" class="button-quiet" :aria-pressed="questionSet === 0" @click="changeQuestionSet(0)">练习题 A</button><button type="button" class="button-quiet" :aria-pressed="questionSet === 1" @click="changeQuestionSet(1)">另一组核对题 B</button><span>{{ questionIndex + 1 }} / 4</span></div>
    <dl v-if="questionIndex === 3" class="fixed-example"><div><dt>固定生成示例 · EUR/USD</dt><dd>交易金额 {{ formatUsd(example.notionalUsd) }}；入场 Bid {{ example.bidPrice }} / Ask {{ example.askPrice }}</dd></div><div><dt>每 pip 美元变化</dt><dd>约 {{ formatUsd(fixedExample.usdPerPip) }}</dd></div><div><dt>入场后立即平仓</dt><dd>{{ formatPnl(fixedExample.immediateClosePnlUsd) }}</dd></div><div><dt>假设退出 Bid {{ example.exitPrice }}</dt><dd>{{ formatPnl(fixedExample.hypotheticalPnlUsd!) }}</dd></div></dl>
    <fieldset><legend>{{ question.title }}</legend><label v-for="(option, index) in question.options" :key="`${questionSet}-${questionIndex}-${index}`"><input v-model="selectedAnswer" type="radio" :name="`concept-${questionSet}-${questionIndex}`" :value="index" :disabled="checked" />{{ option }}</label></fieldset>
    <div class="practice-actions"><button type="button" class="button-outline" :disabled="selectedAnswer === null || checked" @click="checked = true">查看解释</button><button v-if="checked" type="button" class="button-quiet" @click="nextQuestion">下一题</button></div>
    <div v-if="checked" class="concept-feedback" role="status"><strong>{{ selectedAnswer === question.answer ? '概念判断正确' : '再核对这个概念' }}</strong><p>{{ question.explanation }}</p><p class="muted">这只反馈概念理解，不是盈利成绩或实盘能力评估。重复答对已经见过的题目不视为能力提升。</p></div>
    <form class="observation-form" @submit.prevent="recordObservation"><label for="observation-reason">本次选择先观察（可选理由）</label><input id="observation-reason" v-model="observationReason" maxlength="500" :disabled="isSavingObservation" /><button type="submit" class="button-outline" :disabled="!observationReason.trim() || isSavingObservation">{{ isSavingObservation ? '记录中…' : '记录不交易决定' }}</button></form>
    <p v-if="observationMessage" class="practice-note" role="status">{{ observationMessage }}</p>
  </details>
</template>

<style scoped>
.concept-practice { padding: 12px 24px; border-top: 1px solid var(--line); font-size: .875rem; line-height: 1.7; min-width: 0; }
summary { min-height: 44px; padding: 9px 0; cursor: pointer; font-weight: 600; }
.practice-note { color: var(--muted); font-size: .8125rem; margin-bottom: 12px; }
.question-sets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; font-size: .8125rem; }
.question-sets button { min-height: 44px; font-size: .8125rem; }
.question-sets button[aria-pressed="true"] { color: var(--blue); background: var(--blue-soft); }
.fixed-example { margin: 0 0 12px; padding: 10px 12px; background: var(--surface-soft); border-left: 2px solid var(--line-strong); }
.fixed-example div { margin: 5px 0; } .fixed-example dt { color: var(--muted); } .fixed-example dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { font-weight: 600; margin-bottom: 8px; }
fieldset label { display: flex; align-items: flex-start; gap: 8px; min-height: 44px; padding: 8px 0; }
input[type="radio"] { flex: none; width: 18px; height: 18px; min-height: 0; margin: 4px 0 0; accent-color: var(--blue); }
.practice-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.practice-actions button, .observation-form button { min-height: 44px; font-size: .875rem; }
.concept-feedback { border-left: 2px solid var(--blue); margin: 12px 0; padding-left: 12px; }
.concept-feedback p { margin-top: 5px; }
.observation-form { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
.observation-form label { flex-basis: 100%; }
.observation-form input { flex: 1 1 16rem; min-width: 0; max-width: 100%; }
@media (max-width: 600px) { .concept-practice { padding-inline: 16px; } }
</style>
