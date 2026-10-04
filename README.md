# FX 练习室

供本人在本机使用的外汇练习站。使用 Vue 3 与 TypeScript，通过生成行情或历史分钟报价练习看盘、买涨买跌、平仓和查看成交结果。

## 当前状态

**2026-10-04 实施更新：**旧会话恢复、完整备份追加恢复、成交图表复盘、计划与备注、风险及基础统计、历史起点/预热、M5/H1、两组概念题和训练对照已经实现。新模拟参数版本 2 对普通波动/点差做了跨月部分校准，旧版本 1 保持复现；事件等仍为训练设定。提供 `start.cmd`；最终回归和合并进度见 [实施记录](overview/07-optimization-implementation.md)。

追加规模审计修补了长期模拟复盘重复重演：已验证会话通过头/全部块指纹核对后返回旧行情，完整冷恢复仍逐帧校验并分批让出。物理断网及真实读屏由本人后续人工验收，本轮不将其描述为已通过。

P0 已完成，P1 基础交易及整页设计更新已实现并验证：EUR/USD、GBP/USD 模拟行情，Bid 折线与 K 线、成交标记，暂停、单步和调速，单仓交易、账户指标与当前成交记录，以及 IndexedDB 一致快照和刷新后暂停恢复。工作台支持手机布局、文字放大、键盘操作和减少动效；具体布局见 [产品与设计](overview/01-product-and-design.md)，检查结果见 [路线与验收](overview/04-roadmap-and-acceptance.md)。

工作台采用薄荷底色、墨绿主色与粉色买跌按钮，统一选择框、数字字重和区域间距；历史导入按文件与来源信息分组。字体、图标与 Apache ECharts 均随应用本地提供，依赖许可随源码及构建产物提供；术语说明按需打开。

模拟行情提供常规练习和提高事件频率的事件练习，结合持续波动、市场时段、模拟公告与突发冲击，动态生成点差。页面只展示已发生事件及计划公告的时间与预期。参数版本 2 仅对普通波动尺度和基准点差作部分校准：使用 2024 年 1/3 月估计、9 月留出核对；事件频率、影响与形状等仍是训练设定，不能据此宣称整体市场还原或实盘有效。规则见 [数据与交易](overview/03-data-and-trading.md)，依据见 [外汇模拟研究](knowledge/05-foreign-exchange-simulation.md)。

模拟练习持续生成行情，由本人随时暂停；刷新或重新打开沿用原练习、原随机状态与进度，并保持暂停。“新练习”创建独立资金和随机走势，旧练习可在“练习与完整备份”中继续。图表支持 M1/M5/H1，逐根键盘读数及等价行情表；点击成交可定位开平仓周边的已发生行情，复盘观察不回滚账户或改变成交时刻。

“历史数据”支持 CSV 校验进度、取消、本机保存和历史回放。导入只增加数据集；选定开始日期及观察预热后，“开始历史练习”才创建独立资金的会话。来源真实性与源文件 Ask / 训练 Ask 分开标明，缺口不补假分钟。刷新恢复原来源、账户和进度并暂停，结束后仍可按最后报价平仓；格式与规则见 [数据与交易](overview/03-data-and-trading.md)。

本机保留 HistData 双边 tick 聚合的两份工作台周样本，另用跨月本机样本研究部分参数。价格文件不纳入 Git；克隆仓库后需按 [样本说明](public/data/README.md) 准备，或导入自己的 CSV。公开仓库保留来源与校验元信息、转换工具、冻结参数资料和生成的 CSV 模板；这些材料不证明分钟内逐笔还原或公开再分发授权。

可选事前理由、退出计划与后续修订保留在独立备注中；风险预览显示数量、每 pip 金额及假设退出结果，不设置自动订单。基础统计区分结算盈亏、余额回撤和包含浮盈亏的权益回撤。三步引导可跳过，两组概念题只反馈理解；已见重练与本机未见检验分别标记，不把记住走势或答题成绩当作能力证明。

完整备份通过“练习与完整备份”提供，包含全部会话、归档、历史源和注释；先校验并预览，再恢复到空库或追加独立副本，不覆盖已有账户。故障快照保留未提交现场，不能替代完整备份。保存失败暂停并保留原库；容量有限，不自动删除早期行情。详细限制见 [保存与恢复规则](overview/03-data-and-trading.md#6-会话保存与恢复)。

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

`start` 提供本机构建预览，需要先生成 `dist/`。双击 `start.cmd` 会打开本机工作台；保持窗口打开，Ctrl+C 结束。缺依赖、缺构建或 4173 占用时明确失败，不自动安装或换端口。资源本地提供，无登录或密钥；实际物理断网与受控外网不可达检查分别记录，不承诺数据库永不丢失。

## 检查命令

```powershell
npm run typecheck
npm run test
npm run check:simulation
npm run check:continuous
npm run check:history
npm run check:calibration
npm run build
```

`check:simulation` 比较多个种子、两品种与两情景的内部统计特征和机械规律，不证明整体市场真实性。`check:calibration` 复核本机跨月样本、冻结的部分参数及留出比较；它不下载价格文件，样本准备及适用限制见 [实施记录](overview/07-optimization-implementation.md)。

`check:continuous` 在 Node 与 fake-indexeddb 中生成并分块保存 50,000 根，核对历史数量、最近窗口、跨归档开平仓账本及恢复后的下一根。它验证长练习生命周期，不代表真实浏览器存储配额、内存占用或市场校准。

`check:history` 对本机 manifest 中的样本逐一核对文件 SHA-256，运行全部分钟回放、窗口滚动、账户与持仓保存恢复。价格文件缺失时明确失败；它不下载数据。`convert:histdata` 只转换用户已准备的本机双边 tick，参数及使用范围见 [样本说明](public/data/README.md)。

浏览器流程测试使用独立 Chromium。首次下载后可重复执行；下载是开发准备，不是应用运行时依赖：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.vite\playwright'
npx playwright install chromium
npm run test:e2e
```

`npm run test` 通过项目内临时目录运行 Vitest，最多使用两个 worker。Playwright 默认使用 `.vite/playwright`，由 `globalSetup` 在测试进程内启动并关闭 Vite 服务。运行流程测试前停止已启动的服务，避免固定端口冲突。

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

保存失败暂停推进与交易，保留当前窗口内的未保存状态和数据库原记录；读取失败也不自动清空数据。正常备份与故障快照分开提供；有未保存状态时，完整备份只包含最近成功提交的数据。恢复先展示范围，已有数据默认追加并保留当前练习，只有明确选择才打开恢复入口。个人快照、完整备份和授权未核实的真实行情不随 Git 同步。

升级保留旧练习的行情与账本，当前模型下参数版本 1 的会话继续原参数，不静默改用版本 2。更早快照在行情和账本校验后迁移，恢复均暂停；较早模拟行情按块保存，成交复盘按需读取。迁移或保存失败保留原数据并提供重试、故障导出；容量估算与持久存储申请不能代替外部文件备份。具体规则见 [数据与交易](overview/03-data-and-trading.md#6-会话保存与恢复)。

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
| [修补与优化计划](overview/06-repair-and-optimization-plan.md) | 本轮问题证据、任务拆分、兼容与验收要求；实际成果见实施记录 |
| [优化实施记录](overview/07-optimization-implementation.md) | 当前实际代码、检查结果、数据研究与限制 |
| [参考知识库](knowledge/README.md) | 外汇、网页工程和同类产品的官方资料 |
| [开发规范](AGENTS.md) | 文件组织、命名、文档同步与验证约束 |
