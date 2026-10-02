# 本机行情与 CSV 格式示例

`csv-template.csv` 是人工生成的格式示例，不是真实历史报价。它展示源文件给出 Ask 与缺少 Ask 两种行；缺少 Ask 的行使用对应品种的训练点差。导入时必须选择 EUR/USD 或 GBP/USD，文件时间表示分钟完成时刻。

真实报价文件仅保留在本机，本目录的价格 CSV、原始压缩包默认被 Git 排除；格式示例单独例外。来源说明与校验元信息可以公开保存，不能由免费取得推断公开再分发许可。

## HistData 双边 tick 转换

依据：[HistData 数据格式说明](https://www.histdata.com/f-a-q/data-files-detailed-specification/)，核对日期 2026-10-02。Generic ASCII tick 的四列是时间、Bid、Ask、Volume；时间为 `YYYYMMDD HHMMSSNNN`，来源使用固定 EST（UTC−5），不随纽约夏令时变化。其 M1 文件只提供 Bid OHLC，不能当成原始双边报价。

转换器只读取本人已经准备的本机文件，不自动下载：

```powershell
node scripts/convertHistData.mjs --input local-data/DAT_ASCII_EURUSD_T_202403.csv --output local-data/prepared/eurusd-20240304-08.csv --pair EUR/USD --from 2024-03-04T00:00:00Z --to 2024-03-08T23:59:00Z
```

`--from` 与 `--to` 是包含边界的 UTC 分钟完成时间，只裁剪输出，原始 tick 仍全量校验。工具校验真实日历日期、时间顺序、正报价与 Ask ≥ Bid，按 UTC 半开分钟区间聚合 Bid OHLC，使用分钟内最后一组 Bid/Ask；边界 tick 进入下一分钟，没有 tick 的分钟不补行。相同毫秒的 tick 依原始顺序处理，末组报价保留。输出 CSV 通过应用同一导入校验器后写入，拒绝覆盖已有文件。

工具同时输出 `*.csv.metadata.json`，记录来源、固定时区、实际完成时间范围、原始 tick 数、完整分钟数、输出根数、转换版本以及原始文件/输出文件 SHA-256。这些记录证明本机转换与结构校验，不代表覆盖整个外汇市场、还原分钟内成交或取得公开再分发许可。

示例先输出到本机 `local-data/prepared/`，避免覆盖公开仓库已经保留的样本元信息。若转换 CSV 的 SHA-256 与下方样本 manifest 相同，再把价格 CSV 放入 `public/data/`；保留公开元信息中的已核对取得记录。已有价格文件时不覆盖。GBP/USD 使用对应的原始文件、品种和输出文件名。不同内容可直接从界面按用户 CSV 导入。

转换工具默认输出 `verified: false`。本人提供的本机文件即使格式合法，也需要另行核对官方下载来源及用途说明，才可以标记来源已核实。

## 本机已准备样本

2026-10-02 通过 HistData 官方免费页面取得两品种 2024 年 3 月双边 tick，按上述工具截取 UTC 完成时间的目标周。官方 [用途说明](https://www.histdata.com/about-us/) 将数据用于个人策略测试；未取得公开再分发授权，ZIP、原始 tick 和转换 CSV 保持本机私用。转换器对任意用户文件默认不认证来源；以下两份样本的元信息另记录本轮官方取得证据。

| 品种 | 本机文件 | UTC 实际完成时间范围 | 分钟数 | 元信息与原始/输出校验 |
| --- | --- | --- | --- | --- |
| EUR/USD | `eurusd-20240304-08.csv` | 2024-03-04 00:00 至 2024-03-08 22:00 | 7,054 | [EUR/USD 元信息](eurusd-20240304-08.csv.metadata.json) |
| GBP/USD | `gbpusd-20240304-08.csv` | 2024-03-04 00:00 至 2024-03-08 22:00 | 7,050 | [GBP/USD 元信息](gbpusd-20240304-08.csv.metadata.json) |

工作台读取 [manifest](manifest.json)，载入前核对 CSV 原始字节 SHA-256 后全量导入，数据进入 IndexedDB，当前练习不变。点击“开始历史练习”才开始仅首根可见的独立会话。克隆仓库时没有价格文件，载入会如实提示尚未准备；可手动从官方页面取得对应原文件后转换，或导入自己的规范 CSV。转换后文件必须与 manifest 的哈希一致；不同来源或时间范围使用普通 CSV 导入，不修改旧数据集。

`npm run check:history` 验证本机两份样本的哈希、全部分钟回放与存储恢复；缺少价格文件时失败，不自动下载。具体执行结果见项目 [路线与验收](../../overview/04-roadmap-and-acceptance.md)。
