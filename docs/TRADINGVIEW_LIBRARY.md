# TradingView Charting Library / Advanced Charts：申请与接入

> 结论写在最前面：**个人自用的桌面交易工具，不符合免费授权条件。**
> 这份文档把官方规则、申请步骤、以及拿到库之后的接入清单一次讲清楚，最后给出三条可行路线。

---

## 一、先看清授权条件

Advanced Charts（原名 Charting Library）和 Trading Platform 都是**专有软件**，托管在私有 GitHub 仓库，要申请才能拿到。免费，但免费是有条件的。

官方 FAQ 原文（<https://www.tradingview.com/free-charting-libraries/>）：

> At this time, we don't provide the Advanced Charts and the Trading Platform libraries for personal use, hobbies, studies, or testing. These licenses are only available to **companies** for use in **public web projects and/or applications**.

许可协议第 2.4 条（据第三方对协议条文的整理）：

> ...intended for Implementations as a **public access service (as a free offering only)** ... and **not for private, personal or internal uses**.

翻译成大白话：

| 你的用法 | 是否符合免费授权 |
|---|---|
| 公司做的、对公众开放、免费的网页或应用 | ✅ |
| 个人自用、内部工具、私有桌面软件 | ❌ |
| 收费产品 | ❌ |
| 开源项目（代码公开） | ❌ |

对照本项目——「自己画线下单、推到本机 MT5 的私人终端」——属于第二行：**拿不到这条免费授权**。

其他硬性条款（第三方整理，签之前请自己读一遍 PDF）：

- **不可再分发**：库不能出现在任何公开仓库，包括自己的示例仓库
- **不能改**：`charting_library/bundles` 是黑盒，不提供源码
- **必须署名**：保留 TradingView logo 和带链接的署名，链接不能加 `nofollow`
- **必须公告**：2.11 条要求发一篇带反链的博客/新闻公告
- **审计权**：TradingView 可免费、无限次访问你的产品做合规检查
- **违约代价**：7.5 条约定每次违约 5 万美元（第三方整理数字）
- **只能从官方渠道获取**：第三方镜像、网盘、破解版都可能引发法律责任

---

## 二、如果仍要申请：按「公司 + 公开免费产品」准备

### 需要准备的材料

1. **公司主体**：能签合同的公司名（个人身份基本过不了）
2. **官网或产品主页**：能打开的公开页面，不是 GitHub 空仓库
3. **公司邮箱**：用 Gmail/QQ 邮箱申请会被追问，公司域名邮箱显著提高通过率
4. **个人 GitHub 账号**：社区反馈授权发到个人账号，组织/团队账号不行
5. **产品说明**：面向谁、是否免费公开、数据来源（本项目是券商 MT5 数据，不涉及 TradingView 行情）、预计用户量、上线时间
6. **签字人**：能代表公司签许可协议的人

### 申请步骤

1. 打开 <https://www.tradingview.com/advanced-charts/>，滚到页面底部，点 **Get the library / Grab the Library**，弹出申请表。
2. 填表，通常包括：公司名、产品名与网址、联系邮箱、GitHub username、产品形态、数据来源、上线计划。
3. 下载许可协议 PDF，签字后随表回传。
4. 等审批。社区反馈从 3 天到两周不等；超过一周没回复，可发邮件到 `platforms@tradingview.com` 跟进。
5. 通过后，GitHub 会收到 `tradingview/charting_library` 私有仓库的邀请，用填表时的个人账号接受。
6. clone 仓库，把 `charting_library/` 和 `datafeeds/` 两个目录复制进项目。

### 审批期间可以同步做的

- 把产品做成**公开可访问**的形态（去掉强制登录、去掉内部测试页）
- 准备好 TradingView 要求的署名位和公告稿
- 先把数据层抽象好（见第四节），审批通过后只换渲染层

---

## 三、另外两条路

### 路线 B：商业授权

不满足「公开免费」条件，但愿意付费，可以联系 `platforms@tradingview.com` 谈商业许可。报价按产品规模谈，通常不是个人项目量级。

### 路线 C：继续用 Lightweight Charts（当前方案）

- Apache 2.0，可商用、可修改、可分发，没有任何申请流程
- 本项目已经用它跑通了真实行情 + 可拖动订单线 + SL/TP + 下单
- 差距在于：没有 100+ 指标、110+ 画线工具、多图表布局、DOM、完整 TradingView 交互
- 但**界面像素级可以做得非常接近**：TradingView 的深色色板、顶栏、右侧面板、价格轴样式都是公开的视觉语言，照着重绘不涉及授权

对一个「自己用」的 MT5 下单工具来说，路线 C 是唯一没有法律风险的选择，而且功能上完全够用。

---

## 四、拿到库之后的接入清单（针对本项目）

> 目录约定：库放 `public/charting_library/`，已写入 `.gitignore`，不要提交。

### 1. 放置文件

```
public/charting_library/     # 从私有仓库复制，不可修改
public/datafeeds/            # 可选，参考实现
```

### 2. 引入脚本

`index.html` 增加：

```html
<script src="/charting_library/charting_library.standalone.js"></script>
```

### 3. 实现 Datafeed（`src/chart/tv/datafeed.ts`）

对接现有网关方法：

| Datafeed 方法 | 网关调用 | 注意 |
|---|---|---|
| `onReady(cb)` | `system.health` | `supported_resolutions: ['1','5','15','30','60','240','1D','1W']` |
| `resolveSymbol` | `symbol.info` | `pricescale = 10 ** digits`、`mintick = tickSize`、`minmov = 1`、`session` 按券商服务器时区 |
| `getBars` | `history.get` | **MT5 返回的是服务器时间**，必须换算成 UTC，否则 K 线整体偏移 |
| `subscribeBars` | `bars.subscribe` + `bar` 事件 | 用实时推送更新最后一根 |
| `unsubscribeBars` | `bars.unsubscribe` | 切换周期/品种时务必解绑 |
| `getServerTime` | `system.health.serverTime` | 用网关时间校正浏览器时钟 |
| `searchSymbols` | `symbols.list` | 支持中文 description 搜索 |

周期映射要和网关的 `TIMEFRAMES` 对齐：TV 用 `1/5/15/30/60/240/D/W/M`，本项目内部用 `1/5/15/30/60/240/1D/1W/1M`，在适配层做一次转换。

### 4. 替换图表组件

`src/components/ChartPanel.tsx` 改为挂载 `new TradingView.widget({...})`：

```ts
{
  container: host,
  library_path: '/charting_library/',
  locale: 'zh',
  theme: 'dark',
  symbol,
  interval: resolution,
  datafeed,
  fullscreen: false,
  autosize: true,
  overrides: {
    'paneProperties.background': '#131722',
    'paneProperties.vertGridProperties.color': '#1e222d',
    'paneProperties.horzGridProperties.color': '#1e222d',
    'mainSeriesProperties.candleStyle.upColor': '#26a69a',
    'mainSeriesProperties.candleStyle.downColor': '#ef5350',
  },
}
```

### 4.1 当前实现（本机库 v32.1.0，已跑通）

| 位置 | 内容 |
|---|---|
| `public/charting_library/` | 官方库本地副本（31 MB），已 gitignore，不提交、不分发 |
| `index.html` | `<script src="/charting_library/charting_library.standalone.js">` |
| `src/chart/tv/datafeed.ts` | `IDatafeedChartApi`：`onReady` / `resolveSymbol` / `getBars` / `subscribeBars` / `getServerTime`，走本地网关 |
| `src/chart/tv/priceLines.ts` | 下单线/持仓线（绘图层实现，见下） |
| `src/components/ChartPanel.tsx` | 创建 widget、同步品种/周期、把 store 里的挂单/持仓/草稿画成价格线 |

踩过的坑（v32）：

- **`Bar.time` 是毫秒**（`charting_library.d.ts` 里 `Bar.time: number` 标注 milliseconds），网关给的是秒，必须 `* 1000`，否则图上只有一根聚合 K 线；`PeriodParams.from/to` 仍是秒。
- `getServerTime` 返回**秒**，且要和 K 线用同一个时间参照系。
- 券商服务器时间不在 TradingView 支持的时区列表里（如 `Etc/GMT-2` 会被判定 unsupported）。做法：K 线时间原样当成 UTC 展示，网关下发 `serverOffset`，`getServerTime = 现在 + serverOffset`，时区用 `Etc/UTC`，图上时间与 MT5 完全一致。
- `use_localstorage_for_settings` 关掉，避免调试时旧 layout 缓存干扰。
- **`createOrderLine` / `createPositionLine` / `createExecutionShape` 在 Charting Library 里是空实现**，调用直接抛 `only available on Trading Platform`（`bundles/library.*.js` 里写死的）。只有券商版 Trading Platform 才有 Broker API。
- 替代方案：`createShape({ time, price }, { shape: 'horizontal_line', text, disableSave: true })` + `getShapeById(id).setProperties({ linecolor, textcolor })` / `setPoints([{ time, price }])`。拖动可用，但没有移动结束事件，靠 200ms 轮询 `getPoints()` 检测位置变化；拖动后 1.5s 内不按旧数据回拉，等券商回执。

### 5. 交易层（两级，按需选）

> 下面两级的 `createOrderLine` / `IBrokerConnection` 都需要 **Trading Platform（券商版）** 的库，普通 Charting Library 包做不到。当前项目在 Charting Library 上用绘图层模拟了第一级的效果，第二级需另行申请。

**轻量版（1–2 天）**：保留现有下单票，图上改用官方组件画线：

- `chart.createOrderLine()` → 拖拽改价，`onMove` 回调里调 `order.modify`
- `chart.createPositionLine()` → 拖 SL/TP 调 `position.modify`
- `chart.createExecutionShape()` → 成交箭头

**完整版（2–3 周）**：实现 `IBrokerConnection`，把 `order.place` / `position.close` / 账户与持仓查询接进去，图上的买卖按钮、订单面板、成交历史全部由 TradingView 组件渲染，交互和官方一致，但工作量明显更大。

### 6. 清理

- 卸载 `lightweight-charts`（已完成）
- 把 `src/chart/tv/priceLines.ts` 换成 `createOrderLine` / `createPositionLine`（仅 Trading Platform 版可用）
- 保留下单票作为「精确输入」入口

### 7. 验收清单

- [ ] 多周期切换无偏移，K 线时间与 MT5 一致（时区换算正确）
- [ ] 拖订单线改价 → MT5 挂单价格同步变化
- [ ] 拖持仓 SL/TP → MT5 止损止盈同步变化
- [ ] 成交后图上出现箭头/持仓线
- [ ] 断线重连后图表与持仓状态自动恢复
- [ ] 署名与 logo 可见（授权要求）

---

## 五、建议

1. **现在**：留在 Lightweight Charts，把 UI 继续向 TradingView 靠（工具栏、画线、自选列表、DOM、多图表布局）——这些都不需要授权。
2. **如果将来打算公开做产品**：先把产品做成公开、免费、可访问的形态，再用公司主体申请，成功率会高很多。
3. **不要**从任何第三方渠道下载库文件：既违反协议，也可能夹带恶意代码。
