# 架构与目录职责

本文记录 P1 已落地的技术与内部接口，并单独说明后续扩展。实际阶段状态与验证结果见 [路线与验收](04-roadmap-and-acceptance.md)，开发约束见 [AGENTS.md](../AGENTS.md)，依据见 [前端与存储知识](../knowledge/02-web-engineering.md)。

## 技术栈

依赖按 `package.json` 和唯一的 `package-lock.json` 锁定，不把文档的版本号当作升级指令。

| 能力 | 当前依赖 | 用途 |
| --- | --- | --- |
| 界面 | Vue 3.5.43、TypeScript 6.0.3、vue-tsc 3.3.11 | Composition API、单文件组件与严格类型检查 |
| 构建与服务 | Vite 8.3.1、Vue 插件 6.0.9、npm | 本机开发、静态打包与固定地址预览 |
| 状态协调 | Pinia 4.0.3 | 单个会话 Store 统一协调进度、账户和保存 |
| 图表 | Lightweight Charts 5.2.1 | Bid 折线、K 线、十字线、缩放和成交标记 |
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
│  └─ favicon.svg
├─ src/
│  ├─ App.vue                   # 工作台布局、保存状态和功能装配
│  ├─ main.ts                   # Vue 与 Pinia 初始化
│  ├─ priceFormatting.ts        # 多功能共用的数字及时间展示
│  ├─ features/
│  │  ├─ chart/
│  │  │  ├─ MarketChart.vue     # 图表生命周期、序列与成交标注
│  │  │  └─ chartData.ts        # 价格绘图值、秒时间和标记适配
│  │  ├─ replay/
│  │  │  └─ ReplayControls.vue  # 暂停、单步、调速和图表类型
│  │  ├─ trading/
│  │  │  ├─ AccountSummary.vue # 账户指标
│  │  │  └─ TradePanel.vue      # 金额输入、开仓和平仓
│  │  └─ journal/
│  │     └─ TradeJournal.vue    # 当前练习已平仓记录
│  ├─ engine/
│  │  ├─ simulationSource.ts    # 确定性逐根模拟行情
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
├─ index.html
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
└─ playwright.config.ts
```

后续 P2 按需要增加历史源、CSV 校验、本机转换脚本、`public/data/` 与模板；P3 增加会话列表、备注、帮助及完整备份恢复；P4 增加 `start.cmd`。当前没有这些实现。`src/components/`、`src/composables/` 只在出现实际共享需求后建立，功能独用逻辑留在 feature 内。

`priceFormatting.ts` 为账户、报价、持仓和记录共用，无需为一个展示文件预建多层目录。行情源直接放在 `engine/`。用户导入数据未来进入 IndexedDB；公开源码不能自动包含授权未核实的真实行情，来源规则见 [数据与交易](03-data-and-trading.md)。

## 职责与依赖

| 区域 | 负责内容 | 依赖边界 |
| --- | --- | --- |
| `App.vue`、`main.ts` | 初始化、布局、功能装配及文件下载入口 | 不承担账户与成交公式 |
| `features/` | 展示、输入、图表适配和操作反馈 | 通过会话 Store 发起业务操作 |
| `engine/` | 行情、成交、账户和纯数值校验 | 不依赖 Vue、Pinia、DOM、计时器或浏览器存储 |
| `useSessionStore.ts` | 逐根推进、交易、切换、保存状态与重试 | 调用引擎和 storage，拥有并清理回放计时器 |
| `sessionSnapshot.ts` | 校验不可信快照，重放模拟行情并重建账本 | 复用引擎验证价格和结算，不另写公式 |
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

## 已落地内部接口

所有金额、报价和数量跨模块传递十进制字符串；UTC 时间使用毫秒。源码没有网络接口。

| 类型或函数 | 当前内容 |
| --- | --- |
| `MarketQuote` | `timestampMs`、`bidPrice`、`askPrice`、`askSource`；模拟输出来源固定为 `training` |
| `MarketFrame` | 一根完成的 Bid 分钟 OHLC 与当前 `quote` |
| `SimulationState` | 版本、品种、种子、随机状态、首根完成时间、总根数、当前进度与 Bid |
| `createSimulation(pair, seed, options)` | 返回首根 `SimulationStep`，`frameIndex = 0`；配置可指定起始时间与总根数 |
| `advanceSimulation(state)` | 返回下一根及新状态；到末尾返回 `null`，不修改旧状态 |
| `AccountState`、`Position` | 已结算余额、单笔持仓；持仓包含方向、名义金额、数量、成交价和开仓时间 |
| `calculateAccount(account, quote)` | 从当前可平仓报价派生账户指标 |
| `openPosition(...)` | 校验输入和可用资金，返回候选账户 |
| `closePosition(...)` | 返回已结算账户和单笔 `TradeRecord` |
| `settleDepletedAccount(...)` | 逐根检查权益耗尽，需要结清时返回同一成交结果，否则为 `null` |
| `SessionSnapshot` | `schemaVersion`、`id`、`revision`、品种、模拟状态、仅可见帧、账户及成交 |
| `validateSessionSnapshot(input)` | 校验版本、数据关联、确定性帧序列及完整交易账本 |
| `SessionRepository` | `loadCurrent()`、`save(snapshot)`、`close()`；当前快照与索引在同一事务提交 |

`MarketSource` 通用接口、历史源、数据集元信息和 CSV API 仍为 P2 设计项。当前模拟源的纯函数与统一帧类型满足 P1，无需提前包装尚无实际复用的来源层。

快照保存可见帧和模拟随机状态，校验时根据版本、配置和种子重建同一前缀；再按记录引用的可见报价重建账户。恢复后由引擎重算派生指标并暂停。IndexedDB 当前指针同时保存会话标识和 `revision`；事务内比较读取时的基准，拒绝其他窗口已经更新后的陈旧写入。

## 数值、时间与图表适配

`decimal.ts` 使用独立 Decimal 构造器隔离精度与舍入设置。持久化快照和 JSON 导出使用普通对象及字符串，不保存 Decimal 实例。完整交易政策只在 [数据与交易](03-data-and-trading.md) 维护。

`chartData.ts` 集中将 `timestampMs` 转为 `timeSec`，并将价格转成绘图所需的普通数值；绘图值不返回资金计算。展示采用 Asia/Shanghai 并注明 UTC+8。

图表实例保存为普通变量，挂载创建，卸载释放图表、标记、十字线监听和尺寸观察器。逐根推进用 `series.update()`，切换会话、图表类型或可见前缀时才 `setData()`；仅切换类型时保留观察范围。开仓水平线和标记使用实际训练成交价，并保留 Lightweight Charts 署名与 TradingView 链接。

## 运行与验证配置

已提供 `dev`、`typecheck`、`test`、`test:e2e`、`build`、`start`。开发服务与构建预览均绑定 `127.0.0.1:4173` 并启用严格端口，不能同时运行。`start` 是 Vite 本机构建预览，双击入口留在 P4。

Vitest 执行 `tests/unit/`；Playwright 执行 `tests/e2e/`，自动启动固定地址的开发服务并默认从 `.vite/playwright` 查找 Chromium。开发下载缓存放在 `.vite/npm-cache`，不成为运行资源。实际安装与检查命令见 [README](../README.md)，检查结果见 [路线与验收](04-roadmap-and-acceptance.md)。

当前验证通过本机 npm 脚本执行。GitHub Actions 尚未配置；本机通过不等同于远端 CI 已通过。

行情生成器、图表库、字体和界面资源均本地可用；首次依赖与测试浏览器下载需要网络。断网、本机启动脚本和完整首版交付验证仍按 P4 推进。
