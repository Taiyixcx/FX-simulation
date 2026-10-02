# FX 练习室

供本人在本机使用的外汇练习站。使用 Vue 3 与 TypeScript，通过生成行情练习看盘、买涨买跌、平仓和查看成交结果；真实历史回放与 CSV 导入安排在 P2。

## 当前状态

P0 已完成，P1 基础交易及整页设计更新已实现并验证：EUR/USD、GBP/USD 模拟行情，Bid 折线与 K 线、成交标记，暂停、单步和调速，单仓交易、账户指标与当前成交记录，以及 IndexedDB 一致快照和刷新后暂停恢复。工作台支持手机布局、文字放大、键盘操作和减少动效；具体布局见 [产品与设计](overview/01-product-and-design.md)，检查结果见 [路线与验收](overview/04-roadmap-and-acceptance.md)。

字体、图标与 Apache ECharts 均随应用本地提供，依赖许可随源码及构建产物提供；术语说明按需打开。

每次“新练习”或切换品种创建独立资金与随机种子，旧练习保留在本机数据库。P1 暂无旧会话列表、备注、完整备份恢复和三步引导；保存失败时可重试或导出当前 JSON 快照，导出文件暂不能从界面导入。真实历史样本、CSV 导入与双击 `start.cmd` 尚未实现，P2–P4 仍按阶段推进。

## 本机启动

使用 Node.js 24.x 与 npm；本次开发环境为 Node.js 24.18.0、npm 11.16.0。其他支持版本以 `package.json` 的 `engines` 为准。首次安装需要网络，PowerShell 在项目目录执行：

```powershell
$env:npm_config_cache = Join-Path (Get-Location) '.vite\npm-cache'
npm ci
npm run dev
```

打开 [本机工作台](http://127.0.0.1:4173)。开发服务与构建预览均只绑定 `127.0.0.1:4173`，占用时明确报错，不自动更换端口；两者不能同时运行。

日常使用构建版本，先停止开发服务，再执行：

```powershell
npm run build
npm run start
```

`start` 提供本机构建预览；需要先生成 `dist/`。双击启动入口留在 P4。行情、图表、字体与界面资源均随本机应用提供，无需登录、接口密钥、后端或云服务；断网实际验证按阶段记录，不能据此承诺浏览器缓存或数据库永不丢失。

## 检查命令

```powershell
npm run typecheck
npm run test
npm run build
```

浏览器流程测试使用独立 Chromium。首次下载后可重复执行；下载是开发准备，不是应用运行时依赖：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.vite\playwright'
npx playwright install chromium
npm run test:e2e
```

`playwright.config.ts` 默认使用项目下 `.vite/playwright` 并自动启动同一固定端口的开发服务。运行流程测试前停止已启动的服务，避免端口冲突。

需要检验生产构建时，先生成 `dist/`，再让流程测试自动启动构建预览：

```powershell
npm run build
$env:FX_E2E_PREVIEW = '1'
npm run test:e2e
Remove-Item Env:\FX_E2E_PREVIEW
```

该环境变量仅切换测试服务；不设置时仍使用开发服务。生产预览避免开发期间热更新影响长时间回放检查。

## 数据保存

浏览器按当前 origin 在 IndexedDB 保存会话；`127.0.0.1`、`localhost` 或不同端口是不同存储空间。刷新和重新打开恢复最近成功保存的快照，并保持暂停。多窗口保存会核对当前会话及版本，旧窗口不能静默覆盖另一窗口的更新；发生冲突时按提示导出当前快照，再重新打开最新练习。

保存失败暂停推进与交易，保留当前窗口内的未保存状态和数据库原记录；读取失败也不自动清空数据。当前快照导出用于保留故障现场，P3 再提供完整备份恢复。个人快照和授权未核实的真实行情不随 Git 同步。

## 项目文档

前期 [独立交互样稿](overview/05-interface-preview.html) 可直接打开，展示初始、持仓、平仓和保存失败等视觉状态；它不执行交易或保存练习，当前应用以产品文档及实际验收为准。

| 入口 | 内容 |
| --- | --- |
| [产品与设计](overview/01-product-and-design.md) | 当前工作台、首版范围与后续交互 |
| [架构](overview/02-architecture.md) | 实际技术栈、目录职责、接口与数据流 |
| [数据与交易](overview/03-data-and-trading.md) | 默认参数、行情来源、CSV、交易与保存规则 |
| [路线与验收](overview/04-roadmap-and-acceptance.md) | P0–P4 阶段、完成条件及实际验证 |
| [整体页面美化方案](overview/05-interface-redesign.md) | 整体构图、设计依据与取舍 |
| [交互设计样稿](overview/05-interface-preview.html) | 可本机独立打开的示例界面，不执行交易或写入练习 |
| [参考知识库](knowledge/README.md) | 外汇、网页工程和同类产品的官方资料 |
| [开发规范](AGENTS.md) | 文件组织、命名、文档同步与验证约束 |
