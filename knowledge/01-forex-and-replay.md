# 外汇与历史回放

核对日期：**2026-09-30**。以下记录监管教育、央行研究、经纪商示例、平台测试说明及数据提供方规范。交易实现以 [数据与交易规则](../overview/03-data-and-trading.md) 为准，不在这里重复项目公式和默认参数。

## 市场结构与参考汇率

### F01：场外外汇与风险

[Eight Things You Should Know Before Trading Forex](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/CustomerAdvisory_MustKnowForex.html) · **CFTC｜监管教育**。对应：[产品定位](../overview/01-product-and-design.md)。

- 已核查：美国零售场外外汇通常以交易商为对手方，看到的报价和成交条件由其平台提供；杠杆可能放大损失。
- 适用限制：该文讨论美国监管语境。文中亏损账户比例取自 2021 年第二季度至 2022 年第一季度，不能称为当前全球统计。本项目不连接交易商，练习结果也不能证明实盘表现。

### F02：外汇市场不只有即期交易

[OTC foreign exchange turnover in April 2022](https://www.bis.org/publications/202210-commentary-otc-derivatives)、[FX trade execution: complex and highly fragmented](https://www.bis.org/publications/qr-201912/fx-trade-execution-complex-and-highly-fragmented) · **BIS｜央行调查与市场结构分析**。对应：[产品定位](../overview/01-product-and-design.md)、[来源元信息](../overview/03-data-and-trading.md)。

- 已核查：调查区分即期、远期、外汇掉期等工具；2022 年 4 月的日均总量包含多个工具，即期只占其中一部分。市场结构研究说明存在不同交易场所、流动性池与执行方式，单一提供商价格流并不代表全部市场。
- 适用限制：调查为 2022 年，结构研究为 2019 年，不能把其中规模数字当作 2026 年现值。全市场规模不代表零售成交量，也不能据此构造本项目的报价、成交量或撮合规则。

### F03：日度参考汇率不是可成交报价

[Euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) · **ECB｜央行数据说明**。对应：[行情来源](../overview/03-data-and-trading.md)。

- 已核查：ECB 通常在工作日发布一次参考汇率，以欧元为基准，仅供信息用途，并明确不鼓励用于交易。
- 适用限制：单个日度参考值不提供分钟走势或交易时的 Bid/Ask；不能把它包装成实时外汇交易数据。

## 报价与资金

### F04：pip、报价位数与数量

[What is a pip?](https://www.oanda.com/ca-en/skills-and-insights/education/introduction-trading/basics/what-is-a-pip/) · **OANDA 加拿大｜经纪商教育**。对应：[报价与单位](../overview/03-data-and-trading.md)。

- 已核查：pip 是约定的报价变动单位；EUR/USD 等多数货币对的一点为 0.0001，日元货币对通常为 0.01。报价最末位与标准 pip 不一定相同，金额变化还取决于交易的货币数量。
- 适用限制：不同品种有不同点值。本项目的美元名义金额不能直接当作基础货币数量，也不需要照搬平台的手数输入。

### F05：买卖两侧报价与盈亏

[Calculating profit and loss on your trades](https://www.oanda.com/us-en/trading/how-calculate-profit-loss/) · **OANDA 美国｜经纪商计算示例**。对应：[成交与盈亏](../overview/03-data-and-trading.md)。

- 已核查：卖出使用 Bid，买入使用 Ask；做空示例先按卖价卖出，再按买价买回。结果由数量与这两次实际成交价格决定，价格差已经包含点差影响。
- 适用限制：示例中的非美元报价品种还需把盈亏兑换到账户币种。项目只保留直接以美元报价的品种；方向判断正确仍可能因幅度不足以覆盖点差而亏损。

### F06：交易成本不能只看一个固定点差

[Our pricing](https://www.oanda.com/us-en/trading/our-pricing/) · **OANDA 美国｜经纪商定价说明**。对应：[训练成本边界](../overview/03-data-and-trading.md)。

- 已核查：官方区分仅点差定价与点差加佣金等定价安排。成本结构与账户方案有关，真实报价也不能视为恒定点差。
- 适用限制：本页服务于该经纪商美国业务，不代表所有平台。项目的训练点差不能标成某经纪商真实点差；首版省略佣金和融资等成本属于明确简化。

### F07：保证金与仓位名义金额的区别

[How much margin do I need to place an order?](https://help.oanda.com/uk/en/faqs/margin-required.htm) · **OANDA Europe Limited｜产品规则**。对应：[账户与资金占用](../overview/03-data-and-trading.md)。

- 已核查：真实保证金依赖保证金率、数量及到账户币种的换算；不同产品、监管要求和子账户的换算方法可有差别。
- 适用限制：本项目采用训练资金占用，不复现这家平台的保证金和强平制度。名义金额、资金占用、损失限额是不同概念，不能将输入金额描述为最大亏损。

## 历史回放与数据精度

### F08：分钟 OHLC 无法给出全部价格路径

[Testing Trading Strategies](https://www.mql5.com/en/docs/runtime/testing) · **MetaQuotes｜MQL5 官方测试说明**。对应：[回放时间与成交](../overview/03-data-and-trading.md)。

- 已核查：官方区分逐 tick、分钟 OHLC 和仅开盘价等测试模式。OHLC 只保留四个价格，不能确定高低价发生顺序；根据四点构造的路径可能产生不可靠的测试结果。
- 适用限制：MQL5 的生成 tick 模式不等于原始真实 tick；这些模式也不是本项目的执行模型。项目仅用已经完成并显示的分钟报价交易，不推断分钟内止损或触价顺序。

## 数据来源与使用边界

### F09：HistData 的报价类型与时区

[F.A.Q. / Support](https://www.histdata.com/f-a-q/) · **HistData｜数据提供方说明**。对应：[历史样本准备](../overview/03-data-and-trading.md)。

- 已核查：分钟 OHLC 使用 Bid；Generic ASCII tick 格式包含 Bid/Ask。数据时区为固定 EST，不随夏令时调整。
- 适用限制：应按 UTC−5 转换，不能套用会切换夏令时的纽约时区。免费访问不等于完整、无缺口、可公开再分发；FAQ 未核实到明确的再分发授权。

### F10：HistData 原始文件不能直接当作项目 CSV

[Data Files: Detailed Specification](https://www.histdata.com/f-a-q/data-files-detailed-specification/) · **HistData｜文件规范**。对应：[CSV 与分钟聚合](../overview/03-data-and-trading.md)。

- 已核查：Generic ASCII M1 的字段为时间、Bid OHLC、Volume；tick 字段为时间、Bid、Ask、Volume，时间精确到毫秒。两种格式的分隔符与字段不同。
- 适用限制：原始记录需经转换和校验。使用双边 tick 聚合完成分钟、保留最后一组 Bid/Ask 是本项目方案，不是 HistData 原生 M1 自带 Ask 的保证；缺口不应补成虚构走势。

### F11：Dukascopy 历史导出入口

[Forex Historical Data Export](https://www.dukascopy.com/swiss/english/marketwatch/historical/) · **Dukascopy Bank｜官方数据工具说明**。对应：[候选历史来源](../overview/03-data-and-trading.md)。

- 已核查：官方介绍免费历史导出工具，CSV 可覆盖 tick 至月度等粒度。
- 适用限制：读取工具说明不等于取得了指定品种、日期和双边报价，也不能证明样本质量。历史数据的具体许可适用范围尚待核实；未下载或未验证的文件不能记作已交付。

### F12：免费下载与数据库、公开再分发权限

[Terms of Use](https://www.dukascopy.com/swiss/english/legal-pages/terms-of-use/) · **Dukascopy Bank｜网站使用条款**。对应：[样本保存与公开仓库](../overview/03-data-and-trading.md)。

- 已核查：网站条款对内容再发布、分发和数据库构建列出限制；历史导出页面提供免费工具，两者需要结合理解。
- 适用限制：尚未核实上述条款与导出行情专用许可的关系，也未确认个人历史数据库的许可范围。不能据此断言所有个人保存均禁止，或把免费导出当作公开授权；公开仓库只提交已确认可公开的资料和样本。

本地学习用途、软件下载许可、数据下载权限、转换后保存及公开分发应分别核对。发现新的许可说明时更新 F09–F12，并同步项目中的来源结论。
