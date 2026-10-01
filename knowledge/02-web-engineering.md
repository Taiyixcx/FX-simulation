# 网页工程

初始核对日期：**2026-09-30**；P1 图表替换、字体与构建测试条目更新于 **2026-10-01**，具体日期见对应条目。以下使用维护者和平台官方文档；源码与锁文件检查、官方能力描述、实际执行结果分别记录，不把文档描述当作项目验证。模块职责见 [架构](../overview/02-architecture.md)，操作与同步规则见 [AGENTS](../AGENTS.md)。

## 运行与状态组织

### E01：Vue 项目创建与单页应用

[Quick Start](https://vuejs.org/guide/quick-start.html) · **Vue｜框架入门文档**。对应：[技术选择](../overview/02-architecture.md)。

- 已核查：官方 `create-vue` 可创建基于 Vite 的项目，选择 TypeScript 等能力；不需要 SSR 时直接使用 Vite 是简洁方案。
- 适用限制：创建工具有 Node 版本要求，实施时需核对实际版本。Router、SSR 和其他可选功能不因脚手架支持而自动成为项目需求。

### E02：更新性能与浅层响应式

[Performance](https://vuejs.org/guide/best-practices/performance.html) · **Vue｜性能指南**。对应：[行情与图表数据流](../overview/02-architecture.md)。

- 已核查：Vue 默认深层响应式；大体量不可变数据可考虑 `shallowRef`，其内部更新需要替换根值才能触发响应。官方同时建议避免无收益的组件抽象。
- 适用限制：浅层响应式不是所有数据的默认答案。先测量实际更新开销，再优化；图表实例的专门建议见 E07。

### E03：Pinia action 协调会话

[Actions](https://pinia.vuejs.org/core-concepts/actions.html) · **Pinia｜状态库指南**。对应：[会话 Store](../overview/02-architecture.md)。

- 已核查：action 可同步或异步执行、调用其他 action，并获得类型支持，适合协调推进、交易和保存。
- 适用限制：action 能放业务代码不代表全部计算都应进入 Store；本项目把纯计算留在引擎，这属于项目模块边界。

### E04：开发服务的地址与严格端口

[Server Options](https://vite.dev/config/server-options) · **Vite｜配置参考**。对应：[本机运行](../overview/02-architecture.md)。

- 已核查：可设置监听地址和端口；端口占用时默认尝试下一端口，`strictPort` 可令其直接退出。
- 适用限制：监听所有地址会扩大可访问范围。端口稳定还关系到浏览器 origin，必须结合 E12 理解；开发服务不等于线上部署方案。

### E05：构建预览需单独核对配置

[Preview Options](https://vite.dev/config/preview-options) · **Vite｜配置参考**。对应：[本机启动与交付](../overview/02-architecture.md)。

- 已核查：预览有独立的 `host`、`port`、`strictPort` 选项，部分默认值继承开发服务配置；预览端口默认值不能代替显式统一配置。
- 适用限制：该页说明预览选项，不提供公共托管或多用户后端。本项目仅将构建预览作为本机使用方式。

## 图表与十进制计算

### E06：图表选型、模块化与许可分发

[Import ECharts](https://echarts.apache.org/handbook/en/basics/import/)、[ECharts 6.1.0 LICENSE](https://github.com/apache/echarts/blob/6.1.0/LICENSE)、[NOTICE](https://github.com/apache/echarts/blob/6.1.0/NOTICE) · **Apache ECharts｜官方手册与发布许可文件**。对应：[图表选型与分发](../overview/02-architecture.md)。

- 核对日期：2026-10-01。当前锁文件改为 Apache ECharts **6.1.0**；官方支持按需导入图表、组件及渲染器，并以 `ComposeOption` 组合类型。
- 已核查：Apache 2.0 的再分发条件包含提供许可副本、保留适用声明及可读 NOTICE；NOTICE 可以作为随产物分发的文本文件提供。这些文件未发现要求在工作台展示图表品牌或可点击链接的额外条款。运行依赖及字体的其他许可证需分别保留。
- 项目对应：模块化 Canvas 图表，本地随构建提供；`public/licenses/` 保存许可文件并复制到 `dist/licenses/`，不在交易页面放第三方标识。绘图价格与 Decimal 账本计算分开。
- 替换原因：原 P1 使用 Lightweight Charts 5.2.1；其 [官方入门文档](https://tradingview.github.io/lightweight-charts/docs) 额外要求署名及 TradingView 链接。用户要求页面无第三方标识，因此替换依赖，而非隐藏旧库署名。
- 适用限制：这是已核对版本文件的工程分发判断；依赖版本或打包内容变动时应重新核对，不能推断所有图表库均有相同条件。图表库不提供外汇历史报价或交易账户；静态检查不代替实际运行验证。

### E07：图表实例、尺寸与释放

[Chart Container and Size](https://echarts.apache.org/handbook/en/concepts/chart-size/)、[Vue Performance](https://vuejs.org/guide/best-practices/performance.html) · **Apache ECharts / Vue｜官方手册**。核对日期：**2026-10-01**。对应：[图表边界](../overview/02-architecture.md)。

- 已核查：初始化前容器需有尺寸；容器变化调用 `resize()`，仅监听窗口 resize 不能覆盖全部布局变化，可使用 ResizeObserver。卸载图表容器时调用 `dispose()` 释放资源。
- 项目对应：用普通变量保存图表实例，挂载创建、卸载释放；额外监听器及观察器同时清理。报价与账户仍由语义化文本展示，不只存在于画布中。
- 适用限制：保持单实例和正确清理属于生命周期保障，不能单独证明性能足够。不同设备、文字放大和最长行情仍需浏览器测量。

### E08：局部更新、K 线数据与观察范围

[Dynamic Data](https://echarts.apache.org/handbook/en/how-to/data/dynamic-data/)、[Instance API](https://github.com/apache/echarts-doc/blob/master/en/api/echarts-instance.md)、[Candlestick](https://github.com/apache/echarts-doc/blob/master/en/option/series/candlestick.md)、[Marker Coordinates](https://github.com/apache/echarts-doc/blob/master/en/option/partial/marker.md) · **Apache ECharts｜官方手册及文档源码**。核对日期：**2026-10-01**。对应：[行情绘图适配](../overview/02-architecture.md)。

- 已核查：`setOption` 合并局部选项并更新图表，`replaceMerge` 可用于替换指定组件；`appendData` 的支持范围不包含普通折线与 K 线。K 线二维数据顺序为开、收、低、高。
- 项目对应：使用同一实例局部 `setOption`，切换类型时替换 series；观察范围保存绝对索引，只有原本跟随最新才继续跟随。类别轴及成交点坐标使用 UTC 毫秒字符串，避免数值坐标被解释为类别索引。纵轴同时纳入视窗内实际 Ask/Bid 成交价和入场线。
- 静态源码核查：[6.1.0 MarkLineModel](https://github.com/apache/echarts/blob/6.1.0/src/component/marker/MarkLineModel.ts) 的 `precision` 默认为 2。本项目入场线显式设置为 5，避免外汇价格被两位舍入到可见范围之外；真实成交值仍来自引擎。
- 适用限制：ECharts 的动态更新与数据差异处理不等于每次只向内部追加一个点，也不能防止未来泄露；组件输入先限制为已推进前缀。1,440 根最高速度的实际响应和缩放保持结果只记录在 [阶段记录](../overview/04-roadmap-and-acceptance.md)。

### E09：Decimal 的精度、舍入和序列化

[decimal.js API](https://mikemcl.github.io/decimal.js/) · **MikeMcl｜维护者 API 文档**。对应：[数值与持久化](../overview/02-architecture.md)。

- 已核查：Decimal 接受十进制字符串，可配置有效数字精度与舍入模式，并提供十进制输出和 JSON 字符串序列化。
- 适用限制：价格先参与普通浮点运算或被截断后，Decimal 不能恢复已丢失的精度。Decimal 也不是无限精度；项目仍需固定精度、结算舍入与输入校验。

## 本地保存与恢复

### E10：IndexedDB 事务与完成事件

[Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) · **MDN｜Web API 指南**。对应：[存储职责](../overview/02-architecture.md)。

- 已核查：IndexedDB 提供异步请求、对象存储、版本升级和事务。单次写入请求成功时，事务仍可能失败；事务完成后才能确认整批保存完成。
- 适用限制：事务完成不意味着永远不会被用户删除或浏览器清理，也不替代备份。异步事务的有效期需要在实施中处理，不能随意穿插无关等待。

### E11：structured clone 不恢复业务类实例

[The structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) · **MDN｜平台序列化说明**。对应：[快照编码](../overview/02-architecture.md)。

- 已核查：IndexedDB 使用结构化克隆；函数不可克隆，普通对象的原型链、属性描述符等不能按原样复制。
- 适用限制：不能把保存过的 Decimal 或业务对象当作仍有原类方法的实例。用纯对象和字符串保存，再显式恢复、校验，比依赖隐式类恢复可靠。

### E12：origin、配额与数据保留

[Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) · **MDN｜浏览器存储说明**。对应：[保存与恢复规则](../overview/03-data-and-trading.md)。

- 已核查：浏览器通常按协议、主机和端口组成的 origin 管理数据；默认属于尽力保留，配额、清理和隐私模式会影响保存。`persist()` 是申请持久存储，不保证每次批准。
- 适用限制：不同浏览器的配额和策略不同，不能承诺“本地保存永不丢失”。个人备份需能导出到浏览器之外；换端口或把 `127.0.0.1` 改为 `localhost` 会改变 origin。

## 可访问性与仓库同步

### E13：WCAG 2.2 的检查依据

[Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) · **W3C｜可访问性标准**。对应：[界面设计](../overview/01-product-and-design.md)、[体验验收](../overview/04-roadmap-and-acceptance.md)。

- 已核查：标准包含不用颜色作为唯一信息、键盘操作、可见焦点、文字放大、对比度及目标尺寸等准则。适用的普通文本 AA 对比度为 4.5∶1，大文本为 3∶1；文字需支持 200% 放大。
- 适用限制：各准则有等级和例外，不能仅凭字号或一次自动扫描宣称整体符合 WCAG。金融图表需结合文本报价、持仓和键盘流程定向验证。

### E14：将本地内容添加到 GitHub

[Adding locally hosted code to GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github) · **GitHub｜官方操作指南**。对应：[仓库交付](../overview/04-roadmap-and-acceptance.md)。

- 已核查：官方说明初始化本地仓库、提交、关联远端和推送，并提醒避免提交密码、密钥等敏感内容；空远端可避免首次同步的不必要冲突。
- 适用限制：文档步骤不证明当前身份拥有仓库权限，也不授权覆盖后来出现的远端提交。同步前应核对目标和实际内容，个人记录与未确认公开权限的行情不能随源码提交。

### E15：简洁、可识别的提交说明

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) · **Conventional Commits｜公开提交约定**。对应：[交付规范](../AGENTS.md)。

- 已核查：约定以类型、可选范围和简述组织提交标题；正文与脚注按需要补充，常见类型包括 `feat`、`fix` 和 `docs`。
- 适用限制：它是协作约定，不是 Git 强制语法。本项目根据用户要求采用范围必填、中文简述和简洁正文，实际规则只在 AGENTS 维护。

### E16：本地目录名与远端仓库名

[git-clone](https://git-scm.com/docs/git-clone) · **Git｜命令参考**。对应：[仓库与本机路径](../README.md)。

- 已核查：`git clone` 可指定本地目标目录，省略时才根据仓库地址推导目录名。因此 Git 并不要求两者相同。
- 适用限制：目录移动可能影响编辑器工作区、脚本和已有绝对路径，名称统一本身不改善同步。本项目按用户要求保留现有本机目录。

## P1 构建与测试依赖

### E17：Vite、Vitest 与类型检查的兼容性

[Vite Getting Started](https://vite.dev/guide/)、[Vitest Getting Started](https://vitest.dev/guide/) · **Vite / Vitest｜维护者安装与配置指南**。核对日期：**2026-10-01**。对应：[实际技术栈](../overview/02-architecture.md)。

- 已核查：Vite 提供开发服务和静态构建；Vitest 支持独立配置及一次性 `vitest run`。当前官方 Vitest 指南要求 Node.js 至少 22.12.0、Vite 至少 6.4.0。
- 项目对应：锁定 Vite 8.3.1、Vitest 5.0.3、TypeScript 6.0.3、vue-tsc 3.3.11，实际 Node.js 为 24.18.0。类型检查与构建已执行通过，结果见 [阶段记录](../overview/04-roadmap-and-acceptance.md)。
- 适用限制：符合最低版本不等于所有插件和编译器组合均兼容。这里的 TypeScript 选择依据当前 vue-tsc 的实际运行结果，不宣称其他版本不可用，也不因更高版本存在而自动升级。

### E18：Playwright 浏览器与项目缓存

[Installation](https://playwright.dev/docs/intro)、[Browsers](https://playwright.dev/docs/browsers) · **Microsoft｜Playwright 安装与浏览器管理指南**。核对日期：**2026-10-01**。对应：[浏览器检查命令](../README.md)。

- 已核查：Playwright Test 可执行 Chromium、Firefox 与 WebKit 流程；浏览器二进制需要单独安装，安装与执行可用 `PLAYWRIGHT_BROWSERS_PATH` 指向同一目录。
- 项目对应：锁定 Playwright 1.63.0，P1 检查项目仅启用 Chromium；配置默认查找 `.vite/playwright`，避免在受限开发环境中写入项目之外的默认浏览器缓存。实际执行结果单独记录在 [阶段记录](../overview/04-roadmap-and-acceptance.md)。
- 项目取舍：默认启动开发服务进行流程检查；完整最高速度回放用 `FX_E2E_PREVIEW=1` 启动生产构建，避免源码热更新重载影响实例保持证据。这是项目测试配置，不属于 Playwright 的通用环境变量。
- 适用限制：安装测试浏览器需下载资源，但应用运行不依赖这些文件或 Playwright。一个 Chromium 项目不能证明所有浏览器兼容、完整无障碍符合性或全部首版场景已经验收。

### E19：本地字体与原创图标

[Installing Fonts](https://fontsource.org/docs/getting-started/install)、[Inter License](https://github.com/rsms/inter/blob/master/LICENSE.txt) · **Fontsource / Inter｜维护者文档与字体许可**。核对日期：**2026-10-01**。对应：[字体与运行资源](../overview/01-product-and-design.md)。

- 已核查：Fontsource 的 npm 包可按字重、样式和子集导入字体 CSS；Inter 按 SIL Open Font License 1.1 分发。实际安装锁定 `@fontsource/inter` **5.3.0**，包内字体许可随产物保留。
- 项目对应：仅打包 Latin 常用字重 400/500/600/700，英文及数字用 Inter，中文回退到本机系统字体；不在运行时请求 Google Fonts。跨功能图标用项目自己的 SVG 组件提供。
- 适用限制：系统中文字体会因设备而异；本地字体打包不代表物理断网场景已测试。是否存在非本机资源请求需核对构建预览，实际结果见阶段记录。
