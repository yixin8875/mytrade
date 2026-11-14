# Tally 界面重构与复盘功能方案

> 日期：2026-11-10  
> 状态：方案，尚未实施  
> 复盘功能的详细产品文档见 [REPLAY_PRD.md](REPLAY_PRD.md)；本文第 4 节为早期概述，具体规格以新文档为准。  
> 参考：用户提供的「xian 的复盘工具 / 复盘会话」截图（只参考布局与视觉语气，不复制其品牌、文案或业务内容）

---

## 0. 先回答：为什么手数是 0.5

0.5 不是券商限制，是 Tally 自己的风控上限。

- `gateway/config.json` 里 `"max_lot": 0.5`，代码默认值在 `gateway/config.py:25`。
- 自动手数：`gateway/mt5_worker.py:1477` 用 `vmax = min(券商的 volume_max, cfg.max_lot)`，所以目标手数超过 0.5 时会被截到 0.5，并给出「手数已到上限 0.5，未达到目标风险」的提示（`mt5_worker.py:1500-1501`）。
- 手动下单：`gateway/mt5_worker.py:1536-1537` 会直接拒绝超过 `max_lot` 的订单（错误码 `MAX_LOT`）。
- 还有第二道限制：`max_risk_pct` 默认 1%，按止损距离算出的本单风险超过净值 1% 时，`mt5_worker.py:1542-1547` 会拒绝（`RISK_LIMIT`）。所以只把 `max_lot` 调大，可能仍然被 1% 风险上限挡住。

当前代码里的 `max_lot: 0` **不是「不限制」**，而是把上限设成 0，订单会被拒绝。要放开需要填一个足够大的正数（例如 5 或 10），或改代码让 0 表示跟随券商上限。

修改方式：编辑 `gateway/config.json` 的 `max_lot`，重启网关。建议保留 `max_risk_pct`，不要同时去掉风险上限；手数上限防的是手滑，风险百分比防的是单笔亏损失控。

---

## 1. 现状：为什么感觉「所有东西挤在一个界面」

当前 `src/App.tsx` 只有一层页面：

```
TopBar（品种/周期/四图/主题/告警/日志/执行/审计/更新/账户/风控/急停/模式）
├─ ChartGrid（图表 + 下单线 + 持仓线）
└─ aside
   ├─ OrderTicket（下单票 + 手数/风险/模板）
   └─ 持仓 / 挂单 / 自选 三个标签
底部：StatusBar
浮层：AlertsModal / JournalPanel / ExecutionModal / AuditModal / DrawingTemplates / UpdatePanel
```

问题不在功能少，而在**导航层级**：

- 交易相关和「研究/复盘/设置」混在同一层，TopBar 按钮越来越多。
- 主题、四图、告警偏好、手数上限、更新检查分散在不同组件里，没有一个统一的「设置」入口。
- 交易日志、执行质量、审计都是全屏弹窗，关闭后回到图表，做「复盘」时缺少页面级的停留感。
- 右侧下单票常驻 320px，挤占图表；不交易时也一直占着。

---

## 2. 目标信息架构

### 2.1 左侧导航（参考截图的左侧栏）

固定宽度 200–220px，分组：

```
Tally
├─ 交易台
├─ 复盘          （后续新增）
├─ 日志
├─ 统计
└─ 设置
   ├─ 外观
   ├─ 图表
   ├─ 交易与风控
   ├─ 告警
   ├─ 更新
   └─ 数据与账户
```

底部固定显示：连接状态、账户类型、余额/净值、当前模式（只读/模拟/实盘）。急停按钮仍然放在交易台顶部，不放设置里。

### 2.2 页面拆分

| 页面 | 内容 | 从当前界面迁移 |
|---|---|---|
| **交易台** | 图表、下单票、持仓/挂单/自选、急停、模式切换 | 保留现有核心；TopBar 精简为品种/周期/账户/风控/连接 |
| **复盘** | 复盘会话列表、会话详情、回放、模拟交易、复盘报告 | 新增 |
| **日志** | 交易日志表格、按品种/时段/标签统计、截图查看、标签编辑 | `JournalPanel` 从弹窗改为整页 |
| **统计** | 执行质量、盈亏曲线、日/周/月统计、回撤 | `ExecutionModal` + 日志统计合并为页面 |
| **设置** | 主题、密度、图表布局、默认周期、手数/风险上限、告警偏好、更新、数据路径 | 从 TopBar、AlertsModal、OrderTicket、UpdatePanel 收敛 |

交易台顶部只保留：

- 品种、周期、四图/单图（高频）
- 账户/净值、风控胶囊、模式、连接状态（状态）
- 急停（安全）
- 「日志/统计/设置」改为左侧导航，不再放在 TopBar

### 2.3 设置页建议字段

**外观**
- 主题：浅色 / 深色 / 跟随系统
- 界面密度：紧凑 / 舒适
- 非交易页默认主题（可让复盘/日志始终浅色）

**图表**
- 默认布局：单图 / 2×2
- 默认周期
- 画线收藏、画线模板入口（现有 localStorage 数据迁移到设置页展示）
- 图表水印、十字线标签开关

**交易与风控**（只读展示 + 修改需二次确认）
- 单笔最大手数 `max_lot`
- 单笔最大风险 `max_risk_pct`
- 最大持仓数 `max_positions`
- 当日亏损上限 `daily_loss_pct`
- 当日开仓次数 `max_trades_per_day`
- 连亏冷却 `max_consecutive_losses` / `cooldown_minutes`
- 修改后写入 `gateway/config.json`，提示「需要重启网关生效」；不建议在 UI 里无提示地热改风控

**告警**
- 声音、桌面通知
- 第三方通道名称（只显示名称，不显示 token）

**更新**
- 当前版本、检查更新、自动检查开关、忽略的版本

**数据与账户**
- MT5 终端路径（只读）
- 账户类型、服务器（不在截图/分享中展示）
- 交易日志数据库、截图目录、审计目录
- 历史数据缓存（后续复盘用）

---

## 3. 视觉方向（参考截图）

截图给人的感觉是「安静的研究工作台」，不是「高密度交易终端」。可以借用这些原则：

- **大量留白**：页面四周 32px，卡片间距 16–24px，内容最大宽度约 1200px。
- **浅色纸感**：背景不是纯白，是略带灰的米白；卡片纯白；边框非常浅。
- **弱边框、弱阴影**：1px 浅灰边框 + 几乎看不见的阴影，不堆叠重色块。
- **一个强调色**：橙色只用于时间/提醒/主按钮，其他保持黑白灰。
- **数字用等宽/tabular**：盈亏、余额、手数右对齐，绿/红只用于涨跌。
- **标题有层级**：页面标题 24–28px，卡片小标签 11px 大写/加字距，正文 12–13px。
- **卡片化统计**：进行中、盈亏、交易笔数、复盘次数各一张小卡，不放在一条拥挤的工具栏里。

建议 token（浅色）：

| Token | 值 |
|---|---|
| 页面背景 | `#F6F6F3` |
| 卡片背景 | `#FFFFFF` |
| 边框 | `#E7E5DF` |
| 主文字 | `#1A1A1A` |
| 次要文字 | `#77756E` |
| 强调色 | `#E58A00` |
| 盈利 | `#1B7F5A` |
| 亏损 | `#C24A3F` |
| 圆角 | 12px（卡片）/ 8px（按钮） |
| 阴影 | `0 1px 2px rgba(0,0,0,.04)` |

不建议照搬截图里的品牌、Prop 公司名称、通过率模拟等业务内容；只借布局、留白、卡片和浅色语气。

深色主题继续保留给交易台；复盘/日志/统计可以默认浅色，减少长时间看盘后的视觉疲劳。图表本身继续用 TradingView 的浅色/深色主题跟随。

---

## 4. 复盘功能需要做什么

截图里的产品形态可以拆成四层：**会话 → 数据 → 回放/模拟交易 → 复盘报告**。Tally 已经有交易日志、MFE/MAE、截图和统计，缺的是「历史行情回放 + 模拟下单 + 会话化」。

### 4.1 产品形态

**复盘列表页**
- 顶部统计卡：进行中、累计盈亏、交易笔数、复盘次数
- 进行中的会话卡：继续复盘按钮、当前进度
- 会话表格：名称、品种/周期、时间范围、状态、盈亏、交易数、最大回撤、复盘次数、资金曲线缩略图
- 新建会话：选品种、周期、起止时间、初始资金、规则模板
- 状态：进行中 / 已结束 / 已归档

**会话详情页**
- 图表：只显示到当前回放时间点的 K 线
- 回放控制：播放/暂停、单步、速度（1x/2x/5x/10x）、跳转时间、重新开始
- 模拟下单票：市价/限价/停损、手数、SL/TP、风险预览
- 持仓/挂单/成交列表
- 右侧或底部：资金曲线、胜率、盈亏比、期望、最大回撤、R 倍数、MFE/MAE
- 笔记/标签/截图：记录当时为什么进场、错在哪里
- 结束会话：生成复盘报告，归档

### 4.2 数据模型（建议新增 SQLite 表）

```sql
replay_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  initial_balance REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,              -- running / finished / archived
  rules_json TEXT,                   -- 可选：Prop 规则/挑战模板
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

replay_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  volume REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  sl REAL,
  tp REAL,
  open_ts INTEGER NOT NULL,
  close_ts INTEGER,
  profit REAL,
  commission REAL DEFAULT 0,
  swap REAL DEFAULT 0,
  mfe REAL,
  mae REAL,
  tag TEXT,
  closed_by TEXT
)

replay_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  chart_ts INTEGER NOT NULL,         -- 对应 K 线时间
  price REAL,
  text TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
)

replay_bars_cache (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  data BLOB NOT NULL,                -- 压缩后的 OHLCV
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, start_ts, end_ts)
)
```

真实交易日志表 `journal` 不动；复盘数据单独存，避免复盘盈亏混进实盘统计。

### 4.3 行情数据

- 现有网关已经用 `mt5.copy_rates_range` 取历史 K 线（`gateway/mt5_worker.py` 的 `_history`），复盘优先复用。
- 第一版用 **M1 K 线回放**：数据量可控，任何券商都有；先把「按时间推进 + 模拟下单」跑通。
- 后续再加 tick 回放：`mt5.copy_ticks_range`，但券商 tick 历史通常只有几个月，数据量大，需要分块缓存和压缩。
- 会话创建时先检查数据覆盖范围，缺数据要提前提示；不要等到回放到一半才发现空白。
- 数据只存本机，不上传；缓存可按会话删除。

### 4.4 回放引擎

TradingView Advanced Charts **没有内置的 Bar Replay**（那是 TradingView 网站端功能），需要自己做一个回放 datafeed：

- 一个虚拟时钟 `cursorTs`，只把 `time <= cursorTs` 的 K 线交给图表。
- `getBars` 按当前 cursor 截断；定时器推进 cursor 后，通过 `subscribeBars` 的 `onRealtimeCallback` 推下一根 K 线。
- 用 `setVisibleRange` 让 cursor 保持在右侧；允许用户看历史，但不能看到 cursor 之后的未来数据。
- 播放/暂停/单步/速度/跳转都只改 `cursorTs`，不改真实时间。
- 切换周期时重新按 cursor 截断，避免泄漏未来数据。

### 4.5 模拟交易

复盘里的下单**绝不能走 MT5 下单接口**，必须是一个独立的模拟撮合器：

- 市价：按当前 bar 的 close/bid/ask + 点差成交
- 限价/停损：cursor 推进到触发价时成交
- SL/TP：用 bar 的 high/low 判断触发；同一根 bar 同时触发 SL/TP 时按保守顺序（先 SL）处理
- 手数、保证金、盈亏、隔夜利息/手续费按品种参数计算
- 资金曲线、最大回撤、R 倍数、MFE/MAE 从模拟成交算
- 可选把风控规则（单笔风险、日亏上限）应用到复盘，用于训练纪律

实现位置有两种：

- **前端 TS 引擎**：延迟低、和图表同步简单，但和网关的风控/盈亏公式会重复。
- **网关 Python 引擎**：复用现有 `order_calc_profit` 思路和风控逻辑，但每次推进要走 WebSocket，回放速度受往返延迟影响。

建议 MVP 先做前端 TS 引擎（纯函数、可单测），把「撮合/盈亏」抽成独立模块；后续需要严格复用风控时再下沉到 Python。无论哪种，复盘引擎和实盘执行必须物理隔离，不能调用 `order_send`。

### 4.6 复盘报告

会话结束后生成：

- 资金曲线、最大回撤、胜率、盈亏比、期望、平均 R
- 按品种 / 时段 / 标签分组
- 交易列表：入场/出场、持仓时长、MFE/MAE、出场方式、截图
- 笔记时间线：每条笔记对应图表时间点，点一下跳回当时
- 与实盘同口径的统计，方便对比「模拟复盘」和「真实执行」

现有 `gateway/journal.py` 的统计逻辑可以复用/抽公共函数，但数据源换成 `replay_trades`。

### 4.7 分期建议

| 阶段 | 内容 | 相对工作量 |
|---|---|---|
| **P0** | 左侧导航 + 设置页 + 手数上限展示（本次讨论的 1、2） | 小（1–2 天） |
| **P1** | 复盘会话 CRUD + M1 数据缓存 + 只读回放（播放/单步/速度） | 中（3–5 天） |
| **P2** | 模拟下单 + 持仓/成交 + 资金曲线 + 基础统计 | 中（3–5 天） |
| **P3** | 笔记/标签/截图 + 复盘报告 + 日历 | 中（2–4 天） |
| **P4** | tick 回放 + Prop 规则/挑战模板 + 通过率模拟 | 大（5–8 天） |

MVP（P0–P2）大约两周；完整版一个月左右。建议不要从 Prop 通过率模拟开始，它依赖会话、规则和数据模型，后面做更稳。

### 4.8 主要风险

- **数据可得性**：tick 历史受券商限制；第一版只用 M1，避免一开始就被数据卡住。
- **图表库限制**：没有内置回放，必须自定义 datafeed；要严格防止未来数据泄漏。
- **状态隔离**：复盘和实盘不能共用草稿/持仓/风控状态，否则容易误下单；用独立 session id 和独立 store。
- **性能**：M1 一年单品种约 37 万根，多品种要分块加载和索引；不要一次性把所有数据塞进前端。
- **合规/版权**：参考截图的布局语气即可，不复制第三方品牌、文案和专有功能。

---

## 5. 建议实施顺序

1. **先做 P0**：左侧导航 + 设置页 + `max_lot` 只读展示/可确认修改。它能立刻解决「设置散落」和「为什么是 0.5」的困惑，风险最低。
2. **再做交易台迁移**：把日志/统计/执行质量从弹窗改为页面，TopBar 精简，浅色主题按上面的 token 调整。
3. **最后做复盘 MVP**：P1→P2，先只读回放，再加模拟下单。这样每一阶段都能独立验收，不会一次性改动太大。

如果只想先解决手数问题，最小改动是：把 `gateway/config.json` 的 `max_lot` 改成你希望的值（例如 5），重启网关；同时在设置页/下单票显示「单笔上限 X 手」和「风险上限 Y%」，避免下次再猜。
