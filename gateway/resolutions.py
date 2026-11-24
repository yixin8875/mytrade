"""月线倍数周期（3M / 6M / 12M）的聚合。

MT5 只提供原生 1M 月线，Pine 脚本里的 ``request.security(sym, "3M", ...)``
需要季度线。这里按日历把 1M 聚合成每 n 个月一根，口径与 MT5 原生月线一致：

* 时间取该组第一根 1M 的时间（当前月那根自然是月初第一笔报价）；
* 开盘取第一根、收盘取最后一根，最高/最低取极值，成交量求和。

服务器时间按「墙钟即 UTC」处理，与 ``_history`` 的约定相同。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Sequence

_MONTH_MULTIPLE = re.compile(r"^(\d+)M$")


def month_multiple(resolution: str) -> int | None:
    """``3M``/``6M``/``12M`` 返回月数；``1M`` 与原生周期返回 None。"""
    match = _MONTH_MULTIPLE.fullmatch(str(resolution).strip().upper())
    if not match:
        return None
    months = int(match.group(1))
    return months if months >= 2 else None


def month_bucket(timestamp: int | float, months: int) -> int:
    """把时间归到从公元 1 年 1 月起数的第几个 n 月桶。"""
    moment = datetime.fromtimestamp(int(timestamp), tz=timezone.utc)
    return (moment.year * 12 + moment.month - 1) // months


def aggregate_month_bars(bars: Sequence[Any], months: int) -> list[dict[str, Any]]:
    """把按时间升序的 1M K 线聚合成每 ``months`` 个月一根。

    ``bars`` 里的元素按字符串键取值（dict 或 numpy 结构化行都可以），
    返回与 ``history.get`` 相同的 ``{time,open,high,low,close,volume}`` 列表。
    """
    if months < 2:
        raise ValueError("months 至少为 2")
    out: list[dict[str, Any]] = []
    bucket: int | None = None
    for bar in bars:
        key = month_bucket(bar["time"], months)
        if key != bucket:
            bucket = key
            out.append(
                {
                    "time": int(bar["time"]),
                    "open": float(bar["open"]),
                    "high": float(bar["high"]),
                    "low": float(bar["low"]),
                    "close": float(bar["close"]),
                    "volume": float(bar["volume"]),
                }
            )
            continue
        last = out[-1]
        last["high"] = max(last["high"], float(bar["high"]))
        last["low"] = min(last["low"], float(bar["low"]))
        last["close"] = float(bar["close"])
        last["volume"] += float(bar["volume"])
    return out
