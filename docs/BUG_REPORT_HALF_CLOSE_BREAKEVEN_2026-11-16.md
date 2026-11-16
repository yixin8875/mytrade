# 缺陷报告：亏损时「平一半」后止损被贴到现价，剩余仓位被瞬间扫掉

> 日期：2026-11-16 · 状态：已按第 11 节方案修复（见第 12 节）
> 严重度：高 —— 会提前平掉本应保留的仓位，且提示信息与真实止损不一致
> 影响范围：v0.7.13 及之前的「平一半 / 保本 / 分批移保本」逻辑
> 基线：main @ 63f77d3

## 1. 结论

亏损时点「平一半」，网关先平掉一半，随后把剩余仓位的止损“移到保本”。但亏损时开仓价位于现价的**不利一侧**，代码没有拒绝，而是把止损硬压到**离现价只有 6 个 point** 的位置（如黄金 0.06 美元，通常小于一个点差）。行情任何一次正常抖动都会打掉剩余半仓，体感就是“平一半直接变成全平”。

## 2. 触发路径（按时间顺序）

1. 前端 `src/components/PositionsPanel.tsx:79` `closeHalf()`：平仓请求带 `volume: half` + **`moveToBe: true`**（第 96–99 行），无论当前盈亏。
2. 网关 `gateway/worker_trading.py:1209` `_close_position()`：部分平仓成功、持仓仍在、且 `moveToBe` 为真时，第 1251–1257 行调用 `_breakeven()`。
3. 网关 `gateway/worker_trading.py:712` `_breakeven()`：
   - 第 727 行：`target = price_open ± offset`。亏损多单时 target 在现价**上方**（空单反之），本身已无法作为有效止损。
   - 第 728–736 行是关键：`target = min(target, current_price - min_dist)`（空单取 `max`）——**无条件**把保本价截断到现价内侧，只保证“不发 Invalid stops”，不保证“这是保本”。
   - 第 734 行：`min_dist = (max(stops_level, 1) + 5) * point`。多数品种 `trade_stops_level` 为 0，所以 min_dist 只有 **6 个 point**。
   - 第 738–743 行只判断“原止损是否已经更好”，不判断“是否真的回本”。
4. `_breakeven()` 返回 `changed: true`，前端第 100 行据此提示“止损已移到开仓价”——实际止损并不在开仓价。
5. 剩余半仓的止损距现价仅 6 个 point，一次正常回撤即触发，整笔仓位清空。

## 3. 实测复现

用现有测试桩（`gateway/tests/test_worker_manage.py` 的 `make`/`install`，`point=0.01`、`stops_level=0`）直接调用 `_breakeven()`：

| 场景 | 开仓价 | 原止损 | 当时现价 | 实际写入的新止损 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 亏损多单 | 2000.00 | 1990.00 | bid 1999.00 | **1998.94** | 离现价 6 point，即 0.06 |
| 亏损空单 | 2000.00 | 2010.00 | ask 2001.00 | **2001.06** | 离现价 6 point |
| 微利多单 | 2000.00 | 1990.00 | bid 2000.02 | **1999.96** | 止损仍在开仓价**下方** 0.04 |

三种情况都返回 `changed: true`。以 XAUUSD（两位小数、点差常为 0.20–0.40）为例，0.06 的止损距离落在点差之内，下一次报价跳动就会成交。

## 4. 根因

`_breakeven()` 把“避开券商最小止损距离”实现成了“把目标价截断到现价附近”。这个截断在**盈利**场景下无害（目标价本来就在现价外侧，截断几乎不生效），但在**亏损**场景下等价于“把止损搬到市价旁边”。

缺少的前置判断是：**目标保本价是否已经站在现价有利一侧、且至少留出 `min_dist` 的空间；不是的话应该什么都不做。**

## 5. 同类问题（同一套截断逻辑的复制）

| 位置 | 症状 |
| --- | --- |
| `gateway/worker_risk.py:394` `_auto_move_breakeven()` | 与 `_breakeven` 完全相同的 `min/max` 截断。分批计划里 `moveBreakeven: true` 的档位走这里；正常模板档位在盈利侧风险较低，但手动档位或跳空行情下同样会生成“贴脸止损”。 |
| 「保本」按钮（`position.breakeven`） | 亏损时静默把止损搬到现价 6 point 处；toast 会显示 1998.94 这类数字，用户容易忽略它不是开仓价。 |
| 微利场景 | 盈利不足以覆盖 `min_dist` 时，止损被放到开仓价下方，名义“保本”实为锁定小亏（如第 3 节第三行）。 |

## 6. 前端展示问题

`PositionsPanel.tsx:100` 只要 `breakeven.changed` 为真就追加“，止损已移到开仓价”，既不校验 `res.breakeven.sl` 是否等于开仓价，也不提示用户“这次其实没有保本”。这是导致体感“莫名其妙全平”的第二个原因：提示给了错误的安全感。

## 7. 建议修复（待确认后执行）

### 7.1 `Mt5Worker._breakeven()`（`worker_trading.py`）

- 计算 `desired = price_open ± offset`。
- 判断空间：多单要求 `desired > bid - min_dist`，空单要求 `desired < ask + min_dist`。
- 空间不足时**不发 SLTP**，返回 `{ticket, sl: current_sl, changed: false, reason: "not_in_profit"}`。
- 删除 `min/max` 截断；空间足够时按 `desired` 精确下单。
- 保留现有“已在保本或更好”的 no-op 判断。

### 7.2 `WorkerRisk._auto_move_breakeven()`（`worker_risk.py`）

- 采用同一规则：空间不足返回 `None`，不再压到现价附近；同一档位的分批平仓照常执行。

### 7.3 结果透传与前端文案

- `_close_position()` 把 `breakeven.reason` 一并透传；`BreakevenResult`（`src/gateway/types.ts:296`）增加可选 `reason?: 'not_in_profit'`。
- 「平一半」toast 三分支：
  - `changed` → `已平 X 手，止损已移到开仓价 P`（P 用返回的真实 sl）；
  - `reason === 'not_in_profit'` → `已平 X 手，当前未回本，止损保持不变`；
  - 其它（无止损/失败）→ 维持现有提示。
- 「保本」按钮同样按 `reason` 提示“当前未回本，止损未移动”；按钮 title 可补充“亏损时不会移动”。

### 7.4 测试与兼容

- **需改写**：`gateway/tests/test_worker_manage.py:568` `test_保本止损与现价保持最小距离` 固化了截断行为，新语义下该场景（盈利仅 2 point）应返回 `changed: false`。
- **新增**：
  - 亏损多单/空单：不发 SLTP，`changed: false` + `reason: not_in_profit`；
  - 微利（盈利 < `min_dist`）：不发单；
  - 盈利且空间足够：止损精确等于开仓价 ± 偏移，不再被压到现价附近；
  - `_close_position({moveToBe: true})` 亏损时：平仓成功、`breakeven.changed === false`；
  - `_auto_move_breakeven` 亏损时返回 `None`，该档位的分批平仓仍执行；
  - 前端 `PositionsPanel` 三种 toast 文案断言。
- 回放模型 `src/replay/engine.ts:273` 直接 `position.sl = entry`，正常档位都在盈利侧，本次不改；若未来允许亏损侧档位需同步规则。

## 8. 需要你确认的点

1. 亏损时「保本」应该**拒绝移动**（推荐），还是保留现在“贴到现价附近”的行为？建议拒绝。
2. 亏损时「平一半」是否仍默认带“同时移保本”？建议保留勾选，只是当次不生效并提示，回本后再点一次即可。
3. 微利（盈利不足以留出最小止损距离）时也拒绝移动，可以接受吗？建议可以——这是券商最小止损距离的物理限制。

## 9. 涉及文件清单

- `src/components/PositionsPanel.tsx` —— 平一半 / 保本按钮的请求与提示
- `src/gateway/types.ts` —— `BreakevenResult` 增加 `reason`
- `gateway/worker_trading.py` —— `_breakeven`、`_close_position`
- `gateway/worker_risk.py` —— `_auto_move_breakeven`
- `gateway/tests/test_worker_manage.py`、`gateway/tests/test_ladder.py` —— 改写与新增用例
- `src/components/PositionsPanel.test.tsx` —— toast 断言
- `docs/USER_GUIDE.md` —— 保本/平一半行为说明（如确认修复）

## 10. 修复前的临时规避

- 亏损时不要点「平一半」（需要减仓可在「止损止盈」面板手动改量或直接平仓）。
- 若必须减半，用「分批」编辑器添加一档并关闭“移保本”，或平半后立刻在面板里把止损改回原值。

## 11. 需求澄清后的修订方案（2026-11-16）

> 用户澄清：「平一半」在亏损时也是主动减仓手段——行情不对时先降仓位，之后再用移动止损把总亏损控制住。所以修复目标不是“禁止亏损时平一半”，而是：**减仓永远生效，止损只在已经回本时才移动。**

### 11.1 目标行为

| 当时状态（以多单为例） | 平仓 | 止损 | 提示 |
| --- | --- | --- | --- |
| 已回本，且现价距开仓价 ≥ 券商最小止损距离 | 平一半 | 移到开仓价 | 已平 X 手，止损移到开仓价 P，剩余 Y 手 |
| 亏损 / 平手 | 平一半 | **保持原值** | 已平 X 手，当前未回本，止损保持 P；剩余最大亏损约 Z（降为原来的一半） |
| 已回本但离得太近，放不下保本止损 | 平一半 | **保持原值** | 已平 X 手，离保本还差一点，止损保持 P |
| 原本没有止损 | 平一半 | 仍为空 | 已平 X 手；剩余仓位没有止损保护（可选提示去设置） |

三个结论：

1. **亏损时不动止损**。开仓价在现价不利一侧，任何“移到保本”都只能被截断成贴脸止损；把止损往上挪只会更容易被扫。保持原止损时，仓位减半已经把最坏亏损降成原来的一半，天然满足“不超过初始亏损”。
2. **后续用「移动止损」正好对路**。现有 `_trail_positions` 只往有利方向挪、不回头：减半后填一个距离点数，止损会随价格收紧，最坏亏损收敛到止损价。若止损已存在，它不会比原止损更差。
3. **微利不强行保本**。不是回本了就能立刻放保本止损——券商有最小止损距离；差几个点时保持原止损，等价格再走远一点，再点一次「保本」。

### 11.2 网关改动

`Mt5Worker._breakeven()`：

- `desired = price_open ± offset`。
- 多单要求 `desired > bid - min_dist`，空单要求 `desired < ask + min_dist`（`min_dist` 沿用 `(max(stops_level,1)+5) * point`）。
- 不满足且现价仍在开仓价不利侧 → 返回 `{ticket, sl: current_sl, changed: false, reason: "not_in_profit", price}`。
- 不满足但已经回本 → 返回 `{... reason: "too_close"}`。
- 满足 → 按 `desired` 精确下单，删除 `min/max` 截断。
- 保留“止损已在保本或更好”的 no-op。

`Mt5Worker._close_position()`：`moveToBe` 分支原样调用，把 `breakeven.reason` 透传；平仓结果不受影响。

`WorkerRisk._auto_move_breakeven()`：同一规则，不足时返回 `None`；该档 `closePercent` 照常执行；`position.plan.step` 审计里加 `breakevenSkipped` 便于排查。

### 11.3 前端改动

- `PositionsPanel.closeHalf` 继续带 `moveToBe: true`，按 `breakeven.reason` 输出三种提示（见 11.1）。
- 「平一半」title 改为“平掉一半仓位；已回本时把止损移到开仓价，未回本时止损不动”。
- 剩余最大亏损 Z 由 `tickValue` 估算：`maxLoss = (|entry − sl| / tickSize) × tickValue × 剩余手数`。在 `src/lib/stops.ts` 暴露该函数（避免交易面板反向依赖 `replay/engine`）。
- 「保本」按钮在 `not_in_profit` / `too_close` 时提示原因，不再显示一个不是开仓价的 sl。
- `BreakevenResult` 增加 `reason?: 'not_in_profit' | 'too_close'`。

### 11.4 明确不做

- 不新增“仅平一半 / 平一半并保本”两个按钮，除非你想要显式选择；默认按盈亏自动判断。
- 不在亏损时自动收紧止损（那会提高被扫概率，是否收紧由你手动决定）。
- 不改移动止损的方向规则（只进不退，保持现状）。

### 11.5 测试

网关：

- 亏损多单 / 空单：`_breakeven` 不发 SLTP，`changed: false` + `reason: not_in_profit`。
- 已回本但距离不足：`reason: too_close`，不发单。
- 已回本且足够：止损精确等于开仓价 ± 偏移（不再被压到现价附近）。
- `_close_position({moveToBe: true})` 亏损时：平仓成功，`breakeven.changed === false`、`reason` 透传。
- `_auto_move_breakeven` 两种 reason 都返回 `None`，同档分批仍执行，审计有 `breakevenSkipped`。
- 改写 `test_保本止损与现价保持最小距离`（盈利 2 个点时改为拒绝移动）。

前端：

- 三种 toast 文案断言；亏损时剩余最大亏损数字与手数正确。
- `maxLoss()` 单测（多/空、`tickValue` 为 0 时返回 null）。

### 11.6 手动验收场景

1. 多单浮亏 0.5R，点「平一半」→ 成交一半；止损仍是原价（不是贴脸）；记录剩余最大亏损约为原风险一半。
2. 随后价格继续跌到原止损 → 剩余半仓正常止损，总亏损 ≈ 初始风险的一半。
3. 多单浮盈 1R，点「平一半」→ 一半平仓，止损 = 开仓价。
4. 浮盈只有 2 个点 → 平一半，止损不动，提示“离保本还差一点”。
5. 空单重复 1–4。
6. 分批档位勾选“移保本”，在盈利侧触发 → 行为不变。

### 11.7 工作量

网关约 30 行 + 测试；前端 types/文案 + `maxLoss` 工具 + 测试；`USER_GUIDE` 更新「平一半 / 保本」两行。合计约半天，不影响现有 RPC 协议（只新增可选字段）。

## 12. 修复记录（2026-11-16）

- `Mt5Worker._breakeven`：删除 `min/max` 截断；开仓价不在现价有利一侧、或留不出 `min_dist` 时返回 `changed: false` + `reason: not_in_profit | too_close`，不下发 SLTP。`_close_position` 的 `moveToBe` 分支透传该结果。
- `WorkerRisk._auto_move_breakeven`：同一规则，空间不足返回 `None`；`position.plan.step` 审计新增 `breakevenSkipped`，该档的分批平仓照常执行。
- 前端：`BreakevenResult` 增加 `reason`/`price`；「平一半」「保本」按原因提示，未回本时显示剩余最大亏损（`src/lib/stops.ts` 的 `maxLoss()`）。按钮 title 同步说明。
- 测试：改写 3 个固化截断行为的旧用例；新增亏损多/空、微利、亏损时部分平仓、`_auto_move_breakeven` 跳过、档位跳过保本仍平仓、前端 4 个文案用例、`maxLoss` 5 个用例。
- 验证：`npx tsc --noEmit` 通过；`npm run check` 全绿（前端 642、后端 624）。
- README / USER_GUIDE 的「平一半 / 保本」说明已同步。

## 13. 补充：保本偏移设置（2026-11-16）

点差已经包含在开仓价里（多单按 ask 成交、按 bid 触发止损），所以「止损 = 开仓价」就是毛利为零；但手续费、隔夜利息和止损滑点不在里面。为此增加一个可选偏移：

- 位置：设置 → 交易与风控 → 保本偏移。单位是点，0–500 的整数，存在 `localStorage` 的 `mytrade.breakevenOffset`。
- 应用：`position.breakeven` 的 `offsetPoints`、`position.close` 的 `beOffsetPoints`、`position.plan.add` / 模板下单的 `breakevenOffsetPoints`；多单加在开仓价上方，空单减在下方。
- 分批计划在**添加档位时**记录偏移（计划字段 `breakevenOffsetPoints`），之后新增的档位使用新值；旧计划缺省按 0。
- 测试：后端 `_auto_move_breakeven` 偏移、`_plan_add` 持久化；前端 store 钳制、保本/平一半/分批请求参数。
