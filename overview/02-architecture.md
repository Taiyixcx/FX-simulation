# 架构与目录职责

本文记录 P1 已落地的技术与内部接口，并单独说明后续扩展。实际阶段状态与验证结果见 [路线与验收](04-roadmap-and-acceptance.md)，开发约束见 [AGENTS.md](../AGENTS.md)，依据见 [前端与存储知识](../knowledge/02-web-engineering.md)。

## 技术栈

依赖按 `package.json` 和唯一的 `package-lock.json` 锁定，不把文档的版本号当作升级指令。

| 能力 | 当前依赖 | 用途 |
| --- | --- | --- |
| 界面 | Vue 3.5.43、TypeScript 6.0.3、vue-tsc 3.3.11 | Composition API、单文件组件与严格类型检查 |
| 构建与服务 | Vite 8.3.1、Vue 插件 6.0.9、npm | 本机开发、静态打包与固定地址预览 |
| 状态协调 | Pinia 4.0.3 | 单个会话 Store 统一协调进度、账户和保存 |
| 图表 | Apache ECharts 6.1.0 | 按需引入折线、K 线、十字线、缩放、平移和实际成交标记 |
| 字体 | @fontsource/inter 5.3.0 | 本地打包英文及数字的 Inter 400/500/600/700 字重；中文使用系统字体 |
| 计算 | Decimal.js 10.6.0 | 报价、数量、资金与盈亏的十进制运算 |
| 保存 | 浏览器原生 IndexedDB | 会话快照与当前会话索引的事务保存 |
| 单元验证 | Vitest 5.0.3、fake-indexeddb 6.2.5 | 引擎、图表适配、快照、事务和 Store |
| 流程验证 | Playwright 1.63.0 | Chromium 内的工作台操作和刷新恢复 |

使用原生语义控件、CSS 变量和组件 scoped 样式。未引入组件库、Router、SSR、后端或 PWA。TypeScript 使用与当前 vue-tsc 实际验证可用的 6.0.3；是否升级需按项目兼容性判断，不默认切换其他编译器版本。

## 当前目录

```text
FX-simulation/
├─ AGENTS.md
├─ README.md
├─ overview/                    # 产品、架构、规则、阶段与验收
├─ knowledge/                   # 主题笔记及官方资料
├─ public/
│  ├─ favicon.svg              # 与工作台配色一致的本地站点图标
│  └─ licenses/                # 随构建复制的运行依赖许可及 NOTICE
├─ src/
│  ├─ App.vue                   # 工作台布局、保存状态和功能装配
│  ├─ main.ts                   # Vue 与 Pinia 初始化
│  ├─ priceFormatting.ts        # 多功能共用的数字及时间展示
│  ├─ components/
│  │  ├─ Icon.vue              # 跨功能共用的本地 SVG 图标
│  │  └─ InfoTip.vue           # 点击、键盘和焦点管理的信息提示
│  ├─ features/
│  │  ├─ chart/
│  │  │  ├─ MarketChart.vue     # 图表生命周期、序列与成交标注
│  │  │  └─ chartData.ts        # UTC 毫秒类别、OHLC、标记与可见范围适配
│  │  ├─ replay/
│  │  │  ├─ ReplayControls.vue  # 暂停、单步、调速及不可拖动的进度
│  │  │  ├─ SimulationScenario.vue # 新会话的练习情景选择
│  │  │  └─ SimulationEventNotice.vue # 已发生事件与公开计划提示
│  │  ├─ trading/
│  │  │  ├─ AccountSummary.vue # 账户指标
│  │  │  └─ TradePanel.vue      # 金额输入、开仓和平仓
│  │  └─ journal/
│  │     └─ TradeJournal.vue    # 当前练习已平仓记录
│  ├─ engine/
│  │  ├─ simulationSource.ts    # 当前市场模拟、事件与逐根双边报价
│  │  ├─ simulationParameters.ts # 版本化训练参数与纯规则市场时钟
│  │  ├─ execution.ts           # 开仓、平仓与权益耗尽结算
│  │  ├─ account.ts             # 账户估值与交易输入校验
│  │  ├─ decimal.ts             # 复用的十进制政策与解析
│  │  ├─ errors.ts              # 引擎错误类型
│  │  └─ types.ts               # 业务边界类型
│  ├─ stores/
│  │  └─ useSessionStore.ts     # 当前练习、调度器与保存协调
│  ├─ storage/
│  │  ├─ sessionSnapshot.ts     # 纯快照校验与账本重建
│  │  └─ sessionRepository.ts   # IndexedDB 事务及版本冲突检查
│  └─ styles/
│     └─ base.css              # 视觉变量、基础排版与焦点
├─ tests/
│  ├─ unit/                    # 纯逻辑、存储与会话测试
│  └─ e2e/                     # 浏览器关键流程
├─ scripts/
│  └─ checkSimulation.mjs      # 多种子内部统计与机械周期检查
├─ index.html
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
└─ playwright.config.ts
```

后续 P2 按需要增加历史源、CSV 校验、本机转换脚本、`public/data/` 与模板；P3 增加会话列表、备注、三步引导及完整备份恢复；P4 增加 `start.cmd`。当前没有这些实现。`src/components/` 的图标和信息提示已有跨功能复用；`src/composables/` 仍未预建，功能独用逻辑留在 feature 内。

`priceFormatting.ts` 为账户、报价、持仓和记录共用；金额与盈亏格式化可选择是否附带币种，组件分开显示 USD 时不再拆改已格式化字符串。行情源直接放在 `engine/`。用户导入数据未来进入 IndexedDB；公开源码不能自动包含授权未核实的真实行情，来源规则见 [数据与交易](03-data-and-trading.md)。

## 职责与依赖

| 区域 | 负责内容 | 依赖边界 |
| --- | --- | --- |
| `App.vue`、`main.ts` | 初始化、布局、功能装配、同页焦点定位及文件下载入口 | 不承担账户与成交公式 |
| `features/` | 展示、输入、图表适配和操作反馈 | 通过会话 Store 发起业务操作 |
| `components/` | 跨功能的图标、信息提示及焦点处理 | 不持有账户或会话状态 |
| `engine/` | 行情、成交、账户和纯数值校验 | 不依赖 Vue、Pinia、DOM、计时器或浏览器存储 |
| `useSessionStore.ts` | 逐根推进、交易、切换、保存状态与重试 | 调用引擎和 storage，拥有并清理回放计时器 |
| `sessionSnapshot.ts` | 校验不可信快照、迁移旧可见前缀、重放当前模拟后缀并重建账本 | 不执行旧模型；复用引擎验证当前生成价格和结算，不另写公式 |
| `sessionRepository.ts` | 数据库连接、事务、当前索引和并发版本检查 | 事务完成才确认保存；不驱动图表或选择成交价 |
| `styles/`、`priceFormatting.ts` | 共享基础样式和数值展示 | 展示舍入不回写账本 |
| `tests/` | 业务、事务与浏览器流程验证 | 不存放业务源码或生成产物 |

```text
Vue 操作 ───────► useSessionStore
                        │ 逐根推进 / 开仓 / 平仓
                        ▼
             模拟行情源 + 交易与账户引擎
                        │ 同一可见帧与账户结果
                        ▼
                 一致的会话状态 ───► 图表、下单、成交记录
                        │ 候选快照
                        ▼
               校验行情及账本 ───► IndexedDB 事务
                                        │ 完成 / 失败
                                        ▼
                              保存状态 / 暂停及重试
```

加速推进仍逐根更新并检查权益耗尽，之后保存同一时刻的行情与账户。保存失败保留候选内存快照和原数据库记录，并暂停推进与交易；重试保存同一候选快照，不重新执行成交。

`TradePanel` 在交易已保存后管理持仓标题与金额输入的焦点；写入失败通过类型化 `request-recovery-focus` 事件请求 `App.vue` 聚焦其持有的持续错误区。焦点只响应主动交易或同页入口，不跟随行情更新。

## 已落地内部接口

所有金额、报价和数量跨模块传递十进制字符串；UTC 时间使用毫秒。源码没有网络接口。

| 类型或函数 | 当前内容 |
| --- | --- |
| `MarketQuote` | `timestampMs`、`bidPrice`、`askPrice`、`askSource`；模拟输出来源固定为 `training` |
| `MarketFrame` | 一根完成的 Bid 分钟 OHLC 与当前 `quote` |
| `SimulationState` | 模型/参数版本、品种与情景、价格/事件/日程随机状态、起止配置、可见进度与时钟、初始和当前双边报价、波动/流动性/经济背景、最近事件与公开计划事件 |
| `createSimulation(pair, seed, options)` | 返回首根 `SimulationStep`，`frameIndex = 0`；配置可指定起始完成时间、总根数与情景 |
| `initializeSimulation(...)`、`createSimulationFromQuote(...)` | 从新练习或旧会话最后双边报价建立当前模型起点；`originFrameIndex` 区分保留前缀与当前生成后缀 |
| `advanceSimulation(state)` | 返回下一根及新状态；到末尾返回 `null`，不修改旧状态 |
| `SimulationEvent`、`ScheduledSimulationEvent` | 最近已发生事件含时间、类型、标签、详情与标准化惊喜；计划事件仅时间、类型、标签与预期，无实际结果 |
| `AccountState`、`Position` | 已结算余额、单笔持仓；持仓包含方向、名义金额、数量、成交价和开仓时间 |
| `calculateAccount(account, quote)` | 从当前可平仓报价派生账户指标 |
| `openPosition(...)` | 校验输入和可用资金，返回候选账户 |
| `closePosition(...)` | 返回已结算账户和单笔 `TradeRecord` |
| `settleDepletedAccount(...)` | 逐根检查权益耗尽，需要结清时返回同一成交结果，否则为 `null` |
| `SessionSnapshot` | `schemaVersion`、`id`、`revision`、品种、模拟状态、仅可见帧、账户及成交 |
| `validateSessionSnapshot(input)` | 校验版本与关联、按当前模型重放后缀及完整账本；旧格式校验已有可见行情后迁移为当前格式 |
| `SessionRepository` | `loadCurrent()`、`save(snapshot)`、`close()`；当前快照与索引在同一事务提交 |

`MarketSource` 通用接口、历史源、数据集元信息和 CSV API 仍为 P2 设计项。当前模拟源的纯函数与统一帧类型满足 P1，无需提前包装尚无实际复用的来源层。

快照保存可见帧、当前模型全部随机和隐含状态。新会话按模型、参数、配置和种子重建已推进序列；旧格式保留已有行情与账本，校验报价、时间、OHLC、进度和成交关联后，从最后双边报价初始化当前模型，之后仅重放新生成后缀。不保留旧生成算法，也不再通过旧算法重算旧可见前缀；这种迁移校验不是旧行情来源真实性或防篡改证明。恢复后由引擎重算派生指标并暂停。IndexedDB 当前指针同时保存会话标识和 `revision`；事务内比较读取时的基准，拒绝其他窗口已经更新后的陈旧写入。

普通行情、事件结果和计划日程使用独立可保存的随机流，帮助文字及绘图不消耗随机数。情景通过 `startNewSession(pair?, scenario?)` 创建新会话确定；修改选择框不改变当前源。公开事件信息由纯引擎状态提供，页面不会读取未来价格或计划事件结果。具体科学机制、参数与闭市规则见 [数据与交易](03-data-and-trading.md#模拟行情)，研究限制见 [外汇模拟研究](../knowledge/05-foreign-exchange-simulation.md)。

数据库打开请求被其他窗口阻塞后报告失败，原数据保留。该请求若在解除阻塞后才成功，其连接立即关闭，避免错误请求留下未受管理的数据库连接；用户仍可重试读取。

## 数值、时间与图表适配

`decimal.ts` 使用独立 Decimal 构造器隔离精度与舍入设置。持久化快照和 JSON 导出使用普通对象及字符串，不保存 Decimal 实例。完整交易政策只在 [数据与交易](03-data-and-trading.md) 维护。

`MarketChart` 保持 `frames / position / trades / sessionId / chartType` 五项输入，父组件只传已推进前缀。`chartData.ts` 集中将 `timestampMs` 转为类别轴的十进制字符串键，将价格转成绘图所需的普通数值。K 线顺序固定为 `[open, close, low, high]`，绘图值不返回资金计算。图表顶部统一展示当前或十字线所选帧的完整时间，采用 Asia/Shanghai，并注明 UTC+8。

图表实例保存为普通变量，挂载创建，卸载调用 `dispose()` 并移除监听及尺寸观察器。使用 ECharts 的模块化入口和 Canvas 渲染器，仅注册实际使用的折线、K 线、网格、提示、dataZoom、markPoint 和 markLine。行情推进通过同一实例的局部 `setOption` 更新数据；切换图表类型替换 series，不重新创建实例。ECharts 的 `appendData` 不用于折线与 K 线，不将 `setOption` 称作仅追加一个点的 API。

观察范围以绝对索引保持，避免新增帧改变百分比后使窗口漂移。原本跟随最新时保持跟随；用户观察旧区域时保留范围，回到最新入口明确恢复跟随。单根行情以类别轴居中显示，不生成未来占位点。纵轴范围包括视窗内 Bid/OHLC、实际 Ask/Bid 成交标记和当前入场线；视窗外旧成交不固定当前纵轴。成交标记以 UTC 毫秒字符串作为类别坐标，避免数值被误解为类别索引。

画布尺寸与计算后字号共同决定轴标签间隔。最新 Bid 参考线仅在最新帧可见时加入，右侧标签保持实色；普通价格刻度按实际绘图区像素距离避让。尺寸观察器复用同一图表实例更新布局，不把视觉参考线交给成交引擎。

英文及数字的 Inter 字体、本地 SVG 图标和运行资源均随构建提供。`public/licenses/` 保存 ECharts 的 LICENSE/NOTICE、zrender、Inter 及实际打包运行依赖的许可证，Vite 同步复制到 `dist/licenses/`；产品界面不放第三方品牌、版权段落或技术页脚。旧库署名要求及替换理由记录在 [网页工程](../knowledge/02-web-engineering.md#图表与十进制计算)。

## 运行与验证配置

已提供 `dev`、`typecheck`、`test`、`test:e2e`、`check:simulation`、`build`、`start`。开发服务与构建预览均绑定 `127.0.0.1:4173` 并启用严格端口，不能同时运行。`start` 是 Vite 本机构建预览，双击入口留在 P4。

`check:simulation` 调用当前纯模拟源，比较多个固定种子、品种和情景的内部统计及阶段方向规律；不下载历史数据、不连接行情接口。参数仍待合法历史样本校准，脚本通过不等于真实市场特征已复现，也不能证明完全不可预测。

Vitest 执行 `tests/unit/`；Playwright 执行 `tests/e2e/`，默认自动启动固定地址的开发服务并从 `.vite/playwright` 查找 Chromium。设置 `FX_E2E_PREVIEW=1` 时改为自动执行 `npm run start`，用于已构建版本的浏览器回归与完整回放，运行前必须生成 `dist/`。两种模式均拒绝复用现有服务，避免测试错版本或端口冲突。开发下载缓存放在 `.vite/npm-cache`，不成为运行资源。实际安装与检查命令见 [README](../README.md)，检查结果见 [路线与验收](04-roadmap-and-acceptance.md)。

当前验证通过本机 npm 脚本执行。GitHub Actions 尚未配置；本机通过不等同于远端 CI 已通过。

行情生成器、图表库、字体和界面资源均本地可用；首次依赖与测试浏览器下载需要网络。断网、本机启动脚本和完整首版交付验证仍按 P4 推进。
