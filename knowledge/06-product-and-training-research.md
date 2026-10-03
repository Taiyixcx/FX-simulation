# 产品、保存与训练的补充研究

核对日期：**2026-10-03**。本页为 [修补与优化计划](../overview/06-repair-and-optimization-plan.md) 提供依据；当前产品约定、业务公式和实际验证分别仍由 `overview/` 对应文档维护。

研究覆盖八个商业或免费工具，以及存储标准、浏览器文档、可访问性规范和学习/验证原研究。产品结论来自公开官方资料，**未登录、安装、购买或完成交互测评**；性能与学习效果不能从营销介绍推导。未知表示本轮资料未确认，不表示该产品没有功能。下列 R01–R21 的核对日期均为 2026-10-03。

## 1. 同类产品能力比较

| 产品 | 回放与观察 | 风险及复盘 | 保存及离线 | 使用条件与本项目取舍 |
| --- | --- | --- | --- | --- |
| TradingView Replay Trading | 历史起点、调速、单步、同步多图 | 挂单、图上 SL/TP、统计及导出 | 官方说明交易结果仅该会话可用；离线保证未确认 | 历史范围受品种、周期及方案影响；借鉴风险展示，保留本地长期记录 |
| FX Replay | 日期起点、回退、Go-to、多图 | 定仓、清单、日志、图上复盘、时段分析、AI | 账号内保存，保留条件依方案；离线保证未确认 | 免费层与订阅；借鉴成交定位和决策关联，不引入云账户 |
| Forex Tester Desktop | 起点、多周期、前进限定模式 | SL/TP、统计、导出 | 本地项目续练，官方明确离线使用 | 桌面许可与数据档，试用保存有限制；离线不是本项目独有能力 |
| Forex Tester Online | 同步多图、导航、隐藏品种/日期 | SL/TP、信心、清单、日志、退出优化 | 在线项目，保留条件依方案；离线保证未确认 | 免费与付费方案；不把历史最优退出当未来有效规则 |
| Soft4FX | 起点、回退、多周期；MT5 多品种 | 风险定仓、部分平仓、SL/TP、触发暂停、统计 | 文件保存恢复；完整断网许可行为未确认 | Windows、MT4/MT5、一次性许可；demo 保存有限制 |
| Trading Game | 主要为实时模拟；自由历史回放未确认 | 学院、图表概念训练、SL/TP、AI coach | 账号与虚拟组合；离线恢复未确认 | 移动 App 免费/Pro；借鉴短解释后立即练习 |
| ThinkTrader Traders Gym | 日期范围、调速、历史模拟；同步细节待实测 | 平台图表与订单工具 | 官方介绍保存模拟；离线与原子性未确认 | 免费使用有真实账户资格条件，本项目不照搬开户门槛 |
| FX Blue Trading Simulator | MetaTrader 测试器中的手动历史练习 | 市价/挂单、SL/TP、跟踪止损、结果 | 本地运行，可上传分析；完整续练和纯离线未确认 | 免费注册并依赖 MetaTrader；多周期存在官方未来信息警示 |

### R01 TradingView：历史交易与实时纸上交易分别理解

**机构 / 类型：TradingView，官方帮助与发布说明。** [历史交易](https://www.tradingview.com/support/solutions/43000691889-learn-to-trade-on-historical-data/)、[回放起点](https://www.tradingview.com/support/solutions/43000474024-how-do-i-turn-bar-replay-on/)、[同步多图](https://www.tradingview.com/blog/en/synchronized-bar-replay-45933/)、[方案](https://www.tradingview.com/pricing/)。

- 核对结论：Replay Trading 有历史订单、图上 SL/TP、统计和导出；其结果保留限制针对这个模式。普通 Paper Trading 的实时成交不能扩写为“不支持历史交易”。
- 对应设计：会话找回、成交定位、风险预览与历史起点。
- 限制：数据深度和方案可能变化；没有验证成交精度、恢复性能或离线可用性。

### R02 FX Replay：日志关联交易，保留条件不能省略

**机构 / 类型：FX Replay，产品介绍、定价与官方帮助。** [Backtest](https://fxreplay.com/backtest)、[Pricing](https://fxreplay.com/pricing)、[交易记录](https://support.fxreplay.com/articles/trades-and-logging)、[图上 SL/TP](https://support.fxreplay.com/articles/how-to-drag-and-place-stop-loss-take-profit-on-the-chart)。

- 核对结论：历史练习与日志、清单和分析关联，图上风险可以表达金额、点数和比例；不同方案有不同保留条件。
- 对应设计：可选事前计划、成交图表入口、每 pip 金额。
- 限制：不能承诺其账号数据永远保存，不能把 AI 或行为分析介绍当有效性证据；未实测多图和回退。

### R03 Forex Tester Desktop：完整项目及离线续练

**机构 / 类型：Forex Tester，桌面版官方功能、项目指南与 FAQ。** [功能](https://desktop.forextester.com/features)、[项目](https://desktop.forextester.com/projects)、[FAQ](https://desktop.forextester.com/faq)、[Quick Start](https://desktop.forextester.com/quickstart)。

- 核对结论：项目保存订单、图表和测试状态，支持离线练习；数据下载另需网络。存在多周期、风险定仓和前进限定选项。
- 对应设计：区别恢复和重开、完整备份、历史预热和未见片段检验。
- 限制：FAQ 涉及多个版本，试用与完整版本条件不同；未安装验证。本项目不能仅靠“离线”宣称领先。

### R04 Forex Tester Online：信心、盲练与退出优化已有产品提供

**机构 / 类型：Forex Tester，当前官网与发布说明。** [在线产品](https://forextester.com/)。

- 核对结论：当前介绍含同步多图、隐藏品种/日期、信心、清单和笔记；页面日志与退出优化更新分别标注 2025-12-22、2026-01-27。
- 对应设计：将信心、盲练和事前计划定位为训练机制；退出对照必须区分事后解释与未见检验。
- 限制：功能介绍不是学习效果或执行精度测评；隐藏界面日期不能对本机用户提供严格考试防作弊保证。

### R05 Soft4FX：明确暂停触发和风险数量

**机构 / 类型：Soft4FX，官方功能、方案与手册。** [功能](https://soft4fx.com/)、[方案](https://soft4fx.com/pricing.php)、[MT4 手册](https://soft4fx.com/tutorials-mt4.php)。

- 核对结论：有多周期、部分平仓、自动订单、成交触发暂停、统计和文件续练；依赖 MT4/MT5，demo 保存能力受限。
- 对应设计：风险预览、关键结果后暂停解释，以及完整恢复。
- 限制：MT4/MT5 能力不同；没有实际检查纯断网许可行为。更丰富的订单不能直接移植到本项目的 M1 末组报价规则。

### R06 Trading Game：概念后接具体图表任务

**机构 / 类型：Trading Game，官方帮助，所核对页面标注 2026-09-16 更新。** [学院](https://support.tradinggame.com/articles/trading-academy.html)、[Pattern Trainer](https://support.tradinggame.com/articles/pattern-trainer.html)、[Copy to Chart](https://support.tradinggame.com/articles/copy-to-chart.html)、[SL/TP](https://support.tradinggame.com/articles/advanced-order-types.html)、[AI Coach](https://support.tradinggame.com/articles/ai-trading-coach.html)。

- 核对结论：官方描述短知识、图形概念练习、带回模拟图表和 AI 辅助；图表短题不是尚无同类产品的创新。
- 对应设计：可跳过首用、报价与盈亏固定练习、另一组未见例题验证理解。
- 限制：课程和训练器存在，不证明学会交易或提高实盘收益；不移植排行榜、高杠杆激励或付费课程体系。

### R07 Traders Gym：免费也有账户资格

**机构 / 类型：ThinkMarkets，官方教学与帮助。** [2026-06-19 指南](https://www.thinkmarkets.com/en/trading-academy/thinktrader/what-is-backtesting-and-how-does-traders-gym-work/)、[账户资格](https://www.thinkmarkets.com/uk/help-centre/platforms-and-tools/)、[保存介绍](https://www.thinkmarkets.com/latam/traders-gym/)。

- 核对结论：官方介绍历史日期范围、调速和保存模拟；使用条件涉及已批准真实 ThinkTrader 账户，不能只写“无条件免费”。
- 对应设计：保持无注册本机入口，历史起点与保存继续练习清楚区分。
- 限制：地区与资格信息可能不同；未实测保存原子性、多周期同步或离线。

### R08 FX Blue：多周期也可能泄露未来

**机构 / 类型：FX Blue，官方产品与用户指南。** [产品](https://www.fxblue.com/tools-for-download/fx-blue-trading-simulator)、[注册](https://www.fxblue.com/register)、[MT4 用户指南](https://www.fxblue.com/tools-for-download/fx-blue-trading-simulator/user-guide/metaTrader4)。

- 核对结论：注册工具依赖 MetaTrader；MT4 指南 9.3 提醒某些视觉回测多周期指标可能读取未来高周期收盘信息。
- 对应设计：M5/H1 仅聚合已推进 M1；当前高周期柱逐步更新，不能读取完整未来 OHLC。
- 限制：不能据此说所有多周期回测都会泄露；MT5 指南部分平台说明可能滞后，未当作当前平台缺陷。

## 2. 存储、恢复与性能

### R09 IndexedDB：事务完成和永久保存是不同问题

**机构 / 类型：W3C，IndexedDB 3.0 标准草案。** [事务生命周期](https://www.w3.org/TR/IndexedDB/#transaction-lifecycle)、[调度](https://www.w3.org/TR/IndexedDB/#transaction-scheduling)、[事务与 durability](https://www.w3.org/TR/IndexedDB/#transaction-concept)。

- 核对结论：事务有 active/inactive 生命周期，abort 回滚该事务变更；覆盖相关 stores 的同一读取事务可取得一致视图，complete 才表示提交。耐久性提示与原子性不能保证数据永久存在。
- 对应设计：备份一致读视图，恢复先验证再提交，取消语义，多窗口切换。
- 限制：所查 3.0 页面是 Working Draft，不能写成正式 Recommendation；严格耐久性有兼容与性能代价，仍需外部备份。

### R10 存储世代、变化与配额

**机构 / 类型：WHATWG 存储标准、Mozilla 浏览器文档。** [Storage Standard](https://storage.spec.whatwg.org/)、[配额与清理](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)。

- 核对结论：默认 best-effort，持久存储批准取决于浏览器，估算容量不保证下一次写入成功；用户仍可清除站点数据。
- 对应设计：容量与状态反馈、主动备份、超配额失败保留原库；世代与业务变化序号是本项目并发设计，不能冒称平台自动提供。
- 限制：常访问站点的自动淘汰通常少见，不夸大为即将丢失；不同浏览器策略仍需实际检查。

### R11 结构化克隆：不能携带原验证身份

**机构 / 类型：Mozilla，结构化克隆文档。** [Structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)。

- 核对结论：对象克隆不原样保留属性描述符和原型链；私有对象身份不会变成跨线程可信凭证。
- 对应设计：当前 `historySource` 的 WeakSet 与冻结仅对已验证对象有效，数据库/Worker 新对象要通过受控验证路径。
- 限制：这是平台行为与源码结合后的判断；不能靠外来布尔标志或哈希给来源认证。

### R12 Worker：减轻主线程，不免费消除复制与校验

**机构 / 类型：Mozilla，Web Workers 官方文档。** [Using web workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)。

- 核对结论：Worker 可处理计算和使用 IndexedDB；普通消息常复制对象，可转移资源才适用 transfer。当前普通数据集对象不能整体作为 ArrayBuffer 转移。
- 对应设计：先减少重复工作再测量；必要时明确数据所有者、受控响应、取消和验证身份。
- 限制：工作线程不保证内存更低或总时间更短；不为少量文件先建通用 RPC 层。

### R13 OPFS 与用户文件的定位

**机构 / 类型：Mozilla、Chrome，文件系统文档。** [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)。

- 核对结论：OPFS 仍有 origin 配额且可随站点数据清理，不是用户可见外部备份；修改用户文件涉及权限与用户操作，权限可能不跨会话保留。
- 对应设计：首批普通下载/文件选择，按实测再评估流式或指定文件增强。
- 限制：不能把换 OPFS 当作数据永不丢失的修补；兼容与权限生命周期需另验收。

### R14 统计口径与可复现条件

**机构 / 类型：本项目静态源码与隔离运行证据。** [账户计算](../src/engine/account.ts)、[账本重建](../src/storage/sessionSnapshot.ts)、[历史状态校验](../src/storage/historicalSessionSnapshot.ts)、[问题登记](../overview/06-repair-and-optimization-plan.md)。

- 核对结论：成交数组只记录已平仓结果；权益过程需要行情与持仓操作共同重建。行情窗口有界，不代表成交数组的复制和整头写入成本有界。
- 对应设计：余额/权益回撤分开；分钟可平仓报价下的浮盈/浮亏；性能测量包含大量成交。
- 限制：当前没有这些统计功能，不能将拟议统计写成已验证。Bid OHLC 不能单独证明做空 Ask 的分钟内最大风险。

## 3. 执行、样本与学习

### R15 OHLC 成交依赖假设，低周期也不等于真实执行

**机构 / 类型：TradingView，Pine Script 官方文档及帮助。** [策略 broker emulator](https://www.tradingview.com/pine-script-docs/concepts/strategies/)、[Bar Magnifier](https://www.tradingview.com/support/solutions/43000669285-what-is-bar-magnifier-backtesting-mode/)。

- 核对结论：策略回测器默认需要对柱内路径作假设；使用更低周期可以减少部分粗粒度假设，跳空成交仍需明确规则。
- 对应设计：自动 SL/TP 前先定义分钟末组、OHLC 假设或更细双边数据的选择；双触发与缺口不能凭收益更高的顺序结算。
- 限制：资料描述 Pine 策略回测器，不是本项目或所有 TradingView Replay Trading 的执行规则；不直接抄作真实市场事实。

### R16 模拟结果不能推导真实表现

**机构 / 类型：美国 CFTC，交易系统投资者教育资料。** [Commodity Trading Systems Sold on the Internet](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/fraudadv_tradingsystem.html)。

- 核对结论：假设交易结果可能没有充分反映流动性、执行成本和承受损失条件，历史假设不能证明未来收益。
- 对应设计：训练报价、真实历史和成交规则分开；结果解释不宣称实盘效果。
- 限制：美国商品交易系统教育资料不直接确定本个人项目的法律义务，不引入无需求的合规流程或照搬法律声明。

### R17 时间序列评估只能使用目标时点之前的信息

**机构 / 类型：Hyndman、Athanasopoulos，作者教材。** [Forecasting: Principles and Practice，Time series cross-validation](https://otexts.com/fpp3/tscv.html)。

- 核对结论：滚动预测起点评估用过去训练、后来观察作测试；不能在训练中读取目标之后的信息。
- 对应设计：参数校准按完整时间片段划分；练习和未见片段检验分别标记。
- 限制：这是预测验证方法，不证明某交易策略或本项目练习有效；同一片段反复调参会破坏未见状态。

### R18 反复选择历史最优方案会产生过拟合

**机构 / 类型：Bailey、Borwein、López de Prado、Zhu，作者公开原研究，所查版本标注 2015-02。** [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)。

- 核对结论：反复搜索同一历史数据上的最佳方案会产生假发现；简单 hold-out 也不自动解决投资回测中的多重选择问题。
- 对应设计：记录调参尝试、冻结规则、避免把退出优化或同片段重练成绩当泛化证据。
- 限制：研究针对策略选择与概率评估；首批不实现 CSCV 或报告本项目的 PBO 数值，也不声称仅划分样本已解决过拟合。

### R19 决策评价可能受到已知结果影响

**机构 / 类型：Baron、Hershey，原研究，Journal of Personality and Social Psychology，1988；大学托管原文。** [Outcome Bias in Decision Evaluation](https://bear.warrington.ufl.edu/brenner/mar7588/Papers/baron-hershey-jpsp1988.pdf)。

- 核对结论：医疗与金钱情景实验中，结果好坏会影响人们对决策思考质量的评价，即使决策时信息相同。
- 对应设计：保存事前理由、分别呈现计划执行和盈亏，不只按赚钱评分。
- 限制：参与者与情景不是外汇交易训练；它支持需要研究的问题，不证明增加备注就能消除偏差或改善实盘决策。

### R20 提取练习支持概念教学，迁移仍需验证

**机构 / 类型：Karpicke、Blunt，原研究，Science，2011，作者实验室公开原文。** [Retrieval practice produces more learning than elaborative studying with concept mapping](https://learninglab.psych.purdue.edu/downloads/2011/2011_Karpicke_Blunt_Science.pdf)。

- 核对结论：研究在科学文本学习与理解测试中比较学习方式，提取练习体现优势。
- 对应设计：先解释，再让用户独立回答报价/盈亏问题，随后给反馈；用另一组等难度题检查迁移。
- 限制：不能据此证明本项目图表任务提高交易能力；个人试用只能报告自身理解与操作体验。

### R21 可访问性：画布标签不能代替全部功能

**机构 / 类型：W3C WAI，WCAG 2.2 标准解释。** [Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)、[Non-text Content](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html)、[Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)。

- 核对结论：指针功能应有键盘等价途径，图表需能表达等价信息；页面重排、文字放大和浏览器缩放是相关但不同的检查。
- 对应设计：逐根读数、已发生行情表、焦点返回、窄屏与真实缩放。
- 限制：Understanding 文档用于解释，不等于规范正文；复杂图形有例外，不能把一次自动检测或 CSS 字号翻倍当完整符合性证明。

## 4. 研究到计划的映射

| 结论 | 采用方式 | 保留的边界 |
| --- | --- | --- |
| 项目恢复与备份比增加指标更直接解决记录利用 | 会话列表、专用激活、自包含文件、校验后原子恢复 | 旧数据不覆盖；未知版本、缺源和冲突明确失败 |
| 交易需要解释风险和过程 | 事前计划、假设退出预览、成交定位、少量基础统计 | 可跳过；只复用引擎规则；统计范围和样本数明确 |
| 多周期提高观察效率，也带来未来信息风险 | 只从已推进 M1 按时间聚合 M5/H1 | 不改变成交粒度，不使用未完成未来高周期全柱 |
| 大历史需要测量实际浏览器成本 | 先重复读取/摘要修补，再分批/Worker，最后才考虑分块格式 | 不删数据、不绕过验证，不把隔离 Node 计时当验收 |
| 产品已有信心、盲练、清单和 AI | 以中文、本地、可解释过程训练的组合做小实验 | 不宣称首创；个人体验、学习迁移和实盘能力分开 |
| 历史校准和训练成绩都容易受样本选择影响 | 合法跨期样本、记录尝试、冻结与未见片段 | 不保证真实复刻、获利、完全不可预测或严密防作弊 |

后续优先核查：目标浏览器大文件与配额表现、完整备份在空白环境的恢复、实际键盘/读屏流程、本人练习负担与理解效果、合法样本覆盖和参数迁移。上述未执行事项继续作为计划，不用官方产品介绍代替本项目验收。
