# Tally 修订方案与实施计划（2026-11-15）

> 依据：`docs/PRODUCT_REVIEW_2026-11-15.md`
> 性质：方案文档，**未开始实施**；确认后再按第 7 节的 PR 顺序动工。
> 计量单位：人日按「熟悉本仓库 + AI 辅助」估算，含测试与自测，不含反复打磨 UI。

---

## 0. 阅读方式

每一项都按同一结构写：**为什么做 → 现状证据 → 方案与取舍 → 改动面 → 边界/风险 → 验收 → 估算**。第 2 节先给全局约定，第 3 节列出需要你拍板的 8 个决策，第 4 节是 15 个工作项，第 5 节排期，第 6 节明确不做的事，第 7 节是开工顺序与验证。

如果时间有限，只看第 2 节（决策）、第 5 节（排期）、第 6 节（不做）。

---

## 1. 全局约定（所有工作项共同遵守）

| 约定 | 内容 | 理由 |
|---|---|---|
| 时间归属 | 数据库里的 MT5 时间戳一律保持**服务器时间原样**；展示与按日分桶时减去该笔交易记录下来的 offset | 历史数据无法反推当时的 offset，库内改 UTC 会造成不可逆错误 |
| 展示口径 | 日志、日历、统计按**本地时间**；K 线图与回放时钟按**服务器时间**并在界面标注 | 列表回答「我几点做的」，图表回答「行情几点」；两者混用才是问题 |
| 数据归属 | 用户产生的数据（交易、笔记、训练会话、画线）一律进网关 SQLite，纳入现有备份；浏览器存储只做缓存 | 清缓存/换机不丢；备份已覆盖 `data/mytrade.db` |
| 路由兼容 | 旧 hash（`#/reports`、`#/score`、`#/audit`…）永久保留可解析，合并后重定向到新页面/页签 | 书签、文档、命令面板里有旧链接 |
| 交互一致性 | 同一个动作在不同入口的行为、确认方式、反馈文案必须一致；不一致时以「更安全 + 可撤销」为准 | 现在撤单、平仓、删除各有两三套规则 |
| 统计口径 | 所有页面只消费 `journal.stats` / `review.trades` 两个出口；本地只做展示层计算，不再新增第三套聚合 | 已有 `stats_golden.json` 跨端黄金样本，守住它 |
| 空态 | 任何「缺少前置条件」的提示必须带一个可点击的下一步 | 现在多处只有一句话 |

---

## 2. 需要你拍板的决策

| # | 决策 | 选项 | 推荐 | 影响面 |
|---|---|---|---|---|
| D1 | 时间显示 | A. 列表/日历/统计本地时间 + 图表服务器时间（标注）<br>B. 全部服务器时间 | **A** | W1 |
| D2 | 挂单改手数 | A. 不做（MT5 不支持改量）<br>B. 撤单重下 | **A**（只补 SL/TP 编辑） | W3 |
| D3 | 撤单交互 | A. 单击撤单 + 6 秒撤销<br>B. 全部二次确认 | **A**，但需给 toast 加动作能力 | W4 |
| D4 | 回放会话存储 | A. 迁网关 SQLite + localStorage 迁移兜底<br>B. 继续 localStorage，只加导出 | **A** | W8 |
| D5 | 信息架构 | A. 分两步：先分组、再合并页签<br>B. 一次合并到位 | **A** | W10 |
| D6 | 三套纪律 | A. UI 聚合，不合并门禁语义<br>B. 深度合并数据模型 | **A**（门禁只评规则，例行是每日流程，语义不同） | W10 |
| D7 | 评分/执行/审计 | A. 保留路由、移出一级导航<br>B. 删除页面 | **A** | W11 |
| D8 | 复盘「已复盘」 | A. 独立标记（可与笔记分离）<br>B. 沿用「保存笔记即已复盘」 | **A** | W7 |

---

## 3. 工作项

### W1 统一时间口径（P0）

**为什么做**：同一笔交易在日志里显示 10:00、在日历里显示 15:00，或者 30 天窗口少算 5 小时边界交易，是会被用户当成「数据错了」的问题；它还会让「按小时」归因整体偏移。

**现状证据**：
- `_server_offset` 由 tick 推算（`worker_account.py:470-476`），但只在有报价订阅时更新；启动后未订阅时是 0。
- 消费端不一致：Diary/Analysis/Strategy 减 offset（`review.py:_day_key/_raw_range`、`lib/review.ts`），Journal 列表（`views/Journal.tsx:33`）、`journal.stats` 的时段分桶（`journal.py:469`）、统计窗口起点（`journal.py:399`）、报表曲线日期（`Reports.tsx` 的 `fmtDay`）都没减。
- `journal.stats` 的 `since` 用本机 `time.time()`，与库里的服务器时间戳直接比较。

**方案**（比原始评审更进一步）：
1. **给 journal 增加 `server_offset` 列**（`ALTER TABLE journal ADD COLUMN server_offset INTEGER NOT NULL DEFAULT 0`，用 `PRAGMA table_info` 做幂等迁移）。同步成交时写入当时的 offset；老数据首次连上后一次性回填当前 offset。这样跨夏令时/券商调整时，历史交易仍按当时的 offset 显示，而不是用今天的 offset 倒推。
2. **offset 更可靠**：启动、切换账户、`system.health` 被调用时，用当前品种的 tick 计算一次；加陈旧保护（tick 与本地时间相差超过 14 小时视为周末/停牌，不更新）；仍按 15 分钟取整。
3. **统一换算函数**：
   - Python：`display_epoch(raw, offset) = raw - offset`，`day_key(raw, offset, tz)` 复用现有 `review._day_key` 逻辑；
   - TS：新增 `src/lib/time.ts` 的 `fmtServerTime(ts, offset)`、`fmtServerDay`，Journal、TradeChart、TradeDetailModal、Reports 曲线标签统一使用。
4. **统计窗口**：`journal.stats` 与 `journal.list` 的 `since` 改成「本地日界线 + 当前 offset」，并按行 off 做小时分桶。
5. **图表保持服务器时间**：交易台顶部显示「服务器时间」提示；回放工作台时钟标注「行情时间」。这是刻意选择——MT5 用户看盘习惯是服务器时间，改成当地时间会与 MT5/图表刻度对不上。

**改动面**：`gateway/store.py`（列 + 迁移 + 查询）、`gateway/journal.py`（同步写入、stats）、`gateway/worker_account.py`、`worker_market.py`、`mt5_worker.py`（health 时刷新、stats 传 offset）、`src/lib/time.ts`（新）、`views/Journal.tsx`、`components/TradeChart.tsx`、`TradeDetailModal.tsx`、`views/Reports.tsx`、`views/Diary.tsx`（改用共享函数，行为不变）。

**边界/风险**：
- 老数据回填后，历史交易显示会「跳」一次，这是预期修正；在发布说明里写清楚。
- 若券商 tick 时间本身异常（少数模拟服），陈旧保护会避免把 offset 弄坏；仍异常时回退 0（按服务器时间显示）。
- 不改变数据库里已有的任何时间戳值。

**验收**：
- 用 offset=10800 的 fixture：`journal.stats` 的 `byHour` 与手工换算一致；30 天窗口边界包含/排除正确。
- 同一笔交易在 Journal、Diary、TradeChart、Replay 报告里的时间互相对得上（脚本化断言 + 预览截图）。
- `npm run check` 全绿；golden 样本不变（offset 默认 0）。

**估算**：2.5 人日（含迁移与测试）。**依赖**：无。

---

### W2 修复「点击图表设置委托价」（P0）

**为什么做**：界面上写着能点，实际点了没反应——这是「承诺了但没做到」，比没有这个功能更伤信任。

**现状证据**：`handleChartClick` 要求 `event.target` 是 canvas（`ChartPanel.tsx:963-977`），但图表在 iframe 内，父容器收不到（同文件 729-731 注释已说明）；`onClick` 挂在父 div（1086）。

**方案**：
1. 在已有的 `widget.subscribe('mouse_down', ...)`（`ChartPanel.tsx:731`）里实现：若当前槽位是活动槽、草稿已激活且类型非市价，取 `crosshairPrice.current` 写入 `patchDraft({price})`；按住 Shift 时走 `snapLevel`。
2. 点击到图例/坐标轴时 TV 不触发 `mouse_down`，天然排除；拖动已有价格线也会触发，但落点即用户看到的价，可接受。
3. 删除 `handleChartClick` 与父容器 `onClick`，避免两套逻辑；保留「划线中」提示。
4. 多图时只用活动槽的 `symbolInfo` 取整（同时修 W15 的取整 bug）。

**改动面**：`ChartPanel.tsx`（731-735、963-977、1086）、`lib/format.ts`（如需）。

**边界/风险**：TV 的 `mouse_down` 在部分绘图工具激活时也会触发；用「草稿激活 + 非市价」双重门槛限制。若库版本事件签名变化，退回只在 `crosshair_moved` 时记录、点击时读取。

**验收**：预览里用假网关激活划线，点击图上位置，票内委托价同步变化；切换多图后点击副图，价格取自副图品种精度。

**估算**：0.5 人日。

---

### W3 持仓与挂单的止损/止盈编辑（P0）

**为什么做**：补止损是风控最高频动作；现在只能去 MT5 做，等于把最关键的一步推出了产品。

**现状证据**：
- 后端已支持：`_modify_position` 接受 sl/tp（`worker_trading.py:621-666`），并在首次补止损时记录初始风险；`_modify_order` 已接受 sl/tp（576-601）。
- 前端只在 **已有** SL/TP 时画可拖线（`ChartPanel.tsx:568-655`）；持仓面板没有设置入口（`PositionsPanel.tsx` 只有保本/平半/整平/移动止损）。
- 挂单价线只画价格（`ChartPanel.tsx:1024-1035`），不画 SL/TP。

**方案**：
1. **持仓面板加行内编辑**：止损/止盈两个输入格，默认显示现值；保存发 `position.modify`；清空 = 传 0 删除。提交前校验方向（buy: sl < 现价 < tp；sell 相反）、最小距离（`stops_level`）、按 tick 对齐；失败原因原样提示。成功后用现有推送刷新，并 toast。
2. **图上补拖线**：持仓没有 SL/TP 时画虚线引导线「拖动设置止损/止盈」，松手调用 `position.modify`——复用草稿引导线的实现模式（`ChartPanel.tsx:1002-1021`）。
3. **挂单画 SL/TP 线并可拖**：`orders` 循环里补 `order.sl` / `order.tp` 两条线，`onMove` 调 `order.modify({ticket, sl|tp})`。后端已支持，只需前端与校验。挂单价钱、SL/TP 三者关系由前端先校验，后端再加 `BAD_STOPS` 明确报错（现在依赖 MT5 返回模糊错误）。
4. **不改手数**（D2）：MT5 的 `TRADE_ACTION_MODIFY` 不支持改量；撤单重下会在价格穿价时失败并产生空窗，收益低于风险。把「撤单 → 重新下单」留在 W4 的撤销能力里。

**改动面**：`PositionsPanel.tsx`、`ChartPanel.tsx`、`worker_trading.py`（校验）、`gateway/tests/test_trading*.py`、新增 `src/lib/stops.ts`（纯函数校验，便于单测）。

**边界/风险**：
- 补止损会触发后端「按补止损时价格记录初始风险」，这是既有语义，保留；若用户拖错再改，风险记录不重算（现状如此），在文档里注明。
- 挂单 SL/TP 拖动与价格线拖动共用 `moveTo` 的 320ms 节流，避免高频改单。
- 不加「一键全平后保留 SL」之类衍生功能，保持范围。

**验收**：无 SL 的持仓可在图上拖出止损、面板可输入并保存；挂单可改 SL/TP；错误方向被拦下且有中文提示；pytest 覆盖校验；预览实测两种操作。

**估算**：2 人日。

---

### W4 订单交互一致性：撤单、划线、空态（P0）

**为什么做**：同一件事三套规则，用户会误操作；空态只给文字，用户卡在流程中间。

**现状证据**：
- 撤单：图上 × 单击即撤（`ChartPanel.tsx:562-565`、`ChartChips.tsx` 的 onRemove），`OrdersPanel.tsx:80-90` 两步确认。
- 「划线中」按钮再点仍是 `activate()`（`OrderTicket.tsx:572-584`），只能 Esc/图上清除/入场块 ×。
- block 模式无清单只有文字（`OrderTicket.tsx:1198-1200`）；复盘抽屉无策略也只有文字（`TradeReviewDrawer.tsx:226-230`）。
- Shift 吸附提示在票内（1038-1049），但逻辑只在图上拖线生效。
- 整仓平仓/全平/急停缺 busy 与成功反馈（`PositionsPanel.tsx`、`TopBar.tsx:96-130`）。

**方案**：
1. **撤单统一为单击 + 撤销**（D3）：先把 `useApp.toast` 扩展为可选 `action: { label, run }`（6 秒后失效）；撤单成功后弹「已撤 XAUUSD #123 · 撤销」，撤销用原参数重新 `order.place`。若原单带模板分批计划，撤销文案明确「分批计划不会恢复」（`_cancel_order` 已丢弃计划，见 `worker_trading.py:613-617`）。重下失败时提示「价格已穿过，请重新下单」。
2. **划线 toggle**：按钮在激活态显示「取消划线」，点击清理草稿；与 Esc、图上 × 共用同一个 `resetDraft`。
3. **空态带按钮**：新增 store helper `openSettings(section)` 与 `openStrategyNew()`；`settingsSection` 机制已存在（`useApp.ts:138/573`）。block 无清单 → 去「设置→开仓纪律」；完全没有策略 → 去策略手册并直接打开新建。
4. **Shift 文案**：改为「在图上拖动时按住 Shift 吸附整数位」，并放到划线提示旁。
5. **busy/成功反馈**：全平、急停、恢复、模式切换加禁用态与结果 toast；与 `PositionsPanel` 现有 `busy` 写法对齐。

**改动面**：`useApp.ts`（toast action、helpers）、`ConsoleShell`/Toast 渲染、`ChartPanel.tsx`、`OrdersPanel.tsx`、`OrderTicket.tsx`、`PositionsPanel.tsx`、`TopBar.tsx`、`TradeReviewDrawer.tsx`。

**边界/风险**：toast 带动作是全局能力，注意同时只保留一个可撤销提示；被新提示覆盖即视为放弃撤销。撤销重下会产生新的 intent 与审计，符合预期。

**验收**：三个入口撤单行为一致；撤销 6 秒内可恢复；划线可开可关；两个空态可一键到达目标页；平仓/急停有成功提示。

**估算**：1.5 人日。

---

### W5 告警可编辑 + 右侧面板互斥（P0，小）

**为什么做**：现在改价只能删了重建；两个侧栏能同时打开互相覆盖。

**现状证据**：`AlertsPanel.tsx:97-104` 只发 `enabled`；删除无确认；`AlertsPanel.tsx:152` 与 `CalendarPanel.tsx:86-87` 都是 `absolute inset-y-0 right-0`，`App.tsx:304-305` 允许同时打开。

**方案**：
1. 列表每项加「编辑」，复用顶部表单（价格/方向/备注/重复/冷却），发 `alerts.update`（后端已支持这些字段，见 `worker_data.py:111-130`）。
2. 删除加二次确认（与「平半」一致的两击模式）。
3. 打开告警即关闭日历，反之亦然；`useApp` 的 `setAlertsOpen` / `setCalendarOpen` 里互斥，避免每个调用点各写一遍。

**改动面**：`AlertsPanel.tsx`、`useApp.ts`。

**验收**：改价/改备注即时生效；两个面板不会同时出现；删除需确认。

**估算**：1 人日。

---

### W6 日志与报表去重、筛选与下钻（P1）

**为什么做**：两页回答同一个问题；且「EURUSD 亏得多」之后无路可走。

**现状证据**：两页都用 `journal.stats`（`Journal.tsx:75`、`Reports.tsx:63`），分组维度完全相同；Journal 只有 7/30/90 与客户端分页；行内三键 + 整行点击重复（307-310、386-407）；详情截图页签入口不可达（309/390 永远传 `chart`）。

**方案**（分两小步，先做 6a）：
1. **6a 去重**：Journal 顶部只留 3 张卡（交易笔数 / 净盈亏 / 胜率）+「查看完整报表」；「分组表现」卡移除（Reports 已有）。详情弹窗：整行点击进图表；动作区保留「复盘」「回放」，`has_shot` 时加「截图」图标并正确传 `initialTab`；去掉重复的「交易图」。
2. **6b 筛选**：`journal.list` 与 `journal.stats` 增加统一 filter（`symbol` / `tag` / `result=win|loss` / `reviewed=0|1`），SQL 层实现（`store.py:643` 加 WHERE；`reviewed` 通过 `LEFT JOIN trade_notes`）。Journal 顶部加筛选条；统计卡随筛选变化。
3. **下钻**：Reports 的 `BreakdownCard` 行可点击 → 写入 `journalFilter` store → 跳 Journal（已带筛选）；Executions 的品种行同样跳到 Journal（symbol + 时间区间）。
4. **区间统一**：抽出 `RangeChips` 组件，报表增加「全部」（`days=0` 在 `journal.stats` 已有 `since=0` 语义）。

**改动面**：`store.py`、`worker_data.py`（参数透传）、`journal.py`（stats 接受 filter）、`views/Journal.tsx`、`views/Reports.tsx`、`views/Executions.tsx`、`useApp.ts`、`components/RangeChips.tsx`（新）、`src/gateway/types.ts`。

**边界/风险**：
- `reviewed` 需要 join，注意 login 与 position_id 双键；无笔记视为未复盘。
- 筛选后 `truncated` 语义不变（仍是 5000 笔上限）。
- 统计卡改为筛选口径后，用户可能对比旧截图发现数字变化——这是修正，不是回归。

**验收**：同一筛选下 Journal 卡片与列表重算结果一致；从报表点「XAUUSD」进入 Journal 后只显示该品种；截图页签可从有截图的记录直接打开。

**估算**：3 人日（6a 1 天，6b+下钻 2 天）。

---

### W7 复盘闭环：状态、回链、错过机会进回放（P0/P1）

**为什么做**：现在「交易 → 复盘 → 回放 → 重演 → 对照」每一跳都是单向的，用户回不去；「错过机会」最该进回放却没有入口。

**现状证据**：
- `reviewed_at` 只在 `trade_note_save` 时写成 now（`store.py:1345-1383`），没有「只标记不复盘」的路径；Diary 显示「未复盘」来自 annotation（`review.py:288-316`），Journal 没有该字段。
- ReferencePanel 的「去复盘」只 `setPage('journal')`，不带 positionId（260-265）。
- Missed 只有模拟，没有回放（`Missed.tsx:364-371`）；`useTradeReplay.start` 只接受 `JournalRecord`。
- 回放列表「已结束/已归档」都显示「报告/完成」（`ReplayList.tsx:102-107、307、333`）。

**方案**：
1. **独立复盘标记**（D8）：新增 `store.trade_note_set_reviewed(position_id, reviewed, login)`（无记录时插入默认行），RPC `strategy.tradeNote.reviewed`；抽屉底部「标记已复盘 / 取消标记」；保存笔记仍自动标记（保持现状）。`journal.list` 附带 `reviewedAt` 字段，Journal 行显示徽标，「待复盘」筛选复用 W6 的过滤器。
2. **回链**：打开回放时把来源写入 `sessionStorage['mytrade.replay.back'] = {page, positionId?, label}`；工作台与报告顶部显示「返回交易日志 / 盈亏日历 / 绩效趋势」；离开回放域时清除。
3. **去复盘直达**：新增 `useApp.journalFocus`；ReferencePanel 点击后 `setPage('journal') + setJournalFocus(positionId)`，Journal 的 effect 打开对应抽屉并清空 focus。
4. **错过机会进回放**：`useTradeReplay` 增加 `startWindow({symbol, anchorTs, label})`，窗口 = 观察时间前 30 分钟 → 后 120 分钟；`origin: 'missed'`；列表来源筛选加「来自机会」；`Missed.tsx` 每行加「在回放中看」。
5. **列表状态区分**：已结束显示「报告」，已归档显示「已归档」，二者与「完成」分开。

**改动面**：`store.py`、`review.py`、`mt5_worker.py`、`TradeReviewDrawer.tsx`、`Journal.tsx`、`views/Missed.tsx`、`useTradeReplay.tsx`、`reference.ts`、`route.ts`、`ReplayWorkspace.tsx`、`ReplayReport.tsx`、`ReplayList.tsx`、`types.ts`。

**边界/风险**：
- 回放返回用 sessionStorage 而非 URL query，避免破坏现有 `#/replay/<id>` 解析；刷新回放页仍能返回。
- 错过机会没有真实成交，`origin='missed'` 的会话不参与「实盘 vs 重演」对照。
- 标记已复盘不写入评分/笔记，不改变 Score 的遵守率分母。

**验收**：从日志/日历/散点进回放后可一键回到来源；ReferencePanel 能直接打开该笔复盘抽屉；错过机会能生成会话并回放；「待复盘」筛选与标记联动。

**估算**：2.5 人日（标记与回链 1.5，错过进回放 1）。

---

### W8 回放会话持久化（P0，最大的一项）

**为什么做**：训练记录现在存 localStorage，清缓存即归零；且不在备份里。回放是产品护城河，数据必须按资产对待。

**现状证据**：`src/replay/store.ts:129-180`（`localStorage`、上限 60、3 秒防抖）；图表状态与画线也在 localStorage（`ReplayChart.tsx:82-138`）；备份只打包数据库/审计/截图（`exporter.py:262-307`）；K 线缓存在 IndexedDB 且按品种（`replay/cache.ts`），可重新拉取，不需要迁移。

**方案**：
1. **表结构**（幂等建表，现有 store 初始化模式）：
   ```sql
   CREATE TABLE IF NOT EXISTS replay_sessions (
     login INTEGER NOT NULL,
     id TEXT NOT NULL,
     name TEXT NOT NULL,
     symbol TEXT NOT NULL,
     status TEXT NOT NULL,
     origin TEXT,
     reference_key TEXT,
     start_ts INTEGER NOT NULL,
     end_ts INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL,      -- 会话主体（订单/持仓/成交/笔记/权益曲线，曲线已降采样）
     chart TEXT,                 -- TradingView save() 状态
     drawings TEXT,              -- 本会话画线
     PRIMARY KEY (login, id)
   );
   ```
   单文件保护：payload ≤ 4 MB、chart/drawings ≤ 2 MB，超限拒绝并保留本地，提示「会话过大，已保存在本机」。
2. **RPC**：`replay.list`（按 updated_at 倒序，含 payload）、`replay.save`（upsert，带 `updated_at` 做乐观校验）、`replay.delete`。都走 `_review_call` 类似的错误包装，登录号来自 worker，不信任前端传 login。
3. **客户端**：
   - 启动时（gateway 连接后）`replay.list` → 填充 store；`hydrated` 标志控制 ReplayView 骨架屏；失败回退 localStorage 快照（离线只读）。
   - **一次性迁移**：DB 为空且本地有会话 → 全部 `replay.save`；成功后在本地留一份只读副本并写 `mytrade.replay.storage=2`，下一版再删。
   - 保存改为 2 秒防抖 + 脏集合；逐条保存，失败保留脏标记并只提示一次（不打断回放）。
   - 图表状态/画线在离开会话或 5 秒防抖时写入会话行的 `chart` / `drawings`，localStorage 继续作为快速缓存。
4. **容量**：去掉 60 上限与强弹窗；改为软上限 200，超过时在列表提示「建议归档旧会话」，归档不删除。
5. **备份与导出**：DB 已在备份包里自动覆盖；`data.export` 增加 `kind=replay`（JSON，可选，P1）。
6. **兼容**：客户端探测 `replay.list` 是否可用；旧网关返回 `UNKNOWN_METHOD` 时降级为纯 localStorage 模式。

**改动面**：`store.py`、`worker_data.py`（或新 `worker_replay.py`）、`mt5_worker.py` dispatch、`src/replay/store.ts`、`ReplayChart.tsx`、`ReplayView.tsx`、`ReplayList.tsx`、`useTradeReplay.tsx`、`reference.ts`、`src/gateway/types.ts`、`gateway/tests/test_replay.py`（新）、`src/replay/store.test.ts`。

**边界/风险**：
- 迁移必须**先复制后切换**，任何失败都保留 localStorage；发布说明写明。
- 会话 payload 含整段权益曲线，需继续降采样（现有 `downsampleCurve` 复用）。
- 回放依赖网关（bars、会话读取）；与 PRD「MT5 不启动也能复盘」一致——网关需要运行，终端不必。
- 多账户：会话按 login 隔离，切换账户后列表只显示当前账户的会话；这是行为变化，需在 UI 注明。

**验收**：
- 迁移 fixture：本地 3 个会话 → 首次启动全部出现在 DB，刷新后仍在；删除本地 localStorage 后刷新仍能打开。
- 备份 zip 中包含 `data/mytrade.db`，恢复后会话在。
- 保存失败（模拟只读）时回放不中断，提示一次。
- 现有 60 个上限测试改为软上限。

**估算**：4.5 人日。

---

### W9 「今天」工作台（P1）

**为什么做**：15 个页面里没有一处回答「今天我该做什么、还差什么」。这是把复盘层从功能仓库变回流程的关键。

**方案**：在概览页新增「今天」区（仅连接账户时显示）：
1. **例行进度**：`routine.day` 的 due/done，三阶段小进度条，点击去例行页；无例行时显示「生成默认清单」入口（复用 `routine.seed`）。
2. **开仓门禁**：当前生效模式（全局/账户覆盖）与默认清单名，点击去设置→开仓纪律。
3. **今日交易**：`journal.list(days=1)` 的笔数与净盈亏，以及「待复盘 N 笔」（用 `reviewedAt`），点击带筛选跳日志。
4. **继续上次复盘**：最近一个未结束的回放会话（来自 `useReplay`），一键打开。
5. **写今日笔记**：跳日历并选中今天。

**改动面**：`views/Overview.tsx`、`useApp.ts`（跳转 helper）、复用 `range` 工具。

**边界/风险**：概览变长，需要控制为「一屏内 4 个块」；无数据时每块都要有下一步，而不是空白。

**验收**：新账户（无交易/无策略/无例行）看到的不是空白页，而是三条可执行的起点；有数据的账户一屏内能判断今天是否合规。

**估算**：2 人日。

---

### W10 信息架构：先分组，再合并（P1/P2）

**为什么做**：15 项导航，7 项叫「复盘」，用户找不到东西；但一次性大改风险高。

**方案**（D5 分两步）：
- **10a 分组（P1，0.5 天）**：导航改为 5 组：工作台（概览/交易台）、复盘（历史复盘/盈亏日历/策略/例行/错过/趋势/分析/评分）、记录（日志/报表/执行/审计）、设置。只改分组与顺序，不改路由。
- **10b 合并（P2，3 天）**：
  | 新页面 | 页签 | 吸收 |
  |---|---|---|
  | 记录 | 列表 / 日历 | Journal + Diary |
  | 分析 | 报表 / 趋势 / 深度 / 执行质量 | Reports + Trends + Analysis + Executions |
  | 纪律 | 策略 / 例行 / 错过 | Strategy + Routines + Missed |
  | 概览 | — | 概览 + 今日工作台 + 评分卡 |
  | 复盘 | — | 回放（不变） |
  旧 hash 全部重定向到对应页签；命令面板同步。三个合并页保留各自的 store 状态与筛选，切换页签不丢。
- **10c 纪律语义**（D6）：例行清单继续是「每日流程」，开仓门禁继续只评 playbook 规则；纪律页只是把它们放在一起呈现，**不**让例行项进入门禁判定。理由：门禁在交易瞬间执行，例行是当天流程，强行合并会让「今天没打勾」直接阻断下单，语义与用户预期不符。

**改动面**：`ConsoleShell.tsx`、`useApp.ts`（Page/PAGES/hash 解析）、`CommandPalette.tsx`、三个新容器页、各旧页面组件（改为可嵌入）。

**边界/风险**：页面级状态（Journal 筛选、Diary 选中日期）要提升到 store 或用 keep-alive；懒加载避免一次挂载 4 个重组件。旧路由必须可解析，否则书签失效。

**验收**：所有旧 hash 可打开正确页签；命令面板每一项都能到达；切换页签不重置筛选；导航从 15 项降到 7 项。

**估算**：3.5 人日。

---

### W11 评分 / 执行质量 / 审计降级（P1）

**为什么做**：三个低频页面占着一级导航，且与主页面重复。

**方案**：
1. **过程评分**：移出导航；概览的评分卡点击打开评分详情（保留独立路由 `#/score` 作为兼容入口）。页面本身不删。
2. **执行质量**：移出导航，成为「分析」页的「执行质量」页签（W10b 后）；路由 `#/executions` 兼容。补上未使用的 `byHour` / `maxSlippage`（要么展示，要么从接口删掉）。
3. **审计日志**：移出导航，作为设置新增「诊断」分区内容，保留「立即对账」；路由 `#/audit` 兼容。
4. 命令面板与旧深链同步更新。

**改动面**：`ConsoleShell.tsx`、`App.tsx`、`Overview.tsx`、`Reports.tsx`、`SettingsPanel.tsx`、`CommandPalette.tsx`。

**验收**：导航不再出现三项；旧路由仍可打开；概览评分卡可查看完整分量。

**估算**：1 人日（与 W10 有重叠，可合并实施）。

---

### W12 设置、命令面板与隐私收口（P1）

**为什么做**：设置里有一半是重复入口或占位文案；隐私模式覆盖不全，录屏时会漏金额。

**方案**：
1. **删占位**：移除「双介质界面」「第三方通道」「画线工具」三张纯说明卡；「自动检查 已启用」改成真实状态或删掉。
2. **Pine**：折叠到「实验」分组，保留警示文案与「保存后需刷新图表」。
3. **命令面板**：从 `SettingsPanel` 导出 NAV，设置快捷项自动覆盖 12 个分区（现在缺纪律与 AI）；导出日志的区间读取设置页当前选择，不再写死 30 天；补「新建复盘」「继续上次复盘」两条动作。
4. **隐私**：把 `usePrivacyMask` 应用到回放报告、参照面板、AI 面板；规则固定为「除交易台外全部遮金额」，并在 `lib/privacy.ts` 注释与测试中固化。
5. **深链**：空态使用 W4 的 `openSettings(section)`；设置页返回按钮回到来源页而不是永远概览（记录 `settingsReturn`）。

**改动面**：`SettingsPanel.tsx`、`CommandPalette.tsx`、`lib/privacy.ts`、`ReplayReport.tsx`、`ReferencePanel.tsx`、`AiReviewPanel.tsx`、`useApp.ts`。

**验收**：命令面板能到每个设置分区；隐私模式打开后回放报告无金额；无占位卡。

**估算**：1.5 人日。

---

### W13 图表自定义与模板收敛（P2）

**为什么做**：三个模板系统 + 49 种布局，选择成本高于收益，且有跨槽位串数据的 bug。

**方案**：
1. 指标模板与画线模板的 localStorage key 加槽位前缀（`${slot}:study-templates`），迁移旧 key 一次；修四图布局下面板位置共用的问题。
2. 模板面板加「导出/导入 JSON」（单人换机场景），或至少加删除确认（现状无确认）。
3. 布局选择器改为「常用 6 个 + 更多」，数据不变。
4. 指标/画线模板入口从图表左下角按钮保留，设置页说明卡删除（W12）。

**改动面**：`StudyTemplates.tsx`、`DrawingTemplates.tsx`、`LayoutPicker.tsx`、`ChartPanel.tsx`。

**验收**：四图布局各自独立模板与面板位置；旧模板迁移后仍在；布局选择器默认只显示 6 个。

**估算**：1.5 人日。

---

### W14 统计口径单一来源与黄金测试扩展（P1）

**为什么做**：W6 引入筛选与下钻后，口径分叉的风险会变高；现有 golden 只覆盖 summary。

**方案**：
1. 扩展 `testdata/stats_golden.json` 的 `expected`：`byHour`（含 offset）、`byDuration`、`byTag`、`profitFactor`、`expectancy`。
2. 后端 `journal.stats` 与前端 `lib/analysis.summarize/groupTrades` 各跑一遍，断言一致（现有 `test_stats_golden.py` + `analysis.golden.test.ts` 模式）。
3. 新增筛选测试：symbol/tag/result/reviewed 组合下，列表与统计的行集合一致。
4. 在 `docs` 里记录「新增指标必须先进 golden」的约定。

**改动面**：`testdata/stats_golden.json`、`gateway/tests/test_stats_golden.py`、`src/lib/analysis.golden.test.ts`、可能微调 `lib/analysis.ts`。

**验收**：golden 覆盖新增维度；两边断言全绿。

**估算**：1 人日。

---

### W15 杂项正确性（P0/P2 混合）

| 问题 | 位置 | 方案 | 估算 |
|---|---|---|---|
| 多图取整用全局品种参数 | `ChartPanel.tsx:330` vs `362-365` | 用槽位 `symbol` 的 `symbolInfo` | 0.2 天 |
| 详情弹窗截图页签入口不可达 | `Journal.tsx:309/390/442` | `has_shot` 时加截图按钮并传 `initialTab` | 0.2 天 |
| 全平无 busy / 无结果提示 | `PositionsPanel.tsx:115-127` | 与单仓平仓一致 | 0.2 天 |
| 回放创建「数据覆盖」是装饰 | `ReplayCreate.tsx:298-308` | 用真实缓存覆盖或删掉色条 | 0.3 天 |
| 缓存概览只算第一个品种 | `ReplayList.tsx:465-477` | 汇总所有品种 | 0.2 天 |
| 工作台删除无确认 | `ReplayWorkspace.tsx:511-521` | 与列表一致 | 0.2 天 |
| 报告与参照面板字段重复 | `ReplayReport.tsx` / `ReferencePanel.tsx` | 抽 `ReferenceSummary` 组件，报告只显示差异 | 0.5 天 |
| 回放图无指标/画线模板 | `ReplayChart.tsx` | P2，复用 W13 的面板 | 1 天 |

---

## 4. 明确不做（本轮）

| 不做 | 理由 |
|---|---|
| 挂单改手数 | MT5 不支持改量；撤单重下有穿价空窗 |
| 把历史数据迁移成 UTC | 无法反推历史 offset，等于篡改事实 |
| 让例行清单参与开仓门禁 | 语义不同；会让「没打勾」直接阻断下单 |
| 云端同步 / 多用户 / 社区 | 单人本地产品，凭据与隐私负担不值得 |
| 自动回测 / 参数优化 / tick 回放 | 与产品定位冲突，PRD 已列为非目标 |
| 重写统计引擎 | 现有 golden 已守住口径，重写风险大于收益 |
| 删除任何用户数据 | 所有迁移都是复制+切换，旧数据保留 |
| 移动端 / 响应式重做 | 当前是桌面终端场景 |

---

## 5. 排期与依赖

| 阶段 | 内容 | 人日 | 可并行 |
|---|---|---|---|
| **P0（约 1.5–2 周）** | W1 时间口径、W2 图表点价、W3 SL/TP、W4 交互一致性、W5 告警、W7a 复盘标记/回链、W8 回放持久化、W15 关键项 | 13–14 | W1 与 W8 后端独立；W2/W3/W4 都动 ChartPanel，需串行或同一人 |
| **P1（约 1.5 周）** | W6 日志/报表、W7b 错过进回放、W9 今日工作台、W10a 分组、W11 降级、W12 设置收口、W14 黄金测试 | 9–10 | W6 与 W10a 可并行；W9 依赖 W6 的 reviewed 字段 |
| **P2（约 1 周）** | W10b 合并页签、W13 模板收敛、W15 剩余项 | 6 | W10b 需要 W11 先完成 |

**冲突热点**：`ChartPanel.tsx`（W2/W3/W13/W15）、`Journal.tsx`（W1/W6/W7）、`useApp.ts`（W4/W6/W9/W10/W12）。建议按「同一个文件同一周只安排一个工作项」的原则排。

---

## 6. 回归与验证

每个 PR 必须满足：

1. `npm run check` 全绿（tsc + vitest + pytest）。
2. golden 统计测试不变或按 W14 扩展后更新；不允许为了过测试改期望值。
3. 数据迁移有 fixture 测试：旧 localStorage / 旧库 → 新库，数据条数与关键字段一致。
4. 预览验证：用假网关覆盖 UI（`preview_eval` 注入 gateway），至少走一遍本工作项的完整路径并截图。
5. 手动清单（发布前）：
   - 服务器时区非 0 的账户：日志/日历/报表时间一致（W1）
   - 无 SL 持仓补止损；挂单改 SL/TP（W3）
   - 三个入口撤单 + 撤销（W4）
   - 从日志/日历/散点进回放再返回（W7）
   - 关掉网关重启后回放会话仍在；备份恢复后仍在（W8）
   - 旧 hash 逐个打开（W10/W11）

---

## 7. 建议的开工顺序（每个是一个 PR）

1. **PR-1**：W1 时间口径（后端 + 共享格式化 + 测试）——独立、可先合。
2. **PR-2**：W2 + W4（ChartPanel 与订单交互一致性）——同一片代码，一次改完。
3. **PR-3**：W3（持仓/挂单 SL-TP）——依赖 PR-2 的 ChartPanel 结构。
4. **PR-4**：W8（回放持久化，含迁移与备份测试）——最大，单独一个 PR，便于回滚。
5. **PR-5**：W7（复盘状态、回链、错过进回放）+ W5（告警编辑）。
6. 之后按 P1 顺序：W6 → W14 → W9 → W10a/W11/W12 → P2。

每个 PR 都附：改动说明、验证结果、未覆盖项。

---

## 8. 我对这份方案的三点保留

1. **W8 的迁移是唯一有数据风险的动作**。我会做成「复制而非移动」，并保留本地副本一个版本；如果你希望更保守，可以先只做「导出/恢复」而不迁库（序列 D4-B）。
2. **W10b 的页面合并会改变肌肉记忆**。建议先上 10a 分组观察一周，再决定是否合并页签。
3. **W3 的「补止损记录初始风险」是既有语义**：用户在补止损后再次拖动，风险不会重算。改成重算会污染 R 统计，保持现状但要在 UI 上说明「初始风险按第一次补止损时的价格记录」。
