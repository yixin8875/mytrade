"""全项目统一的盈亏口径。

MT5 返回的 profit 是浮点数，±0.005 以内视为持平。交易日志、日报、评分和前端
分析都按这个边界，避免同一笔交易在不同页面被算成胜或负。
"""

from __future__ import annotations

WIN_EPSILON = 0.005


def is_win(profit: float) -> bool:
    return profit > WIN_EPSILON


def is_loss(profit: float) -> bool:
    return profit < -WIN_EPSILON
