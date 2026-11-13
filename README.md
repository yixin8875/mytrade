# MyTrade · MT5 图表交易终端

在 TradingView 风格的图表上直接画线、拖拽价格、下单，订单经本地网关推送到本机 MetaTrader 5 执行。

当前为 **P0 + P1 功能版**：真实行情 + 可拖动订单线 + 下单票 + 持仓/挂单管理 + 风控/持仓管理 + 交易日志与统计 + 2×2 多图联动 + 自选表 + 价格告警，订单经本地网关推送到本机 MT5。
图表层已换成 **TradingView Advanced Charts（Charting Library v32）** 本地库，K 线、指标、绘图工具、十字光标、周期切换全部是官方实现；下单线、挂单线、持仓线与 SL/TP 线用官方绘图层（horizontal line）实现，可直接拖动改价。

---

## 快速开始

### 前置条件

- Windows，已安装并登录 MetaTrader 5 终端
- Python 3.10+，已安装 `MetaTrader5` 包
- Node.js 20+
- 可选：Rust（只在打包桌面版时需要）

### 安装

```bash
npm install
pip install -r gateway/requirements.txt
```

### 启动

1. 安装 MT5；可以在「设置 → MT5 账户」里保存登录号、服务器和密码，让网关启动终端并自动登录，也可以先在终端里手动登录。
2. 启动本地网关：

```bash
npm run gateway
```

首次运行会把旧的 `gateway/config.json`、`gateway/data/`、`gateway/audit/` 迁移到 `%LOCALAPPDATA%\MyTrade\gateway\`，之后源码启动和桌面版共用这份数据。

3. 启动界面：

```bash
npm run dev
```

打开 <http://localhost:5173>。

桌面版：

```bash
npm run tauri:dev
```

> Tauri 会自行执行 `npm run dev`，如果 5173 已被占用，请先停掉单独的 Vite。
> 桌面版会自动启动打包好的网关 sidecar，并在应用退出时一并关闭。开发时如果已经手动运行了 `npm run gateway`，应用检测到 8765 端口已监听就不会重复启动。

### 打包桌面版

首次打包前准备独立的网关构建环境（只需一次）：

```bash
npm run gateway:setup
```

之后直接打包；`tauri:build` 会先运行 `npm run gateway:build`，用 PyInstaller 生成 sidecar，再把它和安装包一起打进去。

```bash
npm run tauri:build
```

产物：

- `src-tauri/target/release/bundle/msi/MyTrade_0.5.5_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/MyTrade_0.5.5_x64-setup.exe`
- 同名 `.sig` 文件（Tauri 更新签名，发布到 GitHub 时使用）

安装包未签名，首次运行 Windows 可能弹 SmartScreen，选「更多信息 → 仍要运行」。安装包已包含网关 sidecar，启动应用时会在后台自动拉起，退出应用时自动关闭，不需要另开终端运行 Python。

网关数据统一保存在 `%LOCALAPPDATA%\MyTrade\gateway\`：`config.json`（账户与风控）、`data\`（交易库、凭据、截图）、`audit\`（审计日志）和 `gateway.log`。从源码目录第一次运行新版网关时，会把旧的 `gateway/config.json`、`gateway/data/`、`gateway/audit/` 复制到这个目录一次；之后桌面版和手动启动共用同一份数据。

### 发布与自动更新（GitHub Releases）

桌面版启动约 6 秒后会自动检查 `https://github.com/yixin8875/mytrade/releases/latest/download/latest.json`；有新版时右下角弹出提示，可以「立即更新」（下载、安装并自动重启）、「稍后」或「忽略此版本」。顶部「更新」按钮可随时手动检查。更新包使用 Tauri 签名校验，签名不匹配不会安装。

安装前应用会先结束网关整棵进程树（含 PyInstaller 子进程和残留的孤儿进程），并等到 `mytrade-gateway.exe` 可覆盖后才启动安装器，避免 Windows 因文件被占用卡住；如果网关未能完全退出会取消安装并保留当前版本，安装失败会自动把网关重新拉起来。

发布新版本在本机执行，因为 `public/charting_library/` 没有提交到 Git，GitHub 云端 runner 无法编译完整应用：

1. 同步修改版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`gateway/app.py`、`gateway/mt5_worker.py`（后两处影响状态栏显示的网关版本）。
2. 确认本机 `public/charting_library/` 存在。
3. 设置一个有 `contents: write` 权限的 GitHub token 后发布：

```bash
export GITHUB_TOKEN=github_pat_xxx
npm run release -- --notes "这一版改了什么"
```

脚本会先构建网关 sidecar，再构建 MSI/NSIS、生成签名、写出 `artifacts/release/latest.json`，并在 GitHub 上创建或更新 `v0.5.5` release、上传安装包与清单。只构建不上传用 `npm run release -- --no-upload`；用已有产物重新上传用 `--skip-build`（此时 sidecar 也必须已经构建好）。

> 更新签名私钥在 `~/.tauri/mytrade.key`（已被 `.gitignore` 排除，**不要提交**），公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey`。私钥丢失后，已安装的旧版本将无法再自动更新。第一次需要手动安装一次带 updater 的版本（v0.2.0），之后才能自动更新。

---

## 当前能做什么

| 功能 | 状态 |
|---|---|
| MT5 真实品种、报价、多周期 K 线 | ✅ |
| 实时 tick 更新当前 K 线 | ✅ |
| 画线下单：图上点击/拖动设置入场价 | ✅ |
| 拖动止损/止盈线 | ✅ |
| 右边缘价格标签可直接上下拖动（草稿入场/止损/止盈、挂单、持仓 SL/TP） | ✅ |
| 深色 / 浅色主题一键切换，选择记在本机 | ✅ |
| 画线样式模板：保存当前画线样式、应用到其他画线、设为默认样式 | ✅ |
| 画线工具收藏，收藏项浮在图上快捷调用 | ✅ |
| 往左滚动按区间加载更早的历史 K 线（跨周末也能继续） | ✅ |
| 自定义指标（JS + PineJS.Std，内置 MT 双 EMA 示例） | ✅ 不支持 Pine 源码 |
| 指标组合自动保存 + 命名指标模板：重启/换品种后保持，可一键套用 | ✅ |
| 市价 / 限价 / 停损，手数按 tick 对齐 | ✅ |
| 下单前预览：保证金、风险金额、风险 %、R:R、点差 | ✅ |
| 按固定亏损金额 / 余额百分比自动算手数（拖动止损实时重算） | ✅ |
| 线右端小块显示手数 + 金额（如 `0.44 -99.41 USD`），点 ✕ 移除止损/止盈/委托 | ✅ |
| 挂单/持仓列表，拖拽改价、改 SL/TP、平仓、撤单 | ✅ |
| 只读 / 模拟可交易切换 | ✅ |
| 幂等 clientOrderId、审计日志、重启对账 | ✅ |
| 硬风控闸门：当日亏损上限（已实现+浮动）、连亏冷却、当日开仓次数、停机 | ✅ |
| 一键急停：平掉全部仓位并禁止再开仓，状态持久化（重启仍生效） | ✅ |
| 持仓管理：保本、移动止损、平一半（分批后自动移损到保本） | ✅ |
| 图上风险区间：止损红色带 / 止盈绿色带、1R/2R… 刻度、强平价估算 | ✅ |
| 交易日志：自动配对成交、MFE/MAE、图表截图、按品种/时段/策略统计 | ✅ |
| 2×2 多周期同屏 + 十字线联动 | ✅ |
| 自选表：点差、当日涨跌幅、持仓标记 | ✅ |
| 价格告警：声音、桌面通知、Webhook/Discord/Telegram/企业微信 | ✅ |
| 快捷键（B/S 市价、Esc 取消）与下单模板（0.5% + 2R + 1R 自动保本） | ✅ |
| 执行质量：点差、滑点、成交延迟 P50/P90、拒单原因 | ✅ |
| 审计日志查询、手动对账、同价位小块自动错行 | ✅ |
| 多账户：设置页添加账户并保存密码，启动/切换自动登录；日志/告警/执行统计按账户隔离 | ✅ |
| 断线自动重连、MT5 重启后按 clientOrderId 对账 | ✅ |
| TradingView Charting Library 完整界面 | ✅ 本地库（v32，勿提交） |
| 实盘交易 | ❌ 默认关闭，需改 `gateway/config.json` |

---

## 图上交易怎么用

1. 顶部选择品种和周期。
2. 点右侧「画线下单」，图表上出现一条可拖动的委托线；也可以直接在图上点击设置价格。
3. 在右侧选择买入/卖出、市价/限价/停损。图上会直接出现红色「拖动设置止损」和绿色「拖动设置止盈」参考线，拖到目标价位即写入草稿，手数会按止损距离自动计算；也可以在右侧输入框直接填写。
4. 在「风险开仓」里选 **固定金额**（如 100）或 **余额 %**（如 1），保持「自动手数」开启：设置了止损后，手数会按「止损距离 × 每点价值」自动算出来；拖动止损线会立刻重算，线右端的小块同步显示手数与预计亏损/盈利金额（持仓的 SL/TP 也会显示打到时的盈亏）。
   - 右边缘这些价格小块（草稿入场、止损、止盈、挂单价、持仓 SL/TP）都可以像线一样按住上下拖动，松手后写入草稿或发 `order.modify` / `position.modify`；入场价和持仓开仓价只做显示。
5. 预览区会实时显示保证金、风险金额、风险 %、R:R 与点差；有异常时会显示黄色警告。手动改手数会自动切回「手动手数」。
6. 顶部把模式从「只读」切到「模拟可交易」。
7. 点击下单按钮 → 确认窗 → 确认发送。订单会进入本机 MT5。

> 第一次切换到「模拟可交易」前，需要在 MT5 工具栏打开 **Algo Trading（自动交易）**，否则网关会拒绝。

### 持仓与风控

- 持仓行的 **保本** 把止损移到开仓价（自动避开券商最小止损距离）；**移动止损** 填距离点数后，网关每 0.4 秒把止损跟着价格往有利方向挪，不会往回走；**平一半** 平掉一半仓位并把止损移到保本。
- 顶部 **急停** 点两次：平掉全部仓位并停机，之后所有开仓都会被拒绝；再点「恢复交易」解除。停机状态存在 SQLite 里，重启网关仍然保持。
- 顶部风控胶囊显示当日盈亏 / 当日亏损上限与剩余额度，悬停可看开仓次数、连亏次数；状态栏显示冷却或停机原因。
- 图上从入场价到止损画红色区间、到止盈画绿色区间，绿色区间里标出 1R/2R… 刻度；杠杆足够大时还会显示橙色「强平估算」小块。

### 交易日志与统计

- 顶部「日志」打开。每次平仓后，网关按 `position_id` 把进出场成交配对成一笔交易，记录方向、手数、开/平价、盈亏（含隔夜利息与手续费）、持仓时长、MFE/MAE（用持仓期间 M1 高低点折算成账户货币）和出场方式（手动 / 止盈 / 止损 / 强平）。
- 可切换最近 7 / 30 / 90 天，查看胜率、净盈亏、盈亏比、期望、最大回撤，并按 **品种 / 时段（开仓小时）/ 策略标签** 分组。
- 下单票里的「策略标签」会随订单写进日志，之后也能在日志表格里直接改。
- 成交后前端自动截取当前图表（JPEG，≤3MB，存 `gateway/data/shots/<positionId>.jpg`），表格里点「图」查看。截图只存本机，不会上传。

### 多图联动与自选表

- 顶部「四图 / 单图」切换。四图是同一品种的 2×2 布局，每格左上角可单独切换周期，默认 5m / 15m / 1h / 4h，选择记在 localStorage。
- 鼠标在任一图的十字线上移动，其余图会用虚线同步价格线与时间线，方便多周期对照。
- 左栏「自选」标签最多放 10 个品种，每 3 秒刷新点差、买价与当日涨跌幅；有持仓的品种带圆点，点一行即可切到当前操作的图表（多图时先点一下目标格子）。

### 价格告警

- 顶栏铃铛打开图表右侧的告警面板：选品种、方向上穿/下穿、触发价、备注，可设置重复提醒与冷却秒数。打开时默认填入当前十字线价格或买价；面板覆盖在图表上，不挤压图表，也不再单独弹窗。
- 网关每 0.5 秒检查一次报价，越线后通过 WebSocket 广播；前端按「声音」「桌面通知」开关播放提示音、弹系统通知（首次会请求浏览器通知权限）。
- 第三方通道在 `gateway/config.json` 的 `alert_channels` 里配置，支持 `webhook` / `discord` / `telegram` / `wecom`，见[配置](#配置)。密钥只留在网关配置文件里，前端只能看到通道名称。
- 本期不含经济数据日历。

### 快捷键与下单模板

- 图表或页面上按 **B** 建买入市价草稿、**S** 建卖出市价草稿；只会填入下单票，仍需点按钮 + 确认窗才会发送。
- 按 **Esc** 关闭弹窗、取消确认窗或清除当前划线草稿；在输入框里不会抢占按键。
- 拖动委托线/止损/止盈时按住 **Shift**，价格吸附到整数点位（FX 10 个点、黄金 0.1、日元 0.01）。
- 下单票的「模板 · 0.5% 风险 + 2R + 保本」一键套用：风险改为余额 0.5%、自动手数、市价；设置止损后止盈自动算到 2R，成交后浮盈到 1R 时网关自动把止损移到开仓价。移动在网关每 0.4 秒检查一次，重启后计划仍然保留。

### 主题与画线模板

- 顶部「浅色 / 深色」按钮一键换主题：整个界面（侧栏、下单票、弹窗）和图表一起切换，选择存在本机 `mytrade.theme`，下次打开保持。
- 画线样式模板在图表左下角「画线模板」：
  1. 在图上点选一条已经调好样式的画线（颜色、线宽、线型、字体大小等）；
  2. 输入模板名点「保存」；
  3. 选中其他同类画线，点模板名即可套用。勾选「应用时也设为该类型画线的默认样式」后，之后新画的同类线也直接使用这套样式。
- 模板按画线类型分组存放（趋势线、水平线、矩形……），存在本机 `mytrade.drawTemplates`，不上传。画线自带的文字不会存进模板，套用时不会覆盖目标画线的文字。
- 面板左下角有拖动手柄：按住「画线模板」按钮拖动即可换位置，位置记在 `mytrade.drawTemplatesPos`；靠近底部往上展开，靠近顶部往下展开。

### 指标自动保存与指标模板

- 每张图表加的指标会自动保存（约 1.5 秒内落盘），重启应用、切换品种或账户后自动恢复；按图表格子分别保存，单图和四图互不覆盖。
- 自动保存存在本机 `mytrade.chartStates`，只保存指标和图表样式，不保存品种/周期，避免恢复时把当前选中的品种改掉。
- 图表左下角「指标模板」可以把当前指标组合存成命名模板，例如「趋势组合」「震荡组合」；点模板名即可套用到当前图表，换品种也能继续用。
- 命名模板存在本机 `mytrade.studyTemplates`，不上传；删除模板只影响模板本身，不影响图表当前指标。

### 画线收藏快捷栏

- 左侧画线工具栏里右键（或展开工具组）可以点星标收藏常用工具；默认已收藏趋势线、水平线、垂直线、射线、平行通道、斐波那契回撤、矩形、椭圆、文字、标注、箭头。
- 收藏的工具会以浮动快捷栏显示在图表顶部中间，点一下就能直接画，不用每次展开左侧工具栏。收藏项存在浏览器 localStorage 里，重启后保留。

### 历史数据翻页

- 图表不是只加载最近一段：往左滚动时，前端把 TradingView 请求的 `from / to` 传给网关，网关用 `mt5.copy_rates_range` 取更早的 K 线。
- 如果请求的窗口正好落在周末/休市，网关会往前找最近一段有数据的区间返回，图表不会因为一个空窗口就停止加载。
- 能翻到多早取决于本机 MT5 终端已下载的历史；MT5「图表中最大柱数」设置会限制可读范围。

### 自定义指标

- Charting Library **不能直接运行 Pine Script 源码**（Pine 是 TradingView 网站端的功能）。库提供的是用 JS + `PineJS.Std` 写自定义指标：`sma / ema / rsi / atr / stdev / highest / lowest` 等函数和 Pine 基本一一对应。
- 本项目已接好 `custom_indicators_getter`，示例在 `src/chart/tv/studies.ts`：内置 **MT 双 EMA**（快线/慢线周期可调），在「指标」里搜索「MT 双 EMA」即可添加。
- 需要把你的 Pine 指标搬过来时，把 Pine 源码发给我，我按 `studies.ts` 的结构转成 JS（plots、inputs、颜色都可以保留）。

### 执行质量

- 左侧「记录 → 执行质量」独立页面，统计最近 7 / 30 / 90 天实际发往 MT5 的下单请求：
  - 平均点差、平均滑点（正数 = 对你不利）、滑点为不利方向的占比、最大滑点；
  - 成交延迟 P50 / P90 / 最慢；
  - 按品种的请求数、拒单数、平均点差/滑点/延迟；
  - 拒单原因聚合（retcode + 券商原文）。
- 每笔记录包含请求价、成交价、手数、点差、滑点（点）、延迟、retcode 与状态，存本地 SQLite，可在「最近请求」里逐笔核对。
- 滑点只对市价成交有意义；延迟是网关 `order_send` 到拿到回执的时间，不含前端与网络往返。

### 稳定性与审计

- 前端 WebSocket 断开后自动重连（最长 5 秒间隔），状态栏显示「自动重连中」；重连成功会重新拉取账户、持仓、挂单、风控与告警。
- 网关与 MT5 断开后每 3 秒重连；连上时把 `sending/unknown` 的意图按 `clientOrderId` 与挂单、持仓、最近 7 天成交重新对账，并写审计。
- 左侧「记录 → 审计日志」独立页面，可按 UTC 日期、类型前缀、文本查询 `gateway/audit/YYYY-MM-DD.jsonl`，展开看完整 payload；「立即对账」手动触发一次对账，显示检查/找到/未找到数量。
- 同一价格附近的多笔持仓/挂单，右边缘小块会竖直错行（每行 18px），不会叠在一起。

---

## 安全默认值

网关默认 `trade_mode: "readonly"`，前端顶部也默认只读。所有下单请求都会经过：

- 券商最小止损距离 `trade_stops_level`
- 手数 min/max/step 对齐
- 保证金占用检查（> 可用保证金 90% 拒绝）
- 单笔最大手数 `max_lot`（默认 0.5）
- 单笔最大风险 `max_risk_pct`（默认净值 1%）
- 最大持仓数 `max_positions`（默认 3）
- 当日亏损上限 `daily_loss_pct`（已实现 + 浮动，默认 2%）
- 连亏冷却 `max_consecutive_losses` / `cooldown_minutes`（默认 3 次 / 30 分钟）
- 当日开仓次数上限 `max_trades_per_day`（默认 8）
- 账户级风控覆盖：每个账户可在设置页单独收紧手数/风险等上限，未覆盖的项继承全局
- 手动停机（急停）后，所有开仓请求拒绝
- 3 秒内同方向同价格重复请求拦截
- `clientOrderId` 幂等 + SQLite 意图记录 + 重启对账
- 全量审计日志：`gateway/audit/YYYY-MM-DD.jsonl`

实盘需要同时满足：

1. 在「设置 → 交易与风控 → 实盘开关」里打开（等价于 `gateway/config.json` 的 `allow_live: true`，立即生效）
2. MT5 终端工具栏的 Algo Trading（自动交易）已打开
3. 账户本身是实盘（美分账户也属于实盘）
4. 前端手动切到实盘模式

即使如此，仍建议先在模拟账户用小手数完整走一遍：开仓 → 拖止损 → 平仓 → 重启应用恢复状态。

---

## 配置

复制模板并按需修改：

```bash
cp gateway/config.example.json gateway/config.json
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `terminal_path` | 空 | 固定连接的 `terminal64.exe` 路径；同时开着多个 MT5 时**必须**设置，否则可能连到别的终端/账户 |
| `expected_login` | `0` | 期望登录的账户号，`0` = 不校验；非 0 时连错账户会报错并断开 |
| `accounts` | `[]` | 多账户列表，可在「设置 → MT5 账户」里增删改：`{"id","label","terminal_path","login","server"}`；可带 `risk` 覆盖风控字段；密码不在本文件；为空时退回单终端配置 |
| `active_account` | 空 | 上次选中的账户 `id`；空或找不到时使用 `accounts` 第一项 |
| `trade_mode` | `readonly` | 启动时的模式，前端可切到 `demo` |
| `allow_live` | `false` | 是否允许切换到实盘；可在「设置 → 交易与风控」里开关 |
| `max_lot` | `0.5` | 单笔最大手数 |
| `max_risk_pct` | `1.0` | 单笔最大风险（净值 %） |
| `max_spread_points` | `0` | 最大点差，0 = 不限制 |
| `max_positions` | `3` | 最大持仓数 |
| `daily_loss_pct` | `2.0` | 当日亏损（已实现 + 浮动）达到起始余额该比例后禁止开新仓，0 = 不限制 |
| `max_trades_per_day` | `8` | 当日最多开仓次数，0 = 不限制 |
| `max_consecutive_losses` | `3` | 连续亏损达到该次数后进入冷却，0 = 不启用 |
| `cooldown_minutes` | `30` | 触发连亏冷却后禁止开仓的分钟数 |
| `trailing_step_points` | `5` | 默认移动止损每次至少改进的点数 |
| `deviation_points` | `20` | 市价单允许滑点 |
| `magic` | `260511` | 订单魔术号，用于对账 |
| `alert_channels` | `[]` | 告警外部通道，元素如 `{"type":"webhook","url":"https://example.invalid/hook"}`；也支持 `discord` / `telegram` / `wecom`。含密钥，只写在本文件，前端只显示通道名 |

多账户也可以完全在界面里管理：打开「设置 → MT5 账户」，填写名称、登录号、服务器、`terminal64.exe` 路径和密码即可。密码经 Windows DPAPI 加密后保存在 `gateway/data/credentials.json`，只有当前 Windows 用户能解密，不会写入 `config.json`，也不会回发到前端。

手工配置示例：

```json
{
  "accounts": [
    {
      "id": "demo-a",
      "label": "模拟 A",
      "terminal_path": "C:/Program Files/MetaTrader 5 A/terminal64.exe",
      "login": 10000001,
      "server": "Broker-Demo"
    },
    {
      "id": "demo-b",
      "label": "模拟 B",
      "terminal_path": "C:/Program Files/MetaTrader 5 B/terminal64.exe",
      "login": 10000002,
      "server": "Broker-Demo"
    }
  ],
  "active_account": "demo-a"
}
```

每个账户还可以带一个可选的 `risk` 对象，只写要偏离全局默认的字段，其余自动继承：

```json
"risk": { "max_lot": 0.2, "max_risk_pct": 0.5, "daily_loss_pct": 3.0 }
```

「设置 → 交易与风控」可以把编辑范围切到「当前账户」，逐项改成本账户专用值；被覆盖的项会显示「用全局」，可单项恢复或一键「全部跟随全局」。切换账户后生效限额自动跟着切换。`allow_live`、交易模式、`magic` / 滑点等执行参数不按账户区分。

切换时网关会 `shutdown` 后重新 `initialize` 到目标终端；若该账户保存了密码，再调用 `mt5.login(login, password, server)` 登录，并校验最终账户号。持仓不会被平掉，但移动止损与自动保本只管理当前账户。截图存到 `gateway/data/shots/<login>/`，旧截图仍可读取。

同一个 `terminal64.exe` 可以配置多个登录号，切换会改变该终端当前登录的账户；如果希望多个账户同时在线，请给每个账户配置不同的终端路径。界面里新增或修改账户即时生效，无需重启网关。连续 3 次自动登录失败后网关会暂停重试，避免反复试错；修改该账户的密码或连接信息后会重新尝试。

---

## 目录

```
mytrade/
├─ src/                    React 前端（Tailwind 4）
│  ├─ chart/tv/            TradingView 适配：datafeed.ts（行情）、priceLines.ts（下单线/持仓线）、sync.ts（十字线联动）、registry.ts
│  ├─ gateway/             WebSocket 客户端与类型
│  ├─ lib/updater.ts       GitHub Releases 自动更新：检查、下载进度、安装重启
│  ├─ views/               概览、交易日志、统计报表、执行质量、审计日志、设置
│  ├─ components/          顶栏、图表、下单票、持仓、挂单、自选、告警面板、更新提示、状态栏
│  └─ store/               Zustand 状态
├─ gateway/                Python MT5 网关
│  ├─ app.py               FastAPI + WebSocket
│  ├─ mt5_worker.py        单线程 MT5 调用、交易、对账
│  ├─ accounts.py          账户校验、增删改、当前账户切换
│  ├─ secure_store.py      Windows DPAPI 加密保存 MT5 密码
│  ├─ journal.py           交易日志：成交配对、MFE/MAE、统计、截图
│  ├─ notify.py            告警外部通道（webhook/Discord/Telegram/企业微信）
│  ├─ store.py             SQLite 意图 + 日志 + 告警 + 执行质量 + JSONL 审计
│  └─ config.py            配置
├─ src-tauri/              Tauri 2 桌面壳
├─ scripts/verify_trade.py 下单链路冒烟测试（挂单→改价→撤单→市价→SL/TP→平仓）
├─ scripts/release.mjs     构建签名安装包、生成 latest.json、发布到 GitHub Releases
├─ DESIGN.md               完整架构设计
└─ public/charting_library TradingView 官方库（本地私有副本，已在 .gitignore，绝不提交）
```

---

## 常见问题

**界面一直显示「等待 MT5 终端」**
确认 MT5 已启动并登录，`MetaTrader5` 包版本与终端匹配。查看 `http://127.0.0.1:8765/health` 的 `lastError`；如果在设置里保存了密码，先检查登录号、服务器和终端路径。

**设置里保存密码后仍提示自动登录失败**
确认服务器名与 MT5 登录窗口完全一致、密码正确、`terminal_path` 指向实际使用的 `terminal64.exe`。连续 3 次失败后网关会暂停重试，修改该账户密码或连接信息即可重新尝试。失败记录可在「审计日志」里搜索 `account.login_failed`，不会记录密码。

**提示「MT5 未开启 Algo Trading」**
在 MT5 顶部工具栏点击「算法交易 / Algo Trading」按钮，图标变绿即可。

**下单被拒：STOPS_LEVEL**
止损/止盈距离小于券商最小点数，把 SL/TP 拖远一点。网关会直接提示具体点数。

**下单被拒：RET_10030 / INVALID_FILL**
券商的成交填充模式不支持，网关会按 `symbol_info.filling_mode` 自动选择 IOC/FOK/RETURN；若仍失败，请把该品种信息发我。

**价格显示成 0.9801599551569506**
拖动时已按 tick 对齐；手动输入框保留原始输入，发送前网关会再次对齐。

**连到了另一个 MT5 终端的账户**
电脑上同时开着多个 MT5 时，不指定路径的话 `MetaTrader5` 可能连到最近用过的那个。在 `gateway/config.json` 里把 `terminal_path` 设成目标终端 `terminal64.exe` 的完整路径，重启网关即可。

**图表空白 / 提示「Charting Library 未加载」**
`public/charting_library/` 是 TradingView 官方库，已 gitignore、不进仓库。换机器或重新克隆时，把整个目录复制到 `public/charting_library/`（保留 `bundles/` 和 `charting_library.standalone.js`），再刷新页面。

**图表时间和 MT5 不一致**
图表把「券商服务器时间」整体当成 UTC 显示，网关同时下发 `serverOffset`（服务器时间与 UTC 的差），`getServerTime` 用它对齐，所以图上的时间、日线分组和 MT5 终端一致，底部时钟显示的是服务器时间。

**点「更新」提示检查失败 / 一直显示已是最新版本**
先确认 <https://github.com/yixin8875/mytrade/releases> 已有 release，并且该 release 里上传了 `latest.json`；没有 release 时更新接口会返回 404。网络需要能访问 `github.com`，公司代理或离线环境会检查失败。

**TradingView 的 `createOrderLine` 报 “only available on Trading Platform”**
本地这个包是 Charting Library（Advanced Charts），官方下单线/持仓线属于券商版 Trading Platform 的功能。项目改用绘图层 `horizontal_line` 实现同样的可拖动价格线，见 `src/chart/tv/priceLines.ts`。

---

## 下一步

- P1：布局保存、日志收益曲线图。**TradingView 库不得提交到公开仓库**，授权边界见 [docs/TRADINGVIEW_LIBRARY.md](docs/TRADINGVIEW_LIBRARY.md)
- P2：若拿到 Trading Platform（Broker API）授权，把 `priceLines.ts` 换成官方 `createOrderLine`/`createPositionLine`，并加成交箭头
- P3：完善对账、崩溃恢复、日亏基准、EA 执行通道
- P4：DOM、更多图表布局、执行质量趋势图
