"""存储层新增查询：初始止损映射与入场执行成本。"""

from store import Store


def _intent(ticket: int, sl: float | None, created_at: int) -> dict:
    return {
        "client_id": f"c{ticket}-{created_at}",
        "login": 1,
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 0.1,
        "price": 1.08,
        "sl": sl,
        "tp": None,
        "state": "filled",
        "ticket": ticket,
        "created_at": created_at,
        "updated_at": created_at,
        "tag": None,
    }


def test_intent_sl_map_keeps_earliest_stop(tmp_path):
    store = Store(tmp_path)
    store.save_intent(_intent(5, 1.0700, 100))
    store.save_intent(_intent(5, 1.0600, 200))
    store.save_intent(_intent(6, None, 100))
    assert store.intent_sl_map(1, [5, 6, 7]) == {5: 1.07}
    assert store.intent_sl_map(2, [5]) == {}


def test_execution_entry_map_uses_first_record_per_ticket(tmp_path):
    store = Store(tmp_path)
    base = {
        "login": 1,
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 0.1,
        "state": "filled",
        "created_at": 1000,
    }
    store.record_execution(
        {**base, "client_id": "a", "ticket": 11, "spread_points": 1.2, "slippage_points": 0.0}
    )
    store.record_execution(
        {**base, "client_id": "b", "ticket": 11, "spread_points": 9.9, "slippage_points": 9.9}
    )
    store.record_execution(
        {**base, "client_id": "c", "ticket": 12, "spread_points": None, "slippage_points": None}
    )
    store.record_execution(
        {**base, "client_id": "d", "ticket": None, "spread_points": 1.0, "slippage_points": 0.0}
    )
    assert store.execution_entry_map(1, 0) == {
        11: {"spread": 1.2, "slippage": 0.0},
        12: {"spread": None, "slippage": None},
    }
