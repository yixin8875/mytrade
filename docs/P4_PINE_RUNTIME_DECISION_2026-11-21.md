# P4-1 Pine 运行时收敛：Piner 单引擎方案

> 状态：**方案 A 已实施（2026-11-21）**；本文保留决策依据与验收标准  
> 日期：2026-11-21  
> 关联：[Pine 指标还原选型（2026-11-15）](PINE_INDICATOR_OPTIONS_2026-11-15.md) · 冒烟脚本 [docs/pine-smoke-test.pine](pine-smoke-test.pine)

## 0. 结论先行

1. **可以完全删除 PineTS。** 项目现在把 Piner 作为主引擎、PineTS 只在 Piner 抛错时兜底；在所有实测脚本里，PineTS 能跑的 Piner 都能跑，而 PineTS 在兜底时**不产出任何绘图对象**，`request.security` 还会**静默用错数据**。这不是"差一点的备胎"，而是"看起来有图、其实可能错"的备胎。
2. **删除后唯一的产品取舍**：Piner 编译不了的脚本会从"降级运行"变成"明确报错"。考虑到降级运行本身画不出 label/line/box/table，曲线 key 也与 Piner 不一致，这个取舍是净收益。
3. **建议做法**：先做一次真实脚本 spike（0.5 天），确认你常用/收藏的脚本都能过 Piner；然后按第 7 节步骤删除 PineTS、清理文案与依赖，预计 **0.5–1 天**完成，收益是懒加载体积 −211 KB gzip、node_modules −19 MB、少 3 个传递依赖、少一条代码路径。
4. 本文只是方案，**审批通过后才动代码**。

---

## 1. 现状：两套运行时是怎么接进来的

### 1.1 调用链

```
Settings 粘贴脚本
  └─ pineScripts.savePineScript()
       ├─ scanWithPiner()       ← 主：解析 inputs/plots、试跑 120 根模拟 K 线
       └─ scanWithPineTS()      ← 仅当 Piner 抛错；扫出的 key 是 PineTS 的命名
  └─ record { plots, inputs, warning? } 存 localStorage

图表上的 Pine 指标
  └─ pineRunner.PineRunner（每图 1.2s 轮询 + bar 更新）
       └─ pineEngine.runPine()
            ├─ runPiner()      ← 主：series + visuals + request.security 注入
            └─ runPineTS()     ← 仅当 Piner 抛错；只有 series，visuals 恒为空
```

### 1.2 代码位置

| 位置 | 作用 |
|---|---|
| [`src/chart/tv/pineEngine.ts:738`](../src/chart/tv/pineEngine.ts#L738) | `runPiner`：编译 + 运行，产出 series、视觉 IR、security 依赖 |
| [`src/chart/tv/pineEngine.ts:806`](../src/chart/tv/pineEngine.ts#L806) | `runPineTS`：现有兜底，只取 `ctx.plots` |
| [`src/chart/tv/pineEngine.ts:867`](../src/chart/tv/pineEngine.ts#L867) | `runPine`：`try Piner / catch PineTS`，失败信息拼两段 |
| [`src/lib/pineScripts.ts:246`](../src/lib/pineScripts.ts#L246) | `scanWithPiner`：保存时预扫描 |
| [`src/lib/pineScripts.ts:299`](../src/lib/pineScripts.ts#L299) | `scanWithPineTS`：保存时兜底扫描 |
| [`src/lib/pineScripts.ts:379`](../src/lib/pineScripts.ts#L379) | 保存流程里的 Piner→PineTS→报错三级回退 |
| [`src/components/SettingsPanel.tsx:2023`](../src/components/SettingsPanel.tsx#L2023) | UI 说明"Piner（失败时回退 PineTS）" |
| [`src/components/SettingsPanel.tsx:2120`](../src/components/SettingsPanel.tsx#L2120) | 免责声明同时点名两个运行时 |
| [`package.json:22`](../package.json#L22) / [`:28`](../package.json#L28) | `@heyphat/piner` 0.13.0 / `pinets` ^0.13.1 |

历史上 PineTS 先接入（`aad49f0`，只画数值曲线），Piner 后接入（`b308b35`）并成为主引擎，PineTS 被降级为兜底，但兜底代码、文案和依赖一直保留。

---

## 2. 两套运行时是什么

| | Piner | PineTS |
|---|---|---|
| 包 | `@heyphat/piner` 0.13.0 | `pinets` 0.13.1 |
| 定位 | **Pine v6 编译器 + 运行时**（clean-room，按公开 v6 文档实现） | **Pine v5/v6 转译器 + 运行时**（原生 v6 标注为 experimental） |
| 输入 | `compile(source)` → `new Engine(compiled, new ArrayFeed(bars))` | `new PineTS(candles, symbol, tf)` → `run(new Indicator(source))` |
| 输出 | 公开的视觉 IR：`plots / hlines / fills / bgColors / barColors / candles / markers / drawings`，且 `compiled.metadata` 直接给出 input 元信息与 `securityDependencies` | `ctx.plots` 等**未文档化的内部 key**（`__labels__`、`bgcolor#0`…），绘图对象需自行解析 |
| `request.security` | `metadata.securityDependencies` 预声明依赖 + `engine.ctx.securityBars` 注入，未注入返回 `na` 并记录 `securityRequests` | 传数组时只按图上数据聚合；**外部品种会静默返回当前品种 close**；要正确必须实现 `IProvider` |
| 许可 | AGPL-3.0-only | AGPL-3.0-only |
| 包体积（本机安装） | **3.6 MB** | **19 MB** |
| 构建产物（本次 `vite build`） | 独立 chunk **231 KB / 66 KB gzip** | 独立 chunk **791 KB / 211 KB gzip** |
| 传递依赖 | 无 | `acorn`、`acorn-walk`、`astring` |
| 速度（5000 根 warm，本机） | SMA 2 ms · RSI+MACD 2 ms · 布林 4 ms | SMA 20 ms · RSI+MACD 38 ms · 布林 33 ms |
| 成熟度 | 新（0.13，2026-08 首发），但输出结构公开、契约清晰 | 较成熟，`ta` 覆盖广，但绘图输出依赖内部约定 |

> 包体积/性能/`request.security` 行为与 2026-11-15 的横向实测一致（当时记录 PineTS 18.1 MB / Piner 3.4 MB、5000 根 35 ms vs 2 ms）；本次复测 Piner 结论不变，PineTS 因脚本不同在 20–38 ms。

---

## 3. 能力强弱：逐项对比

### 3.1 语言与计算

| 能力 | Piner | PineTS | 对项目的影响 |
|---|---|---|---|
| Pine v6 主体语法（变量、`var`、循环、`switch`、函数、UDT、`method`、`enum`、array/matrix/map） | ✅ 实测全部通过 | ✅ 实测全部通过 | 无差异 |
| Pine v5 | ✅ 兼容常用写法 | ✅ | 无差异 |
| **v5 旧别名**：`security()`、`iff()`、`cross()`、`rising()`、`falling()`、`cum()` | ✅ **实测可用** | ❌ **实测报 `Undeclared identifier`** | 删除 PineTS 反而**扩大**可运行脚本范围 |
| `ta.*` 进阶函数（pivot、valuewhen、barssince、linreg、wma、dmi、bb、kc、vwap、wpr、tsi、roc、dev、variance、correlation…） | ✅ 44/44 有效脚本通过 | ✅ 同批通过 | 无差异 |
| `strategy()` | ✅ 引擎支持；入口按产品规则拒绝 | ✅ 同 | 不受影响 |
| 未知/外部数据 `request.financial/economic` | 无数据源（返回 `na`/警告） | 覆盖率约 3/11，多数无数据源 | 两者都不解决，不构成保留理由 |

### 3.2 输出与渲染

| 能力 | Piner | PineTS 兜底路径的实际结果 |
|---|---|---|
| `plot` / `hline` 数值曲线 | ✅ 稳定 key `plot_<id>` / `hline_<id>` | ✅ 有值，但 key 是 `plot#…` 等内部命名，和保存时 Piner 扫描的 key 不一致，只能靠标题/类型兜底匹配 |
| `plotshape` / `plotchar` | ✅ 类型化 `markers`（glyph/location/color/text） | ❌ `runPineTS` **不产出 visuals**；布尔序列还会被当成"无数值"跳过 |
| `label` / `line` / `box` / `polyline` / `table` | ✅ 类型化 `drawings`（本项目已全部接入渲染桥） | ❌ **不产出 visuals**，只能画数值曲线；纯绘图脚本在兜底里等于空图 |
| `fill` / `bgcolor` / `barcolor` | ✅ 逐 bar 颜色 / gradient | ❌ 不产出 visuals；`bgcolor#`/`barcolor#` 被过滤掉 |
| `plotcandle` / `plotbar` | ✅ `candles`（含 wick/border 颜色） | ❌ 不产出 visuals |
| 输入参数（`input.*`） | ✅ `metadata.inputs` 带 id/title/type/默认值/范围/options | ✅ 有元信息，但 id/title 体系与 Piner 不同，运行时要按 title 映射 |
| `request.security`（同品种 HTF） | ✅ 预取 + 注入，按 HTF 收盘对齐 | ⚠️ 未实现 `IProvider` 时边界偏移（2026-11-15 实测 101.53 vs 正确 107.01） |
| `request.security`（外部品种） | ✅ 预取 + 注入 | ❌ **静默返回当前品种 close**（实测 218/218，无 warning） |

**这一节是删除决策的核心**：兜底路径不是"少画几个对象"，而是"可能画出一条看似合理、数值错误的线"。对于交易工具，静默错误比明确报错危险得多。

### 3.3 性能与工程成本

| 维度 | Piner | PineTS |
|---|---|---|
| 5000 根 warm 计算 | 2–4 ms | 20–38 ms（约慢一个数量级） |
| 每图轮询 | 1.2 s/图，5000 根；计算在主线程 | 同频轮询下占用高 10 倍以上 |
| 懒加载传输 | 66 KB gzip | 211 KB gzip |
| 安装体积 | 3.6 MB | 19 MB |
| 维护面 | 一条路径 | 两套输入映射、两套 key、两套错误信息、两套保存扫描 |

---

## 4. 本次实测记录（2026-11-21）

方法：Node 直接调用两个引擎，合成 5 分钟 bars（120–5000 根），覆盖基础指标、进阶 `ta.*`、UDT/method/enum、array/matrix/map、绘图对象、`request.security`（含 tuple）、v5 旧别名、strategy。脚本只放在本地 `build/pine-compare/`（已被 `.gitignore` 忽略），未提交。

| 批次 | 脚本数 | Piner | PineTS |
|---|---|---|---|
| 基础（SMA/RSI/MACD/输入/绘图/security/UDT 等） | 10 | 10 通过 | 10 通过 |
| 真实指标（布林、Supertrend、Ichimoku、plotcandle、matrix、linefill、lower_tf、alert） | 10 | 10 通过 | 10 通过（但绘图对象拿不到） |
| v6 进阶（enum/map/loops/time/inputs/label/box/polyline） | 10 | 9 通过，1 条脚本本身非法（`??`） | 同左 |
| v5/v6 语法对照 | 11 | 10 通过，1 条本身非法（`??`） | **7 通过**，3 条因 `security/iff/cross/rising/falling/cum` 报未声明标识符 |
| 进阶 `ta.*` + 绘图删除 + security tuple | 5 | 5 通过 | 5 通过（绘图对象仍为空） |

结论：**44 条有效脚本中 Piner 44/44 通过；PineTS 41/44，且失败的三条恰是常见的老 v5 写法。** 没有发现任何"PineTS 能跑而 Piner 跑不了"的样本。

补充：

- 数值一致性：SMA/RSI 两者逐值一致；`request.security` 在不注入 HTF 数据时两者取值不同，Piner 返回可解释的对齐值，PineTS 按图内数据偏移。
- 本项目预览环境里 `localStorage['mytrade.pineScripts']` 为 0 条，**没有你的真实脚本可测**；这是删除前唯一需要你配合补测的部分（见 7.0）。
- 2026-11-15 的选型文档还记录过：PineTS 接 `IProvider` 后 MTF 可以正确，但当前代码从未接 provider——也就是说"兜底"这个场景下它永远处于错误模式。

---

## 5. 能不能完全删除 PineTS？

### 5.1 技术判断：可以

- 触发条件单一：PineTS 只在 `runPiner`/`scanWithPiner` 抛错时被调用，主路径不依赖它。
- 能力不互补：兜底只取数值曲线，不取视觉对象；`request.security` 无 provider；v5 旧别名反而更弱。它没有覆盖 Piner 缺的能力。
- 删除面清晰：2 处动态 import、1 个扫描函数、1 个运行函数、2 处 UI 文案、1 个依赖，以及若干处注释/文档表述。
- 可回滚：删除是一个独立提交，回滚只需恢复文件并 `npm ci`。

### 5.2 删除后会失去什么

| 场景 | 现在 | 删除后 |
|---|---|---|
| Piner 能编译的脚本 | 正常（Piner） | 不变 |
| Piner 编译失败的脚本 | 尝试 PineTS：只出曲线；绘图脚本空图；MTF 可能取错数据 | **保存/运行时明确报错**，提示"Piner 不支持该语法"，不会给出误导性的图 |
| 保存时 Piner 预扫描失败 | 用 PineTS 扫 inputs/plots，记录 warning | 保存失败，错误信息只保留 Piner 的原因 |
| 纯绘图脚本的兜底 | PineTS 扫描 `visuals=0`，通常仍会被拒绝 | 同（Piner 正常支持纯绘图脚本） |

### 5.3 不能删除的前提（必须满足）

1. **真实脚本 spike 通过**：用你实际收藏/使用的 3–5 个脚本跑 Piner-only；只要有一个 Piner 编译失败且你希望它继续可用，就改为方案 B（见 6）。
2. **错误 UX 可接受**：保存失败时给出明确原因（语法/未支持函数），运行失败时 toast 只弹一次而不是每 1.2 秒刷新（现有 `reportedErrors` 按 signature 去重，已满足）。
3. **锁定 Piner 版本**：`@heyphat/piner` 用精确版本（当前已是 `0.13.0`，无 `^`），升级前跑契约测试。

---

## 6. 方案选项

### 方案 A：Piner 单引擎（推荐）

- 删除 `runPineTS`、`scanWithPineTS` 与全部回退文案；`runPine` 直接调用 `runPiner`。
- Piner 失败 = 保存/运行失败，错误信息只包含 Piner 原因，并附一句"该脚本可能使用了当前引擎尚不支持的语法"。
- 保留 `regexPlots`（Piner 跑通但 0 曲线时按源码猜曲线）与纯绘图脚本的保存路径。

**收益**：−211 KB gzip、−19 MB node_modules、−3 个传递依赖；单一 key/输入映射；消除 MTF 静默错误；错误可解释。  
**代价**：Piner 编译不了的脚本不再"降级可用"。

### 方案 B：PineTS 仅保留为"保存时兜底扫描"

- 运行时仍只走 Piner；保存时 Piner 失败改用 PineTS 扫 inputs/plots 并打 warning。
- 问题：保存下来的 key 是 PineTS 命名，运行时 Piner 若也失败就没有任何渲染；若 Piner 后续能跑，key 又对不上。等于**保存一个大概率永远画不出来的脚本**，还保留 211 KB 依赖。**不推荐。**

### 方案 C：维持现状（Piner 优先 + PineTS 兜底）

- 成本：211 KB gzip、19 MB、慢 10 倍的兜底、两套 key、误导性 MTF。
- 只有在"真实脚本 spike 发现 Piner 失败且必须继续支持"时才考虑，并且应同时补 `IProvider` 与视觉 IR 解析——工作量远大于删除。

---

## 7. 实施方案（方案 A）

### 7.0 前置：真实脚本 spike（0.5 天，需你提供脚本）

1. 从应用「设置 → Pine 脚本」导出/复制你常用的脚本（或直接在应用里确认列表）。
2. 用一次性脚本把每条源码交给 `@heyphat/piner` 的 `compile + Engine` 跑 150 根合成 bars，记录通过/失败与错误信息。
3. 判定：全部通过 → 进入 7.1；有失败且必须保留 → 暂停，改评估方案 C 的成本。

> 本次预览环境没有已保存脚本（0 条），所以这一步无法由我单方面完成。  
> **实施记录（2026-11-21）**：用户确认采用方案 A；本地脚本集合为空，按"空集合"验收，另以 `docs/pine-smoke-test.pine` 同构脚本完成保存/运行冒烟。

### 7.1 引擎层（0.5 小时）

- `src/chart/tv/pineEngine.ts`
  - 删除 `runPineTS()`、`candlesFrom()`（确认无其他引用）、`PineEngineName` 的 `'pinets'` 分支（保留 `engine: 'piner'` 字段以免动测试/调用方）。
  - `runPine()` 改为直接 `return runPiner(options, [])`；Piner 异常原样抛出，错误前缀改为 `Pine 运行失败：…`。
  - 删除 `import('pinets')` 与回退 warning 文案。
- `src/lib/pineScripts.ts`
  - 删除 `scanWithPineTS()` 与 379–394 的回退分支；`scanWithPiner` 失败时抛出 `脚本无法运行：<Piner 原因>。该脚本可能使用了当前引擎尚不支持的语法`。
  - 保留 `regexPlots` 与"0 曲线但有绘图对象"的保存逻辑。

### 7.2 文案与注释（0.2 小时）

- `SettingsPanel.tsx:2023` → "保存后由 Piner 在本地执行"；`:2120` → 只保留 Piner 的 AGPL 声明。
- `pineEngine.ts:5`、`pineScripts.ts:4/7/361`、`ChartPanel.tsx:889`、`pineRunner.ts:23`、`pineStudies.ts:20/194` 里"PineTS 回退"的注释改为 Piner/通用表述。
- `docs/PINE_INDICATOR_OPTIONS_2026-11-15.md` 顶部加一行"2026-11-21 已决策：单一 Piner，见 P4 文档"，正文作为历史调研保留。

### 7.3 依赖（0.1 小时）

- `npm uninstall pinets`，确认 `package-lock.json` 移除 `pinets`、`acorn`、`acorn-walk`、`astring`（若未被其他依赖使用）。
- `npm ls acorn` 复核。

### 7.4 测试（0.5 小时）

- `pineEngine.test.ts` 增加：
  - Piner 编译失败时 `runPine` 抛出且消息只含 Piner（不再出现"回退 PineTS"）。
  - v5 旧别名契约：`security()/iff()/cross()/rising()/falling()/cum()` 能通过并产出 series（锁定 Piner 相对 PineTS 的优势）。
- `pineScripts.test.ts` 增加：
  - 非法脚本保存失败，错误信息包含 Piner 原因。
  - 纯绘图脚本仍可保存（已有用例保留）。
- 现有 7 + 3 + 6 + 9 + 4 = 29 条 Pine 相关测试全部保留，断言按新错误文案微调。

### 7.5 验证与验收（0.3 小时）

```powershell
npx tsc --noEmit
npx vitest run
cd gateway; python -m pytest -q; cd ..
npx vite build
```

验收标准：

1. `rg -n "pinets|PineTS" src package.json` 只剩测试里的否定断言（`not.toContain('PineTS')`），无实现或依赖引用。
2. `vite build` 不再产出 `pinets.min.browser.es-*.js`；Pine 懒加载 chunk 约 66 KB gzip，总产物减少约 211 KB gzip。
3. `node_modules` 减少约 19 MB，`npm ls acorn` 不再因 pinets 引入。
4. 浏览器冒烟：保存并挂载 `docs/pine-smoke-test.pine`，plot/hline/fill/bgcolor/plotshape/label/line/box/table 全部出现；保存一条使用 `security()` 的 v5 脚本可正常运行；保存乱码脚本只出现一次明确错误、不出现"回退 PineTS"。
5. `tsc` 干净、vitest 全绿、pytest 保持 636（网关未改）。

### 7.6 风险与回滚

| 风险 | 概率 | 处理 |
|---|---|---|
| 你的某个真实脚本依赖 PineTS 才能跑 | 中低（本次 45 条探针未发现） | 7.0 spike 提前暴露；必要时暂缓并评估方案 C |
| Piner 0.13 后续升级回归 | 低 | 版本锁死 + 7.4 契约测试 |
| 错误文案变化让用户以为功能坏了 | 低 | 错误里带"当前引擎尚不支持"与脚本行号；只提示一次 |
| 依赖删除影响其他包 | 极低 | `npm ls` 复核；`npm ci` 可复现 |

回滚：`git revert <commit>` + `npm ci`，无数据迁移、无协议变化。

---

## 8. 明确不在本次范围

- 把 Pine 计算搬到 Web Worker（Piner 的 IR 可序列化，后续可做，单独排期）。
- `strategy()` 放行与成交标记。
- Pine `import` 库的 UI/注册表。
- 升级 Piner 版本或更换图表库。
- `request.financial/economic` 等外部数据源。

---

## 9. 需要你确认（已于 2026-11-21 确认采用方案 A）

1. 是否按 **方案 A（删除 PineTS，Piner 单引擎）** 执行。
2. 是否能在实施前提供 3–5 个你常用的 Pine 脚本做 spike；若暂时没有，我会先按 A 实施并保留"脚本集合为空"的验证记录。
3. 删除后的失败语义是否接受：Piner 编译不了 = 明确报错（保存失败 / 运行提示一次），不再降级出图。

同意后我按第 7 节顺序执行，每步跑 `tsc + vitest`，最后做浏览器冒烟并提交。
