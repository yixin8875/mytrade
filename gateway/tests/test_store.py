"""存储层新增查询：初始止损映射与入场执行成本。"""

import time

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


def test_integrity_check_reports_ok(tmp_path):
    store = Store(tmp_path)

    result = store.integrity_check()

    assert result["ok"] is True
    assert result["messages"] == ["ok"]


def test_intent_sl_map_keeps_earliest_stop(tmp_path):
    store = Store(tmp_path)
    store.save_intent(_intent(5, 1.0700, 100))
    store.save_intent(_intent(5, 1.0600, 200))
    store.save_intent(_intent(6, None, 100))
    assert store.intent_sl_map(1, [5, 6, 7]) == {5: 1.07}
    assert store.intent_sl_map(2, [5]) == {}


def test_position_risk_keeps_first_record(tmp_path):
    store = Store(tmp_path)
    base = {
        "login": 1,
        "position_id": 9,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry": 1.08,
        "sl": 1.075,
        "source": "position",
    }
    assert store.record_position_risk({**base, "risk": 25.0}) is True
    assert store.record_position_risk({**base, "risk": 99.0}) is False
    assert store.position_risk_map(1, [9]) == {
        9: {
            "risk": 25.0,
            "source": "position",
            "entry": 1.08,
            "sl": 1.075,
            "volume": 0.1,
        }
    }
    assert store.position_risk_map(1, [10]) == {}


def test_journal_risk_is_written_only_when_missing(tmp_path):
    store = Store(tmp_path)
    record = {
        "login": 1,
        "position_id": 9,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.085,
        "profit": 50.0,
        "open_time": 100,
        "close_time": 200,
        "duration_sec": 100,
    }
    store.upsert_journal(record)
    store.journal_set_risks(1, {9: (25.0, "intent")})
    row = store.journal_get(9, 1) or {}
    assert row["risk"] == 25.0
    assert row["risk_source"] == "intent"
    # 后续同步带了别的风险也不覆盖第一条
    store.upsert_journal({**record, "risk": 99.0, "risk_source": "order"})
    row = store.journal_get(9, 1) or {}
    assert row["risk"] == 25.0
    assert row["risk_source"] == "intent"


def test_pre_trade_gate_snapshots_rules_and_is_idempotent(tmp_path):
    store = Store(tmp_path)
    first = store.pre_trade_gate_start(1, "cid", "pb", "confirm", ["A", "B"])

    assert first["state"] == "pending"
    assert first["rules"] == ["A", "B"]
    assert first["position_id"] is None

    second = store.pre_trade_gate_start(1, "cid", "other", "block", ["C"])

    assert second["playbook_id"] == "pb"
    assert second["mode"] == "confirm"
    assert second["rules"] == ["A", "B"]
    assert store.pre_trade_gate_get(2, "cid") is None


def test_pre_trade_checks_preserve_not_applicable(tmp_path):
    store = Store(tmp_path)
    store.pre_trade_gate_start(1, "cid", "pb", "confirm", ["A", "B", "C"])
    store.pre_trade_check_set(1, "cid", "pb", "A", True)
    store.pre_trade_check_set(1, "cid", "pb", "B", None)
    store.pre_trade_check_set(1, "cid", "pb", "C", False)

    checks = store.pre_trade_checks_get(1, "cid")

    assert checks == {"A": True, "B": None, "C": False}
    assert "D" not in checks


def test_pre_trade_gate_state_reason_position_and_reset(tmp_path):
    store = Store(tmp_path)
    store.pre_trade_gate_start(1, "cid", "pb", "confirm", ["A", "B"])
    store.pre_trade_check_set(1, "cid", "pb", "A", True)

    updated = store.pre_trade_gate_update(1, "cid", "overridden", reason="急单")
    assert updated["state"] == "overridden"
    assert updated["reason"] == "急单"

    linked = store.pre_trade_gate_link(1, "cid", 88)
    assert linked["position_id"] == 88
    assert linked["state"] == "overridden"

    reset = store.pre_trade_gate_reset(1, "cid")

    assert reset["state"] == "pending"
    assert reset["reason"] is None
    assert reset["position_id"] == 88
    assert reset["rules"] == ["A", "B"]
    assert store.pre_trade_checks_get(1, "cid") == {}


def test_pre_trade_gate_lookup_by_position_and_window(tmp_path):
    store = Store(tmp_path)
    store.pre_trade_gate_start(1, "a", "pb", "confirm", ["A"])
    store.pre_trade_gate_link(1, "a", 77)
    store.pre_trade_gate_start(1, "b", "pb2", "block", ["B"])
    store.pre_trade_gate_link(1, "b", 77)

    latest = store.pre_trade_gate_for_position(1, 77)
    assert latest["client_id"] == "b"
    assert latest["playbook_id"] == "pb2"
    assert store.pre_trade_gate_for_position(1, 78) is None
    assert store.pre_trade_gate_for_position(2, 77) is None

    gates = store.pre_trade_gates_between(1, 0, 2**31)
    assert [gate["client_id"] for gate in gates] == ["a", "b"]
    assert store.pre_trade_gates_between(1, 2**31, 2**32) == []


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


def test_execution_stats_zero_days_means_all_history(tmp_path):
    store = Store(tmp_path)
    base = {
        "login": 1,
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 0.1,
        "state": "filled",
        "spread_points": 1.0,
        "slippage_points": 0.0,
    }
    # 一笔很老的请求与一笔今天的请求
    store.record_execution({**base, "client_id": "old", "created_at": 1000})
    store.record_execution({**base, "client_id": "new", "created_at": int(time.time())})

    assert store.execution_stats(0, 1)["summary"]["total"] == 2
    assert store.execution_stats(30, 1)["summary"]["total"] == 1


def test_journal_server_offset_persists_and_backfill_is_idempotent(tmp_path):
    store = Store(tmp_path)
    record = {
        "login": 1,
        "position_id": 21,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.085,
        "profit": 50.0,
        "open_time": 100,
        "close_time": 200,
        "duration_sec": 100,
        "server_offset": 7200,
    }
    store.upsert_journal(record)
    assert (store.journal_get(21, 1) or {})["server_offset"] == 7200
    # 之后同步没带上偏移（未知）时，已有值不能被覆盖成 NULL
    store.upsert_journal({**record, "server_offset": None})
    assert (store.journal_get(21, 1) or {})["server_offset"] == 7200
    # 回填只补 NULL 的历史记录
    store.upsert_journal({**record, "position_id": 22, "server_offset": None})
    assert store.journal_backfill_offset(1, 3600) == 1
    assert (store.journal_get(22, 1) or {})["server_offset"] == 3600
    assert (store.journal_get(21, 1) or {})["server_offset"] == 7200
    # 已经全有值时再回填不会改动任何行
    assert store.journal_backfill_offset(1, 1) == 0


def test_journal_list_shares_filters_with_stats(tmp_path):
    store = Store(tmp_path)
    base = {
        "login": 1,
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.09,
        "open_time": 100,
        "close_time": 200,
        "duration_sec": 100,
    }
    store.upsert_journal({**base, "position_id": 1, "symbol": "EURUSD", "tag": "突破", "profit": 10.0})
    store.upsert_journal({**base, "position_id": 2, "symbol": "XAUUSD", "tag": None, "profit": -5.0})
    store.upsert_journal({**base, "position_id": 3, "symbol": "EURUSD", "tag": None, "profit": 3.0})
    store.trade_note_set_reviewed(1, True, login=1)
    store.trade_note_set_reviewed(3, True, login=1)

    def ids(filters=None):
        return {
            row["position_id"]
            for row in store.journal_list(login=1, since=0, filters=filters)
        }

    assert ids() == {1, 2, 3}
    assert ids({"symbol": "EURUSD"}) == {1, 3}
    assert ids({"tag": "突破"}) == {1}
    assert ids({"tag": "未标记"}) == {2, 3}
    assert ids({"result": "win"}) == {1, 3}
    assert ids({"result": "loss"}) == {2}
    assert ids({"reviewed": 1}) == {1, 3}
    assert ids({"reviewed": "0"}) == {2}
    assert ids({"symbol": "EURUSD", "reviewed": 0}) == set()

    # 列表带出 reviewed_at，Journal 才能显示「待复盘」
    reviewed = {row["position_id"]: row["reviewed_at"] for row in store.journal_list(login=1, since=0)}
    assert reviewed[1] is not None
    assert reviewed[2] is None

