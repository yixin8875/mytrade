"""错过机会：M1 模拟的保守规则与存储接口。"""

import pytest

from missed import Missed, MissedError, simulate
from store import Store


def bar(minute: int, open_: float, high: float, low: float, close: float, base: int = 1793701800):
    return {
        "time": base + minute * 60,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
    }


@pytest.fixture()
def store(tmp_path):
    instance = Store(tmp_path)
    instance.review_setting_set("timezone_offset_min", 0)
    return instance


def test_buy_limit_triggers_then_hits_target():
    bars = [
        bar(1, 100.4, 100.6, 100.1, 100.3),
        bar(2, 100.3, 100.4, 99.9, 100.1),  # 触及 100 入场
        bar(3, 100.1, 103.5, 100.0, 103.2),
        bar(4, 103.2, 104.4, 103.0, 104.2),  # 触及 104 目标
    ]
    result = simulate(bars, "buy", 1793701800, 100.0, 98.0, 104.0, now=1793720000)
    assert result["status"] == "tp"
    assert result["entryPrice"] == 100.0
    assert result["r"] == pytest.approx(2.0)
    assert result["mfeR"] is not None and result["mfeR"] >= 2.0


def test_same_bar_sl_and_tp_prefers_stop():
    bars = [
        bar(1, 100.2, 100.4, 99.8, 100.0),  # 入场
        bar(2, 100.0, 105.0, 97.0, 101.0),  # 同一根同时打到 98 和 104
    ]
    result = simulate(bars, "buy", 1793701800, 100.0, 98.0, 104.0, now=1793720000)
    assert result["status"] == "sl"
    assert result["r"] == pytest.approx(-1.0)


def test_no_entry_when_price_never_reaches_limit():
    bars = [
        bar(1, 101.0, 101.5, 100.4, 101.2),
        bar(2, 101.2, 102.0, 100.8, 101.9),
    ]
    result = simulate(bars, "buy", 1793701800, 100.0, 98.0, 104.0, now=1793720000)
    assert result["status"] == "no_entry"
    assert result["lastPrice"] == pytest.approx(101.9)


def test_sell_side_target_and_no_risk():
    bars = [
        bar(1, 100.0, 100.2, 99.6, 99.8),  # 市价卖出入场
        bar(2, 99.8, 99.9, 98.4, 98.6),
        bar(3, 98.6, 98.7, 97.8, 98.0),  # 触及 98 目标
    ]
    result = simulate(bars, "sell", 1793701800, None, None, 98.0, market=True, now=1793720000)
    assert result["status"] == "tp"
    assert result["r"] is None  # 没有止损就没有 R


def test_open_vs_timeout_by_window_completion():
    bars = [bar(1, 100.0, 100.2, 99.9, 100.1)]
    early = simulate(bars, "buy", 1793701800, 100.0, 98.0, 104.0, market=True, now=1793701860)
    assert early["status"] == "open"
    late = simulate(
        bars, "buy", 1793701800, 100.0, 98.0, 104.0, market=True, now=1793701800 + 4 * 86400
    )
    assert late["status"] == "timeout"


def test_service_saves_lists_and_simulates(store: Store):
    missed = Missed(store)
    saved = missed.save(
        {
            "symbol": "eurusd",
            "side": "buy",
            "observedAt": 1793701800,
            "entryPrice": 100.0,
            "sl": 98.0,
            "tp": 104.0,
            "note": "回踩没等到",
        },
        1,
    )["missed"]
    assert saved["symbol"] == "EURUSD"

    def fetch(symbol: str, start: int, end: int):
        assert symbol == "EURUSD"
        return [
            bar(1, 100.3, 100.5, 99.9, 100.2),
            bar(2, 100.2, 104.2, 100.1, 104.0),
        ]

    result = missed.simulate({"id": saved["id"]}, 1, fetch)["missed"]
    assert result["sim"]["status"] == "tp"

    listing = missed.list({}, 1)
    assert listing["summary"]["total"] == 1
    assert listing["summary"]["hits"] == 1
    assert listing["summary"]["totalR"] == pytest.approx(2.0)

    assert missed.delete({"id": saved["id"]}, 1)["deleted"] is True
    assert missed.list({}, 1)["missed"] == []


def test_validation(store: Store):
    missed = Missed(store)
    with pytest.raises(MissedError):
        missed.save({"symbol": "EURUSD", "side": "hold", "observedAt": 1793701800}, 1)
    with pytest.raises(MissedError):
        missed.save({"symbol": "EURUSD", "side": "buy", "observedAt": 1}, 1)
    with pytest.raises(MissedError):
        missed.save(
            {
                "symbol": "EURUSD",
                "side": "buy",
                "observedAt": 1793701800,
                "playbookId": "missing",
            },
            1,
        )


def test_plan_direction_is_validated(store: Store):
    missed = Missed(store)
    base = {"symbol": "EURUSD", "observedAt": 1793701800}
    with pytest.raises(MissedError) as exc:
        missed.save({**base, "side": "buy", "entryPrice": 100.0, "sl": 101.0}, 1)
    assert exc.value.code == "BAD_PLAN"
    with pytest.raises(MissedError):
        missed.save({**base, "side": "buy", "entryPrice": 100.0, "tp": 99.0}, 1)
    with pytest.raises(MissedError):
        missed.save({**base, "side": "sell", "entryPrice": 100.0, "sl": 99.0}, 1)
    with pytest.raises(MissedError):
        missed.save({**base, "side": "sell", "entryPrice": 100.0, "tp": 101.0}, 1)
    # 方向正确时可以保存
    ok = missed.save(
        {**base, "side": "buy", "entryPrice": 100.0, "sl": 98.0, "tp": 104.0}, 1
    )
    assert ok["missed"]["entryPrice"] == 100.0


def test_market_entry_beyond_target_is_invalid():
    bars = [bar(1, 27929.0, 27935.0, 27920.0, 27930.0)]
    result = simulate(
        bars, "buy", 1793701800, None, 27750.0, 27900.0, market=True, now=1793720000
    )
    assert result["status"] == "invalid"
    assert result.get("r") is None

