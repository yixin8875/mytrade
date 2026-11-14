"""模板计划：市价票号修正、挂单成交后的登记、撤单/过期清理。"""

import time
import types

import mt5_worker
from mt5_worker import Mt5Worker


class FakeStore:
    """覆盖 _place 与计划持久化需要的 store 接口。"""

    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}
        self.intents: dict[str, dict] = {}
        self.executions: list[dict] = []
        self.risks: list[dict] = []

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def get_intent(self, client_id: str, login: int = 0) -> dict | None:
        return self.intents.get(client_id)

    def save_intent(self, intent: dict) -> None:
        self.intents[intent["client_id"]] = dict(intent)

    def update_intent(
        self, client_id: str, state: str, *, ticket=None, error=None, login: int = 0
    ) -> None:
        intent = self.intents.setdefault(client_id, {"client_id": client_id})
        intent["state"] = state
        if ticket is not None:
            intent["ticket"] = ticket

    def recent_duplicate(self, symbol: str, side: str, price: float, login: int = 0) -> bool:
        return False

    def record_position_risk(self, record: dict) -> bool:
        self.risks.append(record)
        return True

    def record_execution(self, record: dict) -> None:
        self.executions.append(record)

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
        filling_mode=1,
        trade_mode=4,
    )
    for key, value in over.items():
        setattr(info, key, value)
    return info


def make_worker(monkeypatch, *, mode: str = "demo", order: int = 41):
    sent: list[dict] = []

    def order_send(request: dict):
        sent.append(request)
        return types.SimpleNamespace(
            retcode=10009, order=order, deal=0, volume=0.1, price=1.1, comment="ok"
        )

    fake = types.SimpleNamespace(
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_PENDING=5,
        TRADE_ACTION_SLTP=6,
        TRADE_ACTION_MODIFY=3,
        TRADE_ACTION_REMOVE=4,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        ORDER_TYPE_BUY_LIMIT=2,
        ORDER_TYPE_SELL_LIMIT=3,
        ORDER_TYPE_BUY_STOP=4,
        ORDER_TYPE_SELL_STOP=5,
        ORDER_TIME_GTC=0,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
        SYMBOL_TRADE_MODE_DISABLED=0,
        SYMBOL_TRADE_MODE_LONGONLY=1,
        SYMBOL_TRADE_MODE_SHORTONLY=2,
        SYMBOL_TRADE_MODE_CLOSEONLY=3,
        SYMBOL_TRADE_MODE_FULL=4,
        ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2,
        order_send=order_send,
        last_error=lambda: (0, "ok"),
        symbol_info=lambda symbol: fake_symbol_info(),
        symbol_info_tick=lambda symbol: types.SimpleNamespace(bid=1.2000, ask=1.0000),
        positions_get=lambda **kwargs: (),
        orders_get=lambda **kwargs: (),
        history_orders_get=lambda **kwargs: (),
        history_deals_get=lambda *args, **kwargs: (),
        order_calc_profit=lambda *args, **kwargs: 50.0,
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(magic=1, deviation_points=20)
    worker.store = FakeStore()
    worker._loop = None
    worker._connected = True
    worker._account = {"login": 1}
    worker._trade_mode = mode
    worker._halted = None
    worker._limits = {
        "max_lot": 10.0,
        "max_spread_points": 0,
        "max_positions": 100,
        "max_risk_pct": 5.0,
    }
    # 非空即可跳过 _compute_risk（它要读账户与服务器时间）
    worker._risk = {"blockReason": None}
    worker._server_offset = 0
    worker._positions = []
    worker._orders = []
    worker._auto_be = {}
    worker._pending_plans = {}
    worker._auto_be_pause_reason = ""
    worker._risk_tracked = {}
    worker._guard_trade = lambda: {"tradeAllowed": True, "accountType": "demo"}
    worker._poll_risk = lambda force=False: None
    worker._enrich_place_payload = lambda payload, client_id, a: None
    return worker, sent, fake


def analyze_payload(action: int, **over) -> dict:
    payload = {
        "symbol": "EURUSD",
        "side": "buy",
        "type": "market",
        "volume": 0.1,
        "price": 1.1,
        "sl": 1.0,
        "tp": None,
        "action": action,
        "orderType": 0,
        "info": fake_symbol_info(),
        "point": 0.01,
        "spreadPoints": 1.0,
        "riskAmount": 50.0,
        "equity": 10000.0,
        "freeMargin": 9000.0,
        "margin": 100.0,
    }
    payload.update(over)
    return payload


def plan_steps() -> list[dict]:
    return [{"atR": 1.0, "closePercent": 50, "moveBreakeven": True, "done": False}]


def pending_record(**over) -> dict:
    record = {
        "clientId": "mt-abc123",
        "symbol": "EURUSD",
        "side": "buy",
        "sl": 1.0,
        "steps": plan_steps(),
        "placedAt": time.time(),
        "goneAt": None,
        "templateId": "t1",
        "templateName": "默认模板",
    }
    record.update(over)
    return record


def position_payload(ticket: int = 42, comment: str = "mt-abc123-fill", **over) -> dict:
    position = {
        "ticket": ticket,
        "identifier": ticket,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "openPrice": 1.1,
        "sl": 1.0,
        "tp": None,
        "comment": comment,
    }
    position.update(over)
    return position


def test_market_plan_uses_position_ticket(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, order=41)
    worker._analyze = lambda p: analyze_payload(1)

    def enrich(payload, client_id, a):
        payload["ticket"] = 42
        payload["price"] = 1.1

    worker._enrich_place_payload = enrich

    result = worker._place(
        {
            "symbol": "EURUSD",
            "side": "buy",
            "type": "market",
            "volume": 0.1,
            "sl": 1.0,
            "plan": {"steps": plan_steps(), "templateName": "默认模板"},
        }
    )

    assert result["state"] == "filled"
    assert set(worker._auto_be) == {42}
    replaced = worker.store.payload("position.template_plan.ticket_replaced")
    assert replaced == {"order": 41, "position": 42}
    plan = worker.store.payload("position.template_plan.set")
    assert plan["ticket"] == 42
    assert plan["source"] == "market"
    assert worker.store.state["autoBreakeven"]["42"]["steps"][0]["done"] is False


def test_pending_order_records_plan(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._analyze = lambda p: analyze_payload(5, type="limit", price=1.09, orderType=2)

    result = worker._place(
        {
            "symbol": "EURUSD",
            "side": "buy",
            "type": "limit",
            "volume": 0.1,
            "price": 1.09,
            "sl": 1.0,
            "plan": {"steps": plan_steps(), "templateId": "t1"},
        }
    )

    assert result["state"] == "accepted"
    assert worker._auto_be == {}
    record = worker._pending_plans[41]
    assert record["sl"] == 1.0
    assert record["templateId"] == "t1"
    assert record["steps"][0]["atR"] == 1.0
    stored = worker.store.state["pendingTemplatePlans"]["41"]
    assert stored["clientId"].startswith("mt-")
    assert "goneAt" not in stored
    assert worker.store.payload("order.template_plan.pending")["ticket"] == 41


def test_pending_order_without_stop_loss_is_skipped(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._analyze = lambda p: analyze_payload(5, type="limit", price=1.09, sl=None)

    worker._place(
        {
            "symbol": "EURUSD",
            "side": "buy",
            "type": "limit",
            "volume": 0.1,
            "price": 1.09,
            "plan": {"steps": plan_steps()},
        }
    )

    assert worker._pending_plans == {}
    assert worker.store.payload("order.template_plan.skipped")["reason"] == "no-sl"


def test_adopt_registers_plan_when_order_still_working(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._pending_plans[41] = pending_record()
    worker._orders = [{"ticket": 41}]
    worker._positions = [position_payload(7, comment="mt-abc123-fill")]

    worker._adopt_pending_template_plans()

    assert worker._pending_plans == {}
    plan = worker._auto_be[7]
    assert plan["entry"] == 1.1
    assert abs(plan["risk"] - 0.1) < 1e-9
    assert plan["steps"][0]["done"] is False
    assert worker.store.payload("position.template_plan.set")["source"] == "pending"
    assert worker.store.state["pendingTemplatePlans"] == {}


def test_adopt_waits_for_grace_before_history(monkeypatch):
    calls: list[int] = []
    worker, _, fake = make_worker(monkeypatch)

    def history_orders_get(ticket=0, **kwargs):
        calls.append(ticket)
        return ()

    fake.history_orders_get = history_orders_get
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker._pending_plans[41] = pending_record()
    worker._orders = []
    worker._positions = []

    worker._adopt_pending_template_plans()
    assert worker._pending_plans[41]["goneAt"] is not None
    assert calls == []

    worker._pending_plans[41]["goneAt"] = time.time() - 1
    worker._adopt_pending_template_plans()
    assert calls == []
    assert 41 in worker._pending_plans


def test_adopt_matches_position_by_history_position_id(monkeypatch):
    worker, _, fake = make_worker(monkeypatch)
    fake.history_orders_get = lambda ticket=0, **kwargs: (
        types.SimpleNamespace(state=4, position_id=42),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker._pending_plans[41] = pending_record(goneAt=time.time() - 10)
    worker._orders = []
    worker._positions = [position_payload(42, comment="broker-rewritten")]

    worker._adopt_pending_template_plans()

    assert 41 not in worker._pending_plans
    assert 42 in worker._auto_be


def test_adopt_drops_cancelled_history(monkeypatch):
    worker, _, fake = make_worker(monkeypatch)
    fake.history_orders_get = lambda ticket=0, **kwargs: (
        types.SimpleNamespace(state=2, position_id=0),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker._pending_plans[41] = pending_record(goneAt=time.time() - 10)
    worker._orders = []
    worker._positions = []

    worker._adopt_pending_template_plans()

    assert worker._pending_plans == {}
    assert worker.store.payload("order.template_plan.dropped")["reason"] == "cancelled"
    assert worker._auto_be == {}


def test_adopt_replaces_existing_plan_and_audits_netting(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._auto_be[7] = {
        "entry": 1.2,
        "risk": 0.2,
        "side": "buy",
        "steps": plan_steps(),
        "next": 0.0,
    }
    worker._pending_plans[41] = pending_record()
    worker._orders = [{"ticket": 41}]
    worker._positions = [position_payload(7, comment="mt-abc123-fill", openPrice=1.1)]

    worker._adopt_pending_template_plans()

    assert worker._auto_be[7]["entry"] == 1.1
    netting = worker.store.payload("position.template_plan.netting")
    assert netting["replaced"] is True
    assert netting["ticket"] == 7


def test_adopt_drops_plan_when_position_has_no_stop(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._pending_plans[41] = pending_record(sl=0)
    worker._orders = [{"ticket": 41}]
    worker._positions = [position_payload(7, sl=None)]

    worker._adopt_pending_template_plans()

    assert worker._pending_plans == {}
    assert worker._auto_be == {}
    assert worker.store.payload("order.template_plan.dropped")["reason"] == "no-risk"


def test_cancel_order_drops_pending_plan(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    worker._pending_plans[41] = pending_record()
    worker._poll_trade_state = lambda: None

    out = worker._cancel_order({"ticket": 41})

    assert out["retcode"] == 10009
    assert sent[-1]["action"] == 4
    assert worker._pending_plans == {}
    assert worker.store.payload("order.template_plan.dropped")["reason"] == "cancelled"
    assert worker.store.state["pendingTemplatePlans"] == {}


def test_restore_pending_plans_drops_ttl_and_resets_gone_at():
    raw = {
        "1": {"clientId": "a", "placedAt": time.time() - 40 * 86400, "steps": []},
        "2": {"clientId": "b", "placedAt": time.time(), "steps": [], "goneAt": 123.0},
        "x": {"clientId": "c", "placedAt": time.time()},
        "3": "junk",
    }

    plans = Mt5Worker._restore_pending_plans(raw)

    assert set(plans) == {2}
    assert plans[2]["goneAt"] is None


def test_save_pending_plans_omits_gone_at(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._pending_plans[41] = pending_record(goneAt=123.0)

    worker._save_pending_plans()

    stored = worker.store.state["pendingTemplatePlans"]["41"]
    assert "goneAt" not in stored
    assert stored["clientId"] == "mt-abc123"
