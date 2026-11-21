# Pine 指标还原：方案调研与技术选型

> **2026-11-21 更新**：已决策采用单一 Piner 并删除 PineTS，见 [P4 Pine 运行时收敛](P4_PINE_RUNTIME_DECISION_2026-11-21.md)；本文以下内容作为历史调研保留。
>
> 日期：2026-11-15  
> 适用版本：mytrade 0.7.12 / TradingView Charting Library 32.1.0  
> 实测引擎：PineTS 0.13.1、Piner 0.13.0、PyneTS 0.10.0、AlphaResin 0.1.7  
> 结论先行：**不建议为此更换图表库。引擎侧首选 Piner，PineTS 作为成熟回退；两者都必须补渲染桥，才能把 Pine 的绘图对象、marker、背景色和表格画出来。**

---

## 0. TL;DR

1. **当前瓶颈主要是渲染桥，但引擎的输出结构决定了桥好不好搭。** PineTS 0.13.1 已经能算出 `plotshape`、`bgcolor`、`label`、`line`、`box`、`table`、`linefill`、`polyline`，但 `pineRunner` 只取了数值曲线，其余结果全部被丢弃。Piner 0.13.0 则直接给出完整的“视觉 IR”（plots/markers/candles/hlines/fills/bgcolors/barcolors/drawings/tables），更适合直接接渲染层。实测见第 2 节。
2. **有 4 个确定性 bug 值得先修**：`request.security` 因没传 timeframe/没接数据源而失败或静默用错数据；实时 bar 不重算；`plotcandle/plotbar` 被转成 NaN；只有绘图、没有 `plot()` 的脚本无法保存。
3. **四个引擎的横向实测结论**：SMA/EMA/RSI 数值四家一致；5000 根 warm 计算 PineTS 35ms、Piner 2ms、PyneTS 11ms、AlphaResin 5ms；Piner 的视觉输出最完整、直接传数组时 MTF 语义最符合 `lookahead_off`（PineTS 接 `IProvider` 后也能正确）；PineTS 最成熟、覆盖率最高，但绘图结果是未文档化的内部 key；PyneTS 的 `request.security` 基本是“当前 bar 直通”；AlphaResin 是唯一 Apache-2.0，但还早（`plotcandle/plotbar` 不支持、table 缺失、外部数据依赖 Terminal）。
4. **推荐路线 A′**：保留 Charting Library，**Piner 优先、PineTS 回退**，新增一个引擎无关的 `PineRunResult` 和 Pine 绘图层（复用 `sessionBoxes.ts` 的 `createMultipointShape` 经验）+ 表格 HTML 覆盖层；同时用 TradingView 导出的 CSV 建数值 golden 测试台。预计 **2–4 周**从“能跑”到“基本还原”；如果 Piner 一次通过，P1 可缩短到 **6–10 天**。
5. **备选路线 B**：Vela + `@luxalgo/vela-pinets`。Vela 核心 Apache-2.0，Pine 插件 AGPL；能原生渲染 plotshape/bgcolor/label/line/box/table/strategy 成交标记。代价是要换或加一套图表，**8–12 周**量级。
6. **不建议自研 Pine 解释器。** 如果只有 5–10 个固定指标，手工移植（可以 LLM 辅助）反而最快、最准；Pine 引擎继续留给“实验/任意脚本”入口。
7. **先给我 3–5 个你真实在用的脚本**（尤其是最复杂的那个），做一次 2 天的 bake-off，再拍板。没有真实脚本，任何方案都只能按覆盖率猜。

---

## 1. “还原”到底指什么

“还原 TradingView 指标”可以拆成四层，混在一起谈很容易选错方案：

| 层级 | 含义 | 现状 | 能做到什么程度 |
|---|---|---|---|
| L1 计算一致 | 同样的 OHLCV 输入，输出数值一致 | PineTS 覆盖率高；本次四引擎对比见 2.3，真实脚本仍待验收 | 可做到 `1e-6` 相对误差以内；`ta.*` 理论上可接近 bit-exact |
| L2 视觉一致 | 曲线、marker、标签、箱体、表格、背景色一致 | 只画了数值折线 | 路线 A/A′ 可做到 85–95%；bgcolor/barcolor/fill/table 需要近似 |
| L3 交互一致 | 输入参数、实时更新、告警、策略成交 | 输入基本可用；实时 bar 不更新；strategy 被拒绝 | 可做到，但需要补实时重算与诊断 |
| L4 数据一致 | K 线本身与 TradingView 一致 | MT5 数据 vs TV 数据 | **不可能完全一致**；只能对齐口径、量化偏差 |

### 1.1 一个必须先接受的事实

即使 Pine 引擎 100% 正确，**只要 K 线不同，指标就不可能和 TradingView 一模一样**：

- **数据源不同**：你的项目走 MT5 网关；TradingView 用它自己的行情源。成交量尤其不同（MT5 常是 tick volume，TV 可能是交易所成交量），OBV/VWAP/MFI 这类指标会明显不同。
- **日/周线切分不同**：MT5 的日线通常按服务器日切（如 GMT+2/+3），TV 按交易所时区/交易时段切。`request.security(..., "D", ...)`、`dayofweek`、`session` 相关脚本会整体错位。
- **历史长度不同**：当前只取 5000 根；TV 可能加载几万根。长周期均线、`ta.highest(close, 500)` 之类的 warmup 会不一样。
- **时区处理不同**：项目为了和 MT5 对齐，把服务器时间当 UTC 展示；TV 用交易所时区。`hour`、`time`、`session` 相关逻辑会有偏差。

所以验收目标应该写成：

> **同一份 OHLCV 输入下，计算结果与 TradingView 一致；在 MT5 数据下，视觉形态与 TradingView 接近，偏差可解释。**

数值 golden 测试时，直接把 TradingView 导出的 CSV 里的 OHLCV 喂给本地引擎，就能把“引擎差异”和“数据差异”分开。TradingView 的“导出图表数据”会包含图上所有指标的**数值 plot 列**（包括 `display.none` 的列），但不包含绘图对象，正好适合做 L1 验收。[^tv-export]

### 1.2 `request.security` 不是引擎一个人的事

多周期指标（`request.security`）要正确，必须同时满足两件事：

1. **引擎实现 `lookahead_off` 语义**：当前 chart bar 只能看到**上一根已收盘**的 HTF bar，不能看到正在形成的 HTF bar。
2. **宿主提供正确的数据**：同品种高周期可以由图上的 bars 聚合，但**外部品种**（如 `request.security("BTCUSD", "60", close)`）必须由宿主按需取数并注入；引擎自己不可能变出别的品种。

我们用一个可判定的合成序列测了四家（500 根 5 分钟 bar，`request.security(syminfo.tickerid, "60", close)`）：

| 引擎 | 最后一根的值 | 语义 |
|---|---|---|
| PineTS（直接传 bars 数组） | 101.53（`close[488]`，16:40） | 用图上 bars 聚合，但边界有偏移；不等于“上一根已收盘 HTF” |
| Piner（直接传 bars 数组） | 107.01（`close[491]`，16:55） | 等于上一根已收盘 60 分钟 bar 的 close，符合 `lookahead_off` |
| PyneTS（直接传 bars 数组） | 117.38（当前 chart close） | 等于当前 chart bar 的 close，基本是“直通”，不是 HTF |
| AlphaResin（直接传 bars 数组） | 117.38（当前 chart close） | 历史 bar 大多取上一桶，但最后一根取当前 close |

5000 根时结论一致：PineTS `118.37`（07:40）、Piner `119.34`（07:55，上一根已收盘 60 分钟）、PyneTS/AlphaResin `117.95`（当前 chart close）。

再用 103 根 1 分钟 bar（`close = i + 1`，`request.security(..., "5", close)`）看边界：

```
PineTS     last 99   tail [88,89,90,91,92,93,94,95,96,97,98,99]
Piner      last 100  tail [90,90,90,90,95,95,95,95,95,100,100,100]  ← 上一根已收盘 5 分钟桶
PyneTS     last 103  tail [92,93,94,95,96,97,98,99,100,101,102,103]
AlphaResin last 103  tail [90,90,90,95,95,95,95,95,100,100,100,103]  ← 最后一根例外
```

**关键结论**：这不是“Piner 一定比 PineTS 聪明”，而是**数据注入方式**的差异。

- **PineTS 支持自定义 `IProvider`**。把网关数据包成 provider 后，同品种 HTF 和外部品种都能正确取到：我们实测 `same=1009`、`btc=11009`，与注入的 bars 完全一致。注意 provider 的 `getMarketData()` 要返回**网关的真实 HTF/外部 bars**，不要让 provider 用 5 分钟 bars 自己聚合。当前项目传给 PineTS 的是普通数组，所以它只能用图上数据，外部品种甚至会**静默返回当前品种的 close**（在 130 根测试里实测 `same=218`、`btc=218`，没有 warning），这比报错更危险。
- **Piner 支持 `ctx.securityBars` 注入**，并且在 `compile()` 的 metadata 里直接给出 `securityDependencies`（`self` / `symbol` / `timeframe` / `lowerTf` / `lookahead` / `dynamic`），宿主可以一次性把需要的 HTF/外部 bars 全部取好再跑；没注入时返回 `na` 并记录 `securityRequests`，不会静默拿错数据。同样，注入的应该是**真实 HTF bars**，不是自己用 5 分钟 bars 聚合出来的。
- **PyneTS 的 `runProvider` 只负责 chart bars**，没有看到外部/HTF 注入接口；`request.security` 在我们的测试里是直通。
- **AlphaResin 的独立 `runScript` 没有外部数据注入接口**；它依赖 AlphaPine Terminal 的市场数据，独立跑时外部品种为 `na` 并给 warning。

所以引擎选型时，**“有没有明确的 `request.security` 数据注入契约”** 和“计算覆盖率”同样重要。第 2.3 节会把这条单独列出来。

---

## 2. 现状架构与实测

### 2.1 当前链路

```
MT5 gateway
   └─ history.get (5000 bars)
        └─ PineRunner (src/chart/tv/pineRunner.ts)
             ├─ 当前: PineTS.run(script) -> ctx.plots
             ├─ 只保留数值 plot -> setPineResult()
             └─ 丢弃 __labels__ / __lines__ / __boxes__ / __tables__ / bgcolor#...
                  └─ pineStudies.ts 注册成 Charting Library 自定义指标
                       └─ main() 逐 bar 查表，只能返回数值折线

目标链路:
history + HTF/外部 bars
   └─ pineEngine (Piner 优先 / PineTS 回退) -> PineRunResult
        ├─ 数值 plot -> pineStudies.ts -> 自定义指标
        ├─ marker / drawing / table -> PineDrawingLayer / PineTableOverlay
        └─ bgcolor / barcolor / fill -> 近似绘图层
```

关键代码：

| 位置 | 作用 | 问题 |
|---|---|---|
| [`src/chart/tv/pineRunner.ts:291`](../src/chart/tv/pineRunner.ts#L291) | `new PineTS(candlesFrom(bars))` | 没传 `tickerId` / `timeframe`，`request.security` 必失败 |
| [`src/chart/tv/pineRunner.ts:241`](../src/chart/tv/pineRunner.ts#L241) | 计算签名 | 只包含最后一根 bar 的 `time`，不包含 OHLC，实时 bar 不重算 |
| [`src/chart/tv/pineRunner.ts:143`](../src/chart/tv/pineRunner.ts#L143) | 订阅 `bar` 事件 | 只更新缓存，不触发 `tick()` |
| [`src/lib/pineScripts.ts:243`](../src/lib/pineScripts.ts#L243) | 过滤 plot key | 把 `__labels__`、`__lines__`、`bgcolor#` 全部过滤掉 |
| [`src/lib/pineScripts.ts:252`](../src/lib/pineScripts.ts#L252) | 跳过布尔序列 | `plotshape/plotchar` 被直接丢弃 |
| [`src/lib/pineScripts.ts:215`](../src/lib/pineScripts.ts#L215) | 拒绝 `strategy()` | 策略脚本完全不能用 |
| [`src/lib/pineScripts.ts:265`](../src/lib/pineScripts.ts#L265) | 没有 plot 就报错 | 只有 label/box/line 的指标无法保存 |
| [`src/chart/tv/pineStudies.ts:94`](../src/chart/tv/pineStudies.ts#L94) | 所有 plot 都建成 `line` | 柱状/面积/圆点/阶梯线全部画成折线 |
| [`src/chart/tv/sessionBoxes.ts:519`](../src/chart/tv/sessionBoxes.ts#L519) | 用 `createMultipointShape` 画矩形 | 证明“Pine 绘图对象 → 图表库绘图对象”这条路可行 |

### 2.2 PineTS 0.13.1 实测（本机 Node 探针）

用 400 根合成 5 分钟 K 线跑一个包含常见绘图语法的脚本，输出如下：

| Pine 写法 | PineTS 输出 | 当前项目是否使用 |
|---|---|---|
| `plot(ta.sma(...))` | `plots["SMA"]`，`data[].value` 为数值 | ✅ 用了 |
| `hline(100)` | `plots["h100"]`，`style=hline` | ✅ 当折线用了 |
| `plotshape(...)` | `plots["up"]`，`style=shape`，`value` 为布尔 | ❌ 被跳过 |
| `plotchar(...)` | `plots["dn"]`，`style=char`，`value` 为布尔 | ❌ 被跳过 |
| `bgcolor(...)` | `plots["bgcolor#0"]`，`style=background`，每个点带 `options.color` | ❌ 被过滤 |
| `barcolor(...)` | `plots["barcolor#0"]`，`style=barcolor` | ❌ 未处理 |
| `fill(plot1, plot2, ...)` | `plots["fill"]`，`style=fill` | ❌ 未处理 |
| `label.new(...)` | `plots["__labels__"].data[0].value` 为数组 | ❌ 被过滤 |
| `line.new(...)` | `plots["__lines__"]` | ❌ 被过滤 |
| `box.new(...)` | `plots["__boxes__"]` | ❌ 被过滤 |
| `table.new/cell(...)` | `plots["__tables__"]`，含 `cells` 二维数组 | ❌ 被过滤 |
| `linefill.new(...)` | `plots["__linefills__"]` | ❌ 被过滤 |
| `polyline.new(...)` | `plots["__polylines__"]` | ❌ 被过滤 |
| `plotcandle/plotbar` | `plots["candles"].value = [open, high, low, close]` | ❌ 被当数值转成 NaN |
| `request.security(...)` | 传了 timeframe 时正常；不传则报 `Invalid value of the 'timeframe' argument` | ❌ 当前必失败 |

补充实测：

- 历史绘图对象会一次性导出：每 10 根 bar 建一个 label/line/box，300 根 bar 得到 30 个对象。渲染时需要按可见范围裁剪。
- 5000 根 bar、MACD+RSI+ATR+SMA200 的中等脚本，本机 Node 冷跑单次 **68–84ms**（比 2.3 的 numeric 脚本更重，且不是 warm）；浏览器主线程同量级。当前放在主线程可接受，但多图/重脚本建议挪到 Web Worker。
- PineTS 仓库 `main` 分支的 API 覆盖率 badges（读取于 2026-11-15）：`ta 69/69`、`plot 8/8`、`label 43/43`、`line 28/28`、`box 30/30`、`table 23/23`、`array 55/55`、`strategy 96/96`、`matrix 49/49`，**`request 3/11`**。也就是说，指标计算本身基本齐了，缺口主要在 `request.financial/economic/...` 这类外部数据，以及**渲染**。[^pinets-coverage]

### 2.3 引擎横向实测（2026-11-15）

测法：同一组 5000 根合成 5 分钟 bars，覆盖 numeric（SMA20/EMA50/RSI14）、MTF、plotcandle/plotbar、drawings、adv_ta（ATR/BB/MACD/pivot/valuewhen/barssince/linreg/wma）、collections（array/matrix/map/str）、strategy、inputs、lower_tf 等 12 个脚本；绘图对象数量用 300 根 bars 的覆盖探针统计；性能取 warm 后 3 次最好值。复现脚本见附录 B。

#### 2.3.1 基本盘

| 引擎 | 版本 | 许可 | 解包大小 | 运行位置 | 一句话 |
|---|---|---|---|---|---|
| **PineTS** | 0.13.1 | AGPL-3.0-only | **18.1 MB** | 浏览器/Node | 最成熟，覆盖率最高，已接入本项目；绘图输出是内部 key |
| **Piner** | 0.13.0 | AGPL-3.0-only | **3.4 MB** | 浏览器/Node | 编译器 + 运行时，直接产出完整视觉 IR；最快 |
| **PyneTS** | 0.10.0 | AGPL-3.0-or-later | 4.3 MB | 浏览器/Node | PYNE 的 TS 端口；drawing 事件结构清晰；MTF 直通 |
| **AlphaResin** | 0.1.7 | **Apache-2.0** | **0.67 MB** | 浏览器/Node | 许可最友好，但 0.1.x，能力还不完整 |

#### 2.3.2 计算与视觉输出

| 能力 | PineTS | Piner | PyneTS | AlphaResin |
|---|---|---|---|---|
| `ta.*`（9 个进阶函数） | ✅ 9/9 | ✅ 9/9 | ✅ 9/9 | ✅ 9/9 |
| array / matrix / map / str | ✅ | ✅ | ✅ | ✅ |
| `plot` | ✅ | ✅ | ✅ | ✅ |
| `plotshape` / `plotchar` | ✅（`style=shape/char`） | ✅（`markers`，含 glyph/location/color） | ✅ | ✅ |
| `plotcandle` / `plotbar` | ✅（`[o,h,l,c]` 数组） | ✅（`candles`，含 border/wick 颜色） | ✅ | ❌ 2 个 warning、没有列 |
| `hline` | ✅ | ✅（`hlines`） | ✅ | ✅（`levels`） |
| `fill` | ✅（`style=fill`） | ✅（`fills`，支持逐 bar 颜色和 gradient） | ✅（`fills`） | ✅（`zones`） |
| `bgcolor` | ✅（`bgcolor#0`） | ✅（`bgColors`，逐 bar） | ✅（`backgrounds`） | ✅（`backgrounds`） |
| `barcolor` | ✅（`barcolor#0`） | ✅（`barColors`，逐 bar） | ✅ | ✅（`candleTint`） |
| `label` / `line` / `box` | ✅（`__labels__/__lines__/__boxes__`） | ✅（`drawings`，类型化） | ✅（`drawings`，带 bar/text/extra） | ✅（`markers/segments/zones`） |
| `polyline` / `linefill` | ✅（`__polylines__/__linefills__`） | ⚠️ `fills` 支持 fill；polyline/linefill 未单独验证 | 部分 | 部分 |
| `table` | ✅（`__tables__`，含 cells） | ✅（`drawings` 里的 table） | ✅（drawing 事件，未细分） | ❌ 我们实测 0 个 table |
| `strategy` | ✅（但当前入口拒绝） | ✅（`engine.strategy` 报告） | ✅（`strategy` summary） | ✅（`strategy` 报告） |
| `request.security` | ✅ **需要 `IProvider`**；传数组会静默用错数据 | ✅ **需要 `securityBars`**；未注入返回 `na` + `securityRequests` | ⚠️ `runProvider` 只取 chart bars；MTF 直通 | ⚠️ 独立 `runScript` 无注入接口，依赖 Terminal |
| `request.security_lower_tf` | 有限 | ✅ 记录 `lowerTf: true` 请求 | 未验证 | 未验证 |
| 浏览器运行 | ✅ | ✅ | ✅ | ✅ |

> PineTS 的 `__labels__` 等是**未文档化的内部约定**；Piner 的 `OutputCollector` 是公开的序列化 IR；PyneTS 的 `DrawingEvent` 也是公开结构；AlphaResin 的 `output` 是公开对象但字段还在演进。[^piner-ir]

#### 2.3.3 性能与关键行为

| 指标 | PineTS | Piner | PyneTS | AlphaResin |
|---|---|---|---|---|
| 5000 bars，numeric，warm | 35 ms | **2 ms** | 11 ms | 5 ms |
| 300 bars，drawings 输出 | 6 个 `__*` 容器（不是对象数） | **36 个对象 + 1 个 table** | 61 个 drawing 事件 | 36 个对象，**0 table** |
| 外部品种，未注入数据（130 根） | **静默返回当前品种 close**（218/218） | `na` + `securityRequests` | `na` | `na` + warning |
| 外部品种，注入数据 | ✅ 正确（11009） | ✅ 正确（11009） | 未发现注入 API | 无独立注入 API |
| 同品种 HTF，直接传数组（500 根） | ❌ 边界偏移（101.53） | ✅ 正确（107.01） | ❌ 直通（117.38） | ⚠️ 历史大多正确，最后一根例外 |
| 数值一致性（SMA/EMA/RSI） | 基准 | 与基准一致（~1e-10） | 与基准一致（~1e-10） | 与基准一致（~1e-10） |

#### 2.3.4 怎么读这张表

- **如果目标是“视觉还原 + 多周期 + 性能”**：选 **Piner**。它把渲染层需要的所有东西一次性给全，`securityDependencies` 还能让宿主在跑之前就知道要取哪些 HTF/外部数据；包体积只有 PineTS 的 1/5，速度快一个数量级。
- **如果目标是“最成熟、最少未知”**：保留 **PineTS**，但必须做两件事：把普通数组换成 `IProvider`（否则外部品种会静默用错数据），以及把 `__labels__` 等内部 key 解析成稳定的 `PineRunResult`。它的 `ta` 覆盖率和现有集成是优势。
- **PyneTS**：drawing 坐标正确，但 `request.security` 基本是直通，且没有看到外部/HTF 注入接口。适合做“绘图事件”的参考实现，不适合作为多周期指标的主引擎。
- **AlphaResin**：Apache-2.0 + 0.67MB 很诱人，但 0.1.7 还早：`plotcandle/plotbar` 不支持、table 缺失、外部数据依赖 Terminal。现在选它会把“渲染桥”变成“引擎补全 + 渲染桥”，不建议。
- **四家都需要渲染桥**：Charting Library 的自定义指标只能返回数值序列，不能原生画 `bgcolor/barcolor/table`。引擎给的是**数据**，能不能画出来仍取决于 A 的绘图层。

---

### 2.4 当前 10 个断点（按影响排序）

1. **绘图对象全丢**：label/line/box/table/polyline/linefill 都算出来了，但从未进入图表。  
2. **plotshape / plotchar 全丢**：布尔序列被 `typeof lastValue === 'boolean'` 跳过，买卖箭头、信号标记看不到。  
3. **bgcolor / barcolor / fill 全丢**：背景色、蜡烛颜色、两条线之间的填充看不到。  
4. **plotcandle / plotbar 变 NaN**：值是 `[o,h,l,c]` 数组，当前只接受 `number`。  
5. **`request.security` 当前不可信**：`new PineTS(candles)` 没传 timeframe 会失败；即使传了 `symbol, resolution`，普通数组也只能用图上数据，外部品种会静默返回当前品种的 close。修复需要传 `symbol, resolution` **并实现 `IProvider`**（见 1.2 与 4.A.3）。  
6. **实时 bar 不重算**：签名里只有最后 bar 的 `time`，同一根 bar 内价格变化不会触发重算；PineTS 的实时值会停在这根 bar 第一次计算时的价格。  
7. **绘图型指标无法保存**：`savePineScript()` 要求至少有一个数值 plot；只有 label/box 的脚本直接报错。  
8. **5000 根上限 + 保存时 120 根探针**：长 warmup 的 plot 在保存时可能探测不到；图表上超过 5000 根的区域没有值。  
9. **输入类型不完整**：`timeframe/price/session/symbol` 都按文本传给图表库，UI 不是专用控件；`input.source` 目前能用，但依赖 PineTS 对字符串的解析。  
10. **错误不可诊断**：只有 toast，没有行号、没有 `ctx.warnings`、没有“哪个函数不支持”的清单。

---

## 3. 方案矩阵

| 方案 | 一句话 | 计算还原 | 视觉还原 | 任意 Pine | 工作量 | 与现有集成 | 许可 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **A. CL + Piner + 渲染桥** | 保留图表，Piner 出完整视觉 IR，补齐画图 | 高 | 中高（85–95%） | 是 | 2–4 周（P1 6–10 天） | 好（新增适配层） | Piner AGPL | **首选** |
| **A2. CL + PineTS + 渲染桥** | 保留图表，PineTS 出结果，补齐画图 | 高 | 中高（85–95%） | 是 | 2–4 周 | 最好（已接入） | PineTS AGPL | **回退** |
| **B. Vela + Vela-pinets** | 换/加一套原生 Pine 图表 | 高 | 高（95%+） | 是 | 8–12 周（换图）；1–2 周（旁路预览） | 差 | Vela Apache + 插件 AGPL | 长期备选 |
| **C. 网关侧引擎** | 把计算搬到 Python/Node 服务 | 中高 | 同 A | 是 | +2–3 周 | 好 | AGPL / 商业 | 重脚本时加 |
| **D. 自研/分叉解释器** | 自己维护一个 Pine 引擎 | 取决于投入 | 高 | 是 | 6 个月+ | 好 | 自有 | 不推荐 |
| **E. 固定指标手工移植** | 把常用脚本翻成 TS/JS | 最高 | 最高 | 否（只固定几个） | 0.5–2 天/个 | 最好 | 无 | 少量指标首选 |
| **F. 留在 TradingView** | TV 看图，app 只做交易 | 最高 | 最高 | 是 | 0 | 无 | TV 订阅 | 仅工作流 |
| **G. 商业授权** | 买 PineTS/Vela/PyneComp | 同 A/B | 同 A/B | 是 | 同 A/B + 费用 | 同 A/B | 商业 | 分发闭源时考虑 |

> 评分说明：视觉还原是“在当前 Charting Library 里能做到的上限”。A/A2 之所以不是满分，是因为图表库自定义指标**只能返回数值序列**，不能直接画背景色/表格/逐 bar 蜡烛颜色；这些只能靠绘图对象或 HTML 覆盖层近似。Piner 的视觉 IR 让“数据”变完整，但不会改变图表库的渲染上限。

---

## 4. 方案详解

### A. 保留 Charting Library + Piner/PineTS，补渲染桥（推荐）

#### A.0 先定引擎，再定桥

无论选 Piner 还是 PineTS，都建议先定义一个**引擎无关的结果边界**，这样渲染桥不用跟着引擎换：

```ts
// src/chart/tv/pineTypes.ts
export interface PineRunResult {
  plots: PinePlotSeries[];       // 数值曲线 + 逐点颜色 + 样式
  markers: PineMarker[];         // plotshape / plotchar / plotarrow
  candles: PineCandleSeries[];   // plotcandle / plotbar
  hlines: PineHLine[];
  fills: PineFill[];
  bgcolors: PineColorRun[];
  barcolors: PineColorRun[];
  drawings: PineDrawings;        // label / line / box / polyline / linefill
  tables: PineTable[];
  alerts: PineAlert[];
  warnings: PineWarning[];
  meta: { engine: 'piner' | 'pinets'; bars: number; durationMs: number };
}
```

两个适配器的职责：

| 适配器 | 输入 | 输出 | 关键点 |
|---|---|---|---|
| `pinerAdapter.ts` | `compile(source)` + `Engine` | `PineRunResult` | `engine.outputs` 直接映射；`engine.drawings` 映射；`engine.strategy` 可选 |
| `pinetsAdapter.ts` | `new PineTS(provider, symbol, tf)` | `PineRunResult` | 解析 `__labels__/__lines__/__boxes__/__tables__/__polylines__/__linefills__`；`bgcolor#`/`barcolor#` 单独取；`plotcandle` 的数组值保留 |

**建议的决策顺序**：

1. 先用 **Piner** 做 P1，因为它的 IR 最接近渲染层，适配器代码最少，MTF/外部数据契约也最清楚。
2. 如果 Piner 在你的真实脚本上出现无法接受的解析/计算差异，再切到 **PineTS**；`PineRunResult` 和渲染桥不动，只换适配器。
3. 不建议同时维护两个引擎的完整功能；回退引擎只需要“能跑通核心脚本”即可。

#### A.1 它能解决什么

- 数值曲线：保留现有自定义指标通道，补上样式（line/area/columns/circles/stepline/histogram）、线宽、条件颜色、`hline`。
- `plotshape/plotchar`：转成图表库的 `arrow_up/arrow_down/text` 绘图对象。Piner 的 `markers` 已经带 `location` / `glyph` / `color`，不需要再猜。
- `label/line/box/polyline`：转成 `createShape` / `createMultipointShape`。项目已经在 `sessionBoxes.ts` 里用 `rectangle` 画过带填充、虚线、文字的箱体，`referenceLayer.ts` 里也用了 `trend_line/arrow_up/arrow_down/rectangle`，这条路是验证过的。
- `table`：用 HTML 覆盖层画在图表容器上，位置对应 Pine 的 9 个 `position.*`。Piner 的 `drawings` 里有 table 对象和 cells；PineTS 的 `__tables__` 也能拿到。
- `plotcandle/plotbar`：Piner 的 `candles` 直接给 OHLC + 颜色；PineTS 需要把 `[o,h,l,c]` 数组从 plot 值里还原。图表库侧仍用绘图对象/覆盖层近似，不能替换主 K 线。
- `bgcolor/barcolor/fill`：**近似**。背景色可以把连续同色区间合并成整高矩形；barcolor 改不了蜡烛颜色，只能画细条或放弃；fill 可以用静态 `filledAreas` 或矩形近似。Piner 的 `fills` 支持逐 bar 颜色和 gradient，比 PineTS 的单一 `fill` key 更好映射。
- `request.security`：**必须接数据源，不能只传 bars 数组。**
  - Piner：`compile()` 后读 `metadata.securityDependencies`（`self` / `symbol` / `timeframe` / `lowerTf` / `dynamic`），一次性取好 HTF/外部 bars，写进 `engine.ctx.securityBars`（同品种用 `SYMBOL@TF`，外部品种用 `SYMBOL`）；`dynamic: true` 的请求无法预取，运行时返回 `na` 并记录 `securityRequests`。
  - PineTS：实现 `IProvider.getMarketData(tickerId, timeframe, ...)`，同品种 HTF 和外部品种都从网关取；不要再传普通数组，否则外部品种会静默返回当前品种的 close。
- `strategy()`：Piner/PineTS 都支持；当前入口拒绝只是 `pineScripts.ts` 的产品限制。可以后续放开，把成交标记画成箭头/线段。

#### A.2 它解决不了什么

- **逐 bar 改变蜡烛颜色**（`barcolor`）：Charting Library 没有这个 API。
- **完全动态的 `fill` 颜色/透明度**：自定义指标的 `filledAreas` 是元信息里静态声明的，不能逐 bar 变。
- **表格的原生渲染**：只能 HTML 覆盖，截图/导出时要单独处理。
- **外部品种/财务数据的 `request.*`**：`request.security` 可以靠网关补数据解决；`request.financial/economic/quandl` 等仍受数据源限制（PineTS 的 request 覆盖率是 3/11；Piner 也没有这些数据源）。`dynamic: true` 的 security 请求（symbol/timeframe 逐 bar 变化）无法预取，只能运行时返回 `na`。
- **像素级一致**：受 MT5 数据、时区、bar 切分影响。

#### A.3 要建的东西

1. **`PineRunResult` + `pineTypes.ts`**：引擎无关的归一化结构（见 A.0），保留每个点的颜色、样式、绘图对象和 table。
2. **`pineEngine.ts`（新文件）**：统一入口 `runPine(script, bars, inputs, ctx)`。
   - 先实现 `runPineWithPiner()`；Piner 不可用/解析失败时再走 `runPineWithPineTS()`。
   - 计算缓存的 key 要包含：脚本 id/源码 hash、symbol、resolution、inputs、**最后一根 bar 的 OHLC**（不是只含 time）。
   - 时间单位：Piner 的 `Bar.time` 是 epoch **毫秒**；项目若用秒，统一在适配器入口转换一次，避免 HTF 分桶错位。
   - 把 `compile()` 的 diagnostics、运行时 warnings/errors 统一成 `PineWarning[]`。
3. **`pineSecurity.ts`（新文件）**：`request.security` 的数据层。
   - Piner：从 `compiled.metadata.securityDependencies` 生成 `{symbol, timeframe, lowerTf, self, dynamic}` 列表；同品种用 `SYMBOL@TF`，外部品种用 `SYMBOL` 写入 `engine.ctx.securityBars`。
   - PineTS：实现 `IProvider`，`getMarketData()` 走网关 `history.get`，按 `tickerId/timeframe` 缓存。
   - `dynamic` 请求不预取；记录并在 UI 里提示“此脚本的动态 security 请求不支持”。
4. **`PineDrawingLayer`（新文件）**：
   - 输入：归一化后的 `PineDrawings`（label/line/box/polyline/linefill）。
   - 把 Pine 的 `bar_index` 转成图表时间（用喂给引擎的 bars 数组）；`xloc.bar_time` 直接用毫秒时间。
   - 只画可视范围 + 前后各 2 天，按对象 id 缓存，pan/zoom 时增量更新，删掉的对象同步删除。
   - `disableSave: true`，避免写进图表 layout；指标被删除时整组清理。
   - 限制数量：Pine 默认 `max_labels_count=50`，上限 500；只画可见范围，避免几千个 shape。
5. **`PineTableOverlay`（新组件）**：绝对定位在图表 pane 上，按 `position.top_right` 等映射到角落；主题色跟随 app。
6. **`pineStudies.ts` 扩展**：
   - 每个 plot 按 `style` 建对应 `plottype`；条件颜色按颜色拆成多条 plot（用 NaN 断开），或在调色板里做最近色映射。
   - marker/candle 由绘图层/覆盖层处理，不再硬塞进 `line`。
   - 增加一个隐藏的 anchor plot（全 NaN），保证“只有绘图、没有数值曲线”的脚本也能注册成指标。
   - `fill` 用 `filledAreas` 静态声明；动态颜色做多组声明或放弃。
7. **`pineRunner.ts` 修复/重写**：
   - 用 `pineEngine` 替换直接 `new PineTS(candles)`；Piner 时不需要 `new PineTS`。
   - 签名加入最后一根 bar 的 OHLC；`bar` 事件里节流触发 `tick()`/重算。
   - 把 warnings/alerts 带到 UI。
   - 可选：把 `compute()` 挪到 Web Worker（Piner 的 IR 可序列化，适合跨 worker）。
8. **`pineScripts.ts` 保存流程**：
   - 不再要求“必须有数值 plot”；有绘图对象也允许保存。
   - 保存时跑足够长的样本（例如 600–1000 根，或直接用真实历史）来探测 plot 的 key/样式/颜色。
   - 记录 `hasDrawings`、`plotStyles`、`colors`、`securityDependencies` 等元信息。

#### A.4 工作量拆解

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 4 个 bug + `request.security` 数据注入 + 错误提示 | 1–3 天 |
| P0.5 | 用你的真实脚本做 Piner/PineTS 引擎 spike（各跑一遍） | 1–2 天 |
| P1 | `PineRunResult` + Piner 适配器 + plot 样式 + markers + drawings + table overlay + security 数据层 | **6–10 天（Piner）/ 8–12 天（PineTS）** |
| P2 | TV CSV golden 测试台 + 真实脚本验收 | 3–5 天 |
| P3 | bgcolor/barcolor/fill 近似、Worker、strategy | 按需 3–7 天 |

#### A.5 风险

- **Piner 很新**（0.13.0，2026-08 发布）。本次 12 个探针脚本（6 个 bake-off + 6 个覆盖探针）全部通过，但不代表你的复杂脚本也一定过；必须用真实脚本做 P0.5 的 spike，并锁版本 + 契约测试。
- **Piner 的类型检查比 PineTS 宽松**：我们的测试里 `array.push(intArray, float)` PineTS 报错（这个脚本本身在 Pine 里也非法），Piner/PyneTS/AlphaResin 接受。宽松不一定是坏事，但可能掩盖真实类型错误；保存脚本时要保留 diagnostics。
- PineTS 的 `__labels__` 等输出是**未文档化的内部约定**。Vela-pinets 也依赖它们，说明短期内稳定，但升级 PineTS 时要做契约测试（见 P2）。
- 图表库的绘图对象在“已加载 K 线范围之外”会折叠到同一个时间点（`sessionBoxes.ts` 已经踩过），所以必须按可见范围画。
- 条件颜色需要拆线，plot 数量会膨胀；需要限制调色板/拆线数量。
- 5000 根历史对长周期指标不够；要么提高 `HISTORY_COUNT`，要么让用户配置。
- **`request.security` 的 `dynamic: true`**（symbol/timeframe 逐 bar 变化）无法预取，只能返回 `na`；如果核心脚本用了这种写法，需要提前知道。

---

### B. Vela + Vela-pinets（长期备选）

**是什么**：Vela 是 LuxAlgo 的开源图表库（Apache-2.0，npm `@luxalgo/vela` 0.10.8），`@luxalgo/vela-pinets`（AGPL-3.0）把 PineTS 接到 Vela 的 `ScriptingEngine` 上，进程内或 Web Worker 执行原生 Pine v5/v6。Vela-pinets 会消费 PineTS 的 `__labels__/__lines__/__boxes__/__tables__`、`plotshape/plotchar/plotarrow/plotbar/plotcandle/bgcolor/barcolor`，并映射到 Vela 的绘图对象；`strategy()` 的成交还会画成图表标记。[^vela-pinets]

**优点**：

- 视觉保真度最高：Pine 的绘图对象、背景色、表格、策略成交都有原生通道。
- 不需要 TradingView Charting Library 的授权；Vela 核心 Apache-2.0。
- 自带 drawing tools、native renderer，长期看可以替代现在的图表层。

**代价**：

- 换图表是**大工程**：datafeed、下单线/持仓线、画线工具、四图布局、回放、主题、截图、财经日历层都要重做。当前 `ChartPanel.tsx` 1200 行，加上 `priceLines/sessionBoxes/referenceLayer/calendarLayer`，至少 8–12 周。
- Vela 本身较新（0.10.x），API/行为还在演进，生产风险高于 Charting Library。
- Pine 插件 AGPL，和 PineTS 一样有分发义务。

**折中用法**：不换主图，只加一个“Pine 指标预览”页/侧栏，用 Vela + 同一个 datafeed 渲染完整 Pine。工作量 1–2 周，能让“看指标”达到最高保真；但交易仍在原图，两个图表引擎并存，包体和状态同步成本增加。

**适合**：你对 bgcolor/table/fill/strategy 的视觉还原是硬要求，且愿意承担换图成本；或者你本来就想摆脱 Charting Library 的授权限制。

---

### C. 网关侧 Pine 引擎（重脚本/多品种时考虑）

把 Pine 计算从浏览器搬到本地 Python 网关（项目已有 FastAPI + MT5 worker），前端只负责渲染。可选引擎：

| 引擎 | 语言 | 输入 | 覆盖/特点 | 许可 |
|---|---|---|---|---|
| **hoox-pyne / PYNE** | Python | 原生 `.pine` v5/v6 | ANTLR 语法、条循环运行时、112/112 TV golden 列、输出 plots/fills/drawings；`request.security` 同品种直通，外部/HTF 无数据源时为 `na` | AGPL-3.0 |
| **PyneCore** | Python | **Pyne（Python 语法）**，不是原生 Pine | 99.771% 的 1.31 亿个 plot 值与 TV bit-identical；67 个 `ta.*` 全量；绘图对象全量但**不渲染**，`--viz` 输出 NDJSON；原生 Pine 需要付费的 PyneComp 转换 | Apache-2.0（PyneComp 商业） |
| **PineTS/Piner sidecar** | Node | 原生 Pine | 和浏览器同一个引擎，结果一致；只是换到独立进程，避免主线程卡顿 | AGPL-3.0 |

**优点**：

- 重脚本（大数组/循环/多周期/多品种）不阻塞 UI。
- 可以访问网关门后的数据：外部品种、HTF bars、tick/volume、历史更长的 K 线。
- 可以为未来的策略回测、告警、批量扫描复用同一套计算。

**代价**：

- 新增一条 IPC/协议：脚本、输入、结果（5000 bars × 多条 plot + 绘图对象）要序列化；要处理缓存、取消、版本。
- 脚本目前存在 `localStorage`，网关需要知道脚本内容；要么前端把源码随请求发过去，要么把脚本存储上移。
- Tauri 打包要带上 Python 运行时/依赖（项目已有网关打包流程，但不是零成本）。
- **渲染问题不变**：仍然需要 A 的绘图桥。

**适合**：脚本很重、需要多品种/多周期、要做服务端告警或回测；或者你希望把 Pine 能力复用到交易逻辑里。

---

### D. 自研/分叉解释器（不推荐）

- **从零写**：Pine 的语法、序列语义、`na`、`var`、函数隔离、`request.*`、绘图对象、策略撮合，工作量 6 个月起，而且会长期追 TradingView 的新版本。
- **分叉 PineTS**：AGPL 允许你改；针对具体缺口打补丁（例如某个 `request.*`、某个绘图字段）是合理的，1–2 周量级。但要把补丁维护到上游，否则每次升级都要重放。
- **适合**：你确认某个具体 bug 卡住了核心脚本，且上游短期不会修。不是“提升整体还原度”的合理路径。

---

### E. 固定指标手工移植（少量脚本的最优解）

如果最终常用的就是 5–10 个指标：

- 用 `PineJS.Std` 写 Charting Library 自定义指标（项目已有 `studies.ts` 的“MT 双 EMA”示例），或者直接写 TS 计算 + 绘图对象。
- 每个指标 0.5–2 天；数值可以逐行对照 Pine，视觉可以完全按 Pine 的画法实现。
- 可以让 LLM 先把 Pine 翻成 TS，再人工校对 + golden 测试；对复杂脚本通常比通用引擎更准。
- 缺点：不能“粘贴任意 Pine 就能跑”；新脚本仍要人工移植。

**建议**：把“最常用的 3–5 个指标”走 E，把“偶尔试试别人的脚本”留给 A 的 PineTS 入口。这是成本/保真度最好的组合。

---

### F. 留在 TradingView（工作流，不是集成）

- 继续在 TV 上写/调指标，用“导出图表数据”CSV 做回测/对比（含数值 plot，不含绘图对象）。[^tv-export]
- 用 TV 的 alert/webhook 把信号推到本地网关，app 只负责交易执行。
- 无法把 TV 上自己的私有 Pine 指标直接嵌进 app；免费 widget 也不能加载用户私有脚本。真正的 1:1 只在 TV 网站/桌面端。

**适合**：你只需要“看指标 + 收信号”，不需要在 app 里复现指标。

---

### G. 商业授权（分发闭源时）

- **PineTS**：AGPL-3.0 / 商业授权双轨；商业授权只解决许可，不增加功能。
- **Vela**：核心 Apache-2.0；Pine 插件 AGPL，闭源分发需要商业授权（velacharts.dev/pricing）。
- **PyneCore/PyneComp**：PyneCore Apache-2.0；原生 Pine → Pyne 的编译器 PyneComp 是付费服务/API key。
- **TradingView**：没有公开授权“在自己的 app 里执行 Pine 源码”的引擎；Advanced Charts 的自定义指标是 JavaScript，不是 Pine。

**适合**：你打算把 app 分发给别人且不想开源。只自用的话，AGPL 不影响。

---

## 5. 推荐路线与排期

### 5.1 推荐：A′ + E 组合

- **常用指标走 E**：3–5 个核心脚本手工移植，保证交易时看到的图和 TV 一致。
- **任意脚本走 A′**：保留 Charting Library，**Piner 优先、PineTS 回退**，补齐渲染桥，作为“实验/研究”功能。
- **不换图表**：避免 8–12 周的重写风险。
- **Vela 作为备选**：如果 A′ 做完后，你对 bgcolor/table/fill 的近似仍不满意，再评估 B 的旁路预览或整体迁移。

为什么把 Piner 放到首选：

1. 它的 `OutputCollector` 直接给出渲染层需要的 plots/markers/candles/hlines/fills/bg/barcolors/drawings/tables，P1 的适配器代码明显更少；这份 IR 是纯数据，未来换 Vela/Canvas 也能复用。
2. 它用 `securityDependencies` + `securityBars` 把 `request.security` 的数据依赖显式化，适合接网关，且不会静默拿错品种。
3. 5000 根 warm 2ms、包 3.4MB，比 PineTS 轻一个量级；对四图/多指标场景更稳。
4. 许可仍是 AGPL，和 PineTS 一样；自用无额外负担。

为什么保留 PineTS 回退：

1. 它已经接入本项目，`ta` 覆盖率和 API 成熟度更高。
2. 只要实现 `IProvider`，MTF/外部品种也能正确；`__labels__` 等内部 key 虽然不好看，但已知可用。
3. 如果 Piner 在你的某个真实脚本上解析失败，切回 PineTS 只需要换适配器，渲染桥不动。

### 5.1.1 实施进度（2026-11-15 更新）

已落地（工作区改动，未提交）：

| 项 | 文件 | 状态 |
| --- | --- | --- |
| 引擎适配层：Piner 优先、PineTS 回退 | `src/chart/tv/pineEngine.ts`（新增） | 完成 |
| `request.security` 注入：discovery → `outputs.securityRequests` → `ctx.securityBars` → 重跑 | `pineEngine.ts` | 完成 |
| 同品种/跨品种注入键：`SYMBOL@TF` / 原始 `SYMBOL` | `pineEngine.ts` | 完成 |
| 实时 tick：签名含最后一根 bar 的 OHLC，`bar` 事件 120ms 合并 | `src/chart/tv/pineRunner.ts` | 完成 |
| 保存时预扫描改用 Piner（key=`plot_<id>`/`hline_<id>`，标题/颜色/样式/inputs 与运行时同源；失败回退 PineTS 并写 warning） | `src/lib/pineScripts.ts` | 完成 |
| 单测：数值 plot、同品种 MTF、外部品种、hline | `src/chart/tv/pineEngine.test.ts`（新增，4 例） | 完成 |
| 单测：Piner 预扫描、strategy/无 indicator 拒绝 | `src/lib/pineScripts.test.ts`（新增，3 例） | 完成 |

验证结果：`npx tsc --noEmit` 通过；`npx vitest run` 66 个文件 / 588 例全绿；`npm run build` 通过；构建产物里 Piner 单独成 chunk（236 KB），PineTS 仍是回退 chunk（810 KB）。

一个已锁定的语义细节：Piner 按 **HTF bar 的收盘时刻**对齐。最后一根 5 分钟 bar 开在 24:55、收在 25:00，此时 24:00–25:00 这根 1 小时 K 也刚收盘，所以 `request.security` 取到它的 close（1024.5），而前一根（收在 24:55）只能拿到 23:00–24:00 的 close（1023.5）。这与 TradingView `lookahead_off` 一致，单测里两根 bar 都做了断言。

尚未落地：

- 诊断仍只有 toast，没有行号定位；
- 真实脚本 bake-off 需要你提供 3–5 个在用的脚本（可先只给最复杂的那个）。

### 5.1.2 渲染桥一期（2026-11-15）

新增 `src/chart/tv/pineRenderLayer.ts`，把引擎的视觉 IR 画到图上：

| Pine 对象 | 实现方式 |
| --- | --- |
| `plotshape` / `plotchar` | `createShape`；三角形→`arrow_up`/`arrow_down`，圆/方/菱形/叉用 `text` 图形 + Unicode |
| `label.new` | `createShape` 的 `text`，文字/底色/边框透明度按 Pine 参数 |
| `line.new` | 水平线→`horizontal_line`，其余→`trend_line`（`extend` 映射到 `extendLeft/Right`） |
| `box.new` | `createMultipointShape` 的 `rectangle`，边框/填充/透明度 |
| `polyline.new` | `createMultipointShape` 的 `polyline` |
| `plotcandle` / `plotbar` | 实体矩形（open→close，宽度到下一根 bar）+ 影线（high→low）叠加在原生蜡烛上；可视范围内最多 150 根 |
| `barcolor` | 用图上 OHLC + 逐根颜色画同样的实体/影线覆盖原生蜡烛；与 plotcandle 共用 150 根预算 |
| `fill` | 逐 bar 矩形色带（上下沿取两个 plot/hline 的当期值），`zOrder: 'bottom'`；每指标最多 150 根 |
| `table.*` | 叠在图表容器上的 HTML 网格（表格是屏幕锚定，不需要坐标换算） |
| `bgcolor` | 可视价格区间上的半透明矩形，`zOrder: 'bottom'`，透明度取自颜色的 alpha |

调度与清理：

- 只画可视范围 ±2 天的对象，每个指标最多 400 个绘图对象；滚动时按需增删。
- 位置/颜色/文字变了才重建（signature 比对），避免每轮重算把图重画一遍。
- 指标隐藏 → 图形一起收起；删除指标、切换品种/周期、卸载图表 → 对应对象全部移除。
- 构造参数新增 `host`，表格覆盖层挂在图表容器里，随组件卸载一起删掉。

0 曲线脚本（FVG 这类只有 `box` 的指标）：

- 保存时允许 `plots` 为空（只要试跑产出了绘图对象），图表指标里补一条隐藏的「（绘图对象）」占位曲线，满足图表库「至少一条 plot」的硬要求；保存提示相应改成「仅绘图对象（box/label/table）」。
- 元信息必须带顶层 `styles: { plot_0: { title, isHidden } }`：图表库「设置」对话框的样式页用 `metaInfo.styles[id].title` 渲染，缺了会在 `ensureDefined` 里抛 `Value is undefined`，表现为点「设置」毫无反应。内置的 `mt-ema-ribbon`、`mt-pro-sessions` 与所有 Pine 指标都要声明。另外颜色默认值必须写成 `#RRGGBB`/`rgba()`，8 位 `#RRGGBBAA` 同样会让对话框打不开（旧模板在加载时自动迁移）。
- `syminfo.mintick` 由 `PineRunner` 从网关的 `SymbolInfo.tickSize || point` 取值传入引擎，`math.round(gap_size / syminfo.mintick)` 这类跳数过滤才和 TradingView 一致（Piner 默认 0.01）。
- 实测 `DeepCharts - FVG Identifier [v6]`（`build/pine-bakeoff/fvg-probe.mjs`，300 根合成 bars）：`type FvgData`、`array<FvgData>`、`switch`、降序 `for`、`box.new/set_right/delete`、`timeframe.change("D")` 全部可编译可运行，产出 58 个 box、0 条 plot；`mintick` 0.01 / 0.25 均正常。

已知限制：

- `fill` 是逐 bar 矩形拼接，不是真正的多边形：放大到 bar 间距很大时相邻 bar 之间能看到台阶；梯度填充只取顶部颜色近似。
- `linefill.new`（两条 `line` 之间的填充）仍未渲染：需要按两条线在每根 bar 上的插值生成色带，暂未做，脚本用到时会在 toast 里提示一次。
- `plotcandle`/`plotbar`/`barcolor` 都是叠加近似，不是真正的蜡烛替换：实体/影线画在原生蜡烛之上，`plot.style_columns` 也按蜡烛画；十字星（open = close）只画影线；三者共享每指标 150 根预算。
- `plotshape(..., location.absolute)` 的 y 值 Piner 的 `MarkerPoint` 没有带出来，暂用该 bar 的 `close` 代替，会偏离真实值。
- 表格位置用固定内边距（右侧避让价格轴 72px、底部避让时间轴 28px），不是像素级精确。
- 绘图对象都落在主图；非 overlay 指标（副图振荡器）上的绘图暂未做 pane 映射。

验收：`pineRenderLayer.test.ts` 9 例（marker 坐标、可见范围过滤与去重、label/line/box、bgcolor 价格区间、plotcandle 实体+影线、barcolor 与共享预算、fill 色带、table HTML、隐藏/删除清理）、`pineEngine.test.ts` 7 例、`pineStudies.test.ts` 6 例（0 曲线占位、多曲线元信息、styles 标题、颜色迁移、隐藏占位 styles）、`studies.test.ts` 1 例（每个内置指标的每条 plot 都有 styles 标题）；`npx vitest run` 68 个文件 603 例全绿，`npm run build` 通过。真实图表上的视觉验收还需要你在应用里挂一个用 `plotshape + label + table` 的脚本看一眼。

### 5.2 P0：先修 4 个确定性 bug（1–3 天）

1. `pineRunner.ts`：先补上 `symbol` / `resolution`，让 `request.security` 至少知道当前周期：
   ```ts
   const pine = new PineTS(candlesFrom(bars), symbol, resolution);
   ```
   已实测 `resolution` 传 `"5"`、`"60"`、`"240"`、`"1D"`、`"1W"` 都能被 PineTS 识别。  
   **但这还不够**：普通数组只能让 PineTS 用图上数据聚合 HTF；外部品种会静默返回当前品种的 close。P0 里要同时实现 `IProvider`（见 4.A.3 的 `pineSecurity.ts`），或者明确禁用外部品种并报错。

2. 计算签名加入最后一根 bar 的 OHLC，并在 `bar` 事件里节流触发 `tick()`：
   ```ts
   const last = bars?.bars[bars.bars.length - 1];
   const signature = JSON.stringify([
     script.id, symbol, resolution, inputs,
     last?.time, last?.open, last?.high, last?.low, last?.close,
   ]);
   ```

3. `pineScripts.ts`：不再要求必须有数值 plot；把 `plotcandle/plotbar` 的数组值保留下来；把 `__labels__` 等绘图 key 存进结果，而不是过滤。

4. 错误诊断：把 `ctx.warnings`、解析错误、运行时错误（含行号）显示在脚本编辑器和图表上，而不是只弹 toast。

### 5.3 P0.5：用真实脚本做 2 天引擎 bake-off（1–2 天）

在写渲染桥之前，先用你真实在用的 3–5 个脚本（尤其是最复杂的那个）做一次对比。步骤：

1. **准备 golden**：在 TradingView 上对每个脚本“导出图表数据”CSV（OHLCV + 所有数值 plot 列），保存到 `testdata/pine/<script>.csv`。
2. **同数据跑两家**：把 CSV 的 OHLCV 同时喂给 Piner 和 PineTS，按时间对齐同名 plot 列。
3. **数值对比**：`abs <= 1e-8` 或 `rel <= 1e-6`；记录最大偏差和首个偏离 bar。warmup 段单独标注。
4. **视觉对比**：统计 marker 数量/位置、drawing 数量/坐标、table 单元格；与 TV 截图逐项对照，位置误差目标 ≤ 1 根 bar / 1 个 tick。
5. **MTF 对比**：给两家都注入同一份 HTF/外部 bars，确认 `lookahead_off` 边界一致；未注入时确认返回 `na` 而不是静默用错数据。
6. **决策**：
   - 核心脚本全部通过 → **Piner 作为主引擎**。
   - 有 1 个核心脚本 Piner 失败、PineTS 通过 → 以 PineTS 为主，Piner 只用于新脚本/实验。
   - 两家都失败 → 该脚本走 E（手工移植），不要为了它换图表。

**通过标准**：无解析错误；数值最大相对误差 < 1e-6；视觉对象数量一致、位置误差 ≤ 1 bar/1 tick；MTF 边界与 TV 一致。

### 5.4 P1：渲染桥（6–10 天 Piner / 8–12 天 PineTS）

按第 4.A.3 建核心模块：

- `src/chart/tv/pineEngine.ts` + `pineTypes.ts`：引擎适配、归一化 `PineRunResult`、缓存。
- `src/chart/tv/pineSecurity.ts`：`securityDependencies` / `IProvider` → 网关取数 → 注入。
- `src/chart/tv/pineDrawings.ts`：label/line/box/polyline → `createShape`/`createMultipointShape`。
- `src/chart/tv/pineTables.tsx`：table → HTML overlay。
- `src/chart/tv/pineStudies.ts`：plot 样式/颜色/fill/hline；隐藏 anchor plot。
- `src/chart/tv/pineRunner.ts`：调度、实时 tick、Worker（可选）、生命周期。

**P1 验收**：

- 5 个真实脚本：plotshape、label、line、box、table、bgcolor 至少各覆盖一个。
- 可见范围内的绘图对象不缺失；位置误差 ≤ 1 根 bar / 1 个 tick。
- 切换周期、切换品种、删除指标、关闭图表后无残留对象。
- 5000 根 bar、3 个指标、四图布局下不卡顿（单次重算 < 300ms，绘图同步 < 100ms）。

### 5.5 P2：数值 golden 测试台（3–5 天）

1. 从 TradingView 导出目标脚本的 CSV（时间、OHLCV、各指标列）。[^tv-export]
2. 写 `scripts/pine-golden.mjs`：
   - 读 CSV 的 OHLCV，喂给主引擎（Piner/PineTS）；
   - 按时间对齐每个 plot 列；
   - 容差：`abs <= 1e-8` 或 `rel <= 1e-6`；记录最大偏差和第一个偏离点；
   - 输出 `testdata/pine/<script>.json`。
3. 加 `npm run pine:check`，把结果纳入 CI/发版前检查。
4. 对绘图对象做人工/截图验收（CSV 不含绘图）。

**P2 验收**：

- 核心脚本的数值最大相对误差 < 1e-6。
- 每个脚本的“首个偏离 bar”可解释（warmup、数据切分、request 限制）。
- 形成一份 `docs/PINE_COMPATIBILITY.md`：脚本 × 功能 × 状态。

### 5.6 P3：按需增强

- bgcolor/barcolor/fill 的近似策略；
- `strategy()` 成交标记；
- Web Worker；
- `request.security_lower_tf`、`dynamic: true` 的 security 请求、`request.financial/economic` 等外部数据；
- 评估 Vela 旁路预览或整体迁移。

---

## 6. 验收方法

### 6.1 数值验收（可自动化）

| 项目 | 方法 | 通过标准 |
|---|---|---|
| 引擎计算 | TV CSV 的 OHLCV → 主引擎/回退引擎，对比同名 plot 列 | 最大相对误差 < 1e-6 |
| 引擎一致性 | 同一 CSV 分别跑 Piner/PineTS，逐列对比 | 最大相对误差 < 1e-9；不一致的列标为“引擎差异” |
| 多周期 | 给引擎注入同一份 HTF bars，跑 `request.security("60")`，对比 TV 的 HTF 列 | 误差 < 1e-6，边界 bar 允许 1 根 |
| 外部品种 | 注入 `BTCUSD` bars，跑 `request.security("BTCUSD","60",close)` | 与注入值一致；未注入时返回 `na` + warning，**不得**返回当前品种 close |
| 输入参数 | 改 `input.int/source/timeframe`，对比 TV | 与 TV 同参数结果一致 |
| 数据偏差 | MT5 bars vs TV bars 同时间戳对比 | 单独统计，不混入引擎误差 |

### 6.2 视觉验收（人工 + 截图）

每个脚本一张清单：

- [ ] 曲线数量、颜色、线宽、线型（实线/虚线/点线）
- [ ] `plotshape/plotchar` 的位置（abovebar/belowbar/absolute）、形状、颜色、大小
- [ ] `label` 的位置、文字、颜色、背景、大小
- [ ] `line` 的起止点、延伸、线型、宽度
- [ ] `box` 的边界、填充、边框、文字
- [ ] `table` 的位置、行列、边框、文字
- [ ] `bgcolor/barcolor/fill` 的近似效果（明确标注“近似”）
- [ ] 历史绘图对象在 pan/zoom 后不漂移、不重复、不残留

### 6.3 性能验收

- 引擎计算：5000 根、单指标 < 50ms（Piner 实测 2ms，PineTS 35ms）；
- 端到端（含渲染桥）：5000 根、单指标 < 150ms；5 指标 < 500ms；
- 绘图对象同步：可见范围 200 根 bar、50 个对象，< 100ms；
- 拖动/缩放时不掉帧；重脚本用 Worker。

---

## 7. 风险与边界

| 风险 | 影响 | 应对 |
|---|---|---|
| MT5 vs TV 数据不同 | 数值/形态永远有差异 | 用 TV CSV 的 OHLCV 做引擎验收；数据偏差单独统计 |
| **Piner 较新** | 真实脚本可能解析失败/行为变化 | P0.5 spike；锁版本；契约测试；保留 PineTS 回退 |
| **Piner 类型检查较宽松** | 可能掩盖脚本本身的类型错误 | 保存时保留 diagnostics；与 TV 编译结果对照 |
| PineTS 内部输出未文档化 | 升级可能破坏绘图桥 | 锁版本 + 契约测试（P2） |
| **PineTS 传数组时静默用错外部数据** | 指标值看似正常但品种错误 | 必须实现 `IProvider`；无 provider 时外部品种应报错/置 `na` |
| **`request.security` 动态请求** | 无法预取，返回 `na` | 检测 `dynamic`；UI 提示；必要时走 E |
| Charting Library 自定义指标只能出数值 | bgcolor/barcolor/fill/table 无法原生 | 绘图对象/HTML 近似；或选 B |
| 绘图对象性能 | 几千个 shape 会卡 | 只画可见范围 + 数量上限 + 节流 |
| AGPL | 分发闭源安装包有义务 | 自用无影响；分发则商业授权或开源 |
| Vela 较新 | API/行为变化 | 先用旁路预览验证，不急于替换主图 |
| 上游 Pine v6 新特性 | 覆盖率下降 | 关注 Piner/PineTS release；必要时分叉打补丁 |

---

## 8. 需要你拍板的事

1. **引擎**：接受“Piner 优先、PineTS 回退”，还是坚持 PineTS？如果你有很强的“先稳”偏好，PineTS + `IProvider` + 渲染桥也完全可行，只是 P1 多约 2 天。
2. **你的脚本清单**：能否给 3–5 个真实在用的 Pine 脚本（尤其是最复杂的）？这是 P0.5 bake-off 的唯一输入；没有它，Piner/PineTS 的选择只能按我们的合成脚本推断。
3. **必保的视觉元素**：`plotshape` / `label` / `line` / `box` / `table` / `bgcolor` / `barcolor` / `fill` / `strategy` 成交，哪些是“没有就不行”？这决定 P1 的范围和是否最终要上 Vela。
4. **数值要求**：是“形态接近即可”，还是“同一份数据下必须 1e-6 一致”？
5. **分发范围**：只自己用，还是会给别人装？这决定 AGPL/Charting Library 授权要不要认真处理；自用则 Piner/PineTS 的 AGPL 不影响。
6. **是否接受本地 Python 计算服务**：如果脚本很重/要多品种，C 值得；否则 A′ 就够。
7. **是否愿意换/加图表**：如果 bgcolor/table/fill 是硬要求，B 的旁路预览是最小代价；整体换图是 8–12 周。

---

## 9. 参考

- PineTS（LuxAlgo）：<https://github.com/LuxAlgo/PineTS>
- PineTS 文档：<https://docs.luxalgo.com/developers/pinets>
- PineTS API 覆盖率：<https://docs.luxalgo.com/developers/pinets/api-coverage>
- Piner：<https://github.com/heyphat/piner>
- Piner 编译器设计（语言子集/安全语义）：<https://github.com/heyphat/piner/blob/main/docs/compiler-design.md>
- Piner npm：<https://www.npmjs.com/package/@heyphat/piner>
- Vela：<https://github.com/LuxAlgo/Vela>
- Vela-pinets：<https://github.com/LuxAlgo/Vela-pinets>
- PyneCore：<https://github.com/PyneSys/pynecore>
- PyneCore 兼容性：<https://pynecore.org/docs/overview/compatibility/>
- hoox-pyne（PYNE）：<https://github.com/hoox-sh/pyne>
- PyneTS（PYNE 的 TS 端口）：<https://github.com/hoox-sh/pynets>
- AlphaResin：<https://github.com/fadhilmhd/alpharesin>
- AlphaResin 文档：<https://fadhilmhd.github.io/alpharesin/>
- TradingView 自定义指标文档：<https://www.tradingview.com/charting-library-docs/latest/custom_studies/>
- TradingView Pine 绘图对象：<https://www.tradingview.com/pine-script-docs/latest/visuals/drawings/>
- TradingView 导出图表数据：<https://www.tradingview.com/support/solutions/43000537255-how-to-export-chart-data>

[^pinets-coverage]: PineTS README 的 API coverage badges，读取于 2026-11-15；`request` 为 3/11，其余指标相关 namespace 基本满覆盖。
[^piner-ir]: Piner 的 `OutputCollector` / `PlotSeries` / `MarkerSeries` / `CandleSeries` / `FillRegion` / `SecurityRequest` 类型见 `@heyphat/piner` 的 `dist/runtime/output.d.ts` 与 `dist/engine/feed.d.ts`；`compile()` 的 `metadata.securityDependencies` 在 0.13.0 实测可用。
[^vela-pinets]: 从 `@luxalgo/vela-pinets@0.3.4` 包内代码可确认它消费 `__labels__/__lines__/__boxes__/__tables__` 以及 `plotshape/plotchar/plotarrow/plotbar/plotcandle/bgcolor/barcolor`。
[^tv-export]: TradingView “导出图表数据”会包含图上所有指标的数值 plot 列（包括 `display.none`），不包含绘图对象；导出范围受当前已加载历史限制。

---

## 附录 A：建议的结果结构

```ts
export interface PinePlotSeries {
  key: string;
  title: string;
  style: 'line' | 'area' | 'columns' | 'circles' | 'stepline' | 'histogram';
  data: { time: number; value: number | null; color?: string }[];
}

export interface PineMarker {
  time: number;
  title: string;
  kind: 'shape' | 'char' | 'arrow';
  location: 'abovebar' | 'belowbar' | 'top' | 'bottom' | 'absolute';
  glyph: string;
  color?: string;
  text?: string;
}

export interface PineCandleSeries {
  title: string;
  data: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    color?: string;
    wickColor?: string;
    borderColor?: string;
  }[];
}

export interface PineHLine {
  title: string;
  price: number;
  color?: string;
  style?: 'solid' | 'dotted' | 'dashed';
  width?: number;
}

export interface PineColorRun {
  /** bar index range, inclusive start/exclusive end */
  from: number;
  to: number;
  color: string;
}

export interface PineFill {
  title: string;
  plot1: string;
  plot2: string;
  color?: string;
  colors?: { time: number; color: string }[];
  gradient?: { topValue: number[]; bottomValue: number[]; topColor: (string | null)[]; bottomColor: (string | null)[] };
}

export interface PineLabel {
  id: string;
  time: number;
  price: number;
  text: string;
  color?: string;
  textColor?: string;
  style?: string;
  size?: string;
}

export interface PineLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  width?: number;
  style?: 'solid' | 'dotted' | 'dashed' | 'arrow_left' | 'arrow_right' | 'arrow_both';
  extend?: 'none' | 'left' | 'right' | 'both';
}

export interface PineBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  borderColor?: string;
  bgColor?: string;
  borderWidth?: number;
  text?: string;
}

export interface PinePolyline {
  id: string;
  points: { time: number; price: number }[];
  color?: string;
  width?: number;
}

export interface PineLinefill {
  id: string;
  line1: string;
  line2: string;
  color?: string;
}

export interface PineDrawings {
  labels: PineLabel[];
  lines: PineLine[];
  boxes: PineBox[];
  polylines: PinePolyline[];
  linefills: PineLinefill[];
}

export interface PineTable {
  position: 'top_left' | 'top_center' | 'top_right' | 'middle_left' | 'middle_center' | 'middle_right' | 'bottom_left' | 'bottom_center' | 'bottom_right';
  columns: number;
  rows: number;
  cells: { column: number; row: number; text: string; width?: number; height?: number; textColor?: string; bgColor?: string }[];
}

export interface PineRunResult {
  plots: PinePlotSeries[];
  markers: PineMarker[];
  candles: PineCandleSeries[];
  hlines: PineHLine[];
  fills: PineFill[];
  bgcolors: PineColorRun[];
  barcolors: PineColorRun[];
  drawings: PineDrawings;
  tables: PineTable[];
  alerts: { time: number; message: string }[];
  warnings: { message: string; bar?: number }[];
  meta: { engine: 'piner' | 'pinets'; bars: number; durationMs: number; pineVersion: number | null };
}
```

引擎输出到归一化结构的映射：

| 归一化字段 | Piner 0.13.0 | PineTS 0.13.1 |
|---|---|---|
| `plots` | `engine.outputs.plots`（`PlotSeries.data/colors/options`） | `ctx.plots[key]`，排除 `__*`、`bgcolor#`、`barcolor#`、fill |
| `markers` | `engine.outputs.markers`（`MarkerSeries`） | `ctx.plots[key].options.style` 为 `shape/char/arrow`，布尔序列 + `options.color` |
| `candles` | `engine.outputs.candles`（`CandleSeries`） | `ctx.plots[key].value = [o,h,l,c]` 的数组值 |
| `hlines` | `engine.outputs.hlines` | `ctx.plots[key].options.style === 'hline'` |
| `fills` | `engine.outputs.fills`（`FillRegion`） | `ctx.plots[key].options.style === 'fill'` |
| `bgcolors` | `engine.outputs.bgColors` | `bgcolor#N` |
| `barcolors` | `engine.outputs.barColors` | `barcolor#N` |
| `drawings` | `engine.drawings`（`DrawObject[]`） | `__labels__/__lines__/__boxes__/__polylines__/__linefills__` |
| `tables` | `engine.drawings` 里 `type === 'table'` | `__tables__` |
| `alerts` | `engine.outputs.alerts` | `ctx.alerts` |
| `security` 依赖 | `compiled.metadata.securityDependencies` / `engine.outputs.securityRequests` | `IProvider.getMarketData()` 的调用；或运行时拦截 |
| `strategy` | `engine.strategy` / `engine.strategyMetrics()` | `ctx.strategy` |

渲染器接口：

```ts
export interface PineRenderer {
  /** 图表可见范围变化 / 新结果到达时调用 */
  sync(visible: { from: number; to: number }, result: PineRunResult): void;
  dispose(): void;
}
```

## 附录 B：探针脚本

本次调研用的探针放在 `build/`（已 gitignore，不会提交）：

- `build/pine-probe.mjs`：绘图对象、plotshape、bgcolor、fill、table、array/loop/UDT。
- `build/pine-probe2.mjs`：`request.security` 的 timeframe 配置、input 覆盖、5000 根性能。
- `build/pine-probe3.mjs`：plot 各种 style、plotcandle/plotbar、barcolor/bgcolor 的输出结构。
- `build/pine-bakeoff/`：四引擎隔离项目（`pinets` / `@heyphat/piner` / `@hoox-sh/pynets` / `alpharesin`）。
  - `run.mjs`：6 个脚本 × 4 引擎，统计 plots/markers/candles/hlines/fills/bg/barcolors/drawings/tables/alerts。
  - `compare.mjs`：数值一致性、MTF、plotcandle/plotbar、drawings、warm 性能。

复现：

```bash
node build/pine-probe.mjs
node build/pine-probe2.mjs
node build/pine-probe3.mjs
```

```bash
cd build/pine-bakeoff
npm install --ignore-scripts --no-audit --no-fund
node run.mjs
node compare.mjs
```

> `build/pine-bakeoff` 里的依赖是临时安装的，不会进主项目的 `package.json`；如果要把它变成正式测试，建议把 `run.mjs`/`compare.mjs` 的逻辑收进 `scripts/pine-golden.mjs`，并把四个引擎放到 `devDependencies` 或独立 workspace。
