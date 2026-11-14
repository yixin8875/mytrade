"""过程评分：透明、带版本的 0–100 综合分，只评价过程，不预测收益。

公式写在这里，任何改动都要升 TALLY_SCORE_VERSION。
分量不够样本时直接剔除并重新归一化权重，不用 0 分冒充。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from review import Review
from store import Store

TALLY_SCORE_VERSION = 1
MIN_TRADES = 20
MIN_R_TRADES = 5

BREAKEVEN = 0.005

# 顺序即展示顺序；权重固定
COMPONENTS: list[dict[str, Any]] = [
    {
        "key": "expectancy",
        "label": "期望 R",
        "weight": 0.25,
        "unit": "R",
        "rule": "平均每笔 R 从 −0.5 到 +0.5 映射到 0–100",
    },
    {
        "key": "win_rate",
        "label": "胜率",
        "weight": 0.15,
        "unit": "",
        "rule": "胜率从 20% 到 70% 映射到 0–100",
    },
    {
        "key": "payoff",
        "label": "盈亏比",
        "weight": 0.15,
        "unit": "倍",
        "rule": "平均盈利 / 平均亏损，从 0.5 到 2.5 倍映射到 0–100",
    },
    {
        "key": "drawdown",
        "label": "R 回撤",
        "weight": 0.15,
        "unit": "R",
        "rule": "累计 R 的最大回撤，0R 得 100 分，5R 及以上得 0 分",
    },
    {
        "key": "recovery",
        "label": "恢复因子",
        "weight": 0.10,
        "unit": "倍",
        "rule": "总 R / 最大 R 回撤，0 到 3 倍映射到 0–100",
    },
    {
        "key": "concentration",
        "label": "日集中度",
        "weight": 0.10,
        "unit": "",
        "rule": "单日最大绝对盈亏 / 全部绝对盈亏，越分散分越高",
    },
    {
        "key": "discipline",
        "label": "规则遵守率",
        "weight": 0.10,
        "unit": "",
        "rule": "策略手册里已评估的规则勾选通过比例",
    },
]


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _linear(value: float, low: float, high: float) -> float:
    if high <= low:
        return 50.0
    return _clamp((value - low) / (high - low) * 100.0)


class Score:
    def __init__(self, store: Store, review: Review) -> None:
        self.store = store
        self.review = review

    def get(self, params: dict[str, Any], login: int, server_offset: int) -> dict[str, Any]:
        days = int(params.get("days") or 90)
        days = max(7, min(3650, days))
        today = datetime.strptime(self.review._today(), "%Y-%m-%d").date()
        start = today - timedelta(days=days - 1)
        raw_start, raw_end = self.review._raw_range(
            start, today + timedelta(days=1), server_offset
        )
        rows = self.store.journal_between(raw_start, raw_end, login)
        rows.sort(key=lambda row: int(row["close_time"]))

        trades = len(rows)
        profits = [float(row.get("profit") or 0) for row in rows]
        r_values = [self.review._r(row) for row in rows]
        r_values = [value for value in r_values if value is not None]
        net = sum(profits)
        wins = [value for value in profits if value > BREAKEVEN]
        losses = [value for value in profits if value < -BREAKEVEN]

        raw: dict[str, float] = {}
        scores: dict[str, float] = {}

        if r_values:
            raw["expectancy"] = sum(r_values) / len(r_values)
            scores["expectancy"] = _linear(raw["expectancy"], -0.5, 0.5)
        if trades:
            raw["win_rate"] = len(wins) / trades
            scores["win_rate"] = _linear(raw["win_rate"], 0.2, 0.7)
        if wins and losses:
            avg_win = sum(wins) / len(wins)
            avg_loss = abs(sum(losses) / len(losses))
            raw["payoff"] = avg_win / avg_loss if avg_loss > 0 else 0.0
            scores["payoff"] = _linear(raw["payoff"], 0.5, 2.5)

        if len(r_values) >= MIN_R_TRADES:
            cumulative = 0.0
            peak = 0.0
            max_dd = 0.0
            for value in r_values:
                cumulative += value
                peak = max(peak, cumulative)
                max_dd = max(max_dd, peak - cumulative)
            raw["drawdown"] = max_dd
            scores["drawdown"] = _clamp(100.0 - max_dd * 20.0)
            raw["recovery"] = (cumulative / max_dd) if max_dd > 0 else (3.0 if cumulative > 0 else 0.0)
            scores["recovery"] = _linear(raw["recovery"], 0.0, 3.0)

        if trades:
            by_day: dict[str, float] = {}
            for row in rows:
                key = self.review._day_key(int(row["close_time"]), server_offset)
                by_day[key] = by_day.get(key, 0.0) + float(row.get("profit") or 0)
            total_abs = sum(abs(value) for value in by_day.values())
            if total_abs > 0:
                raw["concentration"] = max(abs(value) for value in by_day.values()) / total_abs
                # 0.4 以下摊得很散得 100，1.0（全靠一天）得 0
                scores["concentration"] = _clamp((1.0 - raw["concentration"]) / 0.6 * 100.0)

        discipline = self._discipline(login, server_offset, days)
        if discipline is not None:
            raw["discipline"], scores["discipline"] = discipline

        components: list[dict[str, Any]] = []
        total_weight = 0.0
        weighted = 0.0
        for spec in COMPONENTS:
            key = spec["key"]
            included = key in scores
            value = raw.get(key)
            weight = float(spec["weight"])
            if included:
                total_weight += weight
                weighted += scores[key] * weight
            components.append(
                {
                    "key": key,
                    "label": spec["label"],
                    "weight": weight,
                    "unit": spec["unit"],
                    "rule": spec["rule"],
                    "value": round(value, 4) if value is not None else None,
                    "score": round(scores[key], 1) if included else None,
                    "included": included,
                    "reason": None if included else self._reason(key, len(r_values)),
                }
            )

        score = (weighted / total_weight) if total_weight > 0 and trades >= MIN_TRADES else None
        return {
            "version": TALLY_SCORE_VERSION,
            "score": round(score, 1) if score is not None else None,
            "sample": {"trades": trades, "rTrades": len(r_values), "days": days},
            "windowStart": start.strftime("%Y-%m-%d"),
            "windowEnd": today.strftime("%Y-%m-%d"),
            "components": components,
            "note": (
                None
                if score is not None
                else f"区间内只有 {trades} 笔交易，满 {MIN_TRADES} 笔再给总分"
            ),
        }

    def _discipline(
        self, login: int, server_offset: int, days: int
    ) -> tuple[float, float] | None:
        """按「可能评估的规则数」加权合并各策略的遵守率。"""
        try:
            result = self.review.adherence({"days": days}, login, server_offset)
        except Exception:
            return None
        total = 0.0
        weighted = 0.0
        for book in result.get("books", []):
            rate = book.get("rate")
            weight = float(book.get("possible") or 0)
            if rate is None or weight <= 0:
                continue
            weighted += float(rate) * weight
            total += weight
        if total <= 0:
            return None
        rate = weighted / total
        return rate, _clamp(rate * 100.0)

    @staticmethod
    def _reason(key: str, r_trades: int) -> str:
        if key in ("expectancy", "drawdown", "recovery"):
            return f"需要至少 {MIN_R_TRADES} 笔带止损的交易，当前 {r_trades} 笔"
        if key == "discipline":
            return "还没有在策略手册里勾选过规则"
        if key == "payoff":
            return "区间内需要同时有盈利和亏损的交易"
        return "样本不足"
