# 网页工程

初始核对日期：**2026-09-30**；P1 图表与构建测试条目更新于 **2026-10-01**，具体日期见对应条目。以下使用维护者和平台官方文档；源码与锁文件检查、官方能力描述、实际执行结果分别记录，不把文档描述当作项目验证。模块职责见 [架构](../overview/02-architecture.md)，操作与同步规则见 [AGENTS](../AGENTS.md)。

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

### E06：Lightweight Charts 的能力与署名

[Getting started](https://tradingview.github.io/lightweight-charts/docs) · **TradingView｜Lightweight Charts 5.2 文档**。对应：[图表选型](../overview/02-architecture.md)。

- 核对日期：2026-10-01。P1 实际安装并锁定 Lightweight Charts **5.2.1**，官方资料按 5.2 API 范围核对。
- 已核查：这是面向浏览器的图表库，提供 TypeScript 类型、线图和 K 线等序列；官方说明要求保留 NOTICE 署名及 TradingView 链接。
- 项目对应：使用 v5 的序列与标记 API；源码保留署名和 TradingView 链接，绘图价格与账本计算分开。执行结果见 [阶段记录](../overview/04-roadmap-and-acceptance.md)。
- 适用限制：图表库不提供外汇历史报价或交易账户。锁定版本与静态源码检查不能代替浏览器图表运行验证。

### E07：Vue 图表实例的生命周期

[Vue.js — Wrapper Component](https://tradingview.github.io/lightweight-charts/tutorials/vuejs/wrapper) · **TradingView｜官方集成教程**。对应：[图表边界](../overview/02-architecture.md)。

- 已核查：官方建议用普通变量保存图表 API 实例；需要响应式引用时考虑 `shallowRef`。在挂载后创建，在卸载时调用 `remove()`。
- 适用限制：教程示例需要按项目 TypeScript、库版本和容器尺寸处理适配；示例清理图表并不自动清理项目额外创建的监听器、观察器或计时器。

### E08：整批设置与增量更新

[ISeriesApi](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi) · **TradingView｜Lightweight Charts API**。对应：[回放展示](../overview/02-architecture.md)。

- 已核查：`setData()` 替换序列数据，`update()` 可更新最后一个点或追加新点；需遵守时间顺序及对应数据类型。
- 适用限制：增量更新不能解决业务上的未来泄露。应先限制传给组件的历史范围，再调用图表 API。

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
- 适用限制：安装测试浏览器需下载资源，但应用运行不依赖这些文件或 Playwright。一个 Chromium 项目不能证明所有浏览器兼容、完整无障碍符合性或全部首版场景已经验收。
