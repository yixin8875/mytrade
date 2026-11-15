# 统计口径约定

交易统计有两个实现：后端 `gateway/journal.py` 的 `TradeJournal.stats`（报表页）与前端
`src/lib/analysis.ts` 的 `summarize` / `groupTrades`（分析页）。两边回答的是同一个问题，
所以口径必须一致，并用同一份样本锁住。

## 黄金样本

`testdata/stats_golden.json` 是唯一的跨端样本：

- `trades[]`：合成交易，字段 `positionId / symbol / side / volume / openTime / closeTime /
  profit / r / risk / durationSec / mfe / mae / tag / day`。时间取 2100 年附近的 UTC 秒
  （如 `4102441200`），样本不会随时间过期。
- `expected`：两端都必须算出的结果，包含 `trades / wins / losses / net / winRate / avgR /
  rTrades / avgDurationSec / profitFactor / expectancy`，以及 `byTag / byDuration / byHour`
  三个分组维度。
- `serverOffset`：`byHour` 使用的服务器时区差（秒）。

断言在 `gateway/tests/test_stats_golden.py` 与 `src/lib/analysis.golden.test.ts` 两处。

## 分组口径

| 维度 | 规则 |
|---|---|
| 标签 | `tag` 去空白，空值归入「未标记」 |
| 持仓时长 | 15 分内 / 15 分–1 时 / 1–4 时 / 4–24 时 / 1 天以上（边界取左闭右开） |
| 时段 | 开仓时间减 `serverOffset` 后的 UTC 整点，键形如 `"23:00"` |
| 品种 | 原样使用交易品种 |

前端 `DURATION_BUCKETS` 的 key（`lt15` / `15-60` / `1-4h` / `4-24h` / `gt24h`）与后端
`_duration_bucket` 的中文标签一一对应，改动任一侧必须同时改另一侧。

## 新增指标的流程

1. 先在 `testdata/stats_golden.json` 的 `expected` 里写下期望值（人工核算，不从实现反推）。
2. 再改后端与前端实现，让两边都读出同一结果。
3. 跑 `python -m pytest gateway/tests/test_stats_golden.py` 与
   `npx vitest run src/lib/analysis.golden.test.ts`。
4. 不允许为了过测试改期望值；期望值变化只能来自业务口径的明确变更，并在提交说明里写清原因。

筛选（`JournalFilter`：`symbol / tag / result / reviewed`）在 SQL 层实现，列表与统计共用
同一个过滤构造器（`store.py` 的 `_journal_filter_sql`），所以两处的行集合天然一致。
