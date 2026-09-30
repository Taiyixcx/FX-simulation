# 架构与目录职责

本文定义后续应用实现的技术、模块和内部接口设计；实际阶段状态与验证结果见 [路线与验收](04-roadmap-and-acceptance.md)。开发约束统一见 [AGENTS.md](../AGENTS.md)，技术依据集中在 [前端与存储知识](../knowledge/02-web-engineering.md)。

## 技术栈

| 能力 | 方案 | 用途 |
| --- | --- | --- |
| 界面 | Vue 3、TypeScript | 单页工作台，Composition API 与单文件组件 |
| 构建与服务 | Vite、npm | 本机开发、打包与固定地址运行 |
| 状态协调 | Pinia | 一个会话 Store 协调行情、账户、记录和操作状态 |
| 图表 | Lightweight Charts | 折线、K 线、十字线、缩放和成交标记 |
| 计算 | Decimal.js | 报价、数量、资金与盈亏的十进制运算 |
| 保存 | IndexedDB | 数据集、会话、成交及备注的事务保存 |
| 单元验证 | Vitest | 行情源、交易计算、解析与快照行为 |
| 流程验证 | Playwright | 本地工作台关键操作和恢复流程 |

使用原生语义控件、CSS 变量和组件 scoped 样式。首版不引入完整组件库、Router、SSR、后端或 PWA；仅在实际实现需要时添加辅助依赖。

## 目录设计

以下是应用完成后的组织目标，按阶段创建实际需要的文件；不提前建立空的源码、共享层或测试目录。

```text
FX-simulation/
├─ AGENTS.md
├─ README.md
├─ .gitignore
├─ .gitattributes
├─ overview/                    # 产品、架构、规则、阶段与验收
├─ knowledge/                   # 主题笔记及可核查的外部资料
├─ public/
│  ├─ data/                     # 本机历史样本及来源信息
│  ├─ templates/                # 统一 CSV 模板
│  └─ favicon.svg
├─ src/
│  ├─ App.vue                   # 工作台布局与功能装配
│  ├─ main.ts                   # Vue 与 Pinia 初始化
│  ├─ features/
│  │  ├─ chart/                 # 图表、报价与成交标记
│  │  ├─ replay/                # 数据选择、回放与导入界面
│  │  ├─ trading/               # 下单表单与持仓操作
│  │  ├─ journal/               # 会话、成交与备注
│  │  └─ help/                  # 三步引导与术语
│  ├─ engine/
│  │  ├─ simulationSource.ts    # 可复现的生成行情
│  │  ├─ historicalSource.ts    # 历史帧的前向读取
│  │  ├─ marketData.ts          # 行情格式解析与业务校验
│  │  ├─ execution.ts           # 开仓、平仓与成交结果
│  │  ├─ account.ts             # 权益、可用资金与结算
│  │  └─ types.ts               # 引擎边界业务类型
│  ├─ stores/
│  │  └─ useSessionStore.ts     # 当前会话协调
│  ├─ storage/                 # IndexedDB、序列化、备份与恢复
│  └─ styles/                  # 全局变量与基础样式
├─ scripts/                     # 本机数据整理与校验
├─ tests/
│  ├─ unit/
│  └─ e2e/
├─ index.html
├─ start.cmd
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
└─ playwright.config.ts
```

`src/components/` 仅在出现跨功能共享界面组件后建立；`src/composables/` 仅在出现可复用的 Vue 组合逻辑后建立。功能独用的组件、逻辑和类型留在 feature 内。行情源直接放在 `engine/`，不为两个小模块增加 `sources/` 层；布局由 `App.vue` 承担，不另建 `src/app/`。

用户导入的数据进入 IndexedDB。`public/data/` 可放本机准备的真实样本；公开仓库只提交来源信息和已确认允许再分发的文件。原始下载、个人备份及未获公开授权的行情文件不进入版本控制；具体来源规则见 [数据与交易](03-data-and-trading.md)。

## 职责与依赖

| 区域 | 负责内容 | 依赖边界 |
| --- | --- | --- |
| `App.vue`、`main.ts` | 初始化、布局与功能装配 | 不承载资金公式或数据转换 |
| `features/` | 展示、输入、反馈与功能局部状态 | 通过会话 Store 发起业务操作 |
| `engine/` | 行情、成交、账户和纯数据校验 | 不依赖 Vue、Pinia、DOM、定时器或浏览器存储 |
| `useSessionStore.ts` | 统一推进、交易命令、会话切换和保存协调 | 调用引擎与 storage，拥有回放调度资源 |
| `storage/` | 数据读写、版本校验、DTO 转换、备份与恢复 | 不驱动图表、不决定成交价格 |
| `styles/` | 共享视觉变量、基础排版和全局元素样式 | 组件局部样式留在 `.vue` 文件 |
| `scripts/` | 开发阶段来源转换与样本校验 | 不成为应用运行时联网依赖 |
| `tests/` | 纯业务和浏览器关键流程验证 | 不存放业务源码或生成产物 |

单个会话 Store 避免报价、账户和图表各自推进。金额、数量和盈亏公式只在引擎维护；图表读取可见帧，不能自行访问历史全量数据。纯格式校验放在 `engine/marketData.ts`；浏览器文件读取、事务及恢复提交由 `storage/` 负责。

```text
Vue 操作 ───────► useSessionStore
                        │ 推进 / 开仓 / 平仓
                        ▼
             行情源 + 交易与账户引擎
                        │ 同一可见帧与账户结果
                        ▼
                 一致的会话状态 ───► Vue 图表、下单、记录
                        │ 快照
                        ▼
            storage 校验、序列化、事务 ───► IndexedDB
```

导入先在独立流程读取、解析和校验，通过后才写入数据集。备份恢复也先校验完整快照，再事务提交，最后替换当前会话。保存失败时暂停行情与交易，不发布“已保存”状态；旧数据保留，允许重试和导出内存快照。

## 最小内部接口

这些是实现约定，尚未形成代码 API；不提供网络接口。

| 类型 | 必须表达的内容 |
| --- | --- |
| `MarketQuote` | UTC `timestampMs`、`bidPrice`、`askPrice`，以及 Ask 由源文件提供或训练点差生成的标识；数据真实性另由来源信息说明 |
| `MarketFrame` | 一根已完成的 Bid 分钟 OHLC 及其当前报价；只有已推进帧可以交给界面和成交逻辑 |
| `MarketSource` | 初始化、向前一步、源快照、恢复；两种源输出同一种帧，末尾明确返回结束状态 |
| `DatasetMetadata` | 标识、品种、来源、实际时间范围、原始时区、报价类型、授权核对与数据校验状态 |
| `AccountState` | 已结算余额与当前持仓；权益、可用资金和浮动盈亏由引擎派生 |
| `SessionSnapshot` | 格式版本、会话标识、模式、品种、数据集或模拟配置、源状态、账户、成交与备注 |

模拟源保存种子、确定的生成配置及随机状态和当前进度；恢复后必须产生相同后续序列。历史源保存数据集标识与可见进度，不把未推进帧复制到图表状态。回放调度调用源的单步接口，资金运算不依赖播放速度。

一个快照包含对应同一进度的行情状态、账户、持仓和成交记录。恢复后重算派生账户指标，保持暂停；模式、品种和数据集切换不把旧持仓套用到新报价。详细会话行为见 [数据与交易](03-data-and-trading.md)。

## 数值、时间与图表适配

外部价格及金额从十进制字符串进入 Decimal.js。持久化 DTO 和 JSON 备份采用十进制字符串，恢复时校验再重建 Decimal 对象；权益等派生数值由引擎重新计算。只有图表适配层将价格转换为绘图所需的普通数值，绘图数值不返回资金计算。

内部统一使用 UTC 毫秒 `timestampMs`；图表适配集中转换为秒 `timeSec`。展示时使用 Asia/Shanghai 并注明 UTC+8；来源时区转换在导入或样本整理阶段完成，不写入本机时区的账本时间。CSV 接口、分钟完成时间和来源转换规则由 [数据与交易](03-data-and-trading.md) 唯一维护。

图表组件挂载时创建实例，以普通变量或 `shallowRef` 保存。卸载时释放图表、事件监听与尺寸观察器；会话 Store 清理自己持有的回放调度器。逐步推进使用 `series.update()`，更换会话或数据集才替换可见序列；不反复创建图表。交易标记与水平线使用实际 Bid/Ask 成交价格，保留库要求的署名和链接。

## 运行与验证配置

后续工程提供 `dev`、`typecheck`、`test`、`test:e2e`、`build`、`start` 脚本；使用 npm 和唯一的 `package-lock.json`。类型检查使用 Vue 对应的 TypeScript 检查工具，单元测试与关键流程分别由 Vitest、Playwright 执行。脚本落地与验证结果按 [路线与验收](04-roadmap-and-acceptance.md) 记录。

Vite 开发服务与本机成品服务均绑定 `127.0.0.1:4173`，开启严格端口；占用时明确失败，不自动换端口。两种服务不能同时启动。`start.cmd` 在应用交付阶段负责启动服务并打开相同地址，浏览器数据始终对应同一 origin。

运行时行情、字体、图表和其他资源均本地可用，首次安装依赖和准备真实样本属于开发准备。实际启动命令、前置条件及访问说明只维护在 [根 README](../README.md)。
