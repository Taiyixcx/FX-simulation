# 精致工作台与交互设计研究

核对日期：**2026-10-01**。覆盖 **19 个官方页面、9 个产品和 4 套设计体系**。对应设计：[整体页面美化方案](../overview/05-interface-redesign.md)。

资料通过公开页面正文及可获得的官方截图/截图结构说明核对。没有登录、购买或完整操作这些产品；官方宣传图、作者设计复盘与实际运行验证分别理解。页面展示的能力不代表本项目需要实现，截图不能证明其键盘、手机或性能表现。以下“对应设计”和参数取舍属于本项目判断。

## 产品页面与设计复盘

| 编号 / 机构 | 官方来源 / 资料类型 | 核对结论 | 对应设计与适用限制 |
| --- | --- | --- | --- |
| V01 TradingView | [Getting started with Supercharts](https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/) · 官方教程与工具栏示意 | 顶部承载品种、周期与图表类型，底部提供观察区间、时区等工具，功能围绕主图分工 | 主图上方组织内容、下方组织回放。保留新手可读的动作文字，不复制密集绘图工具或经纪商入口 |
| V02 Koyfin | [My Dashboards](https://www.koyfin.com/help/mydashboards-myd/) · 官方帮助与截图 | 表格、中心图表与分类信息形成模块化布局；官方说明模块可调整大小及联动品种 | 借鉴对齐、数据密度和图表标题。两种品种无需自由拖拽或复杂行情矩阵 |
| V03 Mercury | [Introducing Insights](https://mercury.com/blog/introducing-insights) · 官方产品文章与示意 | 截图把主要现金流结果、收入与支出分级展示，分类标签与筛选联动图表和明细 | 借鉴主数字与共享概要条；不引入银行同步、AI、预测，也不套用其现金流计算 |
| V04 Stripe | [Web Dashboard](https://docs.stripe.com/dashboard/basics) · 官方操作文档 | 仪表盘围绕账户活动及对象组织导航和动作 | 对应上下文动作与记录；不增加支付、账号或云服务。文档说明不等于当前界面的完整视觉体验 |
| V05 Stripe | [Dashboard updates](https://stripe.com/blog/dashboard-updates-oct-2020) · 2020 年官方改版文章及旧版截图 | 当时的改版强调相关聚合统计、对象上下文与集中动作入口 | 对应数据层次和低频动作归拢。历史设计案例，不能称为 Stripe 2026 年实际界面 |
| V06 Wealthfront | [Automated Investing](https://www.wealthfront.com/investing) · 官方产品页与示意图 | 示意图使用较大的账户数字、单色曲线与较小明细；官网说明图像用于示意 | 对应数字与图表权重。收益、预测与账户曲线不进入本项目；未将宣传数据当作证据 |
| V07 Linear | [Display options](https://linear.app/docs/display-options) · 官方文档与设置截图 | 分段切换、分组/排序和属性设置按功能收在一个面板 | 对应折线/K 线与按需说明；不复制任务管理信息架构，深色截图不作为本项目改深色的理由 |
| V08 Linear | [A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh) · 2026-03-12 官方设计复盘 | 讨论弱化辅助导航、统一头部、柔和分隔与更中性的表面，减少等权元素争夺注意力 | 对应连续工作台和主次。作者经验可借鉴，不能视为独立的易用性或性能测评 |
| V09 Coinbase | [Advanced Trade dashboard overview](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/dashboard-overview) · 官方帮助与嵌图 | 价格图、订单面板、未完成订单分区呈现，图表选项可保留 | 对应主图、交易和结果分工；不加入订单簿、深度图、加密资产或实时成交 |
| V10 IBKR | [Navigate the Interface](https://www.ibkrguides.com/ibkrdesktop/how-do-i-navigate-interface.htm) · 桌面使用指南与截图 | 账户概要集中，交易与订单表有稳定位置，报价详情靠近右侧内容区 | 对应概要条和固定交易区。保留直接按钮，不让新手依赖右键或复杂导航 |
| V11 Raycast | [A fresh look and feel](https://www.raycast.com/blog/a-fresh-look-and-feel) · 2022-07-19 官方设计文章 | 扩大核心搜索输入、把动作和反馈归拢到动作栏、统一图标与紧凑模式 | 对应突出核心读数、动作旁反馈与图标纪律。仅为历史设计方法，不描述为新版 Raycast 的完整外观 |

## 控件、动效与可访问性规范

| 编号 / 机构 | 官方来源 / 资料类型 | 核对结论 | 对应设计与适用限制 |
| --- | --- | --- | --- |
| V12 Atlassian | [Motion](https://atlassian.design/foundations/motion) · 官方规范 | 高频交互短促，进入与退出节奏有区别；需要响应减少动效设置，避免动画争夺注意力 | 项目实际动效参数在 [产品与设计](../overview/01-product-and-design.md#视觉与图表) 维护，属于本项目取舍，不是跨产品强制标准 |
| V13 Atlassian | [Border](https://atlassian.design/foundations/border) · 官方规范 | 普通边框与分隔使用较细尺度，选中及焦点强调有不同宽度 | 对应 1px 分隔、2px focus/状态边线；颜色和文字仍必须共同表达状态 |
| V14 Carbon / IBM | [Data table accessibility](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/accessibility) · 官方可访问性指南 | 表格需可访问名称；交互控件、排序和键盘状态有明确要求 | 保留语义表格和详情；没有实现排序就不画排序入口。指南不证明本项目表格已全部达标 |
| V15 Radix | [Theme overview](https://www.radix-ui.com/themes/docs/theme/overview) · 官方文档 | 变体表达视觉重要性，颜色、间距、字体与形状通过主题组织 | 对应项目 CSS 变量与控件层级。不引入 React/Radix 库，继续现有 Vue 组件 |
| V16 Radix | [Button](https://www.radix-ui.com/themes/docs/components/button) · 官方组件文档 | 实色、浅色、描边、轻操作等变体表达不同权重；加载需保持尺寸并阻止重复动作 | 播放、下一根、帮助分为主/普通/轻操作；业务禁用条件沿用现有 store |
| V17 Radix | [Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · 官方配色规范 | 不同色阶分别服务表面、状态底色、分隔、交互边界、实色强调和文字 | 对应有序灰阶与语义色，避免临时给每个区域挑颜色；实际组合仍需测对比度 |
| V18 Radix | [Breakpoints](https://www.radix-ui.com/themes/docs/theme/breakpoints) · 官方响应式文档 | 用断点调整布局与组件尺寸 | 采用内容宽度驱动的桌面/平板/手机结构；本项目断点由交易区和图表的真实占用决定，不照抄库默认值 |
| V19 Apple | [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) · WWDC25 官方视频页面及文字稿 | 材质与交互需适应内容，强调色应有选择；减少透明度、增强对比和减少动效会调整视觉效果 | 学习状态适应与减弱动效，数字密集工作台不采用大面积折射玻璃。Apple 原生系统行为不自动适用于网页，需自行实现 |

## 研究取舍与证据边界

- 产品设计方面，采用 TradingView 的空间分工、Mercury/Wealthfront 的数字层次、Linear/Raycast 的控件纪律，以及 Stripe/Koyfin 的对象与数据组织。所有尺寸和颜色由本项目自行设计。
- “现代、灵动”落实为清晰比例、稳定结构、完整状态和短反馈。行情、余额、盈亏即时显示；每秒 10 根回放不逐根触发数字动画。
- Wise 页面与 Mercury 的独立在线 demo 在本轮无法稳定读取；Apple HIG Motion 的完整正文也未取得，不计入已完成的 19 页。本轮 Apple 依据是已取得文字稿的 WWDC 页面。
- 不下载或公开复制参考产品的图片、图标、字体或代码。仓库仅保存短摘要与原始链接，交互样稿的 SVG 为原创人工示意。
- 正式项目的运行验证只针对本项目。此次样稿的实际检查见 [方案验证](../overview/05-interface-redesign.md#12-本次已交付与验证)，不能据此宣称参考产品或接入后的 Vue 应用已经通过检查。

对应交易公式及本地数据边界继续见 [数据与交易](../overview/03-data-and-trading.md)；现有参考笔记仍见 [同类产品](03-product-references.md)。本条目扩展视觉与交互依据，不重新定义行情与训练规则。
