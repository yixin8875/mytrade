# 需求文档：交易 → 回放桥接、开仓纪律门禁

- 状态：**决策已确认（2026-11-15），待实施**
- 日期：2026-11-14（决策更新：2026-11-15）
- 关联文档：[REPLAY_PRD.md](REPLAY_PRD.md)、[TRADE_JOURNAL_BENCHMARK.md](TRADE_JOURNAL_BENCHMARK.md)
- 一句话：把「已经发生的交易」变成回放的起点，把「策略手册」从事后打分变成下单前的可选门禁。

---

## 0. 结论摘要

| 需求 | 做法 | 是否改网关数据库 | 优先级 |
|---|---|---|---|
| A. 交易 → 回放 | 在交易日志/交易详情里一键创建或回到「这笔交易」的回放会话，把真实成交、截图、笔记、规则检查作为只读参照层叠在回放图上；可一键重演 | 否（回放会话仍在本机 localStorage；笔记/截图走现有接口） | P0 |
| B. 纪律门禁 | 设置里可选 `关闭 / 二次确认 / 强制拦截`；未完成所选策略清单时，`order.place` 由网关按数据库状态判定，前端弹出清单与二次确认 | 是（新增 `pre_trade_gate`、`pre_trade_checks` 两张表） | P0 |

两条需求互不依赖，可以分别排期；A 以前端改动为主，B 需要网关与前端同时改。

---

## 1. 现状核对（以当前代码为准）

### 1.1 交易日志（Journal）

- 数据源：`journal.list` 返回 `JournalRecord`，字段包括 `login / position_id / symbol / side / volume / entry_price / exit_price / profit / swap / commission / open_time / close_time / duration_sec / mfe / mae / tag / closed_by / sl / tp / risk / risk_source / has_shot`。
- 列表行操作：`交易图`（打开 `TradeDetailModal` 的图表页签）、`复盘`（打开 `TradeReviewDrawer`）。
- `TradeDetailModal` 只有两个页签：
  - `图表`：`TradeChart` 用 `history.get` 拉取持仓时段的 K 线，画出入场/出场/持仓区间/SL/TP；
  - `截图`：`http://127.0.0.1:8765/shots/<login>/<position_id>.jpg`，旁边有 `.json` 价格锚点文件时会在图上标入场/出场。
- 笔记、评分、错误标签、规则检查都在 `strategy.tradeNote` 返回；规则勾选由 `strategy.check` 写入 `playbook_checks`。
- **没有**任何入口能进入「这笔交易发生时的可交互行情」；`TradeChart` 是静态重绘，不能前进/下单。

### 1.2 回放（Replay）

- 纯前端实现：`src/replay/*`，**没有**网关侧 `replay.*` 接口，也没有 `replay.db`（`docs/REPLAY_PRD.md` 里的网关侧方案尚未落地）。
- 会话保存在 `localStorage` 的 `mytrade.replay.sessions`，最多 60 个；K 线按 5000 根分块从 `history.get` 拉取，额外预取 1000 根 M1 做指标预热。
- `ReplaySession` 已有 `symbol / symbolInfo / startTs / endTs / settings / orders / positions / trades / notes` 等字段，但**没有**指向真实交易的引用。
- 路由：`#/replay/<id>`、`#/replay/<id>/report`。
- 回放引擎按 M1 推进，自带模拟成交、持仓、统计、报告；`dataSource` 可能是 `gateway`、缓存，或行情缺失时的 `demo`。

### 1.3 策略手册与规则检查

- `playbooks` 表：`id / login / name / description / rules(JSON 字符串数组) / archived_at`；`strategy.list/save/delete` 管理。
- `playbook_checks` 表：主键 `(login, position_id, rule)`，`followed` 为 1/0；只存在于**已平仓交易**的事后复盘里。
- `strategy.adherence` 在策略页按「遵守 / 违反 / 未评估」统计绩效。
- **下单链路完全没有引用 playbook**：`worker_trading.py` 的 `_place` 只检查手数、点差、持仓数、单笔风险、当日风控、保证金、重复单。

### 1.4 下单入口（门禁的唯一收口点）

- 全项目只有 `src/components/OrderTicket.tsx` 的 `send()` 调用 `order.place`。
- 流程：`handlePlace()` → 二次确认弹窗（`data-confirm="order"`）→ `send()`。
- 快捷键 `B` / `S` 只负责生成市价草稿，不直接发送，仍会走同一个确认弹窗。
- 因此门禁只需覆盖这一个前端入口 + `order.place` 一个网关命令。

---

## 2. 需求 A：从一笔已平仓交易进入回放

### 2.1 目标

1. 在交易日志或交易详情里，一键打开「这笔交易发生当时」的回放；
2. 回放里能同时看到真实成交、真实截图、当时的笔记/评分/规则检查，作为只读参照；
3. 可以在回放里「重演这笔」并和真实结果对照；
4. 全程不污染实盘统计：回放成交不写 `journal`、`executions`、`audit`。

### 2.2 非目标

- 不把回放成交合并进交易日志，也不改 `journal` 表；
- 不实现「自动评分 / 自动判定你当时该不该进场」；
- 不在此需求里迁移回放到网关数据库（仍沿用当前 localStorage 方案）；
- 不要求回放加载逐笔 tick；仍以 M1 OHLC 撮合，口径提示必须保留。

### 2.3 入口

| # | 位置 | 交互 | 阶段 |
|---|---|---|---|
| A1 | 交易日志列表行操作区（现有「交易图 / 复盘」旁） | 新增图标按钮「回放」 | P0 |
| A2 | `TradeDetailModal` 顶部右侧 | 新增「在回放中重演」主按钮 | P0 |
| A3 | `TradeDetailModal` 的截图页签 | 同一按钮，截图与回放可互相切换 | P0 |
| A4 | 日记（Diary）某日交易行 | 复用 A1 行为 | P1 |
| A5 | 统计报表 / 散点图点选 | 详情面板里打开回放 | P1 |
| A6 | 命令面板 | 「回放这笔交易」动作，作用于当前选中的交易 | P2 |

入口只在**已平仓**交易上出现；未平仓持仓没有 `JournalRecord`，不提供。

### 2.4 会话生成规则

点击入口后：

1. 先从 `symbols.list`（或缓存）取该品种的 `SymbolInfo`，确认当前终端认识这个品种；
2. 计算可见区间；
3. 查找是否已有绑定的回放会话；有则直接打开，没有则创建；
4. 创建后按现有 `loadSession` 流程拉 M1（缺失时按 1.2 的缓存 / demo 回退），进入工作台。

| 参数 | 默认值 | 说明 |
|---|---|---|
| 会话名 | `<symbol> 实盘复盘 #<position_id>` | 允许用户改名 |
| 品种 | 交易记录里的 `symbol` | 当前终端没有该品种时见 2.8 |
| 可见起点 | `open_time - 30 分钟` | 给「进场前的形态」留观察窗 |
| 可见终点 | `close_time + 30 分钟` | 给「出场后的走势」留观察窗 |
| 最短区间 | 起点到终点不足 60 分钟时，以 `open_time + 60 分钟` 为终点 | 避免剥头皮交易只有几根 K 线 |
| 预热 | 现有 `WARMUP_BARS = 1000` 根 M1，自动加在可见起点之前 | 指标预热，不算会话区间 |
| 初始资金 | 当前账户 `balance`（不可用时 10000） | 只影响回放收益百分比；报告需注明 |
| 币种 | 当前账户币种（不可用时 USD） | |
| 杠杆 | 100（与新建会话默认一致） | `SymbolInfo` 不保存账户杠杆 |
| 点差 | 当前品种点差（取不到时 20 点） | 报告需注明是「当前点差近似」 |
| 佣金 | 0 | 现有默认；可手动改 |
| 数据源 | `gateway` 优先，缓存次之，最后 demo | demo 时必须显著标注，见 2.8 |

**去重规则**：`reference.key = "<login>:<position_id>"`。已有同 key 且未归档的会话时直接打开最近一个；用户可在列表里手动「新建一份」再创建副本。删除会话后可以重新生成。

### 2.5 回放工作台里的「参照交易」层

工作台现有右侧面板页签为 `持仓 / 挂单 / 笔记 / 统计`，新增第五个页签 **`参照`**（P0）。

**图表叠加（默认开启，可切换隐藏）**

- 游标经过 `open_time` 后，在入场时刻画方向箭头 + 成交价标签；
- 从入场到游标之间画持仓区间底色；
- 持仓区间内画真实 SL / TP 虚线（`JournalRecord.sl / tp`，没有就不画）；
- 游标经过 `close_time` 后，在出场时刻画出场标记与盈亏标签（绿/红）；
- 标注文字一律带「实盘」前缀，避免和回放自己的成交混淆；
- 时间对齐使用 MT5 服务器时间戳（`journal` 与 `history.get` 同源，不需要再套时区）；
- 参照层永远只读，不能拖动、不能修改。

**「参照」页签内容**

| 区块 | 内容 |
|---|---|
| 摘要 | 方向、手数、入场/出场价与时间、持仓时长、盈亏、R、MFE/MAE、平仓方式、标签 |
| 当时的判断 | `strategy.tradeNote` 的评分、错误标签、笔记正文 |
| 当时勾选的规则 | 规则名 + 遵守/违反/未评估；没有复盘记录时显示「这笔还没复盘」并给「去复盘」按钮 |
| 截图 | 有 `has_shot` 时显示缩略图，点开复用现有截图查看逻辑（含价格锚点） |
| 操作 | 「重演这笔」「隐藏参照层」 |

加载策略：进入会话时并行请求 `strategy.tradeNote`（单笔，轻量），不要拉全量 `review.trades`；截图按需加载。

### 2.6 「重演这笔」与结果对照

**重演（P0）**

- 点击后把回放下单票预填为：同方向、同手数、同 SL/TP 绝对价、同标签；模板是否启用保持当前设置。
- 如果游标还没到 `open_time`：提示「跳到开仓前一根 M1」；当前引擎没有跳转能力，需新增 `seekTo(ts)`（P0 的一部分）。如果已过 `open_time`：允许重演，但提示「已晚于原始入场时间 N 分钟」。
- 预填后不自动发送，用户仍需正常确认；重演产生的回放订单带 `referenceRole: "retry"` 标记。
- 重演不需要真实资金，也不受需求 B 的门禁约束（回放模式的清单训练另列 P2）。

**对照（P1）**

- 回放结束（或手动点「对照」）时，在报告页新增「实盘 vs 重演」卡片：

| 指标 | 实盘 | 重演 |
|---|---|---|
| 方向 / 手数 | | |
| 入场、出场 | | |
| R | | |
| MFE / MAE | | |
| 持仓时长 | | |
| 出场方式 | | |

- 固定提示：实盘含真实滑点、隔夜利息；回放按 M1 保守撮合、不含隔夜利息，**只用于过程对照，不能据此断言「实盘比回放差」**（与 `REPLAY_PRD.md` §16.3 一致）。

### 2.7 数据模型与持久化

只改前端类型，不加网关表：

```ts
// src/replay/types.ts
export interface ReplayReference {
  kind: 'journal';
  login: number;
  positionId: number;
  symbol: string;
  openTs: number;
  closeTs: number;
  side: Side;
  volume: number;
  entry: number;
  exit: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  r: number | null;
  mfe: number | null;
  mae: number | null;
  tag: string | null;
  closedBy: string | null;
  hasShot: boolean;
  /** 去重键：login:positionId */
  key: string;
}

export interface ReplaySession {
  // ...现有字段
  /** 1 = 从实盘交易创建；缺省为普通会话 */
  origin?: 'manual' | 'journal';
  reference?: ReplayReference;
}
```

- `isSession` 校验保持向后兼容：旧会话没有 `origin/reference` 视为 `manual`。
- 持久化仍在 `mytrade.replay.sessions`；单个 reference 很小，不额外做缓存。
- 会话上限 60 个：创建参照会话会挤掉最旧会话。要求：创建前若已满，明确提示「将移除最旧会话 X」并允许取消；把参照会话在列表里用「来自实盘」标记（P1 可按来源筛选）。
- 重演订单在 `ReplayOrder` 上新增可选 `referenceRole?: 'retry'`；对照通过 `referenceRole` 找第一笔重演交易，找不到时让用户手动选一笔。

### 2.8 边界与失败处理

| 场景 | 行为 |
|---|---|
| 当前终端没有该品种（更名/下架/换券商） | 不创建会话，提示「当前 MT5 终端没有 EURUSD，无法对齐行情」+「选择替代品种」入口（P1） |
| 区间内完全没有行情 | 沿用现有回放：状态 `error`，提示「这段区间没有可用行情」，给出「换区间重试」 |
| 只能拿到缓存 / demo 数据 | 工作台顶部黄色横幅：`演示数据 · 不能作为真实行情对照`；参照层默认隐藏，需手动打开并再次提示 |
| 交易来自非当前账户 | 允许回放（只依赖品种与时间），参照卡片标注「账户 123456 · 当前终端为 789012」 |
| 交易时间早于终端可提供的 M1 | 提示实际可用起点，允许顺延；不静默截断 |
| 周末/节假日缺口 | 正常现象，不报错；持仓区间跨周末时按时间轴照常绘制 |
| 一笔持仓多次部分平仓 | P0 以 `JournalRecord` 汇总的入场/出场为准；P1 再从执行记录补逐笔成交标记 |
| 交易没有 SL/TP | 参照层不画对应线；R 显示「—」 |
| 已有同 key 会话 | 直接打开最近一个；列表提供「新建一份」 |
| 回放会话超过 60 个 | 创建前确认；确认后才移除最旧会话 |
| 会话被删除后再次点入口 | 重新创建 |

### 2.9 验收标准（A）

1. 交易日志任一已平仓行点击「回放」，能创建会话并进入工作台；区间默认覆盖 `open_time - 30min` 到 `close_time + 30min`。
2. 同一笔交易再次点击入口，打开的是同一个会话，不重复创建。
3. 游标越过开仓时间后，图表出现入场标记与持仓底色；越过平仓时间后出现出场标记；SL/TP 在持仓区间内可见；关闭参照层后全部消失。
4. 「参照」页签能显示方向/手数/价格/R/MFE/MAE/标签，并能加载该笔的笔记与规则勾选；没有复盘记录时显示空状态。
5. 有截图时能打开截图并看到入场/出场价格线；没有截图时按钮禁用并说明原因。
6. 点击「重演这笔」预填方向、手数、SL/TP、标签，且不会自动发送。
7. 该笔交易若使用 demo 数据，顶部明确显示「演示数据」，参照层默认关闭。
8. 创建参照会话不会产生 `journal`、`executions`、`audit` 记录（沿用 `REPLAY_PRD.md` 验收 9）。
9. 旧版本保存的 localStorage 会话仍能正常打开（无 `reference` 字段）。
10. 单元测试覆盖：`reference.key` 去重、区间计算、旧数据兼容、demo 数据下的降级标记。

---

## 3. 需求 B：开仓纪律门禁

### 3.1 目标

- 让策略手册的规则从「事后打分」变成「开仓前必须面对的一次检查」；
- 默认不打扰；开启后，未完成清单时下单需要二次确认；
- 严格模式下网关直接拒绝，且所有放行/拦截/强行下单都有审计；
- 不阻止平仓、改止损、保本等保护性操作。

### 3.2 模式与作用域

新增网关配置（写入 `gateway/config.json`，经 `system.getConfig / system.setConfig` 下发）：

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `discipline_mode` | `off` / `confirm` / `block` | `off` | 关闭 / 二次确认 / 强制拦截 |
| `discipline_playbook` | playbook id 或 `""` | `""` | 默认清单；票面可临时改选 |
| `discipline_require_reason` | bool | `false` | 强行跳过时是否必须填写理由 |

- 作用域：全局（与 `max_lot` 等全局风控同级）。按账户覆盖留到 P1，复用 `account_risk` 的覆盖机制。
- 只作用于 `order.place`（市价、限价、停损一视同仁）。
- **不作用于**：`position.close`、`position.closeAll`、`position.modify`、`position.breakeven`、挂单修改/撤销。保护性操作必须永远可达。
- 回放里的模拟下单默认不受门禁影响（P2 可加「回放训练模式」）。
- 只读模式本来就不能下单，门禁不改变这一点。
- 已确认（2026-11-15）：三档全部保留，默认 `off`；开关与默认清单全局一份，账户级覆盖留到 P1。

### 3.3 交互

**设置页**（`设置 → 交易与风控` 新增一张卡片「开仓纪律门禁」）

- 模式三选一：关闭 / 下单前二次确认 / 未完成则禁止下单；
- 默认清单下拉框（当前账户的 playbook 列表，空列表时提示先去「策略」创建）；
- 开关「强行下单时必须填写理由」；
- 文案明确：只拦新开仓，不拦平仓与改单；回放不受影响。

**下单向导**

```
┌─ 确认下单 ─────────────────────────┐
│ EURUSD · 买入 0.10 手 · 市价        │
│ 预估风险 25.00 (0.5%)              │
│                                    │
│ 开仓清单：日内突破 v2      [切换]  │
│ ✓ 只在关键位进场                   │
│ ✗ 没有追单                         │
│ ○ 止损放在结构外                   │
│ 已评估 2/3 · 违反 1                 │
│                                    │
│ [取消]        [确认发送]（禁用）    │
└────────────────────────────────────┘
```

规则行三态：`遵守` / `违反` / `不适用`（默认未评估）。全部规则都有评估结果才算「完成」；「不适用」视为已评估，但不计入遵守数。

| 状态 | `confirm` 模式 | `block` 模式 |
|---|---|---|
| 全部遵守 / 全部「不适用」 | 直接可发送 | 直接可发送 |
| 已全部评估，但有「违反」 | 需勾选「我已复核清单，仍然下单」；开启「必须填写理由」时还要填理由 | 必须填写理由并二次确认后才可发送，审计记 `discipline.override` |
| 仍有未评估规则 | 需勾选「我已复核」后才可发送 | 禁止发送，提示「还有 N 条规则未评估」 |
| 没有选清单 / 清单没有规则 | 显示「当前清单没有规则」，允许发送但写审计 `discipline.skipped` | 禁止发送，提示先配置清单 |

- 二次确认是**额外的**：原有的「确认下单」弹窗保留，清单放在同一弹窗内，避免三次点击；门禁状态与风险摘要同屏。
- 清单打开时即生成稳定的 `clientOrderId`；用户修改方向/手数/价格/SL/TP 后清空清单勾选并重新要求评估（手数变化不改变规则本身，但避免「按 A 计划勾选、按 B 计划下单」）。
- 快捷键 `B` / `S` 只生成草稿，仍然经过同一清单，不存在绕过路径。
- `block` 模式没有「跳过未评估」的入口：未评估项必须逐条勾选；违反项只能通过「填写理由 + 二次确认」放行。关闭门禁本身写审计。

### 3.4 数据模型

复用 `playbooks`；新增两张表（`gateway/store.py` 的建表段）：

```sql
-- 一次开仓尝试对应一行；client_id 与 order.place 的 clientOrderId 相同
CREATE TABLE IF NOT EXISTS pre_trade_gate (
    login INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    playbook_id TEXT,
    mode TEXT NOT NULL,              -- off | confirm | block
    state TEXT NOT NULL,             -- pending | passed | overridden | blocked | skipped
    rules TEXT NOT NULL DEFAULT '[]',-- 开单时的规则快照，防止清单被改后历史错位
    reason TEXT,
    position_id INTEGER,             -- 成交后回填，用于复盘关联
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (login, client_id)
);

CREATE TABLE IF NOT EXISTS pre_trade_checks (
    login INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    playbook_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    followed INTEGER,                -- 1 遵守 / 0 违反 / NULL 不适用
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (login, client_id, rule)
);
```

- `rules` 存规则原文快照（沿用 `playbook_checks.rule` 存原文的既有约定）。
- `client_id` 直接复用 `order.place` 的 `clientOrderId`，与 `intents`、`executions` 同键。成交后回填 `position_id` 的顺序：`executions.ticket` 与 `journal.position_id` 直接相等（市价单常见）→ 命中；否则用现有挂单计划同款的 comment 前缀 `client_id[:20]` 在持仓/成交里匹配；仍匹配不到就只保留审计记录，不强行关联。
- 迁移：`CREATE TABLE IF NOT EXISTS`，不动现有表；老库启动时自动补表。

### 3.5 接口

| 方法 | 参数 | 返回 | 用途 |
|---|---|---|---|
| `discipline.start` | `{clientOrderId, playbookId?}` | `{gate, rules:[{rule, followed}]}` | 打开清单，建 `pending` 行并快照规则 |
| `discipline.check` | `{clientOrderId, playbookId, rule, followed}` | `{gate}` | 保存单条勾选（`followed` 允许 `true/false/null`） |
| `discipline.state` | `{clientOrderId}` | `{gate, rules}` | 断线/重连后恢复 |
| `discipline.reset` | `{clientOrderId}` | `{gate}` | 用户修改票面后清空 |
| `order.place`（扩展） | 增加 `discipline: {clientOrderId, playbookId, confirmed, reason?}` | 同现有 | 网关自行读库判定，不信任前端传的勾选结果 |

错误码：

- `DISCIPLINE_BLOCKED`：`block` 模式下未完成/有违反 → 拒绝下单，`detail` 带 `missing`、`violated` 规则名；
- `DISCIPLINE_INCOMPLETE`：`confirm` 模式下未勾选二次确认 → 前端据此弹出清单，而不是弹普通错误。

`discipline.start` 时若 `clientOrderId` 已存在，返回已有状态（幂等）。

### 3.6 网关判定逻辑（`_place` 内，写 intent 之前）

```text
mode = cfg.discipline_mode
if mode == off: 跳过（不写 gate 行）
playbook_id = payload.discipline.playbookId 或 cfg.discipline_playbook
gate = store.pre_trade_gate_get(login, client_id)
if gate 存在且 state == passed/overridden: 放行（幂等重试）
rules = gate.rules（没有 gate 时用当前 playbook.rules 并建 pending）
checks = store.pre_trade_checks_get(login, client_id)
missing = [rule for rule in rules if rule 不在 checks]
violated = [rule for rule in rules if checks[rule] == 0]
if mode == block:
    if missing: 写审计 discipline.blocked + DISCIPLINE_BLOCKED   # 未评估一律拦住
    if violated:
        if not confirmed or not reason.strip(): 写审计 discipline.blocked + DISCIPLINE_BLOCKED
        写审计 discipline.override
elif mode == confirm and (missing or violated):
    if not payload.discipline.confirmed: 写审计 + DISCIPLINE_INCOMPLETE
    if require_reason and not reason.strip(): DISCIPLINE_INCOMPLETE
    写审计 discipline.override
else: 写审计 discipline.pass
order.place 继续原有风控检查
```

补充规则：

- 网关永远以 `pre_trade_checks` 的行为准，`confirmed` 只表示「用户接受风险」，不表示「清单已完成」。
- 「不适用」在 `pre_trade_checks` 里是 `followed = NULL` 的已评估行，不算缺失、不算违反；两种模式下都不触发拦截、也不要求理由。
- 门禁判定放在原有风控**之前还是之后**：建议放在 `_guard_trade` 之后、`_analyze` 之后、写 intent 之前；这样只读/风控拒绝时不必弹清单。
- `clientOrderId` 幂等：重复请求返回既有 intent 状态，不重复写 gate。
- 门禁异常（比如读库失败）：`block` 模式 fail-closed（报 `INTERNAL`，拒绝下单）；`confirm` 模式 fail-open 但写审计 `discipline.error`。此条需确认。

### 3.7 审计与复盘闭环

审计事件（`store.audit`）：

| 事件 | 关键字段 |
|---|---|
| `discipline.start` | clientId、playbookId、rules 数量 |
| `discipline.check` | clientId、rule（只记规则名前 40 字） |
| `discipline.pass` | clientId、playbookId |
| `discipline.override` | clientId、playbookId、missing、violated、reason |
| `discipline.blocked` | clientId、playbookId、missing、violated |
| `discipline.skipped` | clientId、原因（无清单/无规则） |
| `discipline.error` | clientId、异常摘要 |

复盘闭环：

- `TradeReviewDrawer` 增加「开仓时清单」区块：按 `client_id → position_id` 关联，显示开单时勾了什么、是否强行下单、理由；与现有「事后复盘」并列，两者不互相覆盖。
- 策略页的遵守度统计（`strategy.adherence`）P1 增加「开仓前完成率 / 强行下单率」，与事后评估分开展示。
- `pre_trade_gate` 里的 `rules` 快照保证：清单后来被编辑或归档，历史记录仍能正确显示。

### 3.8 边界与失败处理

| 场景 | 行为 |
|---|---|
| 未配置默认清单且票面没选 | `confirm`：允许但审计 `skipped`；`block`：拒绝并提示去设置 |
| 清单 0 条规则 | 同上，按「无规则」处理 |
| 清单在清单打开后被编辑/归档 | 以 `discipline.start` 时的 `rules` 快照为准，不改已勾选结果 |
| 断线重连 | 清单状态在网关库里，前端可用 `discipline.state` 恢复 |
| 重复点击发送 | `clientOrderId` 幂等；网关返回既有 intent |
| 券商拒绝/滑点失败 | 门禁只影响「是否允许提交」，成交失败仍按现有错误展示；gate 行保留便于复盘 |
| 用户中途取消 | 不删除 gate 行（保留 `pending`），同一 `clientOrderId` 重开时继续 |
| 账户切换 | gate 与 login 绑定，切账户后不复用 |
| 开仓清单无法关联到持仓 | 不阻断交易；`position_id` 留空，复盘抽屉只在能关联时展示「开仓时清单」，审计仍完整 |
| 只读 / 实盘开关关闭 | 原有检查先拒绝，不进入门禁 |
| 平仓、改单、保本、移动止损 | 永远不走门禁 |
| 回放下单 | 不走门禁（P2 另议） |

### 3.9 验收标准（B）

1. 默认 `off`：现有下单流程完全不变。
2. `confirm` 模式且全部规则勾选「遵守」：确认弹窗直接可发送，审计出现 `discipline.pass`。
3. `confirm` 模式且有未评估/违反项：发送按钮禁用；勾选「我已复核」后可发送，审计出现 `discipline.override` 且带缺失/违反规则。
4. `block` 模式且仍有未评估规则：网关返回 `DISCIPLINE_BLOCKED`，不写 intent、不产生订单；审计出现 `discipline.blocked`。
5. `block` 模式已全部评估但有违反：不填理由无法发送；填理由并二次确认后可下单，审计出现 `discipline.override`。
6. `block` 模式全部「遵守」或全部「不适用」：正常下单、无需理由。
7. 开启「必须填写理由」时，`confirm` 模式的强行下单未填理由无法发送。
8. 平仓/改单/保本/移动止损不受门禁影响。
9. 重复提交同一 `clientOrderId` 不重复写 gate，也不重复拦。
10. 打开清单 → 断线 → 重连后 `discipline.state` 能恢复勾选。
11. 清单被编辑后，历史交易的开仓清单仍显示开单时的规则快照。
12. 老数据库升级后自动建表，不影响现有 `playbook_checks / trade_notes`。
13. 单元测试覆盖：三种模式、无清单、0 规则、不适用、违反+理由、幂等、审计字段、fail-open/fail-closed 选择。

---

## 4. 分期与依赖

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| A-P0 | 入口（A1/A2/A3）、参照层、重演预填、去重与失败提示 | 现有 `journal`/`history.get`/`strategy.tradeNote` | 3–4 人日 |
| A-P1 | 对照报告、逐笔成交/截图、其他入口、来源筛选 | A-P0 | 3 人日 |
| B-P0 | 配置项、两张表、四个 discipline 接口、`order.place` 判定、清单 UI、审计 | 无外部依赖 | 3–4 人日 |
| B-P1 | 复盘抽屉「开仓时清单」、遵守度新增指标、按账户覆盖 | B-P0 | 2–3 人日 |

A 与 B 可以并行，但都改 `OrderTicket.tsx` 附近的交互时需协调。

---

## 5. 已确认的决策（2026-11-15）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 门禁档位 | 保留 `off / confirm / block` 三档，默认 `off` |
| 2 | 配置粒度 | 门禁开关与默认清单全局一份；账户级覆盖留到 P1 |
| 3 | 严格档口径 | 完成度门禁：未评估拒绝；违反需填理由 + 二次确认；不适用视为完成 |
| 4 | 无清单 / 0 规则 | `confirm` 放行并审计 `skipped`；`block` 拒绝并给「去设置」入口 |
| 5 | 参照区间 | 开仓前 30 分钟 → 平仓后 30 分钟，最短 60 分钟 |
| 6 | 重演跳转 | 新增 `seekTo(ts)`，可跳到开仓前一根 M1 |
| 7 | 清单回填复盘 | 尽力关联（ticket 直配优先，comment 前缀兜底）；关联不到只保留审计，不阻断交易 |

未决事项：无。实施时若这些结论有变化，以本节为准，并同步修改 3.3 / 3.6 / 3.9。

---

## 6. 影响文件清单（供排期参考）

**需求 A**

- `src/replay/types.ts`：`ReplayReference`、`origin`、`referenceRole`
- `src/replay/store.ts`：按 reference 创建/查找会话、去重、容量提示
- `src/replay/ReplayWorkspace.tsx`：参照页签与重演入口
- `src/replay/ReplayChart.tsx` / `src/chart/tv/*`：参照层价格线/标记
- `src/replay/ReplayReport.tsx`：对照卡片（P1）
- `src/views/Journal.tsx`、`src/components/TradeDetailModal.tsx`：入口按钮
- `src/replay/*.test.ts`：区间计算、去重、旧数据兼容

**需求 B**

- `gateway/config.py`：三个配置字段与校验、`public()`
- `gateway/store.py`：两张表与读写方法
- `gateway/worker_trading.py`：`_place` 门禁判定
- `gateway/mt5_worker.py`：`discipline.*` 分派与超时
- `gateway/review.py`：无需改动（事后复盘接口保持不变）
- `src/gateway/types.ts`、`src/gateway/client.ts`：配置与接口类型、超时
- `src/components/OrderTicket.tsx`：清单 UI 与二次确认
- `src/components/SettingsPanel.tsx`：门禁设置卡片
- `src/components/TradeReviewDrawer.tsx`：开仓时清单区块（P1）
- `gateway/tests/test_store.py`、`test_worker_trade.py`、新增 `test_discipline.py`
- `src/components/OrderTicket.test.tsx`（如有）
