# 参考知识库

这里保存外汇、前端工程和同类产品的查阅笔记。项目决定与具体参数由 [overview](../README.md#项目文档) 维护；本目录说明决定的依据和适用边界。

## 主题与速查

| 主题 | 内容 | 常见问题入口 |
| --- | --- | --- |
| [外汇与历史回放](01-forex-and-replay.md) | 市场结构、报价、盈亏、分钟精度、数据来源与许可 | [上涨为什么仍亏损？](01-forex-and-replay.md#报价与资金)、[OHLC 能还原分钟内走势吗？](01-forex-and-replay.md#历史回放与数据精度)、[免费下载能直接公开吗？](01-forex-and-replay.md#数据来源与使用边界) |
| [网页工程](02-web-engineering.md) | Vue、ECharts、Decimal、IndexedDB、本地字体、可访问性、Git | [图表实例、更新与许可](02-web-engineering.md#图表与十进制计算)、[如何判断保存完成？](02-web-engineering.md#本地保存与恢复)、[换端口为什么看不到记录？](02-web-engineering.md#运行与状态组织) |
| [同类产品与设计](03-product-references.md) | 原型、TradingView、FX Replay、Forex Tester、Trading Game、Linear | [回放与纸上交易有什么不同？](03-product-references.md#tradingview)、[复盘与教学如何保持简单？](03-product-references.md#fx-replay)、[整页设计如何统一？](03-product-references.md#整页设计参考) |
| [精致工作台与交互设计](04-interface-design.md) | 19 个官方页面，覆盖产品构图、数字层级、控件、动效与响应式 | [产品设计参考](04-interface-design.md#产品页面与设计复盘)、[交互规范与限制](04-interface-design.md#控件动效与可访问性规范)、[对应整体方案](../overview/05-interface-redesign.md) |

## 建议阅读顺序

- 理解交易：先读外汇笔记的 F04–F07，再读 [本项目的数据与交易规则](../overview/03-data-and-trading.md)。前者解释概念，后者确定程序行为。
- 准备历史数据：读 F08–F12，确认报价类型、时区、时间含义和使用权限，再按项目约定转换、校验。
- 开发工作台：先读工程笔记 E01–E03、E06–E12，结合 [架构](../overview/02-architecture.md) 确认职责，按 [阶段与验收](../overview/04-roadmap-and-acceptance.md) 推进。
- 改进交互：比较产品笔记 P01–P15；整页层次、回放分组和按需帮助集中在 P12–P15，本地字体见工程 E19。再看 [产品与设计](../overview/01-product-and-design.md)，选择适合个人练习的组织方式，避免照搬商业平台的完整体系。
- 改进视觉质感：阅读 [V01–V19 设计研究](04-interface-design.md)，结合 [整体美化方案与样稿](../overview/05-interface-redesign.md)；实际参数只在 [产品与设计](../overview/01-product-and-design.md) 维护，研究和样稿不代替运行验证。

## 如何使用资料

初始资料核对日期为 **2026-09-30**；**2026-10-01** 更新了图表选型、字体、测试依赖及整页设计参考。条目注明机构、类型、结论、限制和对应设计；后续只更新受影响条目，并单独记录新的核对日期。

资料优先使用监管机构、央行、维护者文档和产品官方帮助页。监管文件按地域和年份理解；产品页反映官方描述，不等于独立评测；设计取舍属于本项目判断。除原型的静态源码读取外，未进行付费竞品的登录、购买或完整交互测试。

笔记保留短摘要和原始链接，不镜像整篇文章、行情数据库或竞品资产。外部页面可能更新或迁移；遇到接口、许可或规则变动时，重新核对原文，不能把这份笔记作为永久授权或完整标准。
