# Tally · MT5 图表交易终端

在 TradingView 风格的图表上直接画线、拖拽价格、下单，订单经本地网关推送到本机 MetaTrader 5 执行。

当前为 **v0.9.1**：真实行情 + 可拖动订单线 + 下单票 + 持仓/挂单管理 + 风控 + 交易日志与统计 + 1–6 图多品种/多周期联动 + 历史复盘 + 纪律与评分 + 自选表 + 价格告警，订单经本地网关推送到本机 MT5。
图表层已换成 **TradingView Advanced Charts（Charting Library v32）** 本地库，K 线、指标、绘图工具、十字光标、周期切换全部是官方实现；下单线、挂单线、持仓线与 SL/TP 线用官方绘图层（horizontal line）实现，可直接拖动改价。

> 第一次使用请先读 [新用户操作指南](docs/USER_GUIDE.md)：从安装、连接 MT5、第一笔模拟交易，到复盘、统计和实盘前检查清单。

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

开发自检（不需要打包，也不连 MT5）：

```bash
python -m pip install -r gateway/requirements-dev.txt
npm run check
```

`npm run check` 先跑 TypeScript 类型检查，再跑 `gateway/tests` 下的 pytest：下单计划清洗与旧格式迁移、风控字段校验、日志分类与截图标注、R 折算与模板执行统计。

产物：

- `src-tauri/target/release/bundle/msi/Tally_0.9.1_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/Tally_0.9.1_x64-setup.exe`
- 同名 `.sig` 文件（Tauri 更新签名，发布到 GitHub 时使用）

安装包未签名，首次运行 Windows 可能弹 SmartScreen，选「更多信息 → 仍要运行」。安装包已包含网关 sidecar，启动应用时会在后台自动拉起，退出应用时自动关闭，不需要另开终端运行 Python。

> 品牌已改名为 Tally，但数据目录仍沿用 `MyTrade`，避免旧安装的数据和凭据需要迁移。

启动页按「本地网关 → MT5 终端 → 账户同步」三阶段提示：网关起不来时显示 `gateway.log` 的最近一行，账户登录失败时显示具体原因和修正入口；终端长时间未连上会在 10 秒后放行到应用内，错误继续显示在底部状态栏。

网关数据统一保存在 `%LOCALAPPDATA%\MyTrade\gateway\`：`config.json`（账户与风控）、`data\`（交易库、凭据、截图）、`audit\`（审计日志）和 `gateway.log`。从源码目录第一次运行新版网关时，会把旧的 `gateway/config.json`、`gateway/data/`、`gateway/audit/` 复制到这个目录一次；之后桌面版和手动启动共用同一份数据。

### 发布与自动更新（GitHub Releases）

桌面版启动约 6 秒后会自动检查 `https://github.com/yixin8875/mytrade/releases/latest/download/latest.json`；有新版时右下角弹出提示，可以「立即更新」（下载、安装并自动重启）、「稍后」或「忽略此版本」。顶部「更新」按钮可随时手动检查。更新包使用 Tauri 签名校验，签名不匹配不会安装。

安装前应用会先结束网关整棵进程树（含 PyInstaller 子进程和残留的孤儿进程），并等到 `mytrade-gateway.exe` 可覆盖后才启动安装器，避免 Windows 因文件被占用卡住；如果网关未能完全退出会取消安装并保留当前版本，安装失败会自动把网关重新拉起来。

#### 发布新版本

发布方式：提交源码 → 在本机打包 → 把安装包上传到 GitHub Release。构建和上传都在本机完成（图表库只在本地有，云端 runner 编译不出完整应用）。

1. 同步修改版本号：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（`src-tauri/Cargo.lock` 里 `name = "app"` 那一段）、`gateway/app.py`、`gateway/mt5_worker.py`。
2. 提交源码并推上去：

```bash
git commit -am "chore: 发布 v0.9.1"
git push origin main
```

3. 确认本机 `public/charting_library/` 存在，然后打包并上传。token 优先读 `GITHUB_TOKEN` / `GH_TOKEN`；都没设时会静默调用 `git credential fill` 从已保存的凭据里取，不会打印：

```bash
npm run release -- --notes "这一版改了什么"
```

需要走代理时用 `RELEASE_PROXY`（也认 `HTTPS_PROXY`）：

```bash
RELEASE_PROXY=http://127.0.0.1:12000 npm run release -- --notes "这一版改了什么"
```

脚本会先构建网关 sidecar，再构建 MSI/NSIS、生成签名、写出 `artifacts/release/latest.json`，并在 GitHub 上创建或更新 `v0.9.1` 的 tag 与 release、上传安装包与清单。`--upload` 表示必须上传（拿不到 token 直接失败）；只构建不上传用 `npm run release -- --no-upload`；用已有产物重新上传用 `--skip-build`（此时 sidecar 也必须已经构建好）。同名资产会先删除再上传，网络失败自动重试，重复执行是安全的。

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
| 浅色 / 白色 / 深色三种主题，选择记在本机 | ✅ |
| 强调色可换：6 个预设或任意十六进制，深色下自动提亮保对比度 | ✅ |
| 画线样式模板：保存当前画线样式、应用到其他画线、设为默认样式 | ✅ |
| 画线工具收藏，收藏项浮在图上快捷调用 | ✅ |
| 往左滚动按区间加载更早的历史 K 线（跨周末也能继续） | ✅ |
| 自定义指标（JS + PineJS.Std，内置 MT 双 EMA 示例） | ✅ |
| Pine v5/v6 指标源码本地执行（Piner 优先，PineTS 回退） | ✅ 实验 |
| 指标组合自动保存 + 命名指标模板：重启/换品种后保持，可一键套用 | ✅ |
| 市价 / 限价 / 停损，手数按 tick 对齐 | ✅ |
| 下单前预览：保证金、风险金额、风险 %、R:R、点差 | ✅ |
| 按固定亏损金额 / 账户净值百分比自动算手数（拖动止损实时重算） | ✅ |
| 线右端小块显示手数 + 金额（如 `0.44 -99.41 USD`），点 ✕ 移除止损/止盈/委托 | ✅ |
| 挂单/持仓列表，拖拽改价、改 SL/TP、平仓、撤单；批量撤销与按品种全清（当前品种平仓 + 撤单） | ✅ |
| 只读 / 模拟可交易切换 | ✅ |
| 幂等 clientOrderId、审计日志、重启对账 | ✅ |
| 硬风控闸门：当日亏损上限（已实现+浮动）、连亏冷却、当日开仓次数、停机 | ✅ |
| 一键急停：平掉全部仓位、撤销全部挂单并禁止再开仓，状态持久化（重启仍生效） | ✅ |
| 持仓管理：保本、移动止损、平掉一半（回本后自动移损到保本，未回本时止损不动） | ✅ |
| 分批止盈：每笔持仓最多 8 档价格触发，图上虚线可直接拖动，按当时剩余仓位比例平仓 | ✅ 需网关运行 |
| 图上风险区间：止损红色带 / 止盈绿色带、1R/2R… 刻度、强平价估算 | ✅ |
| 交易日志：自动配对成交、MFE/MAE、图表截图、按品种/时段/策略统计 | ✅ |
| 1–6 图布局：每格独立品种/周期，十字线与时间轴可同步 | ✅ |
| 自选表：点差、当日涨跌幅、持仓标记 | ✅ |
| 价格告警：声音、桌面通知、Webhook/Discord/Telegram/企业微信 | ✅ |
| 快捷键（B/S 市价、Esc 取消）与下单模板（票内模板栏/计划条、多模板、风险 % / 止盈 R / 分批阶段可自定义，挂单也支持） | ✅ |
| 执行质量：点差、滑点、成交延迟 P50/P90、拒单原因 | ✅ |
| R 统计覆盖率：从成交订单历史补回初始止损，手动单/后加止损也能折算 R | ✅ |
| 财经日历：本周事件面板、图表竖线标注、按品种货币筛选 | ✅ 数据源 ForexFactory |
| 数据导出：交易日志 / 成交 / 审计 / 设置 CSV 与 JSON，一键整库备份与恢复 | ✅ |
| Ctrl/Cmd+K 命令面板：跳页、切主题、打开日历、导出、备份、检查更新 | ✅ |
| 窗口位置与大小记忆，下次打开回到上次的窗口 | ✅ |
| 审计日志查询、手动对账、同价位小块自动错行 | ✅ |
| 多账户：设置页添加账户并保存密码，启动/切换自动登录；日志/告警/执行统计按账户隔离 | ✅ |
| 断线自动重连、MT5 重启后按 clientOrderId 对账 | ✅ |
| TradingView Charting Library 完整界面 | ✅ 本地库（v32，勿提交） |
| 实盘交易 | ❌ 默认关闭，需改 `gateway/config.json` |

> 评分页不在侧栏，可从概览卡片或命令面板进入；审计日志在「设置 → 诊断」。

---

## 图上交易怎么用

1. 顶部选择品种和周期。
2. 点右侧「画线下单」，图表上出现一条可拖动的委托线；也可以直接在图上点击设置价格。
3. 在右侧选择买入/卖出、市价/限价/停损。点买入/卖出默认是市价，图上出现一条跟着现价走的委托线；按住线上的 `TP` / `SL` 徽标向上或向下拖，虚线跟着指针走，松手即写入草稿（只点一下不生成），手数会按止损距离自动计算；也可以在右侧输入框直接填写。
4. 在「风险开仓」里选 **固定金额**（如 100）或 **余额 %**（如 1），保持「自动手数」开启：设置了止损后，手数会按「止损距离 × 每点价值」自动算出来；拖动止损线会立刻重算，线右端的小块同步显示手数与预计亏损/盈利金额（持仓的 SL/TP 也会显示打到时的盈亏）。
   - 右边缘这些价格小块（草稿入场、止损、止盈、挂单价、持仓 SL/TP）都可以像线一样按住上下拖动，松手后写入草稿或发 `order.modify` / `position.modify`；入场价和持仓开仓价只做显示。
5. 预览区会实时显示保证金、风险金额、风险 %、R:R 与点差；有异常时会显示黄色警告。手动改手数会自动切回「手动手数」。
6. 顶部把模式从「只读」切到「模拟可交易」。
7. 点击下单按钮 → 确认窗 → 确认发送。订单会进入本机 MT5。

> 第一次切换到「模拟可交易」前，需要在 MT5 工具栏打开 **Algo Trading（自动交易）**，否则网关会拒绝。

### 持仓与风控

- 持仓行的 **保本** 把止损移到开仓价（自动避开券商最小止损距离，并按「设置 → 交易与风控 → 保本偏移」补上手续费/隔夜/滑点折算的点数；未回本或离现价太近时提示保持原值）；**移动止损** 填距离点数后，网关每 0.4 秒把止损跟着价格往有利方向挪，不会往回走；**平掉一半** 平掉一半仓位，已回本时顺便把止损移到开仓价，未回本时止损不动并提示剩余最大亏损。
- 持仓面板的 **平掉 {品种} 全部**（按钮直接显示品种，如「平掉 XAUUSD 全部」）点两次：先撤销**该品种**的全部挂单，再平掉**该品种**的持仓；别的品种不动。需要清整个账户时用 **平掉账户全部** 配合 **急停**。挂单面板的 **全部撤销** 可以只清全部挂单。批量撤单不提供「撤销」，避免价格已穿过时重挂成一笔新委托。
- 持仓行的 **分批** 展开分批止盈编辑器：默认按下一个空闲的 1R/2R… 添加一档（平 50%），之后可在图上拖动绿色虚线或在面板里改价/改比例/勾选「平后移保本」。比例作用于**当时剩余仓位**；价格到档后网关自动执行，仓位太小拆不开会标记「已跳过」而不反复重试。最终止盈仍是全平出口，所有档位必须早于它；网关退出或 App 关闭时阶梯不执行，只有券商侧 SL/TP 生效。
- 顶部 **急停** 点两次：平掉全部仓位、撤销全部挂单并停机，之后所有开仓都会被拒绝；再点「恢复交易」解除。停机状态存在 SQLite 里，重启网关仍然保持。
- 顶部风控胶囊显示当日盈亏 / 当日亏损上限与剩余额度，悬停可看开仓次数、连亏次数；状态栏显示冷却或停机原因。
- 图上从入场价到止损画红色区间、到止盈画绿色区间，绿色区间里标出 1R/2R… 刻度；杠杆足够大时还会显示橙色「强平估算」小块。

### 交易日志与统计

- 左侧「记录 → 交易列表」打开。每次平仓后，网关按 `position_id` 把进出场成交配对成一笔交易，记录方向、手数、开/平价、盈亏（含隔夜利息与手续费）、持仓时长、MFE/MAE（用持仓期间 M1 高低点折算成账户货币）和出场方式（手动 / 止盈 / 止损 / 强平）。
- 可切换最近 7 / 30 / 90 天，查看胜率、净盈亏、盈亏比、期望、最大回撤，并按 **品种 / 时段（平仓时间）/ 策略标签** 分组；时段换算到复盘时区后按整点归桶。
- 下单票里的「策略标签」会随订单写进日志，之后也能在日志表格里直接改。
- 成交后前端自动截取当前操作的图表格子（JPEG，≤3MB，存 `gateway/data/shots/<positionId>.jpg`），表格里点「图」查看。截图只存本机，不会上传。
- R 用初始止损距离折算：优先取成交订单历史里的止损（手动单、成交后再补的止损都能找到），其次用持仓期间记录的止损，最后用下单意图里的止损；算出来的风险会写回交易日志，下次统计直接复用。统计报表页会显示「R 覆盖」和各类风险来源的笔数。

### 多图联动与自选表

- 顶部布局选择器支持单图到 6 图（2×2、三列、上下分割、左大右小等）；每格可单独选品种和周期，选择记在 localStorage。「设置 → 图表 → 默认周期」始终作用于主图。
- 多图之间可以分别同步品种、周期、十字线和时间轴；关掉同步后各格独立。
- 左栏「自选」列出常用品种，每 3 秒刷新点差、买价与当日涨跌幅；有持仓的品种带圆点，点一行即可切到当前操作的图表（多图时先点一下目标格子）。

### 价格告警

- 顶栏铃铛打开图表右侧的告警面板：选品种、方向上穿/下穿、触发价、备注，可设置重复提醒与冷却秒数。打开时默认填入当前十字线价格或买价；面板覆盖在图表上，不挤压图表，也不再单独弹窗。
- 网关每 0.5 秒检查一次报价，越线后通过 WebSocket 广播；前端按「声音」「桌面通知」开关播放提示音、弹系统通知（首次会请求浏览器通知权限）。
- 第三方通道在「设置 → 告警 → 推送通道」里直接管理（新增 / 编辑 / 删除 / 单通道测试），保存后立即生效，无需重启；也可以手改 `gateway/config.json` 的 `alert_channels`。支持 `webhook` / `discord` / `telegram` / `wecom` / `feishu` / `dingtalk` / `bark` / `ntfy` / `email`，字段见 [docs/ALERT_CHANNELS.md](docs/ALERT_CHANNELS.md)。密钥只留在网关侧，界面只显示名称、类型与「已配置」标记，不回显地址或 Token。

### 财经日历

- 顶栏「日历」打开图表右侧的日历面板，与告警面板一样覆盖在图表上，不挤压图表。
- 数据来自 ForexFactory 的公开周历（`nfs.faireconomy.media`），由网关在后台线程抓取并缓存 6 小时，缓存在 `gateway/data/calendar_cache.json`；断网时沿用旧缓存并在面板顶部提示。
- 默认只看当前品种相关货币的高影响事件（例如 `EURUSD` → EUR/USD，`USTEC` 这类指数 → USD）；可切到「全部」、关闭「仅高影响」看到中影响事件。
- 面板里的「图表标注」开关会在主图按事件时间画竖线，只标注当前可见区间内、与品种货币匹配的高/中影响事件；开关状态存在本机 `mytrade.calendarOverlay`。

### 快捷键与下单模板

- 图表或页面上按 **B** 建买入市价草稿、**S** 建卖出市价草稿；只会填入下单票，仍需点按钮 + 确认窗才会发送。
- 按 **Esc** 关闭弹窗、取消确认窗或清除当前划线草稿；在输入框里不会抢占按键。
- 按 **Ctrl/Cmd+K** 打开命令面板：输入关键词过滤，↑↓ 选择、Enter 执行、Esc 关闭；输入框里也能用。
- 拖动委托线/止损/止盈时按住 **Shift**，价格吸附到整数点位（FX 10 个点、黄金 0.1、日元 0.01）。
- 下单票的模板栏始终可见：左侧显示当前模板名与摘要（如 `默认模板 / 0.5% · 2R · 1R→保本`），点开可切换模板、新建模板或跳到设置页，右侧是「启用」开关和编辑铅笔。
- 点「启用」后把风险改为余额的设定比例并打开自动手数；已有委托价的草稿保留限价/停损，否则准备一张市价草稿；设好止损后止盈按模板的 R 倍数自动放置。停用只解除管理，不动已填的风险、手数、止损止盈。
- 启用后模板栏下方出现计划条：风险 % 与实际金额、止盈价、阶段阶梯；挂单会提示「成交后自动登记阶段计划」。手动改风险/手数后显示「已偏离模板」并可一键恢复；手动改止盈不会被抢回，可点「用模板止盈」还原。
- 模板可以直接在票内铅笔里编辑（与设置页共用同一个编辑器），改风险 % 或止盈 R 会实时跟随到当前草稿；切换模板时风险与止盈也按新模板更新。
- 成交后网关每 0.4 秒检查一次浮盈：阶段按 R 从小到大执行，例如「1R 平 50% 并移到保本」「2R 再平 50%」。到达触发价时先移止损（幂等）、再按当时剩余仓位的比例平仓；仓位小到拆不开时只做止损动作。计划持久化，重启后仍然保留。
- 挂单也可以带模板：成交后自动把阶段计划登记到实际持仓（按委托注释匹配，历史订单里的 position_id 兜底）；撤单、过期或 TTL（30 天）到期会自动清理，不会留下执行不了的旧计划。
- 只读模式或风控急停期间阶段暂停执行（计划条显示「阶段已暂停」），恢复可交易后继续；切换品种、切换账户、删除当前模板或按 Esc/B/S 重置草稿会解除启用。
- 默认模板为 0.5% 风险 + 2R 止盈 + 1R 移到保本；全部模板存在本机 `mytrade.templates`（旧版 `mytrade.template` 会自动迁移），不上传。

### 主题与画线模板

- 设置 → 外观 → 主题：浅色（冷灰仪器台）、白色（纯白底材）、深色（墨面），整个界面（侧栏、下单票、弹窗）和图表一起切换，选择存在本机 `mytrade.theme`，下次打开保持。
- 设置 → 外观 → 强调色：6 个预设或拾色器/十六进制自定义，只影响选中、焦点、链接这类强调元素（涨跌绿红不动）；深色下自动提亮到够读，存 `mytrade.accent`，点「恢复默认」清掉。
- 画线样式模板在图表左下角「画线模板」：
  1. 在图上点选一条已经调好样式的画线（颜色、线宽、线型、字体大小等）；
  2. 输入模板名点「保存」；
  3. 选中其他同类画线，点模板名即可套用。勾选「应用时也设为该类型画线的默认样式」后，之后新画的同类线也直接使用这套样式。
- 模板按画线类型分组存放（趋势线、水平线、矩形……），存在本机 `mytrade.drawTemplates`，不上传。画线自带的文字不会存进模板，套用时不会覆盖目标画线的文字。
- 面板左下角有拖动手柄：按住「画线模板」按钮拖动即可换位置，位置记在 `mytrade.drawTemplatesPos`；靠近底部往上展开，靠近顶部往下展开。

### 指标自动保存与指标模板

- 每张图表加的指标会自动保存（约 1.5 秒内落盘），重启应用、切换品种或账户后自动恢复；按图表格子分别保存，单图和多图互不覆盖。
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

- 内置指标走 Charting Library 的 `custom_indicators_getter`，用 JS + `PineJS.Std` 编写：`sma / ema / rsi / atr / stdev / highest / lowest` 等函数和 Pine 基本一一对应。示例在 `src/chart/tv/studies.ts`：内置 **MT 双 EMA**（快线/慢线周期可调），在「指标」里搜索「MT 双 EMA」即可添加。
- 也可以直接运行 Pine v5/v6 指标源码：在「设置 → Pine 脚本」粘贴原生 `indicator` 源码，保存后由 Piner（失败时回退 PineTS）在本地执行，不上传。该功能仍属实验，保存/删除脚本后需要刷新一次图表。
- TradingView 的 Charting Library 本身不执行 Pine；这里是通过本地运行时解释脚本，绘图能力以运行时支持的范围为准。

### 执行质量

- 「分析 → 报表 → 执行质量」，按报表页的同一区间统计实际发往 MT5 的下单请求：
  - 平均点差、平均滑点（正数 = 对你不利）、滑点为不利方向的占比、最大滑点；
  - 成交延迟 P50 / P90 / 最慢；
  - 按品种的请求数、拒单数、平均点差/滑点/延迟；
  - 拒单原因聚合（retcode + 券商原文）。
- 每笔记录包含请求价、成交价、手数、点差、滑点（点）、延迟、retcode 与状态，存本地 SQLite，可在「最近请求」里逐笔核对。
- 滑点只对市价成交有意义；延迟是网关 `order_send` 到拿到回执的时间，不含前端与网络往返。

### 数据导出与备份

- 设置 → **数据与备份**：按区间（7 / 30 / 90 天 / 全部）导出交易日志、成交记录、审计日志、设置。
  - 交易日志 CSV 带 UTF-8 BOM 和 `初始风险 / 风险来源 / R` 列，Excel 直接打开不乱码；
  - 成交与审计分别导出为 CSV 和 JSON；设置导出为 `{version, app, exportedAt, config, ui, login}`。
  - 文件写在本机数据目录下的 `exports/`，面板里显示完整路径，桌面版可直接在资源管理器里定位。
- 整库备份：把数据库（SQLite 在线快照）、设置、审计日志与截图打成一个 zip（`backups/tally-backup-<时间>.zip`）；不包含 `config.json` 与 MT5 登录凭据，换机后重新登录账户即可。
- 自动备份：网关每小时检查一次，24 小时内没有自动备份就生成 `backups/tally-auto-<时间>.zip`，只保留最近 7 份；手动备份不会被自动清理。备份列表里自动备份标有「自动」。
- 「导出诊断」：下载一份 JSON 诊断包（见下文「崩溃恢复与诊断」），界面崩溃或行情异常时先导出它再反馈。
- 恢复：桌面版里点备份行的「恢复」，会先停掉网关、校验备份里的数据库，再把旧的 `data/`、`audit/` 改名成 `*.old-<时间>` 保留，换上新数据并重启网关；本地 MT5 凭据会保留。恢复失败时保留现场并直接报错。
- 顶栏左侧「搜索命令」或 **Ctrl/Cmd+K** 打开命令面板，可以直接跳页、切主题、打开日历、导出日志、创建备份、检查更新。

### 稳定性与审计

- 前端 WebSocket 断开后自动重连（最长 5 秒间隔），状态栏显示「自动重连中」；重连成功会重新拉取账户、持仓、挂单、风控与告警。
- 网关启动时在后台检查一次 SQLite 完整性，结果在 `/health` 的 `database` 字段；前端渲染异常会被 ErrorBoundary 兜住，可重新加载或导出诊断包。
- 网关与 MT5 断开后每 3 秒重连；连上时把 `sending/unknown` 的意图按 `clientOrderId` 与挂单、持仓、最近 7 天成交重新对账，并写审计。
- 「设置 → 诊断 → 审计日志」，可按 UTC 日期、类型前缀、文本查询 `gateway/audit/YYYY-MM-DD.jsonl`，展开看完整 payload；「立即对账」手动触发一次对账，显示检查/找到/未找到数量。
- 同一价格附近的多笔持仓/挂单，右边缘小块会竖直错行（每行 18px），不会叠在一起。
- 窗口位置、大小与最大化状态记在应用配置目录的 `window-state.json`，下次打开回到上次的窗口；超出屏幕的旧坐标会自动回到默认大小。

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

网关只监听 `127.0.0.1`，并校验每个连接的页面来源：WebSocket 握手、CORS 和截图接口只接受 Vite 开发页（`http://localhost:5173`）与 Tauri 桌面壳（`tauri://localhost`、`http(s)://tauri.localhost`）。浏览器里的其它网页即使向本机发起 WebSocket，或按已知文件名读取 `/shots`，也会被拒绝；`Origin: null`（沙箱 iframe、`file://` 页面）同样拒绝。没有 Origin 的本机脚本（如 `scripts/verify_trade.py`）按原样放行。

需要从别的地址打开界面时，在 `gateway/config.json` 里追加来源（会与默认白名单合并）：

```json
{ "allowed_origins": ["http://192.168.1.10:5173"] }
```

实盘需要同时满足：

1. 在「设置 → 交易与风控 → 实盘开关」里打开（等价于 `gateway/config.json` 的 `allow_live: true`，立即生效）
2. MT5 终端工具栏的 Algo Trading（自动交易）已打开
3. 账户本身是实盘（美分账户也属于实盘）
4. 前端手动切到实盘模式

即使如此，仍建议先在模拟账户用小手数完整走一遍：开仓 → 拖止损 → 平仓 → 重启应用恢复状态。

---

## 命令超时与「结果未知」

网关给每条命令设了服务端超时：普通命令 7 秒，历史行情、统计、AI 复盘、导出/备份等长命令 18–85 秒；前端超时始终比服务端多留几秒，保证先收到明确错误码，而不是笼统的「请求超时」。

- 只读命令超时返回 `TIMEOUT`，可以安全重试。
- 可能已经改变券商状态的命令（`order.place`、`order.modify`、`order.cancel`、`order.cancelAll`、`position.modify`、`position.breakeven`、`position.close`、`position.closeAll`、`trade.flatten`）超时返回 `RESULT_UNKNOWN`：网关不会误报「失败」，而是在工作线程恢复空闲后自动对账，界面提示稍后核对持仓与挂单。
- 命令队列有上限（256 条）；工作线程长时间卡住时新请求会快速返回 `BUSY`，不会无限堆积。
- `/health` 的 `runtime` 字段暴露队列深度、当前执行中的命令、最近命令耗时与慢命令计数；超过服务端超时的命令会写入审计日志 `command.slow`。

---

## 统计口径

前后端共用同一套判定（`gateway/metrics.py` 与 `src/lib/metrics.ts`，`WIN_EPSILON = 0.005`）：

- 盈亏 > 0.005 记胜，< -0.005 记负；两者之间（含 0 与手续费造成的毛刺）不计入胜/负。
- 统计窗口按复盘时区的自然日计算；时段按平仓时间换算到同一时区后归桶，报表、分析、复盘与评分共用这一口径。
- 前端 `winRate` 是 0–1 的比例，网关 `journal.stats` 返回 0–100 的百分数。
- `journal.stats` 最多统计最近 5000 笔；被截断时 `summary.truncated = true`，交易日志页提示「仅统计最近 5000 笔」。
- `testdata/stats_golden.json` 是两端共用的黄金样本，pytest 与 vitest 都会读取，口径漂移会直接测试失败。

---

## 崩溃恢复与诊断

- 网关启动时在独立线程跑一次 SQLite `PRAGMA integrity_check`，结果进入 `/health` 的 `database`；失败会写审计 `database.integrity_failed`，不影响网关继续运行。
- 自动备份线程每小时检查一次：超过 24 小时没有自动备份就创建一份，轮转只保留最近 7 份；手动与自动备份共用一把锁，避免同时写 SQLite 快照。
- 网关日志同时写入 `logs/gateway.log`（2MB 轮转，保留 4 份）。
- 设置 → 数据与备份 →「导出诊断」下载 JSON，包含网关 health、数据库自检、备份列表、日志尾部（password/token/authorization 已脱敏）以及前端未捕获异常与 Promise 拒绝（最近 30 条）。
- 前端由 ErrorBoundary 兜底：渲染崩溃时显示错误信息，可一键重新加载或导出诊断包；交易数据仍在网关和本地库里，不会因此丢失。

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
| `alert_channels` | `[]` | 告警外部通道，元素如 `{"id":"3f9a1c2b","type":"webhook","name":"团队群","url":"https://example.invalid/hook"}`；也支持 `discord` / `telegram` / `wecom` / `feishu` / `dingtalk` / `bark` / `ntfy` / `email`，各通道字段见 [docs/ALERT_CHANNELS.md](docs/ALERT_CHANNELS.md)。可在设置页管理并自动生成 `id`；含密钥，只写在本文件，前端只显示名称、类型与已配置标记 |

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
│  ├─ views/               概览、交易记录、分析、纪律、历史复盘、设置
│  ├─ components/          顶栏、图表、下单票、交易托盘、自选、告警面板、更新提示、状态栏
│  └─ store/               Zustand 状态
├─ gateway/                Python MT5 网关
│  ├─ app.py               FastAPI + WebSocket、来源白名单、命令超时
│  ├─ mt5_worker.py        工作线程生命周期、命令分派、健康状态
│  ├─ worker_base.py       共享常量、依赖代理、超时与队列参数
│  ├─ worker_account.py    连接、多账户、配置与服务器时间
│  ├─ worker_market.py     品种、历史行情、报价/分时订阅、自选
│  ├─ worker_trading.py    预检、下单、改单、平仓、挂单/分批止盈计划
│  ├─ worker_risk.py       风控、持仓快照、移动止损与分批止盈
│  ├─ worker_data.py       日志、导出/备份、价格告警
│  ├─ metrics.py           胜负口径（与 src/lib/metrics.ts 一致）
│  ├─ security.py          Origin/Referer 白名单
│  ├─ diagnostics.py       诊断包（health + 自检 + 日志尾部）
│  ├─ exporter.py          CSV/JSON 导出与 zip 备份
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

- 近期：布局保存、日志收益曲线图、执行质量趋势图。
- 若拿到 Trading Platform（Broker API）授权，把 `priceLines.ts` 换成官方 `createOrderLine`/`createPositionLine`，并加成交箭头。**TradingView 库不得提交到公开仓库**，授权边界见 [docs/TRADINGVIEW_LIBRARY.md](docs/TRADINGVIEW_LIBRARY.md)。
- 后续：完善对账与崩溃恢复、日亏基准、EA 执行通道、DOM。
