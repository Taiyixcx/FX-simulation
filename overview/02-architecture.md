# 架构与目录职责

本文记录 P1、P2 已落地的技术与内部接口，并单独说明后续扩展。实际阶段状态与验证结果见 [路线与验收](04-roadmap-and-acceptance.md)，开发约束见 [AGENTS.md](../AGENTS.md)，依据见 [前端与存储知识](../knowledge/02-web-engineering.md)。

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
| 保存 | 浏览器原生 IndexedDB | 行情归档、历史数据集、会话快照与当前索引的事务保存 |
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
│  ├─ data/                    # 本机历史样本目录、来源说明及生成 CSV 模板
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
│  │  │  ├─ ReplayControls.vue  # 暂停、单步、调速及累计/有限进度
│  │  │  ├─ SimulationScenario.vue # 新会话的练习情景选择
│  │  │  ├─ SimulationEventNotice.vue # 已发生事件与公开计划提示
│  │  │  ├─ HistoryDataPanel.vue # CSV 导入、本机样本及历史练习入口
│  │  │  └─ localHistorySamples.ts # 本机目录解析、文件校验及读取
│  │  ├─ trading/
│  │  │  ├─ AccountSummary.vue # 账户指标
│  │  │  └─ TradePanel.vue      # 金额输入、开仓和平仓
│  │  └─ journal/
│  │     └─ TradeJournal.vue    # 当前练习已平仓记录
│  ├─ engine/
│  │  ├─ simulationSource.ts    # 当前市场模拟、事件与逐根双边报价
│  │  ├─ simulationParameters.ts # 版本化训练参数与纯规则市场时钟
│  │  ├─ historySource.ts       # 历史源、逐根推进、摘要与完整指纹校验
│  │  ├─ historyCsv.ts          # CSV 解析、字段校验及行号错误
│  │  ├─ historyTypes.ts        # 数据集、来源元信息与历史进度类型
│  │  ├─ execution.ts           # 开仓、平仓与权益耗尽结算
│  │  ├─ account.ts             # 账户估值与交易输入校验
│  │  ├─ decimal.ts             # 复用的十进制政策与解析
│  │  ├─ errors.ts              # 引擎错误类型
│  │  └─ types.ts               # 业务边界类型
│  ├─ stores/
│  │  └─ useSessionStore.ts     # 当前练习、调度器与保存协调
│  ├─ storage/
│  │  ├─ sessionSnapshot.ts     # 快照、增量校验、迁移与账本重建
│  │  ├─ historicalSessionSnapshot.ts # 历史快照、联合类型及前缀账本校验
│  │  └─ sessionRepository.ts   # 数据集、行情分块、事务及版本冲突
│  └─ styles/
│     └─ base.css              # 视觉变量、基础排版与焦点
├─ tests/
│  ├─ unit/                    # 纯逻辑、存储与会话测试
│  └─ e2e/                     # 浏览器关键流程
├─ scripts/
│  ├─ checkSimulation.mjs      # 多种子内部统计与机械周期检查
│  ├─ checkContinuousSimulation.mjs # 持续模拟的纯引擎运行检查
│  └─ convertHistData.mjs      # 本机 HistData 文件转换及来源记录
├─ index.html
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
└─ playwright.config.ts
```

历史源、CSV 校验、本机转换脚本、`public/data/` 与模板已在 P2 落地；真实样本文件只在本机准备，公开源码保留来源说明，不自动公开再分发行情。后续 P3 增加会话列表、备注、三步引导及完整备份恢复；P4 增加 `start.cmd`，当前尚未实现。`src/components/` 的图标和信息提示已有跨功能复用；`src/composables/` 仍未预建，功能独用逻辑留在 feature 内。

`priceFormatting.ts` 为账户、报价、持仓和记录共用；金额与盈亏格式化可选择是否附带币种，组件分开显示 USD 时不再拆改已格式化字符串。行情源直接放在 `engine/`。用户导入数据保存到 IndexedDB，不回写源码；公开源码不能自动包含授权未核实的真实行情，来源规则见 [数据与交易](03-data-and-trading.md)。

## 职责与依赖

| 区域 | 负责内容 | 依赖边界 |
| --- | --- | --- |
| `App.vue`、`main.ts` | 初始化、布局、功能装配、同页焦点定位及文件下载入口 | 不承担账户与成交公式 |
| `features/` | 展示、输入、图表适配和操作反馈 | 通过会话 Store 发起业务操作 |
| `components/` | 跨功能的图标、信息提示及焦点处理 | 不持有账户或会话状态 |
| `engine/` | 行情、成交、账户和纯数值校验 | 不依赖 Vue、Pinia、DOM、计时器或浏览器存储 |
| `useSessionStore.ts` | 逐根推进、交易、切换、保存状态与重试 | 调用引擎和 storage，拥有并清理回放计时器 |
| `sessionSnapshot.ts` | 校验不可信快照、验证增量与完整分块历史、迁移旧可见前缀并重建账本 | 不执行旧模型；仅可信已验证状态可作为增量基准，不另写账户公式 |
| `historicalSessionSnapshot.ts` | 历史头快照、已推进前缀和增量校验 | 引用完整已验证数据集，与模拟快照实际复用同一账本验证器；未来报价不进入账本 |
| `sessionRepository.ts` | 数据库连接、行情分块、独立数据集、原子事务、当前索引和并发版本检查 | 归档、快照与指针提交完成才确认保存；导入只新增数据集，不改变当前练习 |
| `localHistorySamples.ts`、`HistoryDataPanel.vue` | 本机静态目录与 CSV 文件读取、来源输入和导入反馈 | 文件读取与下载留在 feature；解析、指纹和行情校验交给纯引擎，数据保存交给 Store |
| `styles/`、`priceFormatting.ts` | 共享基础样式和数值展示 | 展示舍入不回写账本 |
| `tests/` | 业务、事务与浏览器流程验证 | 不存放业务源码或生成产物 |

```text
Vue 操作 ───────► useSessionStore
                        │ 逐根推进 / 开仓 / 平仓
                        ▼
          模拟 / 历史行情源 + 交易与账户引擎
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

所有金额、报价和数量跨模块传递十进制字符串；UTC 时间使用毫秒。引擎没有外部行情网络接口；本机样本读取通过 feature 请求同一站点的静态文件。

| 类型或函数 | 当前内容 |
| --- | --- |
| `MarketQuote` | `timestampMs`、`bidPrice`、`askPrice`、`askSource`；模拟输出来源固定为 `training` |
| `MarketFrame` | 一根完成的 Bid 分钟 OHLC 与当前 `quote` |
| `SimulationState` | 模型/参数版本、品种与情景、价格/事件/日程随机状态、nullable 总根数、全场累计进度与时钟、初始和当前双边报价、市场因子、最近事件、公开计划与已搜索日程游标 |
| `createSimulation(pair, seed, options)` | 返回首根 `SimulationStep`，`frameIndex = 0`；配置可指定起始完成时间、有限总根数或持续源与情景 |
| `initializeSimulation(...)`、`createSimulationFromQuote(...)` | 从新练习或旧会话最后双边报价建立当前模型起点；`originFrameIndex` 区分保留前缀与当前生成后缀 |
| `advanceSimulation(state)` | 返回下一根及新状态，不修改旧状态；有限来源到指定末尾返回 `null`，持续源到模拟时钟边界报告错误并暂停 |
| `SimulationEvent`、`ScheduledSimulationEvent` | 最近已发生事件含时间、类型、标签、详情与标准化惊喜；计划事件仅时间、类型、标签与预期，无实际结果 |
| `HistoryDataset`、`HistoryDatasetSummary` | 不可变完整行情、品种、规范化内容指纹及来源元信息；摘要只含标识、品种、指纹和元信息 |
| `HistoryState`、`HistoryStep` | 状态只含数据集引用、指纹、已推进索引、总根数和当前 UTC 时间；单步返回一根完成行情 |
| `parseHistoryCsv(text, pair, metadata?)` | 解析 CSV 并校验完整报价、来源元信息与指纹；错误包含原文件行号和字段，成功后返回已验证数据集 |
| `createHistory(dataset)`、`advanceHistory(state, dataset)` | 从已验证数据集返回首根或下一根；只读 source、不修改数据集，末尾返回 `null` |
| `validateHistoryDataset(...)`、`validateHistoryState(...)` | 数据集全量检查及 SHA-256 指纹核对；状态必须引用相同数据集、指纹和实际索引时间 |
| `AccountState`、`Position` | 已结算余额、单笔持仓；持仓包含方向、名义金额、数量、成交价和开仓时间 |
| `calculateAccount(account, quote)` | 从当前可平仓报价派生账户指标 |
| `openPosition(...)` | 校验输入和可用资金，返回候选账户 |
| `closePosition(...)` | 返回已结算账户和单笔 `TradeRecord` |
| `settleDepletedAccount(...)` | 逐根检查权益耗尽，需要结清时返回同一成交结果，否则为 `null` |
| `SessionSnapshot` | 保留模拟格式版本 3、`id`、`revision`、品种、完整模拟状态、保留历史类别、`frameStartIndex` 与最近 `frames`、账户及完整成交 |
| `HistoricalSessionSnapshot`、`PracticeSnapshot` | 历史格式版本 4，模式为 `historical`，保存历史进度引用、已推进窗口、账户和完整成交；联合类型保留原模拟快照接口 |
| 快照与历史校验 | 旧格式校验已有行情与账本后内存迁移；加载分块验证完整历史；保存以可信基准验证增量，拒绝陈旧或篡改数据 |
| `SessionRepository` | `loadCurrent()`、`save(snapshot)`、`importDataset(dataset)`、`listDatasets()`、`loadDataset(id)`、`close()`；历史导入与会话提交分别使用原子事务 |

Store 按 `PracticeSnapshot` 的格式版本选择模拟或历史纯函数；两种来源共用 `MarketFrame`、成交与账户计算，不增加尚无维护收益的泛化 `MarketSource` 包装层。完整历史数据集由 Store 的私有普通变量持有，响应式快照与页面只得到已推进窗口和元信息；图表不会得到数据集中的未来行情。

当前头快照保存最近行情窗口、全场位置、账户与完整成交，以及当前模型全部随机和隐含状态；较早行情保存在 IndexedDB 的 `historyChunks`，按 `[sessionId, chunkIndex]` 定位。格式版本、分块与窗口容量统一见 [保存规则](03-data-and-trading.md#6-会话保存与恢复)。加载按块验证整个已经发生的历史和账本，最终只保留最近行情窗口；成交展示分页，不通过截断账本限制显示。

日常保存从私有可信验证检查点核对追加行情、源状态和交易变化，基准必须对应同一会话、版本及完整源配置；缓存和验证结果与调用者对象隔离，不能绕过未验证输入的核对。归档块、头快照、账本和当前指针作为一致事务提交，失败保留原块及未保存候选。缓存不进入持久化快照，也不供页面读取，用于避免长练习每次保存都重放全部合成子步。

数据库升级到版本 3，保留原 `sessions`、`settings`、`historyChunks`，新增以数据集标识为键的 `datasets`。历史数据集只追加，重复导入拒绝覆盖；列表逐条校验并返回摘要，选中或恢复时才执行全部报价和指纹校验。历史头快照引用该数据集，不重复归档原行情；恢复先验证完整原数据集，再使用全部已推进报价重建账本并核对头窗口，最终仍只返回最近已推进窗口。保存从私有可信账本检查点验证追加报价，在同一事务核对源记录存在和当前指针版本后提交头快照与指针。共享账本验证器通过既有成交与账户引擎核对持仓、完整成交及资金耗尽规则，没有第二套账户公式。

旧格式经报价、时间、OHLC、进度和完整账本校验后，从最后双边报价初始化当前持续模型。读取时只作内存迁移，第一次后续保存才原子写入保留旧行情的块、头快照与指针；成功前保留原记录。`retainedPrefixKind` 标记旧保留段：版本 1 继续核对固定分钟时序、点差和相邻开收盘约束，版本 2 核对价格结构、锚点和账本；当前生成后缀逐根重演并比较完整状态。不保留或执行旧生成算法，旧保留段的结构和账本校验不构成旧行情来源真实性或防篡改证明。恢复后由引擎重算派生指标并暂停。IndexedDB 当前指针仍包含会话标识和 `revision`，事务内拒绝其他窗口已经更新后的陈旧写入。

普通行情、事件结果和计划日程使用独立可保存的随机流，帮助文字及绘图不消耗随机数。日程以已判定游标逐段向前搜索有限窗口，未入选候选不反复抽签，不预扫描持续源的全部可用日期。情景通过 `startNewSession(pair?, scenario?)` 创建新会话确定；新会话种子排除上一场，修改选择框不改变当前源，刷新继续原种子与完整状态。公开事件信息由纯引擎状态提供，页面不会读取未来价格或计划事件结果。具体科学机制、参数与闭市规则见 [数据与交易](03-data-and-trading.md#模拟行情)，研究限制见 [外汇模拟研究](../knowledge/05-foreign-exchange-simulation.md)。

数据库打开请求被其他窗口阻塞后报告失败，原数据保留。该请求若在解除阻塞后才成功，其连接立即关闭，避免错误请求留下未受管理的数据库连接；用户仍可重试读取。

## 数值、时间与图表适配

`decimal.ts` 使用独立 Decimal 构造器隔离精度与舍入设置。持久化快照和 JSON 导出使用普通对象及字符串，不保存 Decimal 实例。完整交易政策只在 [数据与交易](03-data-and-trading.md) 维护。

`MarketChart` 保持 `frames / position / trades / sessionId / chartType` 五项输入，父组件只传已经完成的最近窗口。窗口滑动按时间戳识别位置变化，不把窗口内索引当全场累计进度；仍在窗口内的观察时间范围保持稳定，早于显示窗口的观察范围贴近最早剩余时间，较早行情仍在本机归档但暂无图表加载入口。`chartData.ts` 集中将 `timestampMs` 转为类别轴的十进制字符串键，将价格转成绘图所需的普通数值。K 线顺序固定为 `[open, close, low, high]`，绘图值不返回资金计算。图表顶部统一展示当前或十字线所选帧的完整时间，采用 Asia/Shanghai，并注明 UTC+8。

图表实例保存为普通变量，挂载创建，卸载调用 `dispose()` 并移除监听及尺寸观察器。使用 ECharts 的模块化入口和 Canvas 渲染器，仅注册实际使用的折线、K 线、网格、提示、dataZoom、markPoint 和 markLine。行情推进通过同一实例的局部 `setOption` 更新数据；切换图表类型替换 series，不重新创建实例。ECharts 的 `appendData` 不用于折线与 K 线，不将 `setOption` 称作仅追加一个点的 API。

观察范围以绝对索引保持，避免新增帧改变百分比后使窗口漂移。原本跟随最新时保持跟随；用户观察旧区域时保留范围，回到最新入口明确恢复跟随。单根行情以类别轴居中显示，不生成未来占位点。纵轴范围包括视窗内 Bid/OHLC、实际 Ask/Bid 成交标记和当前入场线；视窗外旧成交不固定当前纵轴。成交标记以 UTC 毫秒字符串作为类别坐标，避免数值被误解为类别索引。

画布尺寸与计算后字号共同决定轴标签间隔。最新 Bid 参考线仅在最新帧可见时加入，右侧标签保持实色；普通价格刻度按实际绘图区像素距离避让。尺寸观察器复用同一图表实例更新布局，不把视觉参考线交给成交引擎。

英文及数字的 Inter 字体、本地 SVG 图标和运行资源均随构建提供。`public/licenses/` 保存 ECharts 的 LICENSE/NOTICE、zrender、Inter 及实际打包运行依赖的许可证，Vite 同步复制到 `dist/licenses/`；产品界面不放第三方品牌、版权段落或技术页脚。旧库署名要求及替换理由记录在 [网页工程](../knowledge/02-web-engineering.md#图表与十进制计算)。

## 运行与验证配置

已提供 `dev`、`typecheck`、`test`、`test:e2e`、`check:simulation`、`check:continuous`、`check:history`、`convert:histdata`、`build`、`start`。开发服务与构建预览均绑定 `127.0.0.1:4173` 并启用严格端口，不能同时运行。`start` 是 Vite 本机构建预览，双击入口留在 P4。

`check:simulation` 调用当前纯模拟源，比较多个固定种子、品种和情景的内部统计及阶段方向规律；不下载历史数据、不连接行情接口。参数仍待合法历史样本校准，脚本通过不等于真实市场特征已复现，也不能证明完全不可预测。

`convert:histdata` 只处理用户已在本机准备的 HistData 文件，转换后保留原始时区、完成分钟语义及转换版本等来源说明，不自动下载行情。CSV 格式、报价类型与样本准备限制统一见 [数据与交易](03-data-and-trading.md)；历史来源、导入、事务和前缀账本由相应单元测试及浏览器流程验证。

`check:history` 核对本机两份样本的文件与内容指纹，逐根推进全部原始分钟，并在隔离的 fake-indexeddb 中验证跨窗口交易、完整恢复、末尾及多窗口冲突。缺少文件时明确失败，不自动下载或修改浏览器数据。

Vitest 执行 `tests/unit/`；Playwright 执行 `tests/e2e/`，默认自动启动固定地址的开发服务并从 `.vite/playwright` 查找 Chromium。设置 `FX_E2E_PREVIEW=1` 时改为自动执行 `npm run start`，用于已构建版本的浏览器回归与完整回放，运行前必须生成 `dist/`。两种模式均拒绝复用现有服务，避免测试错版本或端口冲突。开发下载缓存放在 `.vite/npm-cache`，不成为运行资源。实际安装与检查命令见 [README](../README.md)，检查结果见 [路线与验收](04-roadmap-and-acceptance.md)。

当前验证通过本机 npm 脚本执行。GitHub Actions 尚未配置；本机通过不等同于远端 CI 已通过。

行情生成器、图表库、字体和界面资源均本地可用；首次依赖与测试浏览器下载需要网络。断网、本机启动脚本和完整首版交付验证仍按 P4 推进。
