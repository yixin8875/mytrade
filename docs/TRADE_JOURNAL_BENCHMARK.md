# LuxAlgo trade-journal 对标与 Tally 复盘层方案

> 日期：2026-11-14  
> 对应版本：Tally 0.7.2  
> 对标项目：[LuxAlgo/trade-journal](https://github.com/LuxAlgo/trade-journal)（MIT，TypeScript / Next.js / SQLite）  
> 文档性质：产品 + 技术 + UI 方案，尚未实施  
> 结论先行：**可以加入，而且值得加入；但只加入“复盘与反思层”，不要加入“数据接入层”和“托管/AI 层”。**

---

## 0. 一页结论

LuxAlgo 的 trade-journal 是一个**事后交易日志**：靠券商同步、对账单导入或手工录入拿到成交，再重建回合交易，往上叠加日历、统计、策略、例行、错过机会、AI 反思。Tally 是一个**盘中执行终端**：成交、持仓、风控、截图、MFE/MAE、滑点、复盘会话本来就是系统副产物。

两者最强的部分正好互补：

- LuxAlgo 强在**复盘层的产品完成度**：盈亏日历、日笔记、策略规则遵守度、例行清单、错过机会、稀疏样本的诚实表达。
- Tally 强在**数据完整性与执行上下文**：不依赖导入，交易 100% 自动入库；还有滑点、延迟、MFE/MAE、分批止盈执行、行情回放这些 LuxAlgo 拿不到的数据。

因此建议：**把 LuxAlgo 的“复盘层”拆成 5 个 P0 模块移植进 Tally，并用 Tally 独有的执行数据做出它做不到的分析。** 不引入券商 SDK、行情供应商、16 种导入格式、托管 AI、Prop Firm 账本。

### 建议纳入

| 模块 | 优先级 | 一句话价值 | 预估 |
|---|---|---|---|
| 盈亏日历 + 日详情 | P0 | 把“每天怎么样”变成一眼可见的月度视图 | 5 人日 |
| 日复盘笔记 | P0 | 把“当时的想法”留在交易旁边，可检索、可导出 | 2 人日 |
| 策略手册 + 规则遵守度 | P0 | 从“按标签统计”升级为“按策略规则验证纪律” | 4 人日 |
| 隐私模式 | P0 | 录屏、截图、直播时一键遮蔽金额 | 1 人日 |
| 复盘卡导出（PNG / PDF） | P0 | 一天/一周的复盘可以带走、分享、归档 | 2 人日 |
| 例行清单（盘前/盘中/盘后） | P1 | 把纪律变成每天可打勾的流程 | 4 人日 |
| 错过机会日志 | P1 | 记录“看对了没做”的机会，和回放联动 | 4 人日 |
| 深度筛选 + 交叉分析 | P1 | 从 3 个分组扩展到多维度归因 | 5 人日 |
| 绩效趋势 + 交易散点 | P1 | 看近期是否退化、单笔分布是否健康 | 3 人日 |
| 过程评分（Edge Score 思路） | P2 | 一个透明、可解释的综合分 | 2 人日 |
| AI 复盘（自带 Key） | P2 | 自动生成日/周总结与单笔点评 | 5 人日 |
| 外部历史导入 | P3 | 换平台/换券商时补历史 | 5 人日 |

> 人日按“熟悉本仓库 + AI 辅助”估算，含测试与自测，不含反复打磨 UI 的时间。

### 明确不做

- 券商同步 SDK（Alpaca / Binance / IBKR…）：Tally 只服务 MT5，接入面越大，凭据与安全负担越重。
- 行情数据供应商 / K 线 CSV 上传：Tally 已有 MT5 历史与 M1 数据，重复建设。
- 16 种对账单导入：自动同步已覆盖 MT5；外部历史最多做一个通用 CSV。
- Prop Firm 现金账本：是另一套财务产品，和“交易复盘”不同域。
- Notebook 文件夹、富文本、语音听写：Markdown + 模板足够，先不做。
- 拖拽式仪表盘布局：内容还没到位时，布局定制是负价值。
- 多币种换算：当前按账户货币统计，等真的需要合并多账户再谈。
- 把 Edge Score 做成首页主角：综合分只能做导航，不能做目标。

---

## 1. 调研对象拆解

### 1.1 它是什么

一句话：**一个本地优先、可自托管的交易日志**，把成交记录变成回合交易、日历、统计、日记和反思。

- 数据入口：券商只读同步、16 种对账单导入、手工录入。
- 核心原语：`execution`（一笔成交）；回合交易由 FIFO / LIFO / WAVG 重建。
- 展示层：Dashboard（日历、仪表、Edge Score 雷达、权益曲线、时段表现）、Trade 详情（成交路径、回放、MAE/MFE、评分、规则）、Reports（分组、对比、交叉分析、趋势、散点）、Journal（每日笔记）、Notebook / Playbooks、Progress（例行）、Missed（错过机会）、Prop Firms（现金账本）。
- 技术栈：Next.js 15 + SQLite(Drizzle) + Tailwind + Recharts/ECharts + 自有 Vela 图表；核心引擎与导入器拆成 npm 包，纯函数、无 IO。

### 1.2 架构上最值得注意的三点

1. **一个原语驱动所有页面**：`execution → round trip → 所有视图`。没有第二套“统计表”，避免口径分裂。
2. **计算字段与用户注释分离**：`trades` 表里计算列每次重建都会覆盖，但 `notes / tags / mistakes / playbookId / rating / stopLoss / profitTarget / reviewedAt` 这些用户字段按稳定 key 保留。这样“重新同步”不会丢复盘内容。
3. **核心公式是开放、带版本的**：Edge Score 有 `EDGE_SCORE_VERSION = 2`，阈值和权重写在源码与文档里，改公式就升版本。不是黑盒评分。

### 1.3 功能地图

| 能力 | LuxAlgo 做法 | 对 Tally 的启示 |
|---|---|---|
| 券商同步 | `@luxalgo/broker-sdk`，20+ 家 | 不做。Tally 的 MT5 同步就是优势 |
| 对账单导入 | 16 种格式自动识别 + 列映射 | 不做。最多补一个通用 CSV |
| 回合交易重建 | FIFO / LIFO / WAVG，支持部分成交、加仓、反手、期货乘数 | Tally 已按 `position_id` 配对，够用 |
| 统计 | 净/毛盈亏、胜率、日胜率、盈亏比、期望、R、连胜连亏、回撤、恢复、集中度、时段/星期/品种/标签/错误/策略分组 | 补齐“维度”和“交叉”，不要重写已有汇总 |
| 盈亏日历 | HTML 网格，日盈亏 + 笔数，背景深浅表示幅度，周合计，点击进日详情 | **P0 直接借鉴交互，不搬视觉** |
| 日笔记 | 每日 Markdown、模板、附件、语音、日内盈亏曲线、当日交易 | **P0 做 Markdown + 模板 + 关联回放** |
| 策略手册 | Playbook = 名称 + 规则清单；每笔交易逐条打“遵守/违反”；报表对比遵守与违反的绩效 | **P0，Tally 最缺的一层** |
| 例行清单 | 盘前/盘中/盘后，按星期排期，13 周热力图 | **P1，可和交易台联动** |
| 错过机会 | 独立日志，不进入交易绩效 | **P1，Tally 可用回放和 M1 模拟结果做得更深** |
| 交易详情 | 成交路径图、回放、MAE/MFE、评分、止损/目标、标签、错误 | Tally 已有截图和 MFE/MAE，补“注释与评分” |
| 深度分析 | 多维筛选、对比组、二维交叉矩阵、滚动趋势、散点 | **P1，优先做筛选 + 交叉 + 趋势** |
| Edge Score | 6 个分量、固定权重、0–100、样本 < 5 不给分 | P2，透明公式可借鉴，别当主指标 |
| AI 反思 | 自带 Anthropic/OpenAI Key，日/周总结、单笔点评、问日志 | P2，自带 Key、默认关闭、只发聚合数据 |
| Prop Firm | 评估费、重置、出金、部分到账、现金 ROI | 不做 |
| 隐私模式 | 全局遮蔽金额，图表保留形状 | **P0，成本极低、体验极好** |
| 导出 | 交易 CSV、复盘 PDF/PNG、日志 JSON、整库备份 | Tally 已有 CSV/JSON/备份，补复盘卡 |
| 时间口径 | 显示时区与导入时区分离，日切按日志时区 | **前置项：Tally 必须先统一交易日口径** |

### 1.4 五个值得学的设计决策

1. **诚实表达稀疏样本**：少于 5 笔不给 Edge Score；少于 20 笔不画滚动线；少于 8 点不画散点，改用精确值表格；小样本明确标注。  
   → Tally 的复盘层应继承这条：**没有样本就说没有，不画一条“参考线”假装有基准。**
2. **金额与形状分开编码**：日历用背景深浅表达幅度，用正负号和数字表达方向，色盲也能读。  
   → Tally 的暖纸色主题可以直接用 `gain/loss-soft` 做低饱和填充。
3. **注释独立于计算**：重算不会覆盖用户写的东西。  
   → Tally 的 `journal` 表有重建逻辑，**注释必须放独立表**，不能加列。
4. **规则先于统计**：先定义策略规则，再逐笔打勾，最后才谈“遵守时绩效更好”。  
   → 这比“给交易打标签然后按标签统计”更能改变行为。
5. **每个数字都能被解释**：文档写清分母、样本、时间口径、估算边界。  
   → Tally 的报表也要有“口径”提示，尤其是 R 覆盖率和 MFE/MAE 估算。

### 1.5 它的弱点与边界（也是 Tally 的机会）

- **数据完整性依赖外部**：券商同步有历史窗口限制，导入格式随券商变化，手工录入容易漏。Tally 的日志是成交后自动配对，天然完整。
- **执行上下文弱**：没有点差、滑点、成交延迟、分批止盈执行、强平估算。Tally 都有。
- **回放与复盘割裂**：LuxAlgo 的 replay 是“围绕单笔已平仓交易看历史 K 线”；Tally 的复盘会话是“在历史行情里重新做一遍决策”，更接近刻意练习。
- **策略遵守度只有“是/否”**：Tally 可以把规则检查与 R、MFE 捕获率、模板执行结合，回答“遵守了是否真的更赚”。

---

## 2. Tally 现状

### 2.1 已有能力（和本方案相关的部分）

| 能力 | 现状 | 位置 |
|---|---|---|
| 自动交易日志 | 平仓后按 `position_id` 配对成交，写 `journal` 表 | `gateway/journal.py` |
| 净盈亏口径 | `profit` 已含 `profit + swap + commission + fee` | `gateway/journal.py:sync` |
| MFE / MAE | 持仓期间 M1 高低点折算 | `gateway/journal.py:_excursion` |
| R 折算 | 订单止损 → 持仓期记录 → 下单意图 → 存档，四级来源 | `gateway/journal.py:_risk_detail` |
| 标签 | `journal.tag` 可改，按标签统计 | `src/views/Journal.tsx` |
| 截图 | 平仓后自动截当前图表，按账户分目录 | `gateway/data/shots/<login>/` |
| 统计报表 | 区间汇总、盈亏/R 曲线、模板执行、执行交叉、4 个分组 | `src/views/Reports.tsx` |
| 执行质量 | 点差、滑点、延迟 P50/P90、拒单原因 | `src/views/Executions.tsx` |
| 复盘会话 | 历史行情里模拟交易，有订单、笔记、R 分布、报告、CSV | `src/replay/` |
| 多账户 | 日志/统计/告警按 `login` 隔离 | `gateway/store.py` |
| 导出/备份 | CSV/JSON、整库 zip | `src/lib/dataExport.ts`、`gateway/exporter.py` |
| 审计 | 下单/改单/对账 JSONL | `gateway/audit/` |

### 2.2 差距矩阵

| 能力 | LuxAlgo | Tally 现状 | 结论 |
|---|---|---|---|
| 盈亏日历 | ✅ 月网格 + 周合计 + 日详情 | ❌ 只有累计曲线 | **补** |
| 日复盘笔记 | ✅ Markdown + 模板 + 附件 + 语音 | ❌ 只有单笔标签 | **补（不含语音/附件）** |
| 策略手册 | ✅ 规则清单 + 逐笔打勾 + 遵守度报表 | ⚠️ 只有“标签”，没有规则 | **补** |
| 例行清单 | ✅ 盘前/盘中/盘后 + 13 周热力 | ❌ | **补** |
| 错过机会 | ✅ 独立日志 | ❌ | **补** |
| 多维筛选 | ✅ 30+ 过滤条件 | ⚠️ 只有区间 + 账户 | **补核心子集** |
| 交叉分析 | ✅ 二维矩阵 + 对比组 | ❌ | **补** |
| 滚动趋势 | ✅ 20 笔滚动胜率/均值 | ❌ | **补** |
| 交易散点 | ✅ 时长/时段 × 盈亏/R | ❌ | **补** |
| MFE/MAE | ⚠️ 依赖行情供应商估算 | ✅ 持仓期实测 | **Tally 更强，做深** |
| 滑点/延迟 | ❌ | ✅ | **Tally 独有** |
| 分批止盈执行 | ❌ | ✅ 模板阶段统计 | **Tally 独有** |
| 回放 | ⚠️ 单笔路径回放 | ✅ 完整复盘会话 | **Tally 更强，做联动** |
| Edge Score | ✅ 开放公式 | ❌ | 可选 |
| AI 反思 | ✅ 自带 Key | ❌ | 可选，靠后 |
| 隐私模式 | ✅ | ❌ | **补，成本最低** |
| 复盘导出 | ✅ PDF/PNG | ⚠️ CSV/JSON | **补 PNG/PDF** |
| Prop Firm | ✅ | ❌ | 不做 |
| 券商同步/导入 | ✅ | ❌（也不需要） | 不做 |

### 2.3 Tally 的独有数据资产

这些是 LuxAlgo 拿不到、也不该去补的：

1. **成交级执行质量**：请求价、成交价、点差、滑点、延迟、retcode。
2. **持仓期路径**：MFE / MAE、到达 1R 的比例、持仓时长。
3. **模板执行**：分批止盈阶段是否按计划执行、每次减仓的价格与 R。
4. **风控上下文**：当日亏损额度、连亏冷却、开仓次数、是否急停。
5. **复盘会话**：在历史行情里重新做决策的完整订单、笔记、R 分布。
6. **图表截图 + 坐标元数据**：平仓瞬间的图，不只是价格。

复盘层应该围绕这 6 项设计，而不是复刻一个通用交易日志。

### 2.4 结论：做“复盘层”，不做“数据接入层”

```
┌─────────────────────────────────────────────────────────┐
│  Tally 现有：执行层                                      │
│  图表 / 下单 / 风控 / 持仓 / 告警 / 日历事件 / 审计       │
└───────────────────────┬─────────────────────────────────┘
                        │ 自动成交、持仓路径、执行质量
┌───────────────────────▼─────────────────────────────────┐
│  新增：复盘层（只读交易数据 + 写注释/规则）               │
│  日历 / 日记 / 策略 / 例行 / 错过 / 分析 / 导出           │
└───────────────────────┬─────────────────────────────────┘
                        │ 只读引用
┌───────────────────────▼─────────────────────────────────┐
│  现有：复盘会话（历史行情里重做决策）                     │
└─────────────────────────────────────────────────────────┘
```

边界纪律：

- 复盘层**不参与下单决策**。唯一例外是 P1 的“盘前清单未完成”提示，默认软提示，硬闸门必须显式开启。
- 复盘层的写入只发生在 `day_notes / trade_notes / playbooks / playbook_checks / routines / routine_checks / missed_trades`，不改 `journal` 计算列。
- 所有新数据本地 SQLite，不出网；AI 是 P2 且默认关闭。

---

## 3. 功能取舍

### 3.1 评分口径

- **价值**：对“减少重复错误、提高复盘频率、发现优势”的直接帮助（1–5）。
- **成本**：开发 + 测试 + 后续维护（1–5，5 最高）。
- **风险**：数据口径错误、性能、隐私、误导演示（1–5，5 最高）。
- **优先级**：P0 = 本轮做；P1 = 下一轮；P2 = 观察后再定；P3 = 暂不做。

### 3.2 优先级清单

| 功能 | 价值 | 成本 | 风险 | 结论 | 理由 |
|---|---:|---:|---:|---|---|
| 盈亏日历 + 日详情 | 5 | 2 | 1 | **P0** | 数据已有，只差视图；每天都会看 |
| 日复盘笔记 | 5 | 2 | 1 | **P0** | 复盘的载体；和日历天然一体 |
| 策略手册 + 规则遵守度 | 5 | 3 | 1 | **P0** | 从“标签统计”升级为“纪律验证” |
| 隐私模式 | 4 | 1 | 1 | **P0** | 一小时级改动，录屏/分享刚需 |
| 复盘卡导出 | 4 | 2 | 2 | **P0** | 让复盘可带走；PNG 先行 |
| 例行清单 | 4 | 3 | 2 | **P1** | 行为改变强，但需要交易台配合 |
| 错过机会 | 4 | 3 | 2 | **P1** | Tally 可用 M1 模拟结果，价值高于原版 |
| 深度筛选 + 交叉分析 | 5 | 4 | 2 | **P1** | 现有报表维度太少；但工作量大 |
| 绩效趋势 + 散点 | 4 | 2 | 2 | **P1** | 纯前端计算，复用现有数据 |
| 过程评分 | 3 | 2 | 3 | **P2** | 容易被当成目标；公式必须透明 |
| AI 复盘 | 3 | 4 | 4 | **P2** | 成本/隐私/中文质量都不确定 |
| 外部历史导入 | 2 | 3 | 2 | **P3** | 只有换平台才需要 |
| 富文本/附件/语音 | 2 | 3 | 1 | **P3** | Markdown 够用 |
| Prop Firm 账本 | 2 | 4 | 2 | **P3** | 另一套产品 |

### 3.3 路线图

**P0（约 14 人日）**

1. 统一交易日口径（前置，1–2 人日）
2. 日历接口 + 日历页 + 日详情（5 人日）
3. 日笔记 + 模板（2 人日）
4. 策略手册 + 规则检查 + 遵守度（4 人日）
5. 隐私模式（1 人日）
6. 复盘卡 PNG（2 人日）

**P1（约 16 人日）**

1. 例行清单 + 13 周热力 + 盘前提示（4 人日）
2. 错过机会 + 模拟结果 + 回放联动（4 人日）
3. 深度筛选 + 交叉分析（5 人日）
4. 滚动趋势 + 散点（3 人日）

**P2（观察后再定）**

- 过程评分（2 人日）
- AI 复盘（5 人日）
- PDF 导出、附件、富文本（3–5 人日）

---

## 4. 产品需求

### 4.1 盈亏日历（P0）

#### 用户故事

> 作为一名日内交易者，我想在一个月视图里看到每天的盈亏、笔数和周合计，点某一天就能看到那天的交易和笔记，这样我能快速发现“哪几天、哪一周在漏钱”。

#### 页面结构

- 顶部：月份切换、月份汇总（净盈亏、交易日、胜率、累计 R）、导出按钮、隐私开关。
- 主体：7 列日历（周一开始），每格显示日期、净盈亏、笔数；无交易的日子留空；今天有描边。
- 右侧/下方：选中日详情（默认今天或本月最后一个交易日）。
- 周合计列：该周 7 天的合计；如果包含相邻月份的日子，在数字右上角加一个小点，hover 说明。

#### 规则

- **日归属**：按平仓时间 `close_time`，折算到复盘时区后的日期。跨午夜持仓算平仓日。
- **净盈亏**：直接用 `journal.profit`（已含 swap/commission/fee），**不要再次相加**。
- **胜/负/平**：`net > +breakeven` 为胜，`net < -breakeven` 为负，其余为平。默认 `breakeven = max(0.01, 账户余额 × 0.0002)`，可在复盘设置里改为按 R（有风险数据时用 `0.05R`）。
- **周合计**：按自然周（周一–周日）汇总全部 7 天，不只汇总本月可见日。
- **多账户**：默认只看当前账户；日历顶部提供“本账户 / 全部账户”，全部账户只在币种一致时合并金额，否则只合并笔数。
- **空月**：显示“本月还没有已平仓交易”，不画 0 值网格。
- **样本说明**：少于 5 个交易日时，不显示“胜率”结论，只显示计数。

#### 验收

- 月末/月初跨月交易归属正确。
- 夏令时切换、服务器时区偏移不会把交易分到错误日期。
- 同一笔交易不会在两天重复出现。
- 无交易月份、只有 1 天、全部亏损、全部盈利四种形态都不出现 NaN/Infinity。
- 点击某天，日详情与该天交易列表完全一致。

### 4.2 日复盘笔记（P0）

#### 用户故事

> 我想在收盘后花三分钟写下“今天做对了什么、做错了什么、明天注意什么”，并且下次翻到这一天时能直接看到。

#### 结构

- 每天一条笔记，字段：`note`（Markdown）、`mood`（1–5，可选）、`tags`（可选）、`replay_session_id`（可选）。
- 编辑器：纯文本 textarea + 预览切换；顶部模板下拉（默认提供“盘前计划 / 盘后复盘 / 错误复盘”三个模板）。
- 自动保存：输入停止 800ms 后保存；显示“已保存 / 保存中 / 保存失败”。
- 与交易的关系：只读展示当天交易；点击某笔跳到交易日志对应行或截图。
- 与回放的关系：可以把某次复盘会话挂到当天；日详情显示“本次复盘 +2.4R，5 笔”。

#### 规则

- 笔记按 `(login, day)` 唯一；切换账户不会串。
- 模板可增删改；模板内容不自动覆盖已有笔记，只有用户点击“套用模板”才插入。
- 笔记只存本地；导出复盘卡时可选择是否包含笔记。
- 不做富文本、不做附件、不做语音（P3 再议）。

#### 验收

- 刷新、重启、切换账户后笔记仍在。
- 快速切换日期不会把 A 日内容写到 B 日（请求带日期，保存前校验当前日期）。
- 保存失败有明确提示，且保留输入内容。

### 4.3 策略手册与规则遵守度（P0）

#### 用户故事

> 我有三套做法：突破、回踩、逆势。我想为每套写下 4–6 条规则，交易后逐条打勾，然后看“遵守规则时”和“违反规则时”的绩效差多少。

#### 概念

- **策略手册（Playbook）**：名称、说明、规则列表（字符串数组）。
- **交易注释（trade note）**：某笔交易属于哪个策略，评分 1–5，错误标签（如“追单 / 提前入场 / 移动止损”），自由备注。
- **规则检查（rule check）**：某笔交易 × 某条规则 = 遵守 / 违反 / 未评估。
- **遵守度（adherence）**：只在已平仓交易上统计；一笔交易“完全遵守”= 所有规则都打了勾；“违反”= 任意一条违反；其余为“未评估”。

#### 页面

- 策略列表：卡片显示名称、规则数、关联交易数、遵守率、遵守 vs 违反的净盈亏/R。
- 新建/编辑弹窗：名称、说明、规则（一行一条）。
- 策略详情抽屉：规则清单、遵守度条形、最近交易、逐条规则的遵守率。
- 交易侧：在交易日志行展开或详情抽屉里选择策略、逐条打勾、评分、错误标签、备注。

#### 规则

- 一个交易只能属于一个策略（简化）。
- 一个策略的规则可以修改；旧检查按规则文本保留，新规则默认“未评估”。
- 删除策略：交易保留，只解除关联；检查记录归档不删。
- 遵守度报表必须显示样本数；任一组少于 5 笔时，不显示“遵守更好/更差”的结论，只显示数字并标注“样本不足”。
- 净盈亏/R 口径与统计报表一致；R 只用有风险数据的交易，显示覆盖率。

#### 验收

- 规则逐条打勾后，策略卡片的遵守率立即更新。
- 修改规则文本后，旧检查不丢失、不误配。
- 删除策略后，交易列表仍能打开，只是不再显示策略。
- 遵守/违反两组的交易数之和 + 未评估数 = 该策略关联的已平仓交易数。

### 4.4 例行清单（P1）

#### 用户故事

> 我想把“看财经日历、检查点差、写下计划、收盘复盘”变成每天可打勾的清单，并看到过去 13 周有没有坚持。

#### 结构

- 三条泳道：盘前 / 盘中 / 盘后。
- 每条例行：标题、阶段、生效星期（默认周一–周五）、排序、归档。
- 当天清单：按星期过滤，打勾即保存。
- 13 周热力图：每格一天的完成率（完成数/应完成数），0 条例行时为空白而不是 100%。
- 可选：交易台顶栏显示“盘前 3/5”，未完成时点开清单；默认不阻止下单。

#### 规则

- 完成率 = 当天已完成的应做例行 / 当天应做的例行；没有应做项 = null。
- 补打卡：允许选过去 7 天补勾，超过 7 天只读。
- 归档例行不影响历史完成率。
- 与交易数据完全独立，不因盈亏变化。

#### 验收

- 星期过滤正确（周一不显示只在周五生效的例行）。
- 13 周网格跨月、跨年正确。
- 归档后历史热力图不变。

### 4.5 错过机会（P1）

#### 用户故事

> 我看到一个 setup 但没做，后来它走成了 3R。我想记下来，既不污染我的交易绩效，又能在周末回看“我到底错过了什么”。

#### 结构

- 列表：观察时间、品种、方向、计划入场/止损/目标、策略、备注、截图、模拟结果。
- 新建：可从交易台顶栏“记录错过”打开，自动带入当前品种、当前价、图表截图；可从复盘会话“记录错过”带入会话。
- 模拟结果：网关用观察时间之后的 M1 数据，按计划入场/止损/目标走一遍，给出“先到止损 / 先到目标 / 未触发”、理论 R、MFE/MAE、耗时。
- 与回放联动：一键用该时间段创建复盘会话（预填品种、时间、方向）。

#### 规则

- 错过机会**不进入**任何交易绩效、日历、胜率、R 统计。
- 模拟结果标注“理论值，不含点差/滑点/手续费”，不显示为真实盈亏。
- 同一根 M1 同时触及止损和目标时，**按先到止损**处理（保守）。
- 入场：有计划入场价时按限价触发；没有时按观察价市价入场。
- 观察窗口默认 3 个交易日或 5000 根 M1，取先到者；超出窗口标记“未结束”。

#### 验收

- 模拟结果与手动核对一致（至少 5 个固定样本）。
- 周末/休市时间段不会误判触发。
- 删除/归档不影响统计。

### 4.6 深度筛选与交叉分析（P1）

#### 用户故事

> 我想问：“周二上午 9–11 点、持有 15 分钟以内、R 在 -1 到 0 之间的突破单，到底赚不赚？”现在的报表回答不了。

#### 筛选条件（P1 核心子集）

- 时间：区间、入场小时、星期。
- 交易：品种、方向、策略、标签、错误标签、出场方式（止损/止盈/手动/强平）。
- 结果：净盈亏区间、R 区间、持仓时长区间。
- 执行：滑点区间、MFE 捕获率区间（Tally 独有）。
- 账户：当前账户 / 指定账户。

#### 分组维度

品种、策略、标签、错误、方向、小时、星期、持仓时长桶、R 桶、出场方式、时段（亚/欧/美）、MFE 捕获率桶。

#### 交叉分析

- 两个维度做矩阵：行 × 列，单元格显示净盈亏、R、笔数。
- 单元格少于 3 笔时用弱化样式并标样本数；不隐藏，避免“看起来全是空白”。
- 点击单元格下钻到交易列表，筛选条件保留。

#### 规则

- 所有筛选参数白名单化，禁止把字段名直接拼进 SQL。
- 结果集上限 5000 笔；超过时提示缩小范围，不静默截断。
- 金额与 R 分开展示；没有风险数据的交易不参与 R 统计，但参与金额统计。
- 混合账户/币种时只合并笔数与比率，不合并金额。

#### 验收

- 每个筛选条件的组合都能在交易列表里复现同样的结果。
- 交叉矩阵的行合计、列合计与总汇总一致。
- 空结果、单格结果、全零结果都不出现 NaN。

### 4.7 绩效趋势与交易散点（P1）

#### 滚动趋势

- 20 笔滚动胜率、20 笔滚动平均净盈亏、20 笔滚动平均 R。
- 少于 27 笔不画线，显示“还差 N 笔”进度；27–? 显示最新窗口数值；≥ 27 才画线。
- 参考线只用“当前筛选区间的全样本均值”，不引入外部基准。

#### 散点

- X：持仓时长（分钟）或入场小时；Y：净盈亏或 R。
- 点大小固定，颜色只表示正负；点击点打开交易详情/截图。
- 少于 8 个可比点时不画散点，改用精确值表格。
- 不做回归线，不暗示因果。

#### 验收

- 滚动窗口边界（第 20、27 笔）行为正确。
- 散点与表格数据一一对应。
- 隐私模式下金额轴和 tooltip 被遮蔽。

### 4.8 复盘卡导出（P0）

#### 目标

把“某一天”或“某一周”的复盘导出为一张可保存、可分享的卡片。

#### 内容

- 标题：日期 / 周区间、账户别名（不含登录号）。
- 汇总：净盈亏、笔数、胜率、平均 R、累计 R、最大回撤（当日）。
- 当日交易：最多 6 笔，品种/方向/盈亏/R/出场方式。
- 笔记摘要：前 400 字。
- 图表截图：如果当天有截图，取最后一笔；没有则留白。
- 页脚：Tally 版本、导出时间、“由 Tally 生成”。

#### 形式

- P0：PNG（前端 canvas / `html-to-image`，2x 像素密度）。
- P2 落地：画布 → JPEG → 单页 PDF（`src/lib/pdf.ts`，约 150 行、无第三方依赖）。中文在画布里已经栅格化，PDF 只是一张位图，所以不依赖查看端字体，也不会出现缺字方框。
- 隐私模式开启时：导出默认遮蔽金额，用户可显式选择“包含金额”。

#### 验收

- 中文、emoji、长笔记不溢出、不截断关键数字。
- 深色/浅色主题导出都清晰；导出图使用浅色底（便于分享）。
- 不含账户号、服务器、密码、API Key。

### 4.9 隐私模式（P0）

- 位置：左侧栏底部、设置页、导出弹窗。
- 行为：全局遮蔽所有金额（余额、净值、盈亏、价格、R 金额、图表坐标轴金额），保留形状和正负色。
- 持久化：`localStorage["mytrade.privacy"]`，跨页面、跨重启保持。
- 默认关闭；首次打开录屏/分享场景由用户手动开。
- 不遮蔽：笔数、胜率、R 倍数（R 是相对值，通常不敏感；可在设置里选择是否遮蔽）。
- 导出：默认跟随隐私模式；导出前二次确认。
- 验收：所有页面无漏网金额；图表 tooltip、表格、卡片、弹窗、导出都覆盖。

### 4.10 可选：过程评分（P2）

不建议直接搬 Edge Score，因为它的 6 个分量是为“股票/期货多品种日志”校准的。若要做，改成 Tally 口径并明确版本：

- 样本 ≥ 20 笔才给分；< 20 显示“样本不足”。
- 分量：期望 R、胜率、盈亏比、R 回撤、恢复因子、日集中度、规则遵守率（有策略时）。
- 每个分量 0–100，权重固定，公式写在文档与设置页“评分说明”里。
- 首页只作为一个小卡片，不替代净盈亏/R 汇总。
- 版本号 `TALLY_SCORE_VERSION`，改公式升版本。

### 4.11 可选：AI 复盘（P2）

如果未来要做，边界先定死：

- 自带 Key（Anthropic / OpenAI / OpenAI 兼容），Key 用 DPAPI 或本地密钥加密，不回传前端。
- 默认关闭；每次请求前显示“将发送哪些字段”。
- 只发聚合数据与用户主动选中的笔记，不发截图、账户号、服务器。
- 输出只作为“建议”，不写回交易数据，不自动执行。
- 中文 prompt 单独调优；没有 Key 时功能完全不可见。

---

## 5. 技术方案

### 5.1 架构落点

```
React (src/views, src/components)
  ├─ Diary.tsx            日历 + 日详情
  ├─ Strategy.tsx         策略 / 例行 / 错过（tabs）
  ├─ Reports.tsx          增加 筛选 / 交叉 / 趋势 / 散点
  └─ components/review/*  日历、笔记、规则、遵守度、热力、导出
        │  gateway.call(method, params)
        ▼
Python Gateway (gateway/)
  ├─ mt5_worker.py        注册 RPC handler
  ├─ review.py            新增：日历、笔记、策略、例行、错过、分析
  ├─ store.py             新增表与 CRUD、迁移
  ├─ journal.py           只读查询，不改计算逻辑
  └─ tests/test_review.py 新增
        │
        ▼
SQLite (%LOCALAPPDATA%\MyTrade\gateway\data\...)
  journal（只读） + day_notes / playbooks / trade_notes / ...（新增）
```

原则：

- **新增一个 `review.py`，不要把逻辑塞进 `journal.py`**。`journal.py` 只负责成交配对与统计。
- **所有新表与 `journal` 解耦**，不建外键。`journal` 可能重建，注释不能跟着没。
- **RPC 命名空间**：`diary.*`、`strategy.*`、`routine.*`、`missed.*`、`analytics.*`，避免和现有 `journal.*` 混在一起。
- **前端不直接算统计**：日历、遵守度、模拟结果都在网关算，前端只负责展示。趋势/散点可以在前端算，因为数据已经在手。

### 5.2 时间口径（前置任务，必须先做）

这是整个复盘层的地基，做错会导致日历、星期、时段分析全部错位。

现状：

- `journal.open_time / close_time` 直接存 MT5 `deal.time`（服务器时区的时间戳）。
- 前端用 `new Date(ts * 1000)` 按本机时区渲染。若券商服务器是 UTC+2/+3，而本机是 UTC+8，显示时间会偏移数小时。
- 统计只按“最近 N 天”取数，偏移不影响总量，但**日历按日归属会直接出错**。

方案：

1. 网关在每次同步时计算服务器偏移：
   ```python
   server_offset = int(mt5.symbol_info_tick(symbol).time) - int(time.time())
   ```
   四舍五入到 15 分钟，写入 `state` 表 `mt5_server_offset`。
2. 复盘层统一使用 `utc_ts = raw_ts - server_offset`。
3. 复盘设置里提供“复盘时区”：默认跟随本机，可改为固定 UTC+8 / UTC+0 / 券商服务器时区。
4. 日历的 `day` 用 `utc_ts` + 复盘时区计算；统计报表也逐步切到这个口径（可以先只在新页面用，避免影响旧报表）。
5. 迁移：老数据没有偏移记录时，用当前账户最近一笔 tick 估算一次，并在设置页显示“服务器偏移：+3:00（估算）”。

验收：同一笔交易在交易日志列表和日历日详情里显示的日期一致；跨月、跨夏令时不出错。

### 5.3 数据模型

```sql
-- 复盘设置：复盘时区、日切、盈亏平衡阈值、周起始日
CREATE TABLE IF NOT EXISTS review_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 每天一条复盘笔记
CREATE TABLE IF NOT EXISTS day_notes (
  login INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,                    -- YYYY-MM-DD（复盘时区）
  note TEXT NOT NULL DEFAULT '',
  mood INTEGER,                         -- 1..5，可选
  tags TEXT NOT NULL DEFAULT '[]',      -- JSON array<string>
  replay_session_id TEXT,               -- 关联本地复盘会话（localStorage 会话 id）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (login, day)
);

CREATE TABLE IF NOT EXISTS note_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 策略手册
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,                  -- uuid
  login INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '[]',     -- JSON array<string>
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 单笔交易的复盘注释（与 journal 解耦）
CREATE TABLE IF NOT EXISTS trade_notes (
  login INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  playbook_id TEXT,
  rating INTEGER,                       -- 1..5
  mistakes TEXT NOT NULL DEFAULT '[]',  -- JSON array<string>
  note TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (login, position_id)
);

-- 每笔交易 × 每条规则的检查
CREATE TABLE IF NOT EXISTS playbook_checks (
  login INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  playbook_id TEXT NOT NULL,
  rule TEXT NOT NULL,                   -- 规则原文，改规则不覆盖历史
  followed INTEGER NOT NULL,            -- 0/1
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (login, position_id, rule)
);

-- 例行清单
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  login INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  stage TEXT NOT NULL,                  -- before | during | after
  weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_checks (
  routine_id TEXT NOT NULL,
  day TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (routine_id, day)
);

-- 错过机会
CREATE TABLE IF NOT EXISTS missed_trades (
  id TEXT PRIMARY KEY,
  login INTEGER NOT NULL DEFAULT 0,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,                   -- buy | sell
  observed_at INTEGER NOT NULL,         -- epoch 秒（UTC 口径）
  entry REAL, stop REAL, target REAL,
  playbook_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  shot TEXT,                            -- 截图文件名（可选）
  replay_session_id TEXT,
  evaluation TEXT,                      -- JSON：模拟结果
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trade_notes_book ON trade_notes(login, playbook_id);
CREATE INDEX IF NOT EXISTS idx_checks_book ON playbook_checks(login, playbook_id);
CREATE INDEX IF NOT EXISTS idx_missed_login_time ON missed_trades(login, observed_at);
CREATE INDEX IF NOT EXISTS idx_day_notes_day ON day_notes(login, day);
```

设计说明：

- `journal` 可能被 `_rebuild_journal()` 重建，所以**绝不往 `journal` 加复盘列**。
- `playbook_checks.rule` 存规则原文而不是 rule id，避免改规则后历史检查错位；规则重命名视为新规则。
- `routine_checks` 不建外键，归档例行不删检查。
- `missed_trades.evaluation` 存 JSON，便于以后升级模拟口径而不改表。
- 所有时间字段统一 epoch 秒（UTC 口径）；`day` 才用字符串。

### 5.4 RPC 契约

在 `gateway/mt5_worker.py` 的 `handlers` 里注册，具体实现放 `gateway/review.py`。

| 方法 | 参数 | 返回 |
|---|---|---|
| `diary.calendar` | `{month:"2026-11", login?, scope?}` | `{month, timezone, weeks:[{days:[...], total}], summary}` |
| `diary.day` | `{date:"2026-11-14", login?}` | `{date, summary, records, note, templates, routines, missed, playbook}` |
| `diary.note.save` | `{date, note, mood?, tags?, replaySessionId?}` | `{saved:true, updatedAt}` |
| `diary.templates.list` / `.save` / `.delete` | `{id?, name?, body?}` | `{templates}` |
| `strategy.list` | `{includeArchived?}` | `{playbooks:[{id,name,rules,tradeCount,adherence}]}` |
| `strategy.save` | `{id?, name, description, rules[]}` | `{playbook}` |
| `strategy.delete` | `{id}` | `{deleted:true}` |
| `strategy.tradeNote` | `{positionId}` | `{note, rating, mistakes, playbookId, checks}` |
| `strategy.tradeNote.save` | `{positionId, playbookId?, rating?, mistakes?, note?}` | `{saved:true}` |
| `strategy.check` | `{positionId, rule, followed: true / false / null}` | `{saved:true}` |
| `strategy.adherence` | `{days, playbookId?}` | `{books:[{id, total, evaluated, rate, followed, broken, unassessed, rules}]}` |
| `routine.list` | `{date}` | `{routines, checks, score, history}` |
| `routine.save` / `.delete` | `{id?, title?, stage?, weekdays?}` | `{routine}` |
| `routine.toggle` | `{routineId, date, done}` | `{saved:true}` |
| `missed.list` | `{includeArchived?}` | `{trades}` |
| `missed.save` | `{id?, symbol, side, observedAt, entry?, stop?, target?, playbookId?, note?, shot?, replaySessionId?}` | `{trade}` |
| `missed.delete` | `{id}` | `{deleted:true}` |
| `missed.evaluate` | `{id, horizonDays?}` | `{outcome, r, mfe, mae, bars, entryTs, exitTs, caveat}` |
| `analytics.query` | `{days?, filters:{...}, groupBy?, crossBy?}` | `{summary, groups, matrix, trades, matched}` |

示例返回：

```json
{
  "month": "2026-11",
  "timezone": "Asia/Shanghai",
  "weeks": [
    {
      "days": [
        null,
        {"date":"2026-11-03","net":320.5,"trades":3,"wins":2,"losses":1,"r":1.8},
        "..."
      ],
      "total": 540.2
    }
  ],
  "summary": {
    "net": 2340.5,
    "tradingDays": 12,
    "winDays": 7,
    "trades": 41,
    "winRate": 0.585,
    "totalR": 9.4,
    "bestDay": {"date":"2026-11-06","net":820.0},
    "worstDay": {"date":"2026-11-12","net":-410.0}
  }
}
```

### 5.5 关键算法

#### 5.5.1 日归属与日汇总

```python
def day_key(ts: int, tz: ZoneInfo, server_offset: int) -> str:
    return datetime.fromtimestamp(ts - server_offset, tz).strftime("%Y-%m-%d")

def day_summary(rows, day, tz, server_offset, breakeven):
    items = [r for r in rows if day_key(r["close_time"], tz, server_offset) == day]
    net = sum(r["profit"] for r in items)       # profit 已含 swap/commission/fee
    wins = sum(1 for r in items if r["profit"] > breakeven)
    losses = sum(1 for r in items if r["profit"] < -breakeven)
    r_values = [r["profit"] / r["risk"] for r in items if r["risk"]]
    return {
        "date": day,
        "net": round(net, 2),
        "trades": len(items),
        "wins": wins,
        "losses": losses,
        "r": round(sum(r_values), 2) if r_values else None,
    }
```

注意：`journal.profit` 在同步时已把 `deal.profit + swap + commission + fee` 加总，**不能再加 `swap`/`commission` 列**。这是最容易写错的一处。

#### 5.5.2 周合计

- 以周一为一周起点。
- 对每周 7 天分别求 `day_summary`，再求和；不要只汇总本月可见日。
- 相邻月份的日子不计入“本月”汇总，但计入“周合计”；UI 用一个小点标记。

#### 5.5.3 策略遵守度

```python
def classify(trade, rules, checks):
    assessed = [checks.get(rule) for rule in rules]
    if any(v is False for v in assessed):
        return "broken"
    if all(v is True for v in assessed):
        return "followed"
    return "unassessed"
```

- 只统计已平仓交易。
- 组内指标：笔数、净盈亏、胜率、平均 R、期望。
- 任一组 < 5 笔时，前端显示“样本不足”，不显示“更好/更差”的箭头。
- 规则级：每条规则单独算遵守率与两组绩效，帮助定位“哪条规则最值钱”。

#### 5.5.4 例行完成率

```python
scheduled = [r for r in routines if weekday_in(day, r.weekdays) and not archived_before(r, day)]
done = [c for c in checks if c.day == day and c.done and c.routine_id in scheduled_ids]
score = len(done) / len(scheduled) if scheduled else None
```

- 0 条应做 = `null`，不是 0%。
- 热力图颜色按 `score` 映射，`null` 用中性灰。

#### 5.5.5 错过机会模拟

```python
def evaluate_missed(missed, bars, point, multiplier=1):
    # bars: 从 observed_at 开始的 M1 K 线，按时间升序
    entry = missed.entry or bars[0].open
    stop, target = missed.stop, missed.target
    side = 1 if missed.side == "buy" else -1
    entered = False
    mfe = mae = 0.0
    for bar in bars:
        if not entered:
            if missed.entry is None or (bar.low <= entry <= bar.high):
                entered = True
            else:
                continue
        # 先判止损，再判目标（同一根 K 线内保守处理）
        if stop is not None and ((side == 1 and bar.low <= stop) or (side == -1 and bar.high >= stop)):
            return result("sl", (stop - entry) * side, ...)
        if target is not None and ((side == 1 and bar.high >= target) or (side == -1 and bar.low <= target)):
            return result("tp", (target - entry) * side, ...)
        mfe = max(mfe, (bar.high - entry) * side)
        mae = min(mae, (bar.low - entry) * side)
    return result("open" if entered else "untriggered", None, ...)
```

- 不含点差、滑点、手续费；返回 `caveat` 字段供 UI 显示。
- R 的分母 = `abs(entry - stop) * volume * point_value`；没有手数/止损时只返回价格距离与 MFE/MAE。
- 时间窗口默认 3 个交易日；超出标记 `open`。

#### 5.5.6 筛选与交叉

- 参数白名单：
  ```python
  FILTERS = {
    "symbol": "r.symbol = ?",
    "side": "r.side = ?",
    "closed_by": "r.closed_by = ?",
    "pnl_min": "r.profit >= ?",
    "r_min": "(r.profit / r.risk) >= ?",
    ...
  }
  ```
- 星期、小时用 `utc_ts` 折算后再过滤（SQL 里用 `strftime` 前先减偏移，或取出后在 Python 过滤）。
- 数据量小（单账户几千笔），可以“SQL 粗筛 + Python 精筛”，避免复杂 SQL。
- 结果上限 5000，超过返回 `truncated: true`，前端提示。

### 5.6 与现有模块的集成点

| 模块 | 集成方式 |
|---|---|
| 概览 | 加一张“本月日历”卡片（简化版，点击进交易日记）；不加交互编辑 |
| 交易日志 | 行展开增加“策略 / 规则 / 评分 / 备注”；顶部加“按天分组”切换 |
| 统计报表 | 加 tabs：总览 / 分组 / 交叉 / 趋势 / 散点；筛选栏复用 |
| 历史复盘 | 复盘报告增加“把本次会话挂到某天”按钮；日详情显示会话摘要 |
| 交易台 | 顶栏加“记录错过”（P1）；盘前清单未完成时显示软提示（P1） |
| 设置 | 新增“复盘”分区：复盘时区、日切、盈亏平衡阈值、周起始日、隐私默认值 |
| 导出/备份 | 新表自动进入 SQLite 备份；截图/附件目录已在 data/ 下；复盘卡 PNG 存 exports/ |
| 命令面板 | 加“打开交易日记”“记录错过”“新建策略”（P1） |
| 审计 | 成绩类写操作（策略/规则/例行）只记 `updated_at`，不写执行审计，避免噪音 |

### 5.7 性能与安全

性能：

- 日历一次查一个月：`WHERE close_time BETWEEN ? AND ?`，走 `idx_journal_login`。
- 日详情只查当天，最多几百笔。
- 遵守度按区间查已平仓交易，单账户几千笔以内，Python 聚合足够。
- 交叉矩阵的单元格聚合在前端做也可以，但为了口径统一，建议网关返回分组结果。
- 所有新表都有 `(login, ...)` 索引，多账户不互相拖慢。

安全与隐私：

- 复盘数据只存本地 SQLite，不上传。
- 笔记可能含敏感内容：导出/备份时提醒；AI（P2）默认关闭。
- 复盘卡导出不含账户号、服务器、终端路径、密钥。
- 命令参数校验：日期格式、月份格式、ID 长度、规则长度（单条 ≤ 200 字，最多 20 条）。
- 富文本不引入 HTML 渲染，Markdown 预览用白名单渲染或纯文本 + 简单标记，避免 XSS。

### 5.8 测试计划

**pytest（gateway/tests/test_review.py）**

- 日归属：跨月、跨年、夏令时、服务器偏移 +2/+3、负偏移。
- 净盈亏：不重复加 swap/commission；含 fee 的成交。
- 周合计：跨月周、只有 1 天、7 天全有。
- 遵守度：全遵守/部分/未评估/规则变更/删除策略。
- 例行：星期过滤、0 条应做、归档、补打卡边界。
- 错过模拟：先止损、先目标、同根 K 线、未触发、未结束。
- 筛选：每个条件单独 + 组合；R 缺失；结果截断。
- 多账户隔离：A 账户的笔记/策略不出现在 B。

**vitest（src/lib/*.test.ts、src/views/*.test.tsx）**

- 日期工具：周一起点、月份网格、今天定位。
- 格式化：隐私遮蔽、R 格式、空值。
- 分类：胜/负/平阈值。
- 导出：长文本、中文、空数据。

**手工/截图**

- 浅色、白色、深色三主题。
- 空态、加载态、错误态、离线态。
- 1200px / 1440px / 1920px 宽度；窗口最小 1100×720。
- 隐私模式全页面巡检。

### 5.9 迁移与版本

- 新表全部 `CREATE TABLE IF NOT EXISTS`，在 `Store.__init__` 里执行，和现有迁移一致。
- 不修改 `journal` 表结构；如果未来要加列，仍走 `_migrate()`。
- 复盘设置用 `review_settings` 的 key/value，新增配置不需要改表。
- 数据版本：`review_settings["schema_version"] = 1`；未来口径变化时写迁移函数。
- 备份兼容：旧版备份没有新表，恢复后新表为空，不影响启动。

---

## 6. UI 设计

### 6.1 信息架构

现有导航：

```
工作台：概览 / 交易台 / 历史复盘
记录：交易日志 / 统计报表 / 执行质量 / 审计日志
```

建议改为：

```
工作台
  概览
  交易台
  历史复盘          （行情回放，保持原名）
复盘
  交易日记          （新：日历 + 日笔记）
  策略与纪律        （新：策略 / 例行 / 错过，三个 tab）
  统计报表          （增加筛选、交叉、趋势、散点）
  交易日志          （增加策略/规则/评分）
  执行质量
系统
  审计日志
  设置
```

理由：

- 不新增太多一级入口；复盘相关收在“复盘”组。
- “交易日记”是每天都会打开的页面，放第一位。
- “策略与纪律”把三个低频但相关的页面收在一个 tab 里，避免导航膨胀。

### 6.2 视觉基线

沿用现有 `console-*` token，不引入新色板：

| 用途 | Token | 说明 |
|---|---|---|
| 页面底 | `bg-console-canvas` | 暖纸色 |
| 卡片 | `bg-console-card` + `border-console-line` | 1px 边框，圆角 12px |
| 主文字 | `text-console-ink` | 24px 标题 / 13px 正文 |
| 次文字 | `text-console-muted` | 说明、口径、空态 |
| 弱文字 | `text-console-faint` | 表格表头、占位 |
| 盈利 | `text-console-gain` / `bg-console-gain-soft` | 不做渐变 |
| 亏损 | `text-console-loss` / `bg-console-loss-soft` | |
| 选中/焦点 | `console-accent` | 只用于选中、焦点、链接 |
| 数字 | `font-mono` + `num` | 等宽，右对齐 |

字体与字号：

- 页面标题 24px / 500；副标题 13px。
- 卡片标题 13px / 600；正文 12–13px；表格 11–12px。
- 日历日期 12px，盈亏 12–13px 等宽；不在格子里放两行以上文字。

形状与密度：

- 日历格高 88–104px，7 列，间距 4px，圆角 8px。
- 卡片内边距 16–20px；表格行高 36–40px。
- 不使用阴影、发光、渐变；层次靠边框、底色和字重。

### 6.3 页面与线框

#### 6.3.1 交易日记（日历 + 日详情）

```
┌ 交易日记 ─────────────────────────────────────────────────────────────┐
│  ‹  2026 年 11 月  ›     本月 +2,340.50 · 12 个交易日 · 胜率 58%      │
│                                        [本账户 ▾] [导出复盘卡] [👁]    │
├───────────────────────────────────────────────────────────────────────┤
│  周一    周二    周三    周四    周五    周六    周日     周合计       │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐   ┌──────┐      │
│  │ 3  │ │ 4  │ │ 5  │ │ 6  │ │ 7  │ │ 8  │ │ 9  │   │ +540 │      │
│  │+320│ │ -80│ │    │ │+820│ │+120│ │    │ │    │   │      │      │
│  │3 笔│ │2 笔│ │    │ │4 笔│ │1 笔│ │    │ │    │   │      │      │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘   └──────┘      │
│  ...                                                                  │
├───────────────────────────────────────────────────────────────────────┤
│  11 月 14 日 周五        +320.00 · 3 笔 · 2 胜 1 负 · +1.8R           │
│  [打开该日复盘] [创建回放] [记录错过]                                  │
│  ┌ 笔记 ─────────────────────────────┐ ┌ 当日交易 ────────────────┐  │
│  │ [模板 ▾]                    已保存 │ │ 10:32 EURUSD 多  +180 1.2R│  │
│  │ 盘前：等待伦敦开盘…                │ │ 14:05 XAUUSD 空  -60 -0.4R│  │
│  │                                    │ │ 21:10 EURUSD 多  +200 1.0R│  │
│  │                                    │ │                           │  │
│  └────────────────────────────────────┘ └───────────────────────────┘  │
│  ┌ 例行 3/5 ────────────────────────────────────────────────────────┐  │
│  │ 盘前 看日历 ✓  检查点差 ✓  写计划 ✓  盘后 复盘 ✓  记录截图 ○      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

要点：

- 日历格子的底色用 `color-mix(in oklab, var(--color-console-gain-soft) X%, var(--color-console-card))`，X 按 `|net| / maxAbs` 映射到 10–48%。
- 数字始终显示，不靠颜色单独表达正负。
- 今天用 `outline: 1px solid var(--color-console-line-2)`，不用高饱和填充。
- 选中日详情在下方，不弹窗；避免打断日历浏览。
- 月份汇总只在有 ≥ 5 个交易日时显示胜率，否则显示“样本不足”。

#### 6.3.2 策略与纪律（三个 tab）

```
┌ 策略与纪律 ──────────────────────────────────────────────────────────┐
│  [策略手册] [例行清单] [错过机会]                    [+ 新建策略]     │
├───────────────────────────────────────────────────────────────────────┤
│  ┌ 突破回踩 ────────────────────┐ ┌ 逆势反转 ────────────────────┐  │
│  │ 5 条规则 · 32 笔 · 遵守 78%  │ │ 4 条规则 · 18 笔 · 遵守 55%  │  │
│  │ 遵守 +8.4R / 违反 -3.1R      │ │ 遵守 +1.2R / 违反 +2.8R      │  │
│  │ [查看详情]                   │ │ [查看详情]                   │  │
│  └──────────────────────────────┘ └──────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

策略详情抽屉：

```
┌ 突破回踩 ───────────────────────────────────────────────────────────┐
│ 32 笔 · 遵守率 78% · 遵守组 +8.4R · 违反组 -3.1R     [编辑] [删除]   │
│ 规则                                                                  │
│  1. 只在伦敦/纽约时段入场        遵守 26/28  +7.2R / -0.8R           │
│  2. 突破前有至少 3 根缩量 K 线    遵守 24/30  +6.1R / -1.4R           │
│  3. 止损放在结构外 1–2 点         遵守 30/32  +8.0R / -2.0R           │
│ 最近交易                                                              │
│  日期 / 品种 / 盈亏 / R / 遵守情况                                    │
└───────────────────────────────────────────────────────────────────────┘
```

例行清单：

```
┌ 今日 2026-11-14 · 完成 3/5 ──────────────────────────────────────────┐
│ 盘前   ☑ 看财经日历   ☑ 检查点差   ☑ 写下计划                        │
│ 盘中   ☐ 不在计划外开仓                                              │
│ 盘后   ☑ 复盘并截图   ☐ 记录错过机会                                 │
├───────────────────────────────────────────────────────────────────────┤
│ 近 13 周                                                              │
│  ■ ■ ■ □ ■ ■ ■ □ ...  （格子 = 当日完成率；灰 = 无应做项）            │
└───────────────────────────────────────────────────────────────────────┘
```

错过机会：

```
┌ 错过机会 ────────────────────────────────────────────────────────────┐
│ 2026-11-12 14:05  XAUUSD  空   入场 4,120  止损 4,132  目标 4,090    │
│ 策略：逆势反转    模拟：先到目标（+2.4R，理论值）  [回放] [编辑]      │
│ 备注：当时觉得动能太强，没敢进。                                       │
└───────────────────────────────────────────────────────────────────────┘
```

#### 6.3.3 统计报表的新 tabs

```
[总览] [分组] [交叉] [趋势] [散点]
筛选：时间 30 天 ▾ | 品种 全部 ▾ | 策略 全部 ▾ | 方向 全部 ▾ | R -1~3 ▾
```

- 筛选栏吸顶，所有 tab 共享。
- 交叉矩阵：行/列两个下拉；单元格显示净盈亏（主）与笔数（次）；点击下钻。
- 趋势：两张小图（滚动胜率、滚动平均 R），下面一行“样本 41 笔 · 窗口 20 笔”。
- 散点：X/Y 两个下拉；点少时自动切表格，并显示原因。

### 6.4 组件规格

| 组件 | 位置 | 要点 |
|---|---|---|
| `CalendarMonth` | `components/review/CalendarMonth.tsx` | 纯展示 + 点击；不直接请求 |
| `CalendarCell` | 同上 | 日期、净盈亏、笔数；`data-tone` 控制底色 |
| `DayDetail` | `views/Diary.tsx` | 日汇总 + 笔记 + 交易 + 例行 + 错过 |
| `MarkdownNote` | `components/review/MarkdownNote.tsx` | textarea + 预览；自动保存状态 |
| `PlaybookCard` | `components/review/PlaybookCard.tsx` | 名称、规则数、笔数、遵守率、两组绩效 |
| `PlaybookDrawer` | `components/review/PlaybookDrawer.tsx` | 规则列表 + 单规则遵守率 + 最近交易 |
| `RuleChecklist` | `components/review/RuleChecklist.tsx` | 三态：未评估 / 遵守 / 违反 |
| `AdherenceBar` | 同上 | 遵守/违反/未评估三段条，样本数在旁 |
| `RoutineBoard` | `components/review/RoutineBoard.tsx` | 三泳道 + 热力图 |
| `MissedLog` | `components/review/MissedLog.tsx` | 列表 + 新建/编辑 + 模拟结果 |
| `ReviewExport` | `components/review/ReviewExport.tsx` | PNG 预览 + 下载 |
| `PrivacyToggle` | `components/ConsoleShell.tsx` | 侧栏底部眼睛图标 |
| `FilterBar` | `components/review/FilterBar.tsx` | 与报表共享；chip + 下拉 |

组件原则：

- 日历、策略卡片、热力图都是**纯展示组件**，数据由页面请求后传入。
- 不在组件里做金额口径计算；`fmtMoney` 等格式化函数统一走 `lib/format.ts`，隐私模式在格式化层拦截。
- 所有交互控件有 `aria-label`；日历格用 `role="gridcell"`，键盘可选中。

### 6.5 交互与键盘

- 日历：`←/→` 前一天/后一天，`↑/↓` 同一星期上下周，`PageUp/PageDown` 上/下月，`Enter` 打开日详情，`T` 回今天。
- 注意：日历页的 `B/S` 不绑定下单快捷键，避免误触；交易台快捷键不变。
- 笔记：`Ctrl/Cmd+S` 立即保存；`Esc` 退出预览。
- 策略规则：`Tab` 在规则间移动，`Space` 切换遵守/违反/未评估（三态循环）。
- 导出：`Ctrl/Cmd+E` 打开导出预览（仅在日记页）。
- 所有快捷键在输入框聚焦时不拦截。

### 6.6 状态设计

| 状态 | 表现 |
|---|---|
| 加载 | 日历显示骨架格（7×5），不转圈；日详情显示 3 行骨架 |
| 空月 | “本月还没有已平仓交易”，下面一行“切换月份或账户” |
| 空日 | “这一天没有交易”，笔记仍可写 |
| 无策略 | 文字说明“先建一个策略，写下 3–5 条规则”，不放示例假数据 |
| 样本不足 | 数字照常显示，结论位显示“样本不足（< 5 笔）” |
| 网关断开 | 页面顶部条“网关未连接，显示的是上次数据”，禁用保存 |
| 保存失败 | 输入框下方红字 + “重试”，内容不丢 |
| 隐私模式 | 金额显示 `••••`，正负色保留；图表坐标轴同样遮蔽 |

### 6.7 不要照搬的部分

- 不复制 LuxAlgo 的名称、Logo、品牌色、截图、文案。
- 不复制它的蓝紫渐变、雷达图风格、卡片阴影；Tally 是暖纸色仪器台。
- 不引入它的图表库（Vela / Recharts / ECharts）；Tally 已有自己的 SVG/Canvas 图表组件。
- 不照搬它的“券商同步”空态和导入向导，因为 Tally 没有这个流程。
- 不把 Edge Score 的 0–100 分直接做成首页大数字；如果做，必须同时显示分量和样本数。

---

## 7. 风险与合规

### 7.1 产品风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 复盘层膨胀，拖慢交易台 | 高 | 严格分层；复盘层只读交易数据；新页面独立路由 |
| 用户不写笔记，日历变成摆设 | 中 | 日历本身有独立价值；模板降低写作成本；不做强制 |
| 综合分被当成目标 | 中 | 默认不做；如果做，显示分量与样本，文案明确“不是收益预测” |
| 错过机会模拟被当成真实绩效 | 中 | 明确“理论值”；不进任何统计；结果旁边常驻说明 |
| 多账户聚合口径混乱 | 中 | 默认当前账户；跨账户只合并笔数与比率，不合并不同币种金额 |

### 7.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 服务器时区偏移导致日归属错误 | 高 | 5.2 前置任务；同步时记录偏移；测试覆盖 |
| `journal` 重建丢注释 | 高 | 注释独立表；不建外键；集成测试模拟重建 |
| 净盈亏重复加 swap/commission | 高 | 统一用 `journal.profit`；测试固定样本 |
| 日历查询慢 | 低 | 按月查询 + 索引；单账户数据量小 |
| 笔记内容 XSS | 中 | Markdown 白名单渲染；不 `dangerouslySetInnerHTML` 原始 HTML |
| 导出中文乱码/截断 | 中 | 嵌入字体或使用系统字体回退；固定宽度测试 |
| 备份恢复后新表缺失 | 低 | 启动时 `CREATE TABLE IF NOT EXISTS` |

### 7.3 合规与许可

- LuxAlgo trade-journal 是 **MIT**。如果直接复制代码（而不是重写），需保留版权声明与许可文本；建议在 `docs/THIRD_PARTY_NOTICES.md` 记录：
  > Portions adapted from LuxAlgo trade-journal (MIT), © LuxAlgo Global, LLC.
- 本项目是重写实现（Python/React，口径也不同），仍建议保留致谢，尊重来源。
- 不使用其商标、Logo、品牌名作为 Tally 的功能名；“Edge Score”作为通用词可以使用，但不要暗示与 LuxAlgo 有关联。
- 所有复盘数据本地存储；AI（若做）必须自带 Key、默认关闭、明确告知发送内容。

---

## 8. 验收清单

### P0

- [ ] 交易日口径统一：日历、日详情、交易日志的日期一致。
- [ ] 日历月视图：跨月周合计正确；空月/单日/全赢/全亏都不崩。
- [ ] 日详情：汇总、交易、笔记、例行、错过五块齐全；无交易也能写笔记。
- [ ] 笔记：自动保存、失败提示、切换日期不串、重启不丢。
- [ ] 策略：新建/编辑/删除；规则逐条三态；遵守率实时更新。
- [ ] 遵守度：遵守/违反/未评估三组笔数守恒；样本不足有提示。
- [ ] 隐私模式：全页面金额遮蔽；导出跟随；重启保持。
- [ ] 复盘卡 PNG：中文、长文本、深浅主题都正常；不含账户敏感信息。
- [ ] 导出/备份：新表进入备份；恢复后数据完整。
- [ ] 测试：`npm run check` 通过；新增 pytest/vitest 覆盖核心算法。

### P1

- [ ] 例行：星期过滤、补打卡、归档、13 周热力图正确。
- [ ] 错过机会：模拟结果与手工核对一致；不进统计；可跳回放。
- [ ] 筛选：每个条件可复现；组合条件与交易列表一致；结果截断有提示。
- [ ] 交叉：行列合计与总汇总一致；小样本单元格有标识。
- [ ] 趋势/散点：窗口边界、样本不足、隐私模式都正确。

---

## 9. 附录

### 9.1 LuxAlgo 源码索引（阅读路径）

| 主题 | 文件 |
|---|---|
| 数据模型 | `apps/web/src/db/schema.ts` |
| 回合交易 | `packages/core/src/round-trips.ts` |
| 指标 | `packages/core/src/metrics.ts` |
| 分组/筛选 | `packages/core/src/analysis.ts` |
| Edge Score | `packages/core/src/edge-score.ts`、`docs/edge-score.md` |
| 遵守度 | `packages/core/src/adherence.ts` |
| 日历 | `apps/web/src/components/calendar-pnl.tsx`、`docs/calendar-insights.md` |
| 趋势 | `apps/web/src/lib/performance-trends.ts`、`docs/performance-trends.md` |
| 散点 | `docs/trade-explorer.md` |
| 日笔记 | `apps/web/src/app/journal/[date]/page.tsx` |
| 策略 | `apps/web/src/app/playbooks/page.tsx`、`apps/web/src/components/rule-checklist.tsx` |
| 例行 | `apps/web/src/app/progress/page.tsx` |
| 错过 | `apps/web/src/app/missed/page.tsx` |
| 隐私 | `apps/web/src/components/privacy.tsx` |
| 导出 | `apps/web/src/components/review-export.tsx`、`apps/web/src/lib/export-review.ts` |

### 9.2 参考链接

- 仓库：<https://github.com/LuxAlgo/trade-journal>
- Edge Score 文档：<https://github.com/LuxAlgo/trade-journal/blob/main/docs/edge-score.md>
- 日历洞察：<https://github.com/LuxAlgo/trade-journal/blob/main/docs/calendar-insights.md>
- 绩效趋势：<https://github.com/LuxAlgo/trade-journal/blob/main/docs/performance-trends.md>
- 交易散点：<https://github.com/LuxAlgo/trade-journal/blob/main/docs/trade-explorer.md>

### 9.3 术语

| 术语 | 含义 |
|---|---|
| 回合交易 / round trip | 从空仓到再次空仓的一次完整持仓周期 |
| R | 净盈亏 / 初始风险；本文的 R 只在有止损数据时计算 |
| MFE / MAE | 持仓期间最大浮盈 / 最大浮亏 |
| 遵守度 / adherence | 规则逐条打勾后的“完全遵守”比例 |
| 交易日 | 按平仓时间与复盘时区折算出的日期 |
| 复盘卡 | 某一天/某一周的可分享 PNG/PDF 摘要 |
| 过程评分 | 综合多个分量的透明分数，非收益预测 |

---

## 10. 最后一句

LuxAlgo 值得学的不是它的券商接入，也不是它的 AI，而是**它把“记录 → 统计 → 归因 → 反思 → 改进”这条链路做完整了**。Tally 已经拥有这条链路的前半段，而且数据质量更高；缺的只是后半段的界面与习惯。先做日历、日笔记、策略遵守度这三件事，复盘层就成立了；其余的等这三件事真的被每天使用，再决定要不要做。

---

## 11. 落地记录

### 11.1 已实现（P0 + P1 + P2）

| 能力 | 入口 | 后端 | 说明 |
|---|---|---|---|
| 盈亏日历 + 日笔记 + 复盘卡导出 | 盈亏日历 | `diary.*` | 月历按复盘时区折算；日笔记、心情、标签、模板；PNG 卡片 |
| 逐笔复盘（评分 / 错误 / 规则勾选） | 交易日志 → 复盘、盈亏日历 | `strategy.tradeNote.*` | 注释独立于 journal 重建，重新同步不丢 |
| 策略手册 + 遵守度 | 策略手册 | `strategy.*` | 遵守 vs 违反的净盈亏、平均 R、逐规则统计与样本提示 |
| 隐私遮蔽 | 侧栏眼睛按钮 | 前端 `lib/privacy.ts` | 除交易台外所有页面金额被遮，图表形状保留 |
| 例行清单 + 13 周热力图 | 例行清单 | `routine.*` | 盘前 / 盘中 / 盘后三组，星期掩码，最近 7 天可补勾 |
| 错过机会 + M1 模拟 | 错过机会 | `missed.*` | 观察后的 M1 走一遍计划；同根 K 线先算止损；只记理论 R |
| 绩效趋势 | 绩效趋势 | `review.trades` | 20 笔滚动胜率 / 期望 / 平均 R，少于 27 笔只给说明不画线 |
| 交易散点 | 绩效趋势 | `review.trades` | 持仓时长（平方根刻度）× 实现 R，少于 8 点改精确值表 |
| 深度筛选 + 交叉分析 | 深度分析 | `review.trades` | 品种 / 方向 / 标签 / 星期 / 时段 / 持仓筛选；分组汇总与二维矩阵，少于 3 笔淡显 |
| 过程评分 | 过程评分 | `score.get` | 7 分量固定权重、样本不足直接剔除并重新归一化；公式写在页面底部 |
| 复盘 PDF | 盈亏日历 → PDF | 前端 `lib/pdf.ts` | 画布栅格化后写入单页 PDF，中文不依赖查看端字体 |
| AI 复盘（自带 Key） | 设置 → AI 复盘、盈亏日历 | `ai.*` | 默认关闭；Key 走 DPAPI 且不回传；只发聚合统计 + 勾选笔记；结果按区间缓存 |

### 11.2 还没做

- P3：外部历史 CSV 导入。

### 11.3 口径提醒

- 例行清单与错过机会都**不进入**任何盈亏 / 胜率 / R 统计。
- 错过机会的 R 是理论值，不含点差、滑点、手续费；市场价入场后若已越过目标/止损，直接标为「计划无效」。
- 时间口径：journal 与 M1 K 线都按 MT5 服务器时间存；复盘按复盘时区折算日期。前端写入 `missed.observedAt` 时先换算成服务器时间。
- 过程评分：区间少于 20 笔不给总分；盈亏比要求同时有盈亏、恢复因子需要 R 回撤 > 0、规则遵守率要求勾选过规则，缺哪项就剔除该项并重算权重。改公式必须升 `TALLY_SCORE_VERSION`。
- AI 复盘：每次请求前可展开「将发送哪些字段」；笔记默认不发，勾选后截断到 500 字/条；同一 (区间, 提供方, 模型) 复用缓存，重新生成才会计费。
