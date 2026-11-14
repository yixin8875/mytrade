"""下单计划的清洗与旧格式迁移：分批止盈的入口，出错会直接下错单。"""

import time
import types

import mt5_worker
from mt5_worker import Mt5Worker


class FakeStore:
    """只记录审计与 state，够 plan 相关逻辑使用。"""

    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]

    def payload(self, kind: str) -> dict:
        for item_kind, item_payload in self.audits:
            if item_kind == kind:
                return item_payload  # type: ignore[return-value]
        raise AssertionError(f"missing audit {kind}")


def fake_symbol_info(**over) -> types.SimpleNamespace:
    info = types.SimpleNamespace(
        point=0.01,
        digits=2,
        trade_tick_size=0.01,
        trade_stops_level=0,
        trade_freeze_level=0,
        volume_min=0.01,
        volume_step=0.01,
        volume_max=100.0,
    )
    for key, value in over.items():
        setattr(info, key, value)
    return info


def make_worker(monkeypatch, *, mode: str = "demo", halted: bool = False):
    sent: list[dict] = []

    def order_send(request: dict):
        sent.append(request)
        return types.SimpleNamespace(
            retcode=10009, order=0, deal=0, volume=0.0, price=0.0, comment="ok"
        )

    fake = types.SimpleNamespace(
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_PENDING=5,
        TRADE_ACTION_SLTP=6,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        order_send=order_send,
        last_error=lambda: (0, "ok"),
        symbol_info=lambda symbol: fake_symbol_info(),
        symbol_info_tick=lambda symbol: types.SimpleNamespace(bid=1.2000, ask=1.0000),
        positions_get=lambda **kwargs: (),
        orders_get=lambda **kwargs: (),
        history_orders_get=lambda **kwargs: (),
        history_deals_get=lambda *args, **kwargs: (),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(magic=1, deviation_points=20)
    worker.store = FakeStore()
    worker._loop = None
    worker._connected = True
    worker._account = {"login": 1}
    worker._trade_mode = mode
    worker._halted = {"reason": "manual"} if halted else None
    worker._positions = []
    worker._orders = []
    worker._auto_be = {}
    worker._pending_plans = {}
    worker._auto_be_pause_reason = ""
    return worker, sent


def test_normalize_keeps_valid_steps_sorted_by_r():
    raw = [
        {"atR": 2, "closePercent": 50, "moveBreakeven": True},
        {"atR": 1, "closePercent": None, "moveBreakeven": True},
        {"atR": 1.5, "closePercent": 25, "moveBreakeven": False},
    ]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert [step["atR"] for step in steps] == [1.0, 1.5, 2.0]
    assert steps[0] == {"atR": 1.0, "closePercent": None, "moveBreakeven": True, "done": False}
    assert steps[2]["closePercent"] == 50.0


def test_normalize_rejects_junk_entries():
    raw = [
        "nope",
        None,
        {"atR": "abc"},
        {"atR": 0},
        {"atR": -1},
        {"atR": 101},
        {"closePercent": 50},
    ]
    assert Mt5Worker._normalize_plan_steps(raw) == []


def test_normalize_treats_non_list_as_empty():
    assert Mt5Worker._normalize_plan_steps(None) == []
    assert Mt5Worker._normalize_plan_steps({"atR": 1}) == []


def test_normalize_clamps_close_percent():
    raw = [
        {"atR": 1, "closePercent": 0},
        {"atR": 2, "closePercent": 100},
        {"atR": 3, "closePercent": -5},
        {"atR": 4, "closePercent": "abc"},
        {"atR": 5, "closePercent": "50"},
        {"atR": 6, "closePercent": 99.9},
    ]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert [step["closePercent"] for step in steps] == [None, None, None, None, 50.0, 99.9]


def test_normalize_rounds_r_and_caps_at_eight_steps():
    raw = [{"atR": index + 1 + 0.123456, "closePercent": 10} for index in range(12)]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert len(steps) == 8
    assert steps[0]["atR"] == 1.1235
    assert steps[-1]["atR"] == 8.1235


def test_normalize_coerces_move_breakeven_to_bool():
    steps = Mt5Worker._normalize_plan_steps(
        [
            {"atR": 1, "closePercent": 50, "moveBreakeven": 1},
            {"atR": 2, "closePercent": 50},
            {"atR": 3, "closePercent": 50, "moveBreakeven": "yes"},
        ]
    )
    assert [step["moveBreakeven"] for step in steps] == [True, False, True]


def test_plan_steps_returns_existing_list_untouched():
    plan = {"steps": [{"atR": 1, "closePercent": None, "moveBreakeven": True, "done": True}]}
    steps = Mt5Worker._plan_steps(plan)
    assert steps is plan["steps"]
    assert steps[0]["done"] is True


def test_plan_steps_migrates_legacy_be_r():
    plan = {"beR": 2.5}
    steps = Mt5Worker._plan_steps(plan)
    assert steps == [{"atR": 2.5, "closePercent": None, "moveBreakeven": True, "done": False}]
    assert plan["steps"] is steps


def test_plan_steps_defaults_legacy_be_r():
    assert Mt5Worker._plan_steps({})[0]["atR"] == 1.0
    assert Mt5Worker._plan_steps({"beR": 0})[0]["atR"] == 1.0
    assert Mt5Worker._plan_steps({"beR": "abc"})[0]["atR"] == 1.0


def test_auto_move_breakeven_accepts_position_dict(monkeypatch):
    worker, sent = make_worker(monkeypatch)
    info = fake_symbol_info()
    tick = types.SimpleNamespace(bid=1.2000, ask=1.2002)
    position = {
        "ticket": 7,
        "symbol": "EURUSD",
        "side": "buy",
        "openPrice": 1.1,
        "sl": 1.09,
        "tp": 1.2,
    }
    plan = {"entry": 1.1, "side": "buy"}

    target = worker._auto_move_breakeven(7, plan, position, info, tick)

    assert target == 1.1
    assert sent[-1]["action"] == 6
    assert sent[-1]["symbol"] == "EURUSD"
    assert sent[-1]["position"] == 7
    assert sent[-1]["sl"] == 1.1
    assert sent[-1]["tp"] == 1.2


def test_auto_move_breakeven_sell_side_falls_back_to_open_price(monkeypatch):
    worker, sent = make_worker(monkeypatch)
    info = fake_symbol_info()
    tick = types.SimpleNamespace(bid=1.0002, ask=1.0000)
    position = {
        "ticket": 8,
        "symbol": "EURUSD",
        "side": "sell",
        "openPrice": 1.1,
        "sl": 1.11,
        "tp": None,
    }

    target = worker._auto_move_breakeven(8, {"side": "sell"}, position, info, tick)

    assert target == 1.1
    assert sent[-1]["sl"] == 1.1
    assert sent[-1]["tp"] == 0


def test_auto_move_breakeven_noop_when_already_at_breakeven(monkeypatch):
    worker, sent = make_worker(monkeypatch)
    info = fake_symbol_info()
    tick = types.SimpleNamespace(bid=1.2000, ask=1.2002)
    position = {
        "ticket": 9,
        "symbol": "EURUSD",
        "side": "buy",
        "openPrice": 1.1,
        "sl": 1.1,
        "tp": None,
    }

    assert worker._auto_move_breakeven(9, {"entry": 1.1, "side": "buy"}, position, info, tick) is None
    assert sent == []


def test_auto_breakeven_failure_is_audited_and_retried(monkeypatch):
    worker, sent = make_worker(monkeypatch)
    plan = {
        "entry": 1.1,
        "risk": 0.05,
        "side": "buy",
        "next": 0.0,
        "steps": [
            {"atR": 1.0, "closePercent": 50, "moveBreakeven": True, "done": False},
        ],
    }
    worker._auto_be = {7: plan}
    worker._positions = [
        {
            "ticket": 7,
            "symbol": "EURUSD",
            "side": "buy",
            "openPrice": 1.1,
            "sl": 1.0,
            "tp": None,
        }
    ]

    def boom(*args, **kwargs):
        raise ValueError("bad state")

    worker._auto_move_breakeven = boom
    worker._auto_breakeven()

    payload = worker.store.payload("position.template_step.failed")
    assert payload["ticket"] == 7
    assert payload["type"] == "ValueError"
    assert plan["steps"][0]["done"] is False
    assert plan["next"] > time.monotonic() - 1
    assert sent == []


def plan_with_step(**step) -> dict:
    return {
        "entry": 1.1,
        "risk": 0.05,
        "side": "buy",
        "next": 0.0,
        "steps": [
            {
                "atR": 1.0,
                "closePercent": None,
                "moveBreakeven": False,
                "done": False,
                **step,
            }
        ],
    }


def open_position() -> dict:
    return {
        "ticket": 7,
        "symbol": "EURUSD",
        "side": "buy",
        "openPrice": 1.1,
        "sl": 1.0,
        "tp": None,
    }


def test_auto_breakeven_pauses_in_readonly_without_advancing(monkeypatch):
    worker, sent = make_worker(monkeypatch, mode="readonly")
    plan = plan_with_step()
    worker._auto_be = {7: plan}
    worker._positions = [open_position()]

    worker._auto_breakeven()
    worker._auto_breakeven()

    assert worker.store.kinds().count("position.template_plan.paused") == 1
    assert plan["steps"][0]["done"] is False
    assert sent == []


def test_auto_breakeven_pauses_when_halted(monkeypatch):
    worker, sent = make_worker(monkeypatch, mode="demo", halted=True)
    plan = plan_with_step()
    worker._auto_be = {7: plan}
    worker._positions = [open_position()]

    worker._auto_breakeven()

    assert worker.store.payload("position.template_plan.paused")["reason"] == "halted"
    assert plan["steps"][0]["done"] is False
    assert sent == []


def test_auto_breakeven_resumes_after_mode_change(monkeypatch):
    worker, _ = make_worker(monkeypatch, mode="readonly")
    plan = plan_with_step()
    worker._auto_be = {7: plan}
    worker._positions = [open_position()]

    worker._auto_breakeven()
    worker._trade_mode = "demo"
    worker._auto_breakeven()

    kinds = worker.store.kinds()
    assert kinds.count("position.template_plan.resumed") == 1
    assert plan["steps"][0]["done"] is True


def test_restore_auto_be_resets_monotonic_next():
    raw = {
        "7": {"entry": 1.1, "risk": 0.05, "side": "buy", "next": 9_999_999.0, "steps": []},
        "bad": {"entry": 1.0},
        "8": "junk",
    }
    plans = Mt5Worker._restore_auto_be(raw)
    assert set(plans) == {7}
    assert plans[7]["next"] == 0.0


def test_save_auto_be_drops_next(monkeypatch):
    worker, _ = make_worker(monkeypatch)
    worker._auto_be = {
        7: {"entry": 1.1, "risk": 0.05, "side": "buy", "next": 123.0, "steps": []}
    }

    worker._save_auto_be()

    stored = worker.store.get_state("autoBreakeven")
    assert "next" not in stored["7"]
