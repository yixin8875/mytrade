# 一键全清 + 图上分批止盈：开发文档

> 日期：2026-11-16 · 状态：全清与分批止盈均已实施 · 基线：v0.7.13（main @ 63f77d3）
> 范围：仅前端（React）与本机网关（Python/MT5），不改券商侧协议。

## 结论速览

| 功能 | 必要性 | 建议范围 | 预估 |
|---|---|---|---|
| 一键全清 | **有必要，但缺口不是「平仓」** | 平仓 + 撤销全部挂单；顺带修复急停漏撤挂单 | 1 人日 |
| 多次拖动分批止盈 | **有必要** | 图上多条可拖止盈线 + 每档平仓比例；复用模板阶段引擎 | 5 人日 |

一句话：**「平仓」已经有两个入口，「撤单」一个都没有；「分批止盈」的引擎已经写好，但入场后既看不见也改不了。** 两项都值得做，但都应该「补缺口」，而不是再造一套并行入口。

---

## 1. 现状盘点

### 1.1 与「全清」相关的现有能力

| 入口 | 行为 | 问题 |
|---|---|---|
| 持仓面板「全部平仓」`PositionsPanel.tsx:164-185` | 两击确认 → `position.closeAll` 平掉全部持仓 | 不撤挂单；只在有持仓时显示 |
| 顶栏「急停」`TopBar.tsx:101-141` | 两击确认 → `system.halt {closeAll:true}`，平仓并持久化停机 | **不撤挂单**；只读模式下会被 `_guard_trade` 拒绝 |
| 挂单面板 | 只能逐笔撤单 `OrdersPanel.tsx:14-22` | 没有批量撤单 |
| 回放模式 | 会话结束按最后价格平仓 `replay/store.ts:919` | 无挂单，不需要全清 |

**关键发现（安全缺口）**：`system.halt` 的平仓路径是
`TopBar.killSwitch` → `_halt` (`worker_risk.py:173-186`) → `_close_all` (`worker_trading.py:1178-1188`) → `_close_position`。
整条路径只碰 `positions_get`，**没有调用 `orders_get` / `_cancel_order`**。也就是说，急停之后券商侧的挂单仍然存活，价格触发时会开出新仓位，绕过「禁止再开仓」的语义。这不是体验问题，是急停的语义与实现不一致。

### 1.2 与「分批止盈」相关的现有能力

| 模块 | 现状 |
|---|---|
| 数据模型 | `TemplateStep { atR, closePercent, moveBreakeven }`，模板最多 8 档 (`types.ts:346-366`、`lib/template.ts:5-8`) |
| 下单 | 下单票启用模板后，`order.place` 带 `plan.steps`；市价单成交后登记到持仓，挂单成交后由 `_adopt_pending_template_plans` 接手 (`worker_trading.py:461-514, 1002-1052`) |
| 执行 | 网关每 0.4 秒检查浮盈，按 R 从小到大执行：先移保本（幂等），再按「当前剩余仓位」的百分比部分平仓 (`worker_risk.py:409-533`、`worker_trading.py:940-976`) |
| 持久化 | 计划存在 `state` 表的 `autoBreakeven` 键，按 login 隔离；重启恢复 (`worker_trading.py:865-892`) |
| 前端展示 | 只在**下单前**的计划条里显示文字阶梯；成交后图上只有券商 TP 一条线 (`ChartPanel.tsx:643-659, 1122-1145`) |
| 回放 | 回放引擎已能模拟 R 阶段分批与保本 (`replay/engine.ts:236-277`) |

**关键缺口**：
1. 成交后阶段计划**不可见**：`Position` 载荷里没有 `plan` 字段（`worker_risk.py:297-341`），图上没有阶梯线。
2. 成交后阶段计划**不可改**：没有 `position.plan.*` 接口；想临时调整只能去 MT5，或在图上反复点「平一半」。
3. 只能按 R 配置，不能按图上拖出来的价格配置；用户的心智是「把止盈线拖到 1.5R / 前高」，不是先算 R 再填表。

### 1.3 顺带发现的两个安全问题

| 问题 | 影响 | 建议 |
|---|---|---|
| 急停不撤挂单 | 停机后挂单仍可能成交 | 本次同批修复（见 5.2） |
| 只读模式下 `_close_position` 走 `_guard_trade`，平仓/急停会被拒 (`worker_risk.py:38-50`) | 紧急情况反而要先切模式，实盘还受 `allow_live` 约束 | 建议为「只减仓」动作开白名单；需产品确认（见 11） |

---

## 2. 必要性判断

### 2.1 一键全清：有必要，但只补「撤单」这一半

- 「平掉全部持仓」已经有「全部平仓」和「急停」两个入口，再创造一个「全清」按钮只会增加误点风险，也让三个按钮的语义更难解释。
- 真正缺的是**撤销全部挂单**：现在只能一笔一笔点；急停还漏掉了它。
- 因此建议的定义是：**全清 = 平掉全部持仓 + 撤销全部挂单**，不改变「急停」的停机语义。入口放在持仓面板（按当前持仓/挂单数量显示），命令面板提供同义命令；顶栏「急停」内部同样走全清路径。
- 「一键」指一次按钮操作 + 两击确认，不引入无确认的一键平仓。

### 2.2 多次拖动分批止盈：有必要

- 现状把「分批」拆成了三件互不相通的事：下单前配置模板（必须预判）、盘中反复点「平一半」（必须盯盘）、去 MT5 手工平仓（离开产品）。
- 底层 80% 已经存在：计划持久化、0.4 秒执行循环、部分平仓、保本、回放模拟。缺的是**价格维度的表达**和**成交后的可编辑 UI**。
- 拖拽是最贴合图表交易的操作方式：拖一条线就是定一个价位，比例在右侧小块上显示和修改。这比让用户先算 R 再填表更符合「图上交易」的产品定位。
- 结论：做「价格阶梯」，R 只作为派生显示；不要另做一套基于 R 的并行 UI。

### 2.3 优先级

1. **P0**：全清（含急停补撤单）——小改动，消除安全缺口。
2. **P1**：分批止盈阶梯——中等改动，补齐产品闭环。

### 2.4 明确不做

- 不做无确认的「单击即清仓」。
- 不做批量撤单的撤销：挂单价可能已经穿过，重新挂是另一笔新委托，不能承诺恢复。
- v1 不做回放模式的阶梯编辑（回放继续用现有 R 阶段；后续可只读渲染价格阶梯）。
- 不自动给每个持仓生成阶梯；模板产生的计划照常显示，手动阶梯按需添加。

---

## 3. 需求定义

### 3.1 全清

**用户故事**：盘中想一次性离场并清掉所有未成交委托，点一次「全清」，确认后看到「已平 3 个仓位、撤销 2 个挂单」。

规则：
1. 默认作用于全部品种；预留 `symbol` 参数，供以后做「只清当前品种」。
2. 先撤挂单，再平持仓，最后重新读一次账户状态；顺序不能反——先平仓的话，撤单期间可能又有挂单成交。
3. 单笔失败不回滚、不中断，逐笔返回结果；前端汇总显示成功/失败数量，失败原因进审计。
4. 确认文案带数量：`全清 3 个持仓 / 2 个挂单？`；4 秒内未确认自动取消。
5. 执行中按钮禁用并显示「全清中…」；结束后 toast。
6. 「急停」的 `closeAll:true` 复用同一套「撤单 + 平仓」实现，响应兼容旧字段并新增 `cancelled`。
7. 只读/终端未连接等前置错误按现有 `_guard_trade` 语义返回中文错误；是否放行只读见 11。

**验收**：
- 2 个持仓 + 2 个挂单 → 全清后两者都为 0，toast 数量正确。
- 急停后挂单为 0；`orders_get` 不再返回旧挂单。
- 其中一个挂单已被券商拒绝/消失时，其余仍继续执行，结果里带该 ticket 的错误。
- 重复点击第二次不会报错，返回空结果。

### 3.2 图上分批止盈阶梯

**用户故事**：持有多单 1.00 手，想 1R 平 50%、2R 再平 30%，在图上拖出两条绿色止盈线；价格到 1R 自动平 0.50 手，到 2R 再平 0.15 手，剩余 0.35 手由最终止盈或手动处理。

规则：
1. 每个持仓可挂 **1–4 档**（服务端上限沿用 8，UI 限制 4，避免图面拥挤）。
2. 每档字段：触发价、平仓比例（占**当时剩余仓位**的 1–99%）、可选「平后移保本」。
3. 触发价必须在盈利方向：多单高于开仓价、空单低于开仓价；按价格严格排序，不允许同价（半 tick 容差）。
4. 如果持仓已有券商 TP，所有档位必须在 TP 之前（多单 `< TP`、空单 `> TP`）；否则该档永远轮不到，保存时拒绝并提示「请先移动最终止盈或删除该档」。
5. 没有 TP 时允许保存，但面板提示「分批后剩余仓位没有最终止盈」。
6. 价格触及时：先移保本（若勾选、幂等），再按比例平仓；成功后该档标记完成，图上不再画该线，toast 提示。
7. 仓位小到拆不开（目标手数 < 最小手数或 ≥ 剩余仓位）时：不重复重试，标记跳过并 toast「仓位过小，已跳过 1R 分批」；该档保留为「已跳过」历史。
8. 计划持久化，重启网关/切换账户后恢复；持仓平掉后自动清理。
9. 只读或停机期间执行暂停（沿用现有 `_template_pause_reason`），但**允许编辑计划**；恢复可交易后继续。
10. 券商 TP 仍是最终全平出口；阶梯只负责提前减仓。App 关闭时只有 SL/TP 生效，阶梯不执行——这是已知限制，需要在 UI 与 README 写清楚。

**验收**：
- 多单 1.00 手，SL 距离 10 点；拖 1R/50%、2R/30% → 1R 成交 0.50 手，2R 成交 0.15 手，剩余 0.35 手。
- 拖到 TP 之外被拒绝，中文原因正确。
- 两档同价被拒绝。
- 重启网关后档位、完成状态保持。
- 只读模式下到价不平仓；切回模拟后下一轮继续。
- 平掉持仓后计划消失，图表不再残留线。

---

## 4. 数据模型

### 4.1 服务端计划（持久化在 `state.autoBreakeven`）

```jsonc
{
  "entry": 1.10000,          // 开仓价
  "risk": 0.00500,           // 1R 的价格距离（|entry - 初始SL|）
  "side": "buy",
  "steps": [
    {
      "id": "a1b2c3d4",      // 新增：稳定 id，拖动/删除按 id 定位
      "price": 1.10500,      // 新增：价格触发；旧计划没有此字段
      "atR": 1.0,            // 旧字段/模板字段；与 price 二选一
      "closePercent": 50,
      "moveBreakeven": false,
      "done": false,
      "skipped": false       // 新增：仓位拆不开时置 true
    }
  ],
  "templateId": null,
  "templateName": null,
  "source": "manual"        // template | manual
}
```

兼容规则：
- 旧计划只有 `atR`：触发价按 `entry ± risk * atR` 计算，行为不变。
- 新阶梯只有 `price`：触发直接用 `price`；`atR` 由服务端算出来只用于显示。
- 恢复时缺少 `id` 的旧步骤补 `legacy-<序号>`；`skipped` 缺省 false。

### 4.2 下发给前端的 `Position.plan`

```ts
export interface PositionPlanStep {
  id: string;
  /** 触发价（已按 tick 对齐） */
  price: number;
  /** 占当时剩余仓位的百分比；null = 只移保本 */
  closePercent: number | null;
  moveBreakeven: boolean;
  done: boolean;
  skipped: boolean;
  /** 派生显示：相对初始风险的倍数；没有止损时为 null */
  atR: number | null;
}

export interface PositionPlan {
  entry: number;
  risk: number;
  side: Side;
  steps: PositionPlanStep[];
  templateId?: string | null;
  templateName?: string | null;
  source: 'template' | 'manual';
}
```

`Position` 增加 `plan?: PositionPlan | null`。服务端只下发派生后的字段，不暴露 `next`（monotonic 时间戳）。

---

## 5. 后端设计

### 5.1 新增/变更 RPC

| 方法 | 请求 | 响应 | 守卫 | 超时（服务端/前端） |
|---|---|---|---|---|
| `order.cancelAll` | `{ symbol? }` | `{ results: {ticket, error?}[], remaining }` | `_guard_trade` | 18s / 22s |
| `trade.flatten` | `{ symbol? }` | `{ cancelled: {ticket, error?}[], closed: {ticket, volume?, error?}[], remaining: {positions, orders} }` | `_guard_trade` | 30s / 34s |
| `position.plan.add` | `{ ticket, price, closePercent, moveBreakeven? }` | `{ plan: PositionPlan }` | 无（仅连接） | 12s / 15s |
| `position.plan.update` | `{ ticket, stepId, price?, closePercent?, moveBreakeven? }` | `{ plan }` | 无 | 12s / 15s |
| `position.plan.remove` | `{ ticket, stepId }` | `{ plan }` | 无 | 12s / 15s |
| `position.plan.clear` | `{ ticket }` | `{ plan: null }` | 无 | 12s / 15s |

需要同步修改：
- `gateway/mt5_worker.py:400-500` 的 handler 表。
- `gateway/worker_base.py:120-160` 的 `COMMAND_TIMEOUTS` 与 `MUTATING_METHODS`（`trade.flatten`、`order.cancelAll` 加入 MUTATING；计划类不改券商状态，不加入）。
- `src/gateway/client.ts:8-30` 的前端超时表。

### 5.2 全清执行流程

新增 `_flatten(p)`（建议放在 `worker_trading.py`，挨着 `_close_all`）：

```python
def _flatten(self, p):
    self._guard_trade()
    symbol = p.get("symbol")
    cancelled = self._cancel_all_orders({"symbol": symbol})["results"]
    closed = self._close_all({"symbol": symbol})["results"]
    self._poll_trade_state()
    orders = [o for o in (mt5.orders_get() or []) if not symbol or o.symbol == symbol]
    positions = [x for x in self._positions if not symbol or x["symbol"] == symbol]
    payload = {
        "cancelled": cancelled,
        "closed": closed,
        "remaining": {"positions": len(positions), "orders": len(orders)},
    }
    self.store.audit("trade.flatten", payload)
    return payload
```

- `_cancel_all_orders`：快照 `mt5.orders_get()`，过滤 `symbol`，逐笔调用现有 `_cancel_order`；单笔失败收集错误继续。它会顺带清掉挂单模板计划（`worker_trading.py:643-646`）。
- `_halt` 的 `closeAll` 分支改为调用 `_flatten({})`，返回里保留 `closed`，新增 `cancelled`；`store.audit("system.halt", ...)` 带上两个数量。
- 幂等：第二次调用时快照为空，返回空数组；不会重复平仓。
- 顺序理由写在代码注释里：先撤单避免「平仓过程中挂单成交」。

### 5.3 批量撤单

`_cancel_all_orders` 独立成方法，`order.cancelAll` 和 `_flatten` 共用。**不提供撤销**：已有单笔撤单的 6 秒撤销（`orderActions.ts`）依赖原参数重挂；批量重挂无法保证价格仍在、也无法原子恢复，索性明确不支持。

### 5.4 阶梯校验（`position.plan.*`）

统一入口 `_plan_step_input(p, position, plan)`，规则：

1. `ticket` 必须存在；`position` 从 `positions_get` 重新读取，禁止只信前端。
2. `price` 有限、`> 0`、按 `align_price` 对齐 tick。
3. 方向：`buy` 要求 `price > entry + tick/2`；`sell` 要求 `price < entry - tick/2`。这里**不套用 `trade_stops_level`**——它不是券商挂单，距离可以很近。
4. 若 `position.tp` 存在：`buy` 要求 `price < tp - tick/2`，`sell` 要求 `price > tp + tick/2`；否则 `GatewayError("PLAN_BEYOND_TP", "该档在最终止盈之后，不会触发")`。
5. `closePercent`：1–99 的数字；`add` 必填，`update` 可省略。允许小数，显示时保留 0–2 位。
6. 同价档：与其它未完成档位相差小于半个 tick 时拒绝 `PLAN_DUPLICATE`。
7. 上限 8 档（`MAX_PLAN_STEPS`）；UI 限制 4。
8. `moveBreakeven` 强制布尔。
9. `entry/risk` 的来源优先级：已有计划 → 持仓风险表 `store.position_risk_map(login, [ticket])` 里最早的记录 → 当前 SL 与开仓价的距离 → `risk=0`（允许，只是不显示 R）。
10. 编辑计划**不要求**交易模式（`_guard_trade`），因为不发券商请求；执行才受只读/停机限制。这点要在审计和 UI 文案里写清楚。

新增审计：`position.plan.add|update|remove|clear`，payload 带 `ticket`、`stepId`、最终 steps 与 `source`。拖动改价走 320ms 节流（复用 `lib/modifyQueue.ts`），不会打爆审计。

### 5.5 执行循环改造

`worker_risk.py:_auto_breakeven` 的改动最小化：

```python
steps = self._plan_steps(plan)
step = next((s for s in steps if not s.get("done")), None)
...
trigger = float(step["price"]) if step.get("price") else (
    entry + risk * at_r if buy else entry - risk * at_r
)
if (buy and price < trigger) or (not buy and price > trigger):
    continue
```

- 排序：`_normalize_plan_steps` 与恢复路径统一按「触发价 + 方向」排序；价格与 R 混合时先算触发价再排。
- 完成后 `step["done"] = True`，保留计划不删除（用于面板历史）。**变更点**：现有代码在全部阶段完成时 `pop` 计划（`worker_risk.py:529-530`），改为只在持仓消失时 `pop`；`_auto_breakeven` 仍需在每轮开头清理已不存在的持仓。
- 部分平仓返回 `None` 时：设置 `done=true, skipped=true`，审计 `position.plan.step.skipped`，发一次 toast 事件；不要每 0.4 秒重试。
- 执行成功后 `_poll_trade_state()`；因为 `_position_payload` 现在带 `plan`，前端会收到更新后的 `positions` 事件，图上的线和面板自动刷新。

### 5.6 防重复平仓（幂等）

现有 `_auto_partial_close` 在「券商已成交但响应超时」时会抛错，下一轮（3 秒后）可能再平一次。阶梯功能把这个问题放大（用户会盯着每一档），建议同批加固：

- 部分平仓的 `comment` 从 `tpl-partial` 改为 `plan-<stepId>`（模板阶段用 `tpl-<atR>`）。
- 发单前先查 `mt5.history_deals_get(position=ticket)`，如果已有同 comment 的成交，直接认为该档完成，不再发单。
- 查历史失败时按「没成交」处理（保持现有行为），但审计记录查询异常。

### 5.7 持久化与账户

- 继续使用 `state.autoBreakeven`（`worker_trading.py:865-892`），按 login 隔离；新增字段随 dict 一起落盘，无需迁移。
- `_restore_auto_be` 补 `id`、`skipped`、`price` 的兼容；`next` 重置为 0。
- 账户切换时确认 `_auto_be` 重新加载（现有 `_switch_account` 流程），补一条 pytest。
- 持仓 ticket 在 netting 合并后会变化：沿用 `_register_pending_plan` 的 `ticket_replaced` 思路，阶梯按 `comment`/`identifier` 重新挂靠；找不到就丢弃并审计 `position.plan.dropped`（v1 可接受）。

### 5.8 事件与审计

- `positions` 事件：`Position.plan` 一起下发。
- 复用 `templateStep` 事件并扩展：`{ ticket, symbol, stepId, price, atR, volume, skipped, source }`。`App.tsx:165-173` 的 toast 文案区分「分批止盈」与「仓位过小已跳过」。
- `autoBreakeven` 事件保持不变（移保本）。
- 新审计：`position.plan.step`（成功）、`position.plan.step.skipped`、`position.plan.step.failed`、`trade.flatten`、`order.cancelAll`。

---

## 6. 前端设计

### 6.1 类型与状态

- `src/gateway/types.ts`：新增 `PositionPlanStep` / `PositionPlan`，`Position.plan`。
- 不需要新增 zustand 状态：计划随 `positions` 推送更新。
- 新增纯函数模块 `src/lib/plan.ts`（便于单测，不依赖图表）：
  - `stepTrigger(step, plan)`：返回价格；
  - `stepAtR(step, plan)`：派生 R；
  - `nextStepPrice(position, plan)`：新增档的默认价（下一个未被占用的 1R/2R/3R，且不超过 TP）；
  - `validatePlanStep(input, position, plan)`：镜像服务端规则，返回中文错误；
  - `estimateStepLots(volume, steps)`：按顺序演示每档手数与剩余；
  - `planSummary(plan)`：`1R 平50% · 2R 平30%`。

### 6.2 图表渲染

`ChartPanel.tsx` 现有两条通道：价格线（`priceLines.ts`）和右侧小块/区间（`ChartChips.tsx`）。

1. **价格线**：为每个 `!done && !skipped` 的档位画一条绿色水平线，key = `plan:<ticket>:<stepId>`。
   - 颜色用比券商 TP 略浅的绿（如 `#4db6ac`），并加虚线区分：给 `PriceLineSpec` 增加 `linestyle?: number`，`priceLines.ts` 在 `setColor` 之外增加 `setStyle`（`linestyle: 2`）。
   - `editable` 默认 true；`onMove` 走 `moveTo`，节流 key 用同一个 key。
   - 超出 TP 的档位（理论上保存时会被拒，但 TP 可能后来被拖近）画灰色虚线、`editable:false`，chip 文案 `超出止盈`。
2. **右侧小块**：每个档位一个 chip，颜色同上，文案：
   - 有 R：`50% · 0.25手 · 1.0R`
   - 无 R：`50% · 0.25手`
   - 已完成/跳过不画线，也不在图上留 chip（在面板里看历史）。
   - `onMove`：`moveTo(key, step.price, price, v => gateway.call('position.plan.update', { ticket, stepId, price: v }))`。
   - `onRemove`：`position.plan.remove`，成功后 toast「已删除 1R 分批」。
3. **R 刻度带**：v1 不改 `addBands`。现有 1R/2R 刻度已经能帮助对齐；避免在绿色带里再叠一层标签。
4. **乐观价格**：沿用 `optimisticPrices`，key 用 `position:<ticket>:plan:<stepId>`，12 秒兜底；失败时 `clearOptimistic` + toast。

### 6.3 持仓面板（添加/编辑入口）

`PositionsPanel.tsx` 每行增加「分批」按钮，展开一个编辑区：

```
分批止盈（占当前剩余仓位）
[1.10500] [50]%  [ ]平后移保本  [删除]
[1.11000] [30]%  [x]平后移保本  [删除]
+ 添加一档     剩余约 0.35 手 · 最终止盈 1.12000
```

- 新增档默认价：`nextStepPrice`（1R、2R、3R…中第一个未被占用且早于 TP 的价位）；没有 R 基准时，多单取「现价与 TP 的中点」，无 TP 时取 `+0.2%`，空单镜像。
- 价格输入失焦/回车即发 `position.plan.update`；比例输入同理。不要做一个总「保存」按钮——拖拽和逐格提交更符合图上下单的习惯。
- 每档实时显示预计手数（按当前剩余手数顺序取整到 volume step），若某档拆不开，行内红字提示并禁止保存该档。
- 行内校验用 `validatePlanStep`；服务端仍会再校验一次，错误原样 toast。
- 空态文案：「还没有分批止盈。添加一档后可直接在图上拖动」。
- 仓位等于最小手数时禁用「添加一档」，提示「仓位已是最小手数，无法分批」。

### 6.4 全清入口

1. **持仓面板标题栏**（`PositionsPanel.tsx:196-208`）：
   - 订阅 `orders`，当 `positions.length + orders.length > 0` 时显示「全清」。
   - 两击确认：第一击按钮变为 `全清 3仓/2单？`，4 秒后复原；第二击发 `trade.flatten`。
   - 进行中禁用并显示 `全清中…`。
   - 结果 toast：`已平 3 个仓位、撤销 2 个挂单`；有失败时 `已平 2/3，撤单 1/2，1 个失败`。
2. **挂单面板标题栏**：有挂单时显示「全部撤销」，同样两击确认，调用 `order.cancelAll`；文案明确「不支持撤销」。
3. **顶栏急停**：不新增按钮；`system.halt` 返回的 `cancelled` 计入 toast：`已停机，平 3 个、撤 2 个挂单`。
4. **命令面板**：新增「全清：平掉全部持仓并撤销全部挂单」，执行前仍走确认（命令面板已有 `run` 的异常处理，直接调用同一处理函数）。
5. 只读/未连接时禁用并给 title 提示，避免用户点了才看到错误。

### 6.5 文案规范

| 场景 | 文案 |
|---|---|
| 全清确认 | `全清 3 个持仓 / 2 个挂单？` |
| 全清成功 | `已平 3 个仓位、撤销 2 个挂单` |
| 全清部分失败 | `已平 2/3，撤单 1/2，1 个失败` |
| 急停成功 | `已停机，平 3 个、撤 2 个挂单` |
| 添加档位 | `已添加 1R 分批：平 50%` |
| 到价执行 | `分批止盈：XAUUSD 到 1.0R，平 0.25 手` |
| 仓位过小 | `仓位过小，已跳过 1.0R 分批` |
| TP 之外 | `该档在最终止盈之后，不会触发` |
| 无最终止盈 | `分批后剩余仓位没有最终止盈` |
| 只读暂停 | `阶段已暂停：只读模式，恢复可交易后继续`（沿用现有） |

### 6.6 可测试性

把「根据 position + plan 生成价格线/小块规格」抽成纯函数（例如 `src/lib/planChart.ts`），返回 `{ lines, chips, bands }` 的描述，`ChartPanel` 只负责喂给图层。这样不依赖 TradingView 也能单测排序、超出 TP、跳过、R 计算。

---

## 7. 边界与风险

| 场景 | 处理 |
|---|---|
| 券商 TP 比某档更近 | 保存时拒绝该档；TP 后来被拖近时，该档画灰线并标记「超出止盈」，不执行 |
| App 关闭 / 网关退出 | 阶梯不执行；SL/TP 仍由券商守护。README 与面板提示写明 |
| 仓位小于最小手数 | 添加档位禁用；执行时跳过并 toast，不无限重试 |
| 两档同价 / 价格在开仓价错误一侧 | 前端行内拦截 + 服务端拒绝 |
| 拖动过程中频繁改价 | 复用 `modifyQueue` 320ms 节流 + 每档独立 key |
| 券商已成交但响应丢失 | 用 `plan-<stepId>` comment 查历史成交，避免重复平仓（见 5.6） |
| netting 合并导致 ticket 变化 | 按 comment/identifier 重新挂靠；找不到则丢弃并审计 |
| 多账户切换 | 计划按 login 隔离；切换后重新加载，补测试 |
| 手动平仓/部分平仓 | 计划保留，比例作用于新剩余手数；持仓消失后清理 |
| 移动止损与阶梯同时存在 | 互不冲突：保本/移损只动 SL，阶梯只减仓 |
| 多图同品种 | 每张图都画同一组线；编辑通过 `positions` 事件同步 |
| 只读 / 停机 | 执行暂停，允许编辑；恢复后继续 |
| 重复点击全清 | 第二次快照为空，返回空结果，不报错 |
| 撤单与平仓并发 | 固定先撤后平；平仓后重新检查挂单并计入 `remaining` |

---

## 8. 测试计划

### 8.1 pytest（网关）

新增/扩展：

- `gateway/tests/test_plans.py`
  - 价格步骤清洗：正数、tick 对齐、方向、排序、去重、上限。
  - 混合 R/价格步骤的触发价计算。
  - 旧计划恢复补 `id`、`skipped`。
  - 全部完成后保留计划，持仓消失才清理。
  - 部分平仓返回 None → `skipped` + 审计 + 只执行一次。
- `gateway/tests/test_ladder.py`（新）
  - `position.plan.add/update/remove/clear` 的校验与审计。
  - TP 之外、同价、错误方向、超上限的拒绝文案。
  - 只读模式下编辑允许、执行暂停；恢复后继续。
  - 重启恢复与账户切换。
  - 幂等：历史里已有 `plan-<stepId>` 成交时不重复发单。
- `gateway/tests/test_flatten.py`（新）
  - `order.cancelAll` 全部成功/部分失败。
  - `trade.flatten` 先撤后平、剩余数量、重复调用。
  - `system.halt {closeAll:true}` 会撤挂单，响应兼容 `closed` 并带 `cancelled`。
  - 只读模式下的守卫行为（按最终产品决定）。

### 8.2 vitest（前端）

- `src/lib/plan.test.ts`：`stepTrigger` / `stepAtR` / `nextStepPrice` / `validatePlanStep` / `estimateStepLots` / `planSummary`。
- `src/lib/planChart.test.ts`：排序、跳过/完成过滤、超出 TP 的灰线、同价 chip 错行输入。
- `src/components/PositionsPanel.test.tsx`：
  - 有持仓/挂单时显示「全清」，两击调用 `trade.flatten`。
  - 分批编辑区添加/改价/删除调用对应 RPC，失败 toast。
  - 仓位最小手数时禁用添加。
- `src/components/OrdersPanel.test.tsx`：「全部撤销」两击调用 `order.cancelAll`。
- 现有 `npm run check`（`tsc --noEmit` + vitest + pytest）必须全绿。

### 8.3 手工验收（模拟账户）

1. 开 2 个持仓、挂 2 个限价单 → 全清 → 持仓/挂单都归零，审计有 `trade.flatten`。
2. 急停 → 挂单也被撤；恢复交易后不再有旧挂单。
3. 多单 1.00 手，设 SL；面板加 1R/50%、2R/30%；图上出现两条线；拖动第二条到 2.5R，松手后线停在 2.5R，面板同步。
4. 价格到 1R：平 0.5 手，toast；到 2.5R：平 0.15 手；剩余 0.35 手。
5. 重启应用：两条线仍按完成状态显示（未完成的可继续拖）。
6. 只读模式到价不平；切回模拟后继续。
7. 手动平掉持仓：计划消失。
8. 关闭网关等价格触及：只有 SL/TP 生效，阶梯不执行（预期）。

---

## 9. 实施计划

### Phase 0：安全缺口（0.5 人日）

- `gateway/worker_trading.py`：`_cancel_all_orders`、`_flatten`。
- `gateway/worker_risk.py`：`_halt` 复用 flatten。
- `gateway/mt5_worker.py`、`worker_base.py`：注册与超时。
- `gateway/tests/test_flatten.py`。

### Phase 1：全清 UI（0.5 人日）

- `src/gateway/types.ts`、`src/gateway/client.ts` 超时。
- `PositionsPanel.tsx`「全清」；`OrdersPanel.tsx`「全部撤销」；`TopBar.tsx` toast；`CommandPalette.tsx` 命令。
- `PositionsPanel.test.tsx`、`OrdersPanel.test.tsx`。

### Phase 2：阶梯后端（1.5 人日）

- 计划模型扩展（id/price/skipped）、清洗、校验、add/update/remove/clear。
- `_position_payload` 带 plan；执行循环改价格触发；完成保留；跳过语义。
- 幂等 comment + 历史成交检查。
- 持久化/账户/恢复测试。

### Phase 3：阶梯图表（1.5 人日）

- `priceLines.ts` 支持虚线。
- `ChartPanel.tsx` 画线 + chip + 拖动/删除；`lib/planChart.ts` 抽纯函数。
- 乐观价格与错误回退。

### Phase 4：面板编辑与收尾（1 人日）

- `PositionsPanel.tsx` 分批编辑区（添加、改价、比例、保本、删除、手数预览）。
- 文案、README/USER_GUIDE 更新。
- 全量 `npm run check` + 手工验收。

**合计约 5 人日**（不含评审与真实账户验证）。

---

## 10. 兼容与迁移

- 旧模板计划（只有 `atR`）无需迁移，执行路径保持。
- 新增 RPC 是纯增量；旧前端忽略 `Position.plan` 字段即可。
- `templateStep` 事件只增加字段，不删旧字段；旧前端 toast 不受影响。
- `system.halt` 响应保留 `closed`，新增 `cancelled`；旧前端最多不显示撤单数量。
- `state.autoBreakeven` 结构向后兼容；恢复时补默认值。
- 计划文件/数据库无需 schema 升级（state 表存 JSON）。

---

## 11. 待确认的产品决策

1. **只读模式下是否允许「全清/急停」平仓？**
   现状：`_close_position` 走 `_guard_trade`，只读会被拒。建议：为只减仓动作开白名单（只校验连接、终端自动交易、账户允许交易），因为紧急离场不应该要求先切模式；但这会改变现有「只读=完全只读」的语义，需要你确认。
2. **急停是否必须撤挂单？**
   本文按「必须」设计。若希望保留现有急停语义，可只把撤单放进「全清」，但那样急停仍有挂单成交的缺口。
3. **UI 档位上限 4 是否够用？**
   服务端保持 8；如果用户习惯 5 档以上，图表会开始拥挤，建议先 4 档，观察反馈。
4. **阶梯是否允许「立即触发」的价位（已穿过现价）？**
   本文允许：拖动到现价附近时下一轮就执行，toast 提示。若希望完全禁止，可在 `add/update` 增加「必须比现价更远一个 stops_level」的校验。

---

## 12. 实施记录（2026-11-16）

「全清 + 批量撤单」已按本文第 5–8 节落地；分批止盈尚未开始。

### 12.1 已实施

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 网关 | `gateway/worker_trading.py` | 新增 `_cancel_all_orders`（逐笔复用 `_cancel_order`，单笔失败不影响其它单）与 `_flatten`（先撤单、再 `_close_all`，返回最新快照的 `remaining`） |
| 网关 | `gateway/mt5_worker.py` | 注册 `order.cancelAll`、`trade.flatten` |
| 网关 | `gateway/worker_base.py` | 命令超时 `18s` / `30s`，两者加入 `MUTATING_METHODS` |
| 网关 | `gateway/worker_risk.py` | `system.halt` 的 `closeAll` 分支改走 `_flatten`，响应新增 `cancelled` |
| 网关 | `gateway/tests/test_flatten.py`（新增） | 撤单成功、单笔失败隔离、按品种过滤、先撤后平顺序、`remaining` 快照、急停复用 `_flatten` |
| 前端 | `src/gateway/types.ts` | `BulkActionItem`、`CancelAllResult`、`FlattenResult` |
| 前端 | `src/gateway/client.ts` | `order.cancelAll` 22s、`trade.flatten` 34s |
| 前端 | `src/components/PositionsPanel.tsx` | 表头「全清」二次确认；结果 toast 汇总成功/失败/剩余 |
| 前端 | `src/components/OrdersPanel.tsx` | 表头「全部撤销」二次确认；toast 汇总成功/失败/剩余 |
| 前端 | `src/components/TopBar.tsx` | 急停 toast 同时报告平仓数与撤单数 |
| 文档 | `README.md`、`docs/USER_GUIDE.md` | 功能说明、操作步骤、急停撤单语义、变更 RPC 列表 |

### 12.2 与设计稿的差异

- **未做「批量撤销可回滚」**：原价可能已被穿过，重挂是另一笔委托，回滚会造成错误预期；UI 的 `title` 明确写「不支持撤销」。
- **未做命令面板的「全清」动作**：避免在无二次确认的入口暴露破坏性操作。
- **未改 `_guard_trade` 语义**：只读模式下依然拒绝全清/撤单，对应第 11 节第 1 条仍是开放决策。
- **`order.cancelAll` 返回 `remaining` 为数字**（而非列表），与设计稿的 `remaining: number` 一致；`trade.flatten` 的 `remaining` 是 `{positions, orders}` 计数。

### 12.3 验证结果

- `npx tsc --noEmit`：通过。
- 后端 `pytest gateway/tests`：599 项通过。
- 前端 `vitest`：614 项通过（需 `--testTimeout=15000`；默认 5s 下 `src/replay/ReplayList.test.tsx > ReplayList 软上限提示` 在整包并发时偶发超时约 5.7s，单独运行 8 项 3.9s 通过，与本次改动无关）。

### 12.4 下一步

- 分批止盈按第 4–6 节实现：`position.plan.*` RPC + 图表多档拖拽价格线 + `worker_risk.py` 档位执行。
- 待你确认第 11 节第 1 条（只读模式是否放行只减仓动作），再决定是否调整 `_guard_trade`。

### 12.5 后续调整：全清改为当前品种（2026-11-16）

按反馈「全清不要全部了」，持仓面板的「全清」改为只清**当前图表品种**的持仓与挂单：

- 前端把 `state.symbol` 作为 `symbol` 传给 `trade.flatten`，按钮计数、确认 title、toast 都按该品种统计并带品种名。
- 当前品种没有持仓和挂单时按钮不显示；账户级的「全部平仓」保持原样，急停仍是全局（`_flatten({})`）。
- 网关侧无需改动，`trade.flatten` 本来就支持 `symbol`；单测已覆盖带 `symbol` 的请求与跨品种不显示。

---

## 13. 实施记录：分批止盈（2026-11-16）

### 13.1 已实施

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 网关 | `gateway/worker_trading.py` | 计划模型补 `id`/`price`/`skipped`/`source`；`position.plan.add/update/remove/clear`；`_validate_plan_price`（方向、止盈、同价、tick 对齐）与 `_validate_plan_percent`；`_plan_payload` / `_position_plan`；`_restore_auto_be` 兼容旧计划 |
| 网关 | `gateway/worker_risk.py` | `Position.plan` 随持仓下发；执行循环改按触发价、TP 守卫、仓位拆不开标记 `skipped`、全部完成不再删除计划 |
| 网关 | `gateway/mt5_worker.py` | 注册四个计划 RPC |
| 网关 | `gateway/worker_base.py` | 四个计划 RPC 超时 12s（不发券商请求，不加入 `MUTATING_METHODS`） |
| 网关 | `gateway/tests/test_ladder.py`（新增） | 增删改查、方向/止盈/同价/比例拒绝、空单排序、到价执行、TP 守卫、拆不开只跳过一次、历史成交幂等、持仓消失清理 |
| 前端 | `src/gateway/types.ts` | `PositionPlanStep` / `PositionPlan`，`Position.plan` |
| 前端 | `src/lib/plan.ts`（新增） | `nextStepPrice`、`validatePlanStep`、`estimateStepLots`、`stepAtR`、`planSummary`，与服务端规则镜像 |
| 前端 | `src/chart/tv/priceLines.ts` | `PriceLineSpec.dashed`（`linestyle=2`），不支持时退回实线而不是删线 |
| 前端 | `src/components/ChartPanel.tsx` | 每档一条绿色虚线 + 右侧小块（比例/手数/R），可拖动改价、✕ 删除；超出止盈画灰线且禁止拖动 |
| 前端 | `src/components/PositionsPanel.tsx` | 每行「分批」编辑器：添加一档、改价/比例、平后移保本、删除、清空、手数预览、剩余手数与最终止盈提示 |
| 前端 | `src/App.tsx` | `templateStep` 事件区分「平仓」与「仓位过小已跳过」 |
| 测试 | `src/lib/plan.test.ts`（新增）、`PositionsPanel.test.tsx` | 纯函数单测 + 编辑器调用 `position.plan.*` 的交互测试 |
| 文档 | `README.md`、`docs/USER_GUIDE.md` | 功能清单、操作步骤、图上线条说明、网关关闭不执行的限制 |

### 13.2 与设计稿的差异

- **幂等备注统一为 `plan-<stepId>`**：设计稿写的是模板阶段用 `tpl-<atR>`，但手动拖价后 atR 会变、无法稳定对应；统一用档位 id，`journal._close_kind` 仍把它归为手动平仓。
- **`position_risk_map` 的 `risk` 是账户货币金额**，不是价格距离；创建计划时用落库的 `entry/sl` 折算 1R，避免把金额当成价格用。
- **同价判定用半个 tick**：对齐后相邻 tick 不会误判为重复，完全同价必被拒。
- **前端 UI 上限 4 档**，服务端仍允许 8 档（为旧模板/脚本留余量）。
- **计划编辑不需要交易模式**：只写本地 state、不发券商请求；执行层仍受只读/停机暂停约束。

### 13.3 验证结果

- `npx tsc --noEmit`：通过。
- 后端 `pytest gateway/tests`：619 项通过（新增 20 项）。
- 前端 `vitest`：632 项通过（新增 18 项；整包仍需 `--testTimeout=15000`，原因同 12.3）。

### 13.4 仍未做

- 命令面板里的「分批止盈」入口。
- 第 11 节第 1 条（只读模式是否放行只减仓动作）仍未确认。
- 真实账户上的手工验收（模拟账户到价、重启恢复、拖拽回执）尚未执行。
