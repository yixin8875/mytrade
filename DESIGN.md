# MyTrade · 自有 TradingView 级图表交易终端（MT5）

> 目标：一个界面完全采用 TradingView 的桌面交易终端，在图上直接画线、下单、拖拽止损止盈，订单实时推送到本机 MT5 执行，并把持仓/挂单/成交回报同步回图表。

- 状态：设计稿 v1
- 日期：2026-11-10
- 项目目录：`G:\codex\mytrade`（当前为空，全新工程）
- 可复用资产：`G:\codex\fxplayer`（Tauri + React + MT5 Python 桥）、`G:\codex\mt5order`（MQL5 风控/下单 EA）

---

## 1. 结论先行

1. **"完完全全使用 TradingView 的界面"只有一条正路：自托管 TradingView Charting Library（Advanced Charts）**，并实现它的 `Datafeed API` + `Broker API`。
   - 画线工具、指标、多周期、十字光标、右键菜单、对象树、自选列表、DOM、订单票、图上订单线/持仓线/成交箭头，全部是库自带的，不需要仿制。
   - `Broker API` 就是官方为"接自己的券商/交易通道"准备的，天生支持：图上拖拽改价、下单、改单、撤单、平仓、持仓盈亏线、成交标记。
2. **不能用官网 `tv.js` widget 嵌入**：iframe 内无法注入自己的行情和交易通道，只能看 TradingView 的数据，不能下自己的单。
3. **不用 lightweight-charts 硬仿**：它只有 K 线渲染，没有画线工具、指标 UI、订单线拖拽。要仿到"完完全全"成本是官方库的 3–5 倍，且永远差一截。
4. **执行通道独立成 `MT5 Gateway`**：前端只认一条本地 WebSocket 协议，不直接碰 MT5。第一期用 Python `MetaTrader5` 包最快落地；后续可把执行层换成 MQL5 EA（复用 `mt5order` 的风控逻辑），前端零改动。
5. **默认安全**：默认只读/模拟、下单二次确认、手数与点差上限、日亏锁、幂等 clientOrderId、全量审计日志。实盘开关单独授权。

---

## 2. 三种"TradingView 界面"方案对比

| 方案 | 界面还原度 | 画线/指标 | 图上交易 | 行情来源 | 授权与限制 |
|---|---|---|---|---|---|
| **官方 Charting Library 自托管** | 100% | 全量官方工具 | Broker API 原生支持 | 自定义 Datafeed，可接 MT5 | 免费但**仅限公司主体的公开免费产品**，个人自用/内部工具不符合授权；不可公开再分发源码 |
| 官网 `tv.js` widget 嵌入 | 100% | 有，但仅限 TV 数据 | ❌ 不支持自有券商 | 只能用 TradingView 行情 | 受 widget 使用条款约束，无法接自有数据 |
| `lightweight-charts` 自研仿制 | 60–80% | 全部自研 | 全部自研 | 自由 | Apache-2.0，无授权风险，但工作量最大 |

> **授权现实**：TradingView 官方 FAQ 明确不向 personal use / hobbies / studies / testing 提供 Advanced Charts，只发给公司用于公开免费的产品。**个人自用的私有终端拿不到这条免费授权**，不要在申请表里写"个人自用"。详细规则、申请步骤和商业授权渠道见 [docs/TRADINGVIEW_LIBRARY.md](docs/TRADINGVIEW_LIBRARY.md)。
>
> **当前实际做法**：本地已有 Charting Library v32 源码，直接接入（`public/charting_library/`，gitignore，不提交、不分发），图表层即官方实现。授权边界没变——这份库只能私有使用，不能随产品公开分发。
>
> **一个实际限制**：Charting Library 包（非券商版 Trading Platform）里 `createOrderLine` / `createPositionLine` / `createExecutionShape` 会直接抛 `only available on Trading Platform`。所以下单线/持仓线用官方绘图层 `horizontal_line` 实现（`src/chart/tv/priceLines.ts`）：线条与拖动体验和官方下单线一致，但取消按钮、成交箭头、Broker API 的原生事件需要 Trading Platform 授权后才能用。绘图本身没有“移动结束”事件，拖拽结果靠 200ms 轮询 `getPoints()` 发现。
> 
> 绘图自带的文字标签只能居中，也做不出参考图里“右缘小块 + 金额 + ✕”的样子，所以线段不写字，由 React 覆盖层 `src/components/ChartChips.tsx` 读取 iframe 主图 canvas 的位置和内部 `priceToCoordinate`，把小块贴在线右端（手数 + 金额，✕ 撤单/去 SL/TP）。拖完线会用 `chart.selection().clear()` 取消选中，否则绘图会显示「添加文字」的占位。

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tauri 2 桌面壳（WebView2）                                           │
│                                                                     │
│  ┌──────────────────────────────┐   ┌─────────────────────────────┐ │
│  │ TradingView Charting Library │   │ 自有业务面板                 │ │
│  │  · Datafeed 适配器            │   │  · 账户/持仓/挂单/成交       │ │
│  │  · Quotes 适配器              │   │  · 下单票 / 风控预览         │ │
│  │  · Broker 适配器              │   │  · 自选 / 审计 / 设置        │ │
│  │  · 画线、指标、多周期、DOM    │   │  · 连接状态 / 实盘开关       │ │
│  └──────────────┬───────────────┘   └──────────────┬──────────────┘ │
│                 │        Zustand 单一状态树         │                │
│                 └───────────────┬───────────────────┘                │
│                                 │ WebSocket JSON (127.0.0.1)          │
└─────────────────────────────────┼────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ MT5 Gateway（本地 sidecar，Python）                                  │
│  · 行情：tick 轮询 → 实时 K 线 / 报价推送                            │
│  · 快照：account / positions / orders / deals                        │
│  · 交易编排：校验 → 下单 → 回报 → 对账 → 重试                        │
│  · 风控：手数、保证金、点差、止损距离、日亏锁、最大持仓              │
│  · 审计：所有请求/响应原文落盘                                       │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ MetaTrader5 Python API（仅本机、Windows）
                                  ▼
                        ┌──────────────────────┐
                        │ MT5 Terminal（已登录）│
                        └──────────────────────┘
```

### 3.1 为什么网关要单独一层

| 原因 | 说明 |
|---|---|
| MT5 API 非线程安全 | 所有 MT5 调用收敛到网关的单一工作线程 + 命令队列，避免并发崩溃 |
| 无事件回调 | Python 包只能轮询；网关负责把轮询差异转成增量事件推给前端 |
| 执行通道可替换 | 第一期 Python，第二期可换成 MQL5 EA（socket/文件 IPC），协议不变 |
| 安全边界 | 前端拿不到 MT5 凭证；所有下单必须过网关校验与审计 |
| 幂等与对账 | 断线重连后能回答"这笔单到底成没成"，这是交易软件的生命线 |

---

## 4. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2 | 与 `fxplayer`/`mytrader` 一致，体积小，Windows 原生 |
| 前端 | React 19 + TypeScript + Tailwind 4 + Zustand | 同上，团队已有肌肉记忆 |
| 图表 | TradingView Charting Library（自托管） | 唯一能 100% 还原的需求解 |
| 本地服务 | Python 3.11 + FastAPI + uvicorn + `MetaTrader5` | MT5 官方 Python 包，开发最快 |
| 打包 | PyInstaller sidecar + Tauri bundle | 用户无需装 Python |
| 存储 | SQLite（布局、审计、订单意图、设置） | 本地单机，无需服务端 |

> 备选：网关用 Rust 直连 MT5 DLL —— 性能更好但开发成本高，不推荐第一期做。

---

## 5. TradingView 集成设计

### 5.1 库的放置与加载

```
public/
└─ charting_library/          # 官方包（授权后获取，勿提交到公开仓库）
   ├─ charting_library.js
   ├─ charting_library.css
   └─ bundles/
```

```ts
// src/chart/widget.ts
const widget = new TradingView.widget({
  container: el,
  library_path: '/charting_library/',
  symbol: 'XAUUSDc',
  interval: '5',
  locale: 'zh',
  timezone: 'Etc/UTC',           // 统一 UTC，界面上按用户时区显示
  theme: 'dark',
  autosize: true,
  datafeed: new Mt5Datafeed(gateway),
  broker_factory: (host) => new Mt5Broker(host, gateway),
  enabled_features: ['trading_account_manager', 'order_panel', 'dom_widget'],
  disabled_features: ['use_localstorage_for_settings' /* 改用自有 SQLite 布局 */],
  overrides: { 'paneProperties.background': '#0e1117', /* 主题微调 */ },
});
```

> 具体选项名以拿到的库版本文档为准（`broker_factory` / `enabled_features` 在不同版本有差异），P0 阶段做一次 API 对齐。

### 5.2 Datafeed 适配器（`IDatafeedChartApi`）

| 方法 | 实现 |
|---|---|
| `onReady` | 声明支持搜索、周期 `1/5/15/30/60/240/1D/1W/1M`、品种类型 |
| `resolveSymbol` | 把 MT5 品种规格翻译成 TV 符号信息：`pricescale=10^digits`、`minmov`、`session`、`timezone`、`volume_precision`、`currency_code`、`pointvalue` |
| `getBars` | 把 `from / to / countBack` 传给网关 `history.get`；MT5 原生周期直接取，避免前端聚合误差 |
| `subscribeBars` | 网关按订阅推送当前 bar（同一 `time` 覆盖更新） |
| `unsubscribeBars` | 取消订阅，网关停止推送 |
| `getQuotes/subscribeQuotes` | 自选列表买卖价、涨跌幅 |
| `getServerTime` | 用网关时间校正本地时钟偏移 |

**K 线策略**
- 首次加载：`copy_rates_from_pos(symbol, tf, 0, N)` 取最近 N 根。
- 向左翻页：TradingView 带上 `periodParams.from / to`，网关用 `copy_rates_range(symbol, tf, from, to)` 只取这一段并截到 `count` 根。
- 时区：MT5 Python 把 `datetime` 当本地墙钟换算时间戳，而 K 线 `time` 按「服务器时间当 UTC」处理，所以区间参数用 `datetime.fromtimestamp(ts)`（本地墙钟）构造，不能直接 `utcfromtimestamp`。
- 休市窗口：请求区间为空时，网关最多向前探 6 个窗口，找到最近一段有数据的 K 线返回；前端不再按 `from` 截断，图表因此能跨过周末继续加载。
- 实时：网关维护每个 `(symbol, resolution)` 的"当前 bar"，tick 到达时更新 `high/low/close`，每 200–250ms 推送一次。
- 缺口：休市产生的空 bar 由 TV 处理，`resolveSymbol` 里声明正确的交易时段。
- 深度取决于本机 MT5 已下载的历史与「图表中最大柱数」设置，请求大周期大 `count` 时会触发终端下载并可能短暂阻塞。

### 5.3 Broker 适配器（`IBrokerConnection`）

这是"图上交易"的核心，官方已经定义好交互，我们只负责把方法映射到网关：

| Broker API 能力 | 映射到网关 |
|---|---|
| `placeOrder` | `order.place`（市价/限价/停损，带 SL/TP） |
| `modifyOrder` | `order.modify`（改价、改量、改 SL/TP） |
| `cancelOrder` | `order.cancel` |
| `closePosition` | `position.close`（支持部分平仓） |
| `getPositions / subscribePositions` | `positions.snapshot` + `positions` 事件 |
| `getOrders / subscribeOrders` | `orders.snapshot` + `orders` 事件 |
| `getExecutions` | `history_deals_get` 映射为成交箭头 |
| `getQuotes / subscribeQuotes` | 复用行情通道 |

**图上对象**（库自带 API，不需要自己画）：

```ts
// 挂单线：可拖动改价，右键可撤单
const orderLine = widget.createOrderLine();
orderLine.setQty(volume).setPrice(price).setText('Buy Limit 0.10');
orderLine.onModify(() => gateway.call('order.modify', { /* ... */ }));
orderLine.onCancel(() => gateway.call('order.cancel', { /* ... */ }));

// 持仓线：显示均价、盈亏，拖拽改 SL/TP
const posLine = widget.createPositionLine();
posLine.setQuantity(volume).setPrice(openPrice)
       .setProtectLevels(sl, tp)
       .setText(`+${profit}`);
posLine.onClose('close', () => gateway.call('position.close', { /* ... */ }));
posLine.onModify(() => gateway.call('position.modify', { /* ... */ }));

// 成交箭头
widget.createExecutionShape().setText('Buy 0.10').setPrice(p).setTime(t);
```

> "图上画一条线就下单"的交互建议：按住快捷键（如 `B`/`S`）在图上点击 → 以点击价为入场价弹出订单票 → 拖动预置的 SL/TP 线 → 确认发送。这套交互用 `createOrderLine` 的草稿模式实现。

### 5.4 界面布局（完全沿用 TradingView）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 品种搜索 │ 周期 │ K线类型 │ 指标 │ 比较 │ 警告 │ 回放 │ 撤销/重做 │ 布局 │ ⚙ │
├────┬──────────────────────────────────────────────────────────┬──────────┤
│ 左 │                                                          │ 右栏      │
│ 工 │                                                          │ · 自选    │
│ 具 │            TradingView 图表（K线 + 指标 + 画线）          │ · DOM     │
│ 栏 │            图上：挂单线 / 持仓线 / 成交箭头               │ · 持仓    │
│    │                                                          │ · 挂单    │
│    │                                                          │ · 对象树  │
├────┴──────────────────────────────────────────────────────────┴──────────┤
│ 底部交易条：账户 │ 手数 │ SELL / BUY │ 订单类型 │ SL/TP │ 风险预览 │ 连接状态 │
└──────────────────────────────────────────────────────────────────────────┘
```

**必须保留的 TradingView 原生体验**
- 左侧画线工具栏（趋势线、斐波那契、矩形、文字、测量、磁吸）
- 顶部周期/指标/图表类型/布局保存
- 右键菜单（画线、删除、交易）
- 十字光标 + OHLC 图例
- 对象树、多图表布局、全屏

**我们额外加的自有 UI（不破坏 TV 观感）**
- 连接状态灯：`网关` / `MT5 终端` / `账户` / `交易权限`
- 订单票里的风险预览：预估保证金、点差成本、风险金额、R 倍数
- 风控条：当日亏损、当日单数、最大手数、剩余额度
- 审计面板：最近 50 条请求/回报，可导出

### 5.5 主题与"像不像"

TV 库自带完整主题体系。要做到"完全一致"：
- 默认 `dark` 主题 + 官方配色，不自造 CSS 覆盖核心组件
- 自有面板严格复用 TV 的 CSS 变量（`--tv-color-*`）与字体栈
- 布局尺寸对齐 TV：顶栏 38px、左栏 52px、右栏 300px、底部交易条 48px
- 图标优先用库自带，其次用 TradingView 风格的线性图标集

**深 / 浅色切换**（`src/store/useApp.ts` 的 `theme`）：
- 自有面板用 Tailwind 4 `@theme` 变量 `--color-tv-*`；浅色主题在 `src/index.css` 用 `html[data-theme="light"]` 整套覆盖，组件代码不写死颜色。
- 图表由 `ChartPanel` 监听 `theme`，调用 `widget.changeTheme(theme)` 后再 `applyOverrides(chartOverrides(theme))` 补齐背景、网格、坐标轴与蜡烛颜色；不重建 widget，已画的线保留。
- 选择存 localStorage `mytrade.theme`，顶部栏按钮切换。

**画线样式模板**（`src/components/DrawingTemplates.tsx`）：
- 本版 Charting Library 内置「模板」菜单只有「应用默认」，其保存/读取适配器是 `Not implemented`，因此不走内置 UI。
- 选中画线用 `chart.selection().onChanged()` 跟踪，`getAllShapes()` 过滤掉指标；保存时取 `getShapeById(id).getProperties()`，去掉 `text` 字段后按工具名分组存进 localStorage `mytrade.drawTemplates`。
- 应用时 `setProperties(props, true)`：第二个参数让同类型之后新建的画线也使用这套样式，实现「不再只有默认值」。
- 右边缘价格小块（`ChartChips`）通过 `priceAt(y)` 做坐标反解，指针拖动时 90ms 节流回调，松手再补一次终值；草稿写 `patchDraft`，挂单/持仓写 `order.modify` / `position.modify`。
- 模板面板本身可拖动：按钮上按住移动，位置存 `mytrade.drawTemplatesPos`（相对图表容器的像素坐标），拖动时夹在容器内，窗口变小会自动收回可视范围。

**画线收藏**
- widget 选项 `favorites.drawingTools` 只作为首次默认值；`items_favoriting` 默认开启，用户在左侧工具栏点星标即可增删收藏，收藏项浮在图上快捷调用。
- featureset 用 `save_chart_properties_to_local_storage: false`，而不是整个 `use_localstorage_for_settings`：这样图表布局不被缓存，收藏和自选仍能持久化。

**自定义指标**
- Charting Library 不支持 Pine 源码；自定义指标通过 `custom_indicators_getter(PineJS)` 返回 `CustomIndicator[]`，实现放在 `src/chart/tv/studies.ts`。
- `metainfo` 声明 `plots / inputs / defaults / format`；`constructor.init/main` 每根 bar 调用一次，用 `ctx.new_var(PineJS.Std.close(ctx))` 把标量包成序列，再交给 `PineJS.Std.ema / sma / rsi / atr` 等计算。
- 内置示例「MT 双 EMA」（快慢线周期可调）；新增指标照抄结构即可，Pine 源码可以逐行对应该标准库函数。

---

## 6. MT5 网关设计

### 6.1 进程模型

```
uvicorn 主线程
 ├─ WS 连接管理（asyncio）
 ├─ 命令队列（asyncio.Queue）
 └─ MT5 工作线程（唯一持有 mt5.* 调用权）
      ├─ 命令执行器（下单/改单/撤单/平仓）
      ├─ tick 轮询（100ms，仅订阅品种）
      ├─ 账户轮询（500ms）
      └─ 订单/持仓轮询（300ms，交易后立即刷新）
```

> `MetaTrader5` 包不是线程安全的；所有调用必须串行。用一条线程 + 队列是踩坑最少的做法。

### 6.2 协议（WebSocket JSON）

请求：

```json
{ "id": "c-8f2a", "method": "order.place", "params": { "...": "..." } }
```

响应：

```json
{ "id": "c-8f2a", "result": { "ticket": 123456789, "state": "accepted" } }
{ "id": "c-8f2a", "error": { "code": "STOPS_LEVEL", "message": "SL 距离小于券商最小止损距离 35 点" } }
```

推送：

```json
{ "event": "tick", "data": { "symbol": "XAUUSDc", "bid": 2345.12, "ask": 2345.42, "time": 1762740000123 } }
{ "event": "bar", "data": { "symbol": "XAUUSDc", "resolution": "5", "bar": { "time": 1762740000, "open": 2345.1, "high": 2345.6, "low": 2344.8, "close": 2345.4, "volume": 128 } } }
{ "event": "account", "data": { "balance": 10000, "equity": 10021.4, "margin": 350, "freeMargin": 9671.4 } }
{ "event": "positions", "data": [ { "ticket": 111, "symbol": "XAUUSDc", "side": "buy", "volume": 0.1, "openPrice": 2340.2, "sl": 2335.0, "tp": 2350.0, "profit": 5.1 } ] }
{ "event": "execution", "data": { "deal": 999, "order": 888, "price": 2345.42, "volume": 0.1, "time": 1762740000456 } }
{ "event": "alert", "data": { "id": 7, "symbol": "XAUUSDc", "kind": "above", "price": 2350.0, "note": "突破", "triggerCount": 1 } }
{ "event": "gateway", "data": { "terminal": "connected", "account": "demo", "tradeAllowed": true } }
```

方法清单：

| 分类 | 方法 |
|---|---|
| 品种 | `symbols.list`、`symbol.info`、`symbol.search` |
| 行情 | `history.get`、`quotes.subscribe`、`quotes.unsubscribe`、`bars.subscribe` |
| 账户 | `account.get` |
| 交易 | `order.place`、`order.modify`、`order.cancel`、`position.close`（可带 `volume` / `moveToBe`）、`position.modify`、`position.closeAll` |
| 持仓保护 | `position.breakeven`、`position.trailing.set`、`position.trailing.clear` |
| 校验 | `trade.preview`（保证金/风险/点差/RR，不发送）、`trade.size`（按固定金额或余额 % 反推手数） |
| 风控 | `risk.status`、`system.halt`（可带 `closeAll`）、`system.resume` |
| 日志 | `journal.sync`、`journal.list`、`journal.stats`、`journal.tag`、`journal.screenshot.save` |
| 告警 | `alerts.list`、`alerts.create`、`alerts.update`、`alerts.delete`、`alerts.test` |
| 自选 | `watchlist.get`、`watchlist.set` |
| 执行质量 | `executions.get`、`executions.stats` |
| 审计 | `audit.tail`、`audit.query`、`system.reconcile` |
| 系统 | `ping`、`server.time`、`system.setTradeMode` |

### 6.3 下单链路（时序）

```
用户                前端                         网关                        MT5
 │  图上点击/拖线     │                            │                          │
 │──────────────────▶│ 1. trade.preview           │                          │
 │                   │───────────────────────────▶│ 校验规格/保证金/点差     │
 │                   │◀───────────────────────────│ 返回风险预览             │
 │  确认              │                            │                          │
 │──────────────────▶│ 2. order.place(clientId)   │                          │
 │                   │───────────────────────────▶│ 幂等检查 + 终校验        │
 │                   │                            │ 3. order_send ──────────▶│
 │                   │                            │◀──────────── retcode     │
 │                   │◀───────────────────────────│ 4. 结果 + 刷新快照       │
 │                   │ 5. 图上出现持仓线/挂单线    │                          │
 │                   │◀───────────────────────────│ 6. 轮询到的增量事件      │
```

### 6.4 订单状态机

```
draft → validating → sending → accepted → working → filled
                        │         │          │
                        │         │          ├→ partially_filled → filled
                        │         │          └→ cancelled / expired
                        │         └→ rejected
                        └→ unknown（超时）→ 对账 → filled / rejected / not_found
```

**关键规则**
- 超时 ≠ 失败。先按 `clientOrderId`（写入 `comment` + `magic`）查 `orders_get` / `positions_get` / `history_deals_get` 对账，确认不存在才允许重发。
- 每次状态变更写 SQLite，应用崩溃后可恢复。
- 所有请求/响应/retcode 原文写入 `audit/YYYY-MM-DD.jsonl`。

### 6.5 交易参数映射（易错点）

| 参数 | 处理 |
|---|---|
| `type_filling` | 读 `symbol_info.filling_mode` 位掩码：优先 IOC，其次 FOK，最后 RETURN；不要硬编码 |
| `trade_stops_level` | 券商最小止损距离，下单前校验并提示 |
| `trade_freeze_level` | 挂单接近市价时禁止修改的距离 |
| `volume_step / volume_min / volume_max` | 手数向下取整到 step，越界拒绝 |
| `digits / trade_tick_size` | 价格按 tick 对齐后再发送 |
| `symbol` 后缀 | 券商品种名可能是 `XAUUSDc`、`EURUSD.a`，必须走 `symbols.list` 动态映射 |
| hedging / netting | `account_info.margin_mode` 决定平仓按 position ticket 还是按品种 |
| `deviation` | 市价单允许滑点（点），默认 20，可配置 |
| 挂单过期 | GTC / DAY / 指定时间，按用户选择 |
| `comment` | 部分券商限长（本机实测 ≥30 字符报 `Invalid "comment"`）。`clientOrderId` 用 UUID，发送时截为 `client_id[:20]` 再写入 comment |
| `autoBreakeven` | 仅 `order.place` 可选布尔。市价单带止损时记录 `entry / risk / trigger=1R`，工作线程每 0.4 秒检查，到 1R 把 SL 移到开仓价，计划持久化到 `state` 表 |

### 6.6 风控与安全（默认开启）

| 项 | 默认 |
|---|---|
| 只读模式 | 开（首次启动必须手动切到"模拟可交易"） |
| 实盘交易 | 关（需单独开关 + 二次确认 + 输入账户尾号） |
| 单笔最大手数 | 0.50（可配） |
| 单笔最大风险 | 账户净值 1%（可配） |
| 最大点差 | 品种 ATR 或固定点数（可配） |
| 日亏锁 | 当日亏损（已实现 + 浮动）达起始余额 2% 后禁止开新仓 |
| 连亏冷却 | 连续亏损 3 次后冷却 30 分钟 |
| 当日开仓上限 | 8 次（可配，0 = 不限制） |
| 停机（急停） | 平掉全部仓位并拒绝开仓，状态存 SQLite，重启仍生效 |
| 最大持仓数 | 3（可配） |
| 重复下单 | 同方向同价位 3 秒内重复请求拦截 |
| 审计 | 全量落盘，不可关闭 |

当日风控状态全部按**券商服务器时间**计算（网关连上时先从一个品种报价推算时区）：`risk.status` 返回 `dayPnl / dailyLoss / dailyLossLimit / remaining / tradesToday / consecutiveLosses / cooldownRemainingSec / halted / blockReason`，变化时通过 `risk` 事件推送。

移动止损由网关 0.4 秒一轮执行，只朝有利方向挪动，每次至少改进 `stepPoints`；计划存 SQLite，重启后按持仓恢复。保本/移损的止损价与现价至少留 `max(stops_level, 1) + 5` 个点，避免贴边被报价跳动打成 `Invalid stops`。

### 6.7 交易日志

- 网关读 `history_deals_get`（最近 30 天），按 `position_id` 分组；有进场且出场总量 ≥ 进场总量才算一笔完整交易。开/平价按手数加权，盈亏含 `profit + swap + commission + fee`。
- MFE/MAE：取持仓区间的 M1 高低点，用 `order_calc_profit` 折算成账户货币；失败时留空，不阻塞记录。
- 出场方式由最后一条出场成交的 comment 推断（`tp*` / `sl*` / `so*` / 其余为手动）。
- 成交后前端截取图表并调用 `journal.screenshot.save`，JPEG 存 `data/shots/<positionId>.jpg`；`sync()` 会按文件存在性回填 `has_shot`，所以截图早于配对完成也不会丢。
- 统计在读取时计算：胜率、盈亏比、期望、最大回撤、平均持仓，以及按品种 / 开仓小时 / 标签分组；日志只在 SQLite，不上传。

### 6.8 价格告警

- 告警存 SQLite；工作线程 0.5 秒读一次订阅报价，用上一价格与现价判断上穿/下穿，跨过后广播 `alert` 事件。
- `repeat=1` 时按 `cooldown_sec` 冷却后重新武装，否则触发一次即禁用；`trigger_count` / `triggered_at` 落库。
- 前端负责声音（WebAudio 双音）与桌面通知（Notification API，需授权）；网关侧 `notify.py` 把同一事件推给 `alert_channels`（webhook / Discord / Telegram / 企业微信）。
- 通道配置只从 `gateway/config.json` 读取，`Config.public()` 只下发 `alert_channel_names`，URL/Token 不出网关。

### 6.9 执行质量

- 每次真正调用 `mt5.order_send` 都写一条 `executions` 记录：请求价、成交价、手数、发出时点差、滑点（点）、`order_send` 往返延迟、retcode、状态与拒单原因。
- 滑点只对市价单计算：买单 `(fill - requested) / point`，卖单 `(requested - fill) / point`，正数表示不利。延迟只含网关到券商回执，不含前端。
- `executions.stats` 读取时聚合：平均点差/滑点、不利占比、最大滑点、延迟 P50/P90/最大、按品种与按小时统计、拒单原因计数、最近 200 条明细。
- 记录失败被吞掉，不影响下单；SQLite 存本机，不随前端导出。

### 6.10 稳定性

- 前端 WebSocket 断开自动重连（0.5s 起指数退避，上限 5s），重连后重新拉快照；`open` 事件触发一次全量刷新。
- 网关每 3 秒尝试重新 `initialize()` MT5；连上后 `_reconcile()` 按 `clientOrderId` 查挂单、持仓与最近 7 天成交，把 `sending/unknown` 意图修正为 `accepted` 或 `not_found`。
- `system.reconcile` 可手动触发同一逻辑，返回 `{checked, found, notFound}` 并写审计。
- `audit.query {date, kind, text, limit}` 读 UTC 日期 JSONL，kind 前缀过滤、text 整行模糊匹配，返回最新 N 条。
- 图表右侧小块按 y 坐标分组，18px 内的多个小块围绕组中心上下错行，避免同价位持仓/挂单重叠。

---

## 7. 数据模型（前端）

```ts
type SymbolInfo = {
  name: string; description: string; digits: number;
  point: number; tickSize: number; tickValue: number; contractSize: number;
  minVolume: number; maxVolume: number; volumeStep: number;
  stopsLevelPoints: number; freezeLevelPoints: number;
  marginMode: 'hedging' | 'netting';
  session: string; currency: string;
};

type Quote = { symbol: string; bid: number; ask: number; spread: number; time: number };

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

type Account = {
  login: number; server: string; currency: string; leverage: number;
  balance: number; equity: number; margin: number; freeMargin: number;
  marginMode: 'hedging' | 'netting'; tradeAllowed: boolean;
};

type Position = {
  id: string; ticket: number; symbol: string;
  side: 'buy' | 'sell'; volume: number; openPrice: number;
  sl: number | null; tp: number | null;
  profit: number; swap: number; commission: number;
  magic: number; comment: string; openTime: number;
};

type Order = {
  ticket: number; clientOrderId: string; symbol: string;
  type: 'market' | 'limit' | 'stop';
  side: 'buy' | 'sell'; volume: number; price: number;
  sl: number | null; tp: number | null;
  state: OrderState; expiration: number | null;
  filledVolume: number; comment: string; createdAt: number;
};

type OrderIntent = {
  clientOrderId: string; symbol: string; side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop'; volume: number; price?: number;
  sl?: number; tp?: number; riskAmount?: number; riskPercent?: number;
  createdAt: number; state: OrderState; attempts: number;
};
```

---

## 8. 手数与风险计算

```ts
// 1) 按风险金额算手数
// SL 距离（价格）→ 每手在 SL 处的亏损（用 order_calc_profit 精确计算，避免黄金/交叉盘换算误差）
const lossPerLot = await gateway.call('trade.calcProfit', { symbol, side, openPrice, closePrice: slPrice, volume: 1 });
const rawVolume  = riskAmount / Math.abs(lossPerLot);
const volume     = roundDownToStep(clamp(rawVolume, minVolume, maxVolume), volumeStep);

// 2) 保证金校验
const margin = await gateway.call('trade.calcMargin', { symbol, side, volume, price });
if (margin > freeMargin * 0.8) reject('保证金不足');

// 3) 预览
const preview = {
  volume, riskAmount, riskPercent,
  rr: Math.abs(tpPrice - entry) / Math.abs(entry - slPrice),
  spreadCost: spread * pointValue * volume,
  margin, marginLevelAfter: equity / (margin + usedMargin) * 100,
};
```

> 不要用"点数 × 每点价值"手算，遇到交叉盘、黄金、指数、原油会出现系统性误差。一律用 `order_calc_profit` / `order_calc_margin`。

---

## 9. 与现有项目的关系

| 现有资产 | 复用方式 |
|---|---|
| `fxplayer/bridge/mt5_bridge.py` | 直接演进为网关：补 WS、订单、账户、持仓；历史行情接口几乎可原样搬 |
| `fxplayer/src/lib/indicators.ts`、`format.ts`、`tf.ts` | 可复用到预览/自选/工具函数 |
| `mt5order` 的 MQL5 EA | 第二期执行通道备选；其风控/规则逻辑（日锁、手数、止损距离）可移植到网关 Python |
| `mytrader` 的统计/CSV | 第三期做交易复盘时复用 |

> 建议新工程独立建在 `G:\codex\mytrade`，不要和 `fxplayer` 混在一起；两者定位不同（复盘 vs 实盘终端）。

---

## 10. 目录结构

```
mytrade/
├─ DESIGN.md
├─ package.json
├─ index.html
├─ vite.config.ts
├─ public/
│  └─ charting_library/          # 官方库（授权后放入，.gitignore）
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ chart/
│  │  ├─ widget.ts               # 创建/销毁 TV widget
│  │  ├─ datafeed.ts             # IDatafeedChartApi
│  │  ├─ quotes.ts               # 自选报价
│  │  ├─ broker.ts               # IBrokerConnection
│  │  ├─ lines.ts                # 挂单线/持仓线/成交箭头
│  │  └─ symbolMap.ts            # MT5 品种 ↔ TV 符号
│  ├─ gateway/
│  │  ├─ client.ts               # WS JSON-RPC + 重连 + 请求超时
│  │  ├─ events.ts               # 事件分发
│  │  └─ types.ts
│  ├─ trading/
│  │  ├─ OrderTicket.tsx
│  │  ├─ TradeBar.tsx
│  │  ├─ risk.ts
│  │  ├─ validate.ts
│  │  └─ stateMachine.ts
│  ├─ panels/
│  │  ├─ Watchlist.tsx
│  │  ├─ Positions.tsx
│  │  ├─ Orders.tsx
│  │  ├─ Dom.tsx
│  │  ├─ AccountBar.tsx
│  │  └─ AuditLog.tsx
│  ├─ store/
│  │  ├─ account.ts
│  │  ├─ market.ts
│  │  └─ settings.ts
│  └─ lib/
│     ├─ format.ts
│     └─ time.ts
├─ src-tauri/
│  ├─ tauri.conf.json
│  └─ src/main.rs                # sidecar 启动/退出
├─ gateway/
│  ├─ app.py                     # FastAPI + WS
│  ├─ mt5_worker.py              # 单线程 MT5 封装
│  ├─ market_data.py             # 历史 + 实时 bar
│  ├─ trading.py                 # 下单/改单/撤单/平仓
│  ├─ risk.py
│  ├─ symbols.py
│  ├─ models.py
│  ├─ journal.py                  # 成交配对 / MFE-MAE / 统计 / 截图
│  ├─ notify.py                   # 告警外部通道
│  └─ requirements.txt
└─ docs/
   ├─ PROTOCOL.md
   └─ TEST_PLAN.md
```

---

## 11. 分期计划

| 阶段 | 内容 | 交付标准 | 预估 |
|---|---|---|---|
| **P0 技术验证** | 申请 TV 库；搭 Tauri + React；widget 起图；自定义 datafeed 显示真实 XAUUSD；画一条可拖动的订单线 | 图上能看到真实 K 线且订单线可拖动 | 3–5 天 |
| **P1 只读终端** | 品种搜索、周期、实时 tick、自选、布局保存、断线重连 | 可以当纯看盘软件日常使用 | 1–1.5 周 |
| **P2 图上交易** | Broker API、订单票、市价/限价/停损、SL/TP 拖拽、改单/撤单/平仓、成交箭头 | 模拟账户完整跑通"图上开仓→拖动止损→平仓" | 2 周 |
| **P3 风控与可靠性** | 手数计算、保证金/点差/止损距离校验、幂等、对账、审计、只读/模拟/实盘开关、日亏锁 | 断网、超时、拒单、重启后状态一致 | 1–1.5 周 |
| **P4 打磨** | 交易日志与统计、2×2 多图联动、自选表、价格告警、快捷键与下单模板、执行质量、审计查询与手动对账、小块错行均已交付；剩余 DOM、崩溃恢复、PyInstaller sidecar、自动更新 | 可日常实盘小仓使用 | 1 周 |
| **P5 可选** | EA 执行通道、多账户、收益曲线与复盘报表、经济日历、执行质量趋势图 | — | — |

**建议第一个里程碑就卡在 P2**：能下单、能拖止损、能平仓，比什么面板都重要。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| TV 库仅限私有使用 | 不能公开分发/开源 | 库放 `public/charting_library/` 并 gitignore；发布包内嵌但不给源码；不用个人自用名义申请授权 |
| TV 库版本 API 变动 | Broker 适配器返工 | 锁定版本；适配层隔离；升级前跑回归清单 |
| Python MT5 包仅 Windows、只能连本机已登录终端 | 无法远程/服务器部署 | 明确产品定位为"本机桌面终端"；远程需求另做 EA + 云网关 |
| 轮询延迟 | 报价/持仓不够实时 | tick 100ms、持仓 300ms；交易后立即强制刷新 |
| 券商规则差异（filling/stops level/后缀） | 下单被拒 | 启动时读 `symbol_info` 自适应；拒单时把 retcode 翻译成人话 |
| 断线期间订单状态不明 | 重复下单/漏单 | clientOrderId 幂等 + 三重对账 + 本地意图日志 |
| 实盘误操作 | 资金损失 | 默认只读/模拟、二次确认、限额、日亏锁、醒目实盘标识 |
| TV 库禁止公开分发 | 不能开源 | 私有仓库；`.gitignore` 排除 `charting_library/`；发布包内嵌但不提供源码 |

---

## 13. 需要确认的决策

1. **图表层授权**：官方库不覆盖个人自用，当前以本地私有副本接入（见 [docs/TRADINGVIEW_LIBRARY.md](docs/TRADINGVIEW_LIBRARY.md)），不得公开分发。若要发布成公开免费产品，需按该文档申请正式授权；若要官方的下单线/Broker API，需升级到 Trading Platform 版本。
2. **执行通道**：第一期用 Python 直连（快），还是直接用 MQL5 EA（稳、可复用 `mt5order`）？建议 Python 先行，网关协议不变，第二期可替换。
3. **券商与账户**：哪家、什么品种为主（黄金/外汇/指数）、hedging 还是 netting、品种后缀是什么？这决定平仓与品种映射实现。
4. **DOM 是否必需**：不少零售券商不提供深度数据；没有就不做 DOM 面板。

---

## 14. 非目标（明确不做）

- 不做行情服务器、云同步、多端账号体系
- 不自建撮合、不做信号社区、不做跟单
- 不保存 MT5 账号密码（依赖本机已登录终端）
- 不绕过券商风控与监管限制
- 不公开分发 TradingView 库源码
