"""开仓纪律门禁：三档模式、不适用、理由、幂等、审计与失败处理。

用真实 Store（tmp_path）验证落库口径，用最小 fake mt5 验证 order.place
在门禁放行后才会写 intent。
"""

import json
import types

import pytest

import mt5_worker
from mt5_worker import GatewayError, Mt5Worker
from store import Store


def make_worker(
    tmp_path,
    *,
    mode="confirm",
    require_reason=False,
    default_book="",
    login=1,
):
    store = Store(tmp_path)
    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(
        discipline_mode=mode,
        discipline_playbook=default_book,
        discipline_require_reason=require_reason,
        magic=1,
        deviation_points=20,
    )
    worker.store = store
    worker._account = {"login": login}
    return worker, store


def make_book(store, rules=("只在关键位进场", "没有追单"), login=1):
    return store.playbook_save("日内突破", "", list(rules), login=login)


def start(worker, client="cid", playbook_id=None):
    params = {"clientOrderId": client}
    if playbook_id is not None:
        params["playbookId"] = playbook_id
    return worker._discipline_start(params)["gate"]


def mark(worker, gate, values):
    for rule, followed in values.items():
        worker._discipline_check(
            {
                "clientOrderId": gate["clientId"],
                "playbookId": gate["playbookId"],
                "rule": rule,
                "followed": followed,
            }
        )


def all_events(store):
    events = []
    for path in sorted((store.base_dir / "audit").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            events.append(json.loads(line))
    return events


def gate_events(store):
    return [
        record
        for record in all_events(store)
        if str(record.get("kind", "")).startswith("discipline.")
    ]


def event_kinds(store):
    return [record["kind"] for record in all_events(store)]


def event(store, kind):
    """取最近一次同类审计；同一测试里可能有多次 skipped。"""
    found = None
    for record in gate_events(store):
        if record["kind"] == kind:
            found = record["payload"]
    if found is None:
        raise AssertionError(f"missing audit {kind}")
    return found


# ---------- 模式 ----------


def test_off_模式完全跳过门禁(tmp_path):
    worker, store = make_worker(tmp_path, mode="off")

    worker._discipline_gate(1, "cid", {})

    assert store.pre_trade_gate_get(1, "cid") is None
    assert gate_events(store) == []


def test_confirm_全部遵守时放行并记pass(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": True})

    worker._discipline_gate(1, "cid", {})

    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["state"] == "passed"
    payload = event(store, "discipline.pass")
    assert payload["clientId"] == "cid"
    assert payload["playbookId"] == book["id"]
    assert payload["rules"] == 2


def test_confirm_全部不适用也算完成(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": None, "没有追单": None})

    worker._discipline_gate(1, "cid", {})

    assert store.pre_trade_gate_get(1, "cid")["state"] == "passed"
    assert "discipline.pass" in event_kinds(store)


def test_confirm_未评估时需要复核(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True})

    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid", {})
    assert exc.value.code == "DISCIPLINE_INCOMPLETE"
    assert exc.value.detail["missing"] == ["没有追单"]
    assert store.pre_trade_gate_get(1, "cid")["state"] == "pending"
    assert "discipline.incomplete" in event_kinds(store)

    worker._discipline_gate(1, "cid", {"confirmed": True})

    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["state"] == "overridden"
    payload = event(store, "discipline.override")
    assert payload["missing"] == ["没有追单"]
    assert payload["violated"] == []
    assert payload["reason"] is None


def test_confirm_必须填写理由(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm", require_reason=True)
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": False})

    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid", {"confirmed": True})
    assert exc.value.code == "DISCIPLINE_INCOMPLETE"

    worker._discipline_gate(
        1, "cid", {"confirmed": True, "reason": "  这次是计划内加仓  "}
    )

    assert store.pre_trade_gate_get(1, "cid")["reason"] == "这次是计划内加仓"
    assert event(store, "discipline.override")["violated"] == ["没有追单"]


def test_block_未评估直接拒绝(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True})

    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid", {"confirmed": True, "reason": "急单"})

    assert exc.value.code == "DISCIPLINE_BLOCKED"
    assert exc.value.detail["missing"] == ["没有追单"]
    assert store.pre_trade_gate_get(1, "cid")["state"] == "pending"
    assert "discipline.blocked" in event_kinds(store)


def test_block_有违反时必须理由加确认(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": False})

    for payload in ({}, {"confirmed": True}, {"reason": "急单"}):
        with pytest.raises(GatewayError) as exc:
            worker._discipline_gate(1, "cid", payload)
        assert exc.value.code == "DISCIPLINE_BLOCKED"

    worker._discipline_gate(
        1, "cid", {"confirmed": True, "reason": "急单，愿意承担后果"}
    )

    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["state"] == "overridden"
    assert saved["reason"] == "急单，愿意承担后果"
    payload = event(store, "discipline.override")
    assert payload["violated"] == ["没有追单"]
    assert payload["reason"] == "急单，愿意承担后果"


def test_block_无清单或零规则时拒绝(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")
    start(worker)

    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid", {})
    assert exc.value.code == "DISCIPLINE_BLOCKED"
    assert store.pre_trade_gate_get(1, "cid")["state"] == "skipped"
    assert event(store, "discipline.skipped")["reason"] == "no-playbook"

    empty = make_book(store, rules=())
    start(worker, client="cid-2", playbook_id=empty["id"])
    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid-2", {})
    assert exc.value.code == "DISCIPLINE_BLOCKED"
    assert event(store, "discipline.skipped")["reason"] == "no-rules"


def test_confirm_无清单允许但记skipped(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    start(worker)

    worker._discipline_gate(1, "cid", {})

    assert store.pre_trade_gate_get(1, "cid")["state"] == "skipped"
    assert event(store, "discipline.skipped")["reason"] == "no-playbook"
    assert "discipline.pass" not in event_kinds(store)


def test_已放行的同一个client_id重试不再拦(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": True})
    worker._discipline_gate(1, "cid", {})

    # 模拟下单失败后重试：清单已被清空也应直接放行
    store.pre_trade_checks_clear(1, "cid")
    worker._discipline_gate(1, "cid", {})

    assert store.pre_trade_gate_get(1, "cid")["state"] == "passed"
    assert event_kinds(store).count("discipline.pass") == 1


def test_账户覆盖优先于全局(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")
    worker.cfg.discipline_settings = lambda account_id=None: {
        "mode": "confirm",
        "playbook": "",
        "require_reason": False,
    }
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True})

    # 全局是 block：未评估会被拒绝；账户覆盖成 confirm 后勾选复核即可放行
    worker._discipline_gate(1, "cid", {"confirmed": True})

    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["state"] == "overridden"
    assert saved["mode"] == "confirm"


# ---------- 清单接口 ----------


def test_start幂等并保留规则快照(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    first = start(worker, playbook_id=book["id"])
    second = start(worker, playbook_id=book["id"])

    assert second["createdAt"] == first["createdAt"]
    assert second["rules"] == first["rules"]
    assert event_kinds(store).count("discipline.start") == 1

    # 清单后来被编辑，历史 gate 仍显示开单时的规则
    store.playbook_save("日内突破", "", ["新的规则"], 1, book["id"])
    assert (
        worker._discipline_state({"clientOrderId": "cid"})["gate"]["rules"][0]["rule"]
        == "只在关键位进场"
    )


def test_check校验规则与取值(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    start(worker, playbook_id=book["id"])

    with pytest.raises(GatewayError) as exc:
        worker._discipline_check(
            {
                "clientOrderId": "cid",
                "playbookId": book["id"],
                "rule": "不存在",
                "followed": True,
            }
        )
    assert exc.value.code == "BAD_RULE"

    with pytest.raises(GatewayError) as exc:
        worker._discipline_check(
            {
                "clientOrderId": "cid",
                "playbookId": book["id"],
                "rule": "只在关键位进场",
                "followed": "yes",
            }
        )
    assert exc.value.code == "BAD_VALUE"

    with pytest.raises(GatewayError) as exc:
        worker._discipline_check(
            {
                "clientOrderId": "missing",
                "rule": "只在关键位进场",
                "followed": True,
            }
        )
    assert exc.value.code == "NOT_FOUND"

    store.pre_trade_gate_update(1, "cid", "passed")
    with pytest.raises(GatewayError) as exc:
        worker._discipline_check(
            {"clientOrderId": "cid", "rule": "只在关键位进场", "followed": True}
        )
    assert exc.value.code == "CONFLICT"


def test_state断线后恢复勾选(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": None})

    reconnected = make_worker(tmp_path, mode="confirm")[0]
    restored = reconnected._discipline_state({"clientOrderId": "cid"})["gate"]

    assert restored["rules"] == [
        {"rule": "只在关键位进场", "followed": True, "evaluated": True},
        {"rule": "没有追单", "followed": None, "evaluated": True},
    ]
    assert restored["missing"] == []
    assert restored["violated"] == []


def test_reset清空勾选但保留快照(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True})

    reset = worker._discipline_reset({"clientOrderId": "cid"})["gate"]

    assert reset["state"] == "pending"
    assert reset["missing"] == ["只在关键位进场", "没有追单"]
    assert reset["rules"][0]["evaluated"] is False
    assert store.pre_trade_checks_get(1, "cid") == {}
    assert "discipline.reset" in event_kinds(store)


def test_reset不存在的清单返回空(tmp_path):
    worker, _ = make_worker(tmp_path)
    assert worker._discipline_reset({"clientOrderId": "nope"}) == {"gate": None}


def test_成交后回填持仓号(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": True})
    worker._discipline_gate(1, "cid", {})

    worker._discipline_link(1, "cid", 777)

    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["position_id"] == 777
    assert saved["state"] == "passed"


# ---------- 失败处理 ----------


def test_confirm模式读库失败时fail_open并记审计(tmp_path):
    worker, store = make_worker(tmp_path, mode="confirm")

    def boom(*args, **kwargs):
        raise RuntimeError("db locked")

    store.pre_trade_gate_get = boom

    worker._discipline_gate(1, "cid", {})

    payload = event(store, "discipline.error")
    assert "db locked" in payload["error"]


def test_block模式读库失败时fail_closed(tmp_path):
    worker, store = make_worker(tmp_path, mode="block")

    def boom(*args, **kwargs):
        raise RuntimeError("db locked")

    store.pre_trade_gate_get = boom

    with pytest.raises(GatewayError) as exc:
        worker._discipline_gate(1, "cid", {})
    assert exc.value.code == "INTERNAL"
    assert "纪律门禁不可用" in exc.value.message
    assert "discipline.error" in event_kinds(store)


# ---------- order.place 集成 ----------


def analysis(**over):
    base = {
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 1.0,
        "price": 2000.7,
        "sl": 1999.7,
        "tp": None,
        "orderType": 0,
        "action": 1,
        "margin": 100.0,
        "riskAmount": 10.0,
        "rewardAmount": None,
        "rr": None,
        "spreadPoints": 20.0,
        "freeMargin": 5000.0,
        "equity": 10000.0,
        "point": 0.01,
        "info": types.SimpleNamespace(filling_mode=0),
    }
    base.update(over)
    return base


def place_worker(tmp_path, monkeypatch, *, mode="block"):
    worker, store = make_worker(tmp_path, mode=mode)
    worker._connected = True
    worker._trade_mode = "demo"
    worker._positions = []
    worker._orders = []
    worker._limits = {
        "max_lot": 1000.0,
        "max_risk_pct": 100.0,
        "max_positions": 10,
        "max_spread_points": 0,
    }
    worker._risk = None
    worker._risk_tracked = {}
    worker._auto_be = {}
    worker._pending_plans = {}
    worker._guard_trade = lambda: worker._account
    worker._analyze = lambda params: analysis()
    worker._compute_risk = lambda: {"blockReason": ""}
    worker._poll_trade_state = lambda: None
    worker._poll_risk = lambda force=False: None
    worker._enrich_place_payload = lambda payload, client_id, a: None
    worker._record_execution = lambda *args, **kwargs: None
    worker._risk_for = lambda *args: None
    worker._emit = lambda *args: None

    def order_send(request):
        return types.SimpleNamespace(
            retcode=10009,
            order=55,
            deal=56,
            volume=float(request.get("volume") or 0.0),
            price=float(request.get("price") or 0.0),
            comment="ok",
        )

    fake = types.SimpleNamespace(
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_PENDING=5,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        ORDER_TIME_GTC=0,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
        order_send=order_send,
        positions_get=lambda **kwargs: (),
        orders_get=lambda **kwargs: (),
        last_error=lambda: (-1, "x"),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    return worker, store


def order(**over):
    params = {
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 1,
        "clientOrderId": "cid",
    }
    params.update(over)
    return params


def test_place在block未完成时不写intent(tmp_path, monkeypatch):
    worker, store = place_worker(tmp_path, monkeypatch, mode="block")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True})

    with pytest.raises(GatewayError) as exc:
        worker._place(order(discipline={"playbookId": book["id"]}))

    assert exc.value.code == "DISCIPLINE_BLOCKED"
    assert store.get_intent("cid", 1) is None
    assert "order.place.request" not in event_kinds(store)


def test_place门禁放行后正常写intent(tmp_path, monkeypatch):
    worker, store = place_worker(tmp_path, monkeypatch, mode="confirm")
    book = make_book(store)
    gate = start(worker, playbook_id=book["id"])
    mark(worker, gate, {"只在关键位进场": True, "没有追单": True})

    result = worker._place(
        order(discipline={"clientOrderId": "cid", "playbookId": book["id"]})
    )

    assert result["state"] == "filled"
    assert store.get_intent("cid", 1)["state"] == "filled"
    saved = store.pre_trade_gate_get(1, "cid")
    assert saved["state"] == "passed"
    assert saved["position_id"] == 55
