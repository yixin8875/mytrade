"""月线倍数周期：纯聚合函数与 history.get / bars.subscribe 的接入。"""

import types
from datetime import datetime, timezone

import pytest

import mt5_worker
from mt5_worker import GatewayError, Mt5Worker
from resolutions import aggregate_month_bars, month_bucket, month_multiple
from worker_base import TIMEFRAMES


def ts(year: int, month: int, day: int = 2) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp())


def bar(t: int, o: float, h: float, l: float, c: float, v: float) -> dict:
    # MT5 行用 tick_volume；aggregate_month_bars 收的是已转换过的 volume
    return {
        "time": t,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "tick_volume": v,
        "volume": v,
    }


# ---------- month_multiple ----------


def test_month_multiple只认两位以上的月线():
    assert month_multiple("3M") == 3
    assert month_multiple("6M") == 6
    assert month_multiple("12M") == 12
    assert month_multiple("3m") == 3
    assert month_multiple(" 12M ") == 12


def test_month_multiple放过原生周期():
    assert month_multiple("1M") is None
    assert month_multiple("1") is None
    assert month_multiple("1D") is None
    assert month_multiple("12") is None
    assert month_multiple("") is None


# ---------- month_bucket ----------


def test_month_bucket按日历分组():
    assert month_bucket(ts(2024, 1), 3) == month_bucket(ts(2024, 3), 3)
    assert month_bucket(ts(2024, 3), 3) != month_bucket(ts(2024, 4), 3)
    # 12M 就是自然年
    assert month_bucket(ts(2024, 1), 12) == month_bucket(ts(2024, 12), 12)
    assert month_bucket(ts(2024, 12), 12) != month_bucket(ts(2025, 1), 12)
    # 6M 跨年：2024-07 与 2024-12 一组，2025-01 换组
    assert month_bucket(ts(2024, 7), 6) == month_bucket(ts(2024, 12), 6)
    assert month_bucket(ts(2024, 12), 6) != month_bucket(ts(2025, 1), 6)


# ---------- aggregate_month_bars ----------


def test_按季度聚合成一根():
    months = [
        bar(ts(2024, 1), 10, 15, 8, 12, 1),
        bar(ts(2024, 2), 12, 20, 11, 18, 2),
        bar(ts(2024, 3), 18, 19, 5, 7, 3),
        bar(ts(2024, 4), 7, 9, 6, 8, 4),
    ]

    out = aggregate_month_bars(months, 3)

    assert out == [
        {"time": ts(2024, 1), "open": 10.0, "high": 20.0, "low": 5.0, "close": 7.0, "volume": 6.0},
        {"time": ts(2024, 4), "open": 7.0, "high": 9.0, "low": 6.0, "close": 8.0, "volume": 4.0},
    ]


def test_首组不完整也照样聚合():
    # 窗口从 2 月开始：2+3 月合成一根，时间取组内第一根
    months = [bar(ts(2024, 2), 12, 20, 11, 18, 2), bar(ts(2024, 3), 18, 19, 5, 7, 3)]

    out = aggregate_month_bars(months, 3)

    assert len(out) == 1
    assert out[0]["time"] == ts(2024, 2)
    assert out[0]["open"] == 12.0
    assert out[0]["close"] == 7.0
    assert out[0]["volume"] == 5.0


def test_空输入返回空列表():
    assert aggregate_month_bars([], 3) == []


def test_月数小于2直接报错():
    with pytest.raises(ValueError):
        aggregate_month_bars([], 1)


# ---------- history.get / bars.subscribe 接入 ----------


class FakeMt5:
    """只提供 _history / _ensure_symbol 用到的接口。"""

    def __init__(self, rates, range_error_before=None):
        self.rates = rates
        self.requests = []
        self.range_requests = []
        # 模拟券商/MT5 对 1970 年附近的起点直接抛 OSError
        self.range_error_before = range_error_before

    def symbol_info(self, name):
        return types.SimpleNamespace(name=name, digits=2, visible=True, description=name)

    def symbol_select(self, name, visible=True):
        return True

    def copy_rates_from_pos(self, symbol, tf, pos, count):
        self.requests.append((symbol, tf, pos, count))
        return self.rates[-count:]

    def copy_rates_range(self, symbol, tf, start, end):
        self.range_requests.append((symbol, tf, start, end))
        if self.range_error_before is not None and start.year < self.range_error_before:
            raise OSError("Invalid argument")
        return self.rates

    def last_error(self):
        return (0, "ok")


def make_worker(monkeypatch, rates, range_error_before=None):
    fake = FakeMt5(rates, range_error_before=range_error_before)
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    w = Mt5Worker.__new__(Mt5Worker)
    w._bar_subs = {}
    return w, fake


MONTH_BARS = [
    bar(ts(2024, 1), 10, 15, 8, 12, 1),
    bar(ts(2024, 2), 12, 20, 11, 18, 2),
    bar(ts(2024, 3), 18, 19, 5, 7, 3),
    bar(ts(2024, 4), 7, 9, 6, 8, 4),
    bar(ts(2024, 5), 8, 11, 7, 9, 5),
    bar(ts(2024, 6), 9, 10, 8, 10, 6),
]


def test_history对3M返回季度线(monkeypatch):
    w, fake = make_worker(monkeypatch, MONTH_BARS)

    result = w._history({"symbol": "XAUUSD", "resolution": "3M", "count": 10})

    assert result["symbol"] == "XAUUSD"
    assert result["resolution"] == "3M"
    assert result["digits"] == 2
    assert result["bars"] == [
        {"time": ts(2024, 1), "open": 10.0, "high": 20.0, "low": 5.0, "close": 7.0, "volume": 6.0},
        {"time": ts(2024, 4), "open": 7.0, "high": 11.0, "low": 6.0, "close": 10.0, "volume": 15.0},
    ]
    # 取的是 1M 月线：count × 3 根
    (symbol, tf, pos, count), = fake.requests
    assert (symbol, pos, count) == ("XAUUSD", 0, 30)
    assert tf == TIMEFRAMES["1M"]


def test_history对12M按自然年聚合(monkeypatch):
    w, _ = make_worker(monkeypatch, MONTH_BARS)

    result = w._history({"symbol": "XAUUSD", "resolution": "12M", "count": 5})

    assert len(result["bars"]) == 1
    assert result["bars"][0]["time"] == ts(2024, 1)
    assert result["bars"][0]["open"] == 10.0
    assert result["bars"][0]["close"] == 10.0


def test_history保留原生1M行为(monkeypatch):
    w, _ = make_worker(monkeypatch, MONTH_BARS)

    result = w._history({"symbol": "XAUUSD", "resolution": "1M", "count": 3})

    # count 下限是 10，假数据只有 6 根 → 原样转换返回，不做聚合
    assert result["bars"] == [
        {
            "time": b["time"],
            "open": float(b["open"]),
            "high": float(b["high"]),
            "low": float(b["low"]),
            "close": float(b["close"]),
            "volume": float(b["volume"]),
        }
        for b in MONTH_BARS
    ]


def test_极早的from被钳到安全下限(monkeypatch):
    # 图表首次加载自定义周期会要几十年的数据；MT5 对 1970 附近起点抛异常
    w, fake = make_worker(monkeypatch, MONTH_BARS, range_error_before=1975)

    result = w._history(
        {
            "symbol": "XAUUSD",
            "resolution": "1M",
            "count": 10,
            "from": -802137600,
            "to": ts(2024, 6, 30),
        }
    )

    assert result["bars"]
    assert fake.range_requests[0][2].year == 1980


def test_只有to时同样钳住过长的回溯窗口(monkeypatch):
    w, fake = make_worker(monkeypatch, MONTH_BARS, range_error_before=1975)

    result = w._history(
        {"symbol": "XAUUSD", "resolution": "1M", "count": 5000, "to": ts(2024, 6, 30)}
    )

    assert result["bars"]
    assert fake.range_requests[0][2].year == 1980


def test_history未知周期仍报错(monkeypatch):
    w, _ = make_worker(monkeypatch, MONTH_BARS)

    with pytest.raises(GatewayError) as exc:
        w._history({"symbol": "XAUUSD", "resolution": "2Y"})

    assert exc.value.code == "BAD_RESOLUTION"


def test_bars_subscribe对月线倍数报仅历史(monkeypatch):
    w, _ = make_worker(monkeypatch, MONTH_BARS)

    with pytest.raises(GatewayError) as exc:
        w._bars_subscribe({"symbol": "XAUUSD", "resolution": "3M"})

    assert exc.value.code == "BAD_RESOLUTION"
    assert "仅支持历史 K 线" in exc.value.message


def test_bars_subscribe原生周期照常(monkeypatch):
    w, _ = make_worker(monkeypatch, MONTH_BARS)

    assert w._bars_subscribe({"symbol": "XAUUSD", "resolution": "1M"}) == {
        "symbol": "XAUUSD",
        "resolution": "1M",
    }
