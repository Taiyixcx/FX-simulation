# 外汇模拟的研究依据与验证边界

核对日期：**2026-10-02**。本页整理模拟器的研究依据和项目判断；具体公式、训练参数及报价政策只在 [数据与交易](../overview/03-data-and-trading.md) 维护。来源研究、静态实现与项目运行验证是不同证据，实际检查见 [路线与验收](../overview/04-roadmap-and-acceptance.md)。

**2026-10-04 状态补核：**参数版本 2 对普通波动尺度和点差基准完成有限历史估计，S06 记录样本划分与限制。事件、持续波动和日内形状仍为训练设定；不能把“部分校准”写成整体市场已验证。补充研究见 [R01–R21](06-product-and-training-research.md)，实施证据见 [实际记录](../overview/07-optimization-implementation.md)。

## 收益方向与波动的可预测性

### S01：方向不确定不等于所有市场特征都随机

[Micro Effects of Macro Announcements: Real-Time Price Discovery in Foreign Exchange](https://public.econ.duke.edu/~boller/Published_Papers/aer_03.pdf) · **Andersen、Bollerslev、Diebold、Vega｜原研究，American Economic Review，2003**。

- 已核查：研究使用包含欧元、英镑的高频外汇报价，讨论公告惊喜、非正态收益和收益幅度的时间依赖；最短滞后的微小收益相关也可能受微观结构影响。
- 项目判断：普通分钟价格不设固定方向轮转；活跃时段和波动持续可以部分预测，下一步方向与幅度仍须保留不确定性。有限自相关或几个策略结果不能证明完全不可预测。
- 适用限制：样本和市场时期较早，不能移用为当代 EUR/USD、GBP/USD 的分钟参数；研究没有证明本项目的随机生成路径已经真实校准。
- 对应设计：普通收益、事件惊喜与内部统计检查，见 [模拟行情](../overview/03-data-and-trading.md#模拟行情)。

### S02：时段变化与持续波动要分别建模

[Intraday periodicity and volatility persistence in financial markets](https://www.sciencedirect.com/science/article/pii/S0927539897000042) · **Andersen、Bollerslev｜原研究，Journal of Empirical Finance，1997**。

- 已核查：明显的日内波动周期会影响高频依赖的估计；分析持续波动时需要考虑这种周期。
- 项目判断：以实际市场所在地时钟构造归一时段因子，并以不同时间尺度的随机波动状态形成安静和活跃的持续变化。通过随机尺度混合产生厚尾，不额外堆叠未经校准的极厚尾噪声。
- 适用限制：两时标设计是本项目的简化选择，不是论文指定算法；日内系数和衰减速度属于训练设定，仍需按合法真实样本去季节化后校准，避免重复放大风险。
- 对应设计：模拟器状态及参数，见 [数据与交易](../overview/03-data-and-trading.md#模拟行情)。

## 公告与突发事件

### S03：公告的意外部分和波动余波是两种作用

[The High-Frequency Effects of U.S. Macroeconomic Data Releases on Prices and Trading Activity in the Global Interdealer Foreign Exchange Market](https://www.federalreserve.gov/Pubs/ifdp/2004/823/ifdp823.htm) · **美联储｜原研究，IFDP 823，2004**。

- 已核查：公告相对预期的意外部分可迅速改变价格；公告后交易和波动可以继续偏高，即使结果符合预期也可能活跃。
- 项目判断：模拟事件分别更新价格重新定价、波动和流动性状态；计划事件预告只含类型、时间和预期，不提前暴露实际结果。事件练习提高频率，便于集中教学，不能称为正常市场频率。
- 适用限制：不采用“加息必涨”“好数据必涨”的固定交易口诀；事件标签和预期均是明确标注的模拟情景，不是某一历史日期的真实新闻。不同事件的影响参数尚未按当前样本估计。
- 对应设计：事件显示见 [产品与设计](../overview/01-product-and-design.md)，训练规则见 [数据与交易](../overview/03-data-and-trading.md#模拟行情)。

政策信息拆分另参考 [Deconstructing monetary policy surprises: the role of information shocks](https://www.ecb.europa.eu/pub/pdf/scpwps/ecb.wp2133.en.pdf) · **ECB，Jarociński、Karadi｜原研究，Working Paper 2133，2018**。已核查：公告可以同时传递政策信息与央行对经济前景的判断，两者作用不同。项目因此区分当期决定、未来路径、经济信息与解读分歧；这是机制选择，模型权重与独立创新假设并非该论文对 EUR/USD、GBP/USD 分钟价格的估计结果。

### S04：流动性冲击也能放大短时行情

[The October 2016 sterling flash episode: when liquidity disappeared from one of the world’s most liquid markets](https://www.bankofengland.co.uk/working-paper/2017/the-october-2016-sterling-flash-episode) · **英格兰银行｜原研究，2017**。

- 已核查：研究分析英镑闪跌与安静时段、流动性及集中卖单之间的关系。
- 项目判断：流动性事件可造成暂时价格偏移、波动与点差上升，之后逐步消退；不把所有极端变化都命名为新闻，不把点差变化等同于基本面变化。
- 适用限制：单一闪跌案例不能决定正常事件率，不能保证每次冲击都会反转，也不能据此实现真实订单簿、成交深度或滑点。
- 对应设计：动态双边报价；成交仍按当前可见完成分钟报价，见 [数据与交易](../overview/03-data-and-trading.md#4-报价与统一回放进度)。

## 校准、时区与数据

### S05：统计校准需要匹配报价和时间口径

[Instrument definitions](https://developer.oanda.com/rest-live-v20/instrument-df/)、[REST v20 historical data differences](https://help.oanda.com/us/en/faqs/rest-v20-api-troubleshooting-guide.htm) · **OANDA｜官方数据定义与帮助**。时区依据为 [英国夏令时说明](https://www.gov.uk/when-do-the-clocks-change) 与 [美国 NIST 夏令时说明](https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst)。

- 已核查：OANDA 区分 Bid、Ask、中间价 K 线，历史 candle 定价组可能不同于实际账户报价；英国与美国夏令时切换日不同。
- 项目判断：用同步双边报价分离中间价收益和点差，用所在地时钟处理市场时段；不能拿 Bid 与 Ask 各自的分钟高点之差充当实时点差。HistData 的固定 EST 原始时区另按 [F09–F10](01-forex-and-replay.md#数据来源与使用边界) 转换。
- 适用限制：单一来源不代表整个分散的外汇市场；来源数据有缺口时不补成真实走势。数据访问、数据库保存、校准及公开分发的授权分别核对，不能由免费入口推导许可。
- 对应设计：本机历史样本准备、报价来源标记及有限参数估计；未来进一步校准仍需合法跨时期样本。

### S06：时间留出与依赖保留优于分钟随机打散

[Time series cross-validation](https://otexts.com/fpp3/tscv.html) · **Hyndman、Athanasopoulos｜作者教材，2021，在线版**；[The Stationary Bootstrap](https://www.tandfonline.com/doi/abs/10.1080/01621459.1994.10476870) · **Politis、Romano｜原研究，Journal of the American Statistical Association，1994**。

- 已核查：时间序列预测验证只用目标时点之前的训练数据；原研究提供用于弱依赖时间序列不确定性估计的重采样方法。
- 项目判断：按完整日、周或月划分估计与保留样本；比较多尺度收益、尾部、方向相关、波动持续、时段、OHLC 和点差。置信区间需保留依赖结构，不能把分钟独立打散后声称保持了市场规律。
- 实际执行：两品种 HistData Generic ASCII 双边 tick 按固定 EST 转为完成 M1；2024-01、2024-03 整月估计，先冻结参数版本 2，再用 2024-09 整月评估。只用时间相邻分钟的同步中间价收益及点差，排除缺口；版本 1 常量保留。冻结样本的字节哈希、内容指纹和记录数见 [校准资料](../public/data/simulation-calibration.json)，`npm run check:calibration` 生成完整诊断。
- 适用限制：单供应商、两种品种、有限月份，只估计普通波动尺度和基准点差，没有估计事件参数、季节形状、持续波动或 bootstrap 置信区间。GBP/USD 2024-10 原 tick 第 1,799,990 行倒序，转换器拒绝，未排序或删行；EUR/USD 2024-10 已探索，不作为留出。项目内部多种子统计只用于发现机械周期、数值问题和不合理倾向，不能证明整体真实性、未来实盘表现或完全不可预测性。原价格只在本机，个人测试说明不推导公开再分发许可。
- 对应设计：规范参数只在 [数据与交易](../overview/03-data-and-trading.md#模拟行情) 维护；留出误差、重现和边界见 [实施记录](../overview/07-optimization-implementation.md#参数版本与数据研究)。

持续练习只改变生成与保存生命周期，不新增经济规律或改变上述校准状态。默认没有固定根数终点不等于数学无限：模拟时钟采用既定支持范围，浏览器存储有实际容量限制。图表最近窗口用于控制显示与内存，完整已发生行情仍分块保存；统计检查应按全场进度与分块历史取样，不能误把最近显示窗口当作完整样本。刷新保留原状态和未重新抽签的日程，另开新练习才更换种子。规则与容量见 [数据与交易](../overview/03-data-and-trading.md#6-会话保存与恢复)。
