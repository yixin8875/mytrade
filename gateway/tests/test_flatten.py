"""批量撤单与全清：执行顺序、失败隔离、急停复用。"""

import types

import mt5_worker
from mt5_worker import Mt5Worker


class FakeStore:
    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def get_intent(self, client_id: str, login: int = 0) -> None:
        return None

    def update_intent(self, client_id: str, state: str, **fields) -> None:
        pass

    def payload(self, kind: str) -> dict:
        for item_kind, item_payload in self.audits:
            if item_kind == kind:
                return item_payload  # type: ignore[return-value]
        raise AssertionError(f"missing audit {kind}")


def make_worker(monkeypatch, *, orders=None, positions=None):
    orders = list(orders or [])
    positions = list(positions or [])

    def orders_get(ticket=None, **kwargs):
        if ticket is not None:
            return tuple(item for item in orders if item.ticket == ticket)
        return tuple(orders)

    def positions_get(ticket=None, **kwargs):
        if ticket is not None:
            return tuple(item for item in positions if item.ticket == ticket)
        return tuple(positions)

    def order_send(request):
        ticket = int(request.get("order") or 0)
        if ticket == 12:
            return types.SimpleNamespace(
                retcode=10013, order=ticket, deal=0, volume=0, price=0, comment="bad"
            )
        orders[:] = [item for item in orders if item.ticket != ticket]
        return types.SimpleNamespace(
            retcode=10009, order=ticket, deal=0, volume=0, price=0, comment="ok"
        )

    fake = types.SimpleNamespace(
        TRADE_ACTION_REMOVE=4,
        TRADE_ACTION_DEAL=1,
        orders_get=orders_get,
        positions_get=positions_get,
        order_send=order_send,
        last_error=lambda: (0, "ok"),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(magic=1, deviation_points=20)
    worker.store = FakeStore()
    worker._connected = True
    worker._account = {"login": 1}
    worker._trade_mode = "demo"
    worker._positions = []
    worker._orders = []
    worker._pending_plans = {}
    worker._risk = {"blockReason": None}
    worker._guard_trade = lambda: {"tradeAllowed": True, "accountType": "demo"}
    worker._login = lambda: 1
    worker._poll_trade_state = lambda: None
    worker._poll_risk = lambda force=False: None
    worker._emit = lambda *args: None
    worker.health = lambda: {}
    return worker, orders, positions


def order(ticket: int, symbol: str = "XAUUSD"):
    return types.SimpleNamespace(ticket=ticket, symbol=symbol, comment="")


def test_cancel_all_cancels_every_order(monkeypatch):
    worker, orders, _ = make_worker(
        monkeypatch, orders=[order(11), order(13, "EURUSD")]
    )

    out = worker._cancel_all_orders({})

    assert out["remaining"] == 0
    assert out["results"] == [{"ticket": 11}, {"ticket": 13}]
    assert worker.store.payload("order.cancelAll")["cancelled"] == 2
    assert orders == []


def test_cancel_all_keeps_going_after_one_failure(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, orders=[order(11), order(12), order(13)]
    )

    out = worker._cancel_all_orders({})

    assert out["remaining"] == 1
    assert [item.get("ticket") for item in out["results"]] == [11, 12, 13]
    assert out["results"][1]["error"]
    audit = worker.store.payload("order.cancelAll")
    assert audit["cancelled"] == 2
    assert audit["remaining"] == 1
    assert audit["failed"][0]["ticket"] == 12


def test_cancel_all_filters_by_symbol(monkeypatch):
    worker, orders, _ = make_worker(
        monkeypatch, orders=[order(11), order(13, "EURUSD")]
    )

    out = worker._cancel_all_orders({"symbol": "EURUSD"})

    assert out["results"] == [{"ticket": 13}]
    assert [item.ticket for item in orders] == [11]


def test_flatten_cancels_before_closing(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    events = []
    worker._cancel_all_orders = lambda p: (
        events.append(("cancel", p)) or {"results": [{"ticket": 11}]}
    )
    worker._close_all = lambda p: (
        events.append(("close", p)) or {"results": [{"ticket": 101}]}
    )

    out = worker._flatten({})

    assert events == [("cancel", {"symbol": None}), ("close", {"symbol": None})]
    assert out == {
        "cancelled": [{"ticket": 11}],
        "closed": [{"ticket": 101}],
        "remaining": {"positions": 0, "orders": 0},
    }
    assert worker.store.payload("trade.flatten")["closed"] == 1


def test_flatten_reports_remaining_from_latest_snapshot(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        positions=[types.SimpleNamespace(ticket=101, symbol="XAUUSD")],
    )
    worker._cancel_all_orders = lambda p: {
        "results": [{"ticket": 11, "error": "拒单"}]
    }
    worker._close_all = lambda p: {"results": [{"ticket": 102}]}

    out = worker._flatten({})

    assert out["remaining"] == {"positions": 1, "orders": 0}
    assert worker.store.payload("trade.flatten")["failed"] == [
        {"ticket": 11, "error": "拒单"}
    ]


def test_halt_reuses_flatten_and_returns_cancelled(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._flatten = lambda p: {
        "cancelled": [{"ticket": 11}],
        "closed": [{"ticket": 101}],
        "remaining": {"positions": 0, "orders": 0},
    }

    out = worker._halt({"reason": "手动急停", "closeAll": True})

    assert out["halted"] is True
    assert out["closed"] == [{"ticket": 101}]
    assert out["cancelled"] == [{"ticket": 11}]
    assert worker.store.state["halted"]["reason"] == "手动急停"
