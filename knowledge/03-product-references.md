# 同类产品参考

核对日期：**2026-09-30**。原型通过公开 HTML、JavaScript 和 CSS 静态读取核对；其余条目依据产品官方说明和帮助页，未完成付费产品的登录与交互测试。以下“借鉴”“取舍”为本项目判断，不是独立性能或易用性测评。最终布局与功能见 [产品与设计](../overview/01-product-and-design.md)。

## Bilibili 原型

### P01：直接进入练习的轻量入口

[Bilibili 外汇模拟入口](https://www.bilibili.com/toy/fx-simple/index.html)、[实际嵌入页面](https://www.bilibilitoy.com/toy/fx-simple/37279699568640-v20149/index.html)、[公开脚本](https://www.bilibilitoy.com/toy/fx-simple/37279699568640-v20149/app.js)、[公开样式](https://www.bilibilitoy.com/toy/fx-simple/37279699568640-v20149/styles.css) · **Bilibili 入口／bilibilitoy 页面｜静态源码核查**。对应：[产品定位与首用](../overview/01-product-and-design.md)。

- 已核查：公开源码包含模拟、真实汇率参考、历史场景等模式，以及交易、账户、教学和本地记录相关逻辑；真实汇率部分使用日度参考数据。外层页通过 iframe 引入实际页面；样式依赖 Google Fonts，保存函数未向用户报告捕获到的存储异常。
- 借鉴：明确的买卖入口、模式区分和与操作相邻的解释，便于快速理解练习目标。
- 取舍与限制：源码读取不证明每个功能可成功联网运行。本项目采用系统字体和明确的保存失败反馈，不沿用贷款、挑战和高杠杆体系，也不把日度参考值称作分钟成交报价；只学习思路，不复制其代码与视觉资产。

## TradingView

### P02：Bar Replay 的时间控制与边界

[How do I turn Bar Replay on?](https://www.tradingview.com/support/solutions/43000474024-how-do-i-turn-bar-replay-on/) · **TradingView｜官方帮助**。对应：[回放与报价一致性](../overview/03-data-and-trading.md)。

- 已核查：图表回放提供选择起点、播放、调速和单步。官方列出的限制包括：普通 Paper Trading 或连接经纪商的订单仍按实时数据执行，交易面板报价也可能仍是实时数据。
- 借鉴：将播放和下一根放在图表附近，暂停后仍可观察。
- 取舍与限制：本项目让图表、报价和成交共享历史进度，避免新手混淆两种时间。官方限制不能被扩写为所有 TradingView 历史交易都不支持。

### P03：Replay Trading 是独立的历史交易模式

[Learn to trade on historical data](https://www.tradingview.com/support/solutions/43000691889-learn-to-trade-on-historical-data/) · **TradingView｜官方帮助**。对应：[会话与成交记录](../overview/03-data-and-trading.md)。

- 已核查：Replay Trading 与 Paper Trading 分开，支持在回放中交易；页面说明交易和总体结果仅在该次会话可用，不保存到其他地方。
- 借鉴：入场、出场和结果与当前历史练习关联。
- 取舍与限制：本项目增加本地快照与复盘保存。这里的交易结果保留限制不能推断为图表回放进度或整个 TradingView 账号都不能保存。

### P04：Paper Trading 的账户与结果呈现

[Paper trading — main functionality](https://www.tradingview.com/support/solutions/43000516466-paper-trading-main-functionality/) · **TradingView｜官方帮助**。对应：[交易区与记录区](../overview/01-product-and-design.md)。

- 已核查：虚拟交易账户提供下单、持仓、订单和账户历史等信息，帮助观察操作结果。
- 借鉴：让报价、持仓状态和结算结果清晰分开，保留能解释结果的记录。
- 取舍与限制：它主要是跟随当前行情的模拟交易，不等于历史回放引擎。本项目不照搬多订单、多仓、账号和经纪商连接体系。

## FX Replay

### P05：围绕历史会话组织练习

[Backtest Any Trading Strategy on Real Market Data](https://fxreplay.com/backtest) · **FX Replay｜产品介绍**。对应：[工作台交互](../overview/01-product-and-design.md)。

- 已核查：官方介绍围绕历史行情进行回放、模拟下单和表现分析的流程。
- 借鉴：看图、交易与查看结果放在相近的操作环境，降低反复切换成本。
- 取舍与限制：产品页面的效率和表现宣传未独立验证。本项目只采用基础闭环，不移植脚本、复杂分析、挑战和商业账户体系。

### P06：交易日志连接决策与结果

[Trading Journal](https://fxreplay.com/trading-journal)、[How to Journal Trades Inside FX Replay’s Trading Simulator](https://fxreplay.com/learn/how-to-journal-trades-inside-fx-replays-trading-simulator) · **FX Replay｜产品介绍与官方教学**。对应：[本地复盘](../overview/01-product-and-design.md)。

- 已核查：官方介绍把交易、备注、标签和分析关联起来，用于回看入场理由、情绪和结果。
- 借鉴：在成交记录旁提供可选备注，让复盘围绕实际交易进行。
- 取舍与限制：首版保留纯文本备注，不要求用户给每笔交易填多项分类，不接入云端日志、经纪商导入或 AI 辅导；未实测自动记录的完整性与恢复能力。

### P07：回退功能的同步与性能成本

[How to Use Bar-by-Bar Rewind](https://support.fxreplay.com/articles/how-to-use-bar-by-bar-rewind) · **FX Replay｜官方功能说明**。对应：[回放边界](../overview/03-data-and-trading.md)。

- 已核查：支持按选择的回放间隔退回一根，图表和交易可见性随之调整；官方提示单图单品种效果较好，多图或多品种可能卡顿。
- 借鉴：保持一个清楚的时间控制入口和单品种工作台。
- 取舍与限制：卡顿是官方提示，未在本轮复现。首版不提供倒退后改写交易，避免同时引入账户回滚、记录重算和未来信息使用问题。

## Forex Tester

### P08：桌面版的暂停、练习与离线使用

[Forex Tester Desktop](https://desktop.forextester.com/) · **Forex Tester｜产品介绍**。对应：[基础练习流程](../overview/01-product-and-design.md)。

- 已核查：官方展示选择历史起点、暂停分析、下单、继续推进的流程，并介绍本地离线回测。
- 借鉴：暂停状态仍能完成观察和下单；将交易环境与历史数据分别说明。
- 取舍与限制：没有安装和测试桌面软件。其“真实条件”宣传不代表能完全复现实盘；多周期、自动策略、丰富成本参数和数据订阅不进入本项目首版。

### P09：在线版的项目组织与数据条件

[Forex Tester Online](https://forextester.com/) · **Forex Tester｜在线产品介绍**。对应：[会话保存与阶段安排](../overview/04-roadmap-and-acceptance.md)。

- 已核查：当前官网介绍历史练习、项目管理、成交分析和同步多图，并列出数据保留与项目时长等方案条件。
- 借鉴：围绕独立练习组织行情和交易，清楚呈现当前时间及复盘入口。
- 取舍与限制：数据精度、保留期限和规模属于官方产品说明，未独立验证。本项目使用单图、本地保存和个人备份，不承诺跨设备同步或无限保留。

## Trading Game

### P10：第一次交易只解释必要输入

[How do I make my first trade?](https://support.tradinggame.com/articles/first-trade.html) · **Trading Game｜官方帮助**。对应：[下单与首用引导](../overview/01-product-and-design.md)。

- 已核查：步骤依次为选择资产、方向、虚拟金额及杠杆、开仓，然后在持仓中观察并关闭；该页说明模拟使用市价单。
- 借鉴：把说明贴近用户当前要做的操作，开仓后立即指向持仓结果。
- 取舍与限制：本项目去掉杠杆选择，仅提供当前报价训练成交。官方步骤说明不能当作已经测试了其报价质量或完整执行行为。

### P11：学习一个概念后立即练习

[What can I learn in Trading Academy?](https://support.tradinggame.com/articles/trading-academy.html) · **Trading Game｜官方教学说明**。对应：[新手帮助](../overview/01-product-and-design.md)。

- 已核查：学院覆盖交易基础、图表和风险等主题，并鼓励把刚学到的一个概念带到模拟图表中练习；入门与付费内容分层。
- 借鉴：短解释紧接一个可完成的操作，帮助用户建立报价、点差与盈亏之间的联系。
- 取舍与限制：首版采用可跳过的三步引导，不建设课程平台、付费解锁或复杂进度系统。课程存在不等于学习效果已获本项目验证。
