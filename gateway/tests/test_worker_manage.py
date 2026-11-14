"""挂单/持仓管理：改单、撤单、保本、移动止损、平仓与重启对账。"""

import types
from pathlib import Path

import pytest

import mt5_worker
from mt5_worker import GatewayError, Mt5Worker

LIMITS = {
    "max_lot": 1000.0,
    "max_risk_pct": 1.0,
    "max_positions": 3,
    "daily_loss_pct": 2.0,
    "max_trades_per_day": 8,
    "max_consecutive_losses": 3,
    "cooldown_minutes": 30,
    "max_spread_points": 0,
}


def symbol_info(**over):
    base = dict(
        name="EURUSD",
        description="Euro vs US Dollar",
        point=0.01,
        digits=2,
        trade_tick_size=0.01,
        trade_tick_value=1.0,
        trade_contract_size=100000.0,
        volume_min=0.01,
        volume_max=100.0,
        volume_step=0.01,
        trade_stops_level=0,
        trade_freeze_level=0,
        spread=20,
        trade_mode=4,
        filling_mode=0,
        visible=True,
        currency_profit="USD",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


def tick(bid=2000.5, ask=2000.7):
    return types.SimpleNamespace(bid=bid, ask=ask)


def position(**over):
    base = dict(
        ticket=1,
        symbol="EURUSD",
        type=0,
        volume=1.0,
        price_open=2000.0,
        sl=0.0,
        tp=0.0,
        comment="",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


def pending_order(**over):
    base = dict(
        ticket=5,
        symbol="EURUSD",
        type=2,
        price_open=1999.0,
        sl=1998.0,
        tp=2002.0,
        comment="",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


class FakeStore:
    def __init__(self) -> None:
        self.base_dir = Path("C:/data")
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}
        self.intents: dict[str, dict] = {}
        self.updates: list[tuple[str, str, dict]] = []
        self.risks_rows: list[dict] = []

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0):
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def get_intent(self, client_id: str, login: int = 0):
        return self.intents.get(client_id)

    def update_intent(self, client_id: str, state: str, **fields) -> None:
        self.updates.append((client_id, state, fields))

    def record_position_risk(self, row: dict) -> None:
        self.risks_rows.append(row)

    def recent_intents(self, limit: int, login: int = 0):
        return self.intents.get("_recent", [])

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]


def install(monkeypatch, *, orders=(), positions=(), quote=None, info=None, deals=()):
    """安装最小 MT5 假实现：全平后持仓消失，部分平仓时保留。"""
    state = {"closed": False, "sent": [], "deals_error": False, "deal_price": None}
    info = symbol_info() if info is None else info
    quote = tick() if quote is None else quote
    orders = tuple(orders)
    positions = tuple(positions)

    def order_send(request: dict):
        state["sent"].append(request)
        if request.get("action") == 1 and request.get("position"):
            target = next(
                (p for p in positions if p.ticket == request["position"]), None
            )
            if target is None or request["volume"] >= float(target.volume) - 1e-9:
                state["closed"] = True
        price = state["deal_price"]
        if price is None:
            price = float(request.get("price") or 0.0)
        return types.SimpleNamespace(
            retcode=10009,
            order=request.get("order") or request.get("position") or 0,
            deal=9,
            volume=float(request.get("volume") or 0.0),
            price=price,
            comment="ok",
        )

    def orders_get(**kwargs):
        ticket = kwargs.get("ticket")
        if not ticket:
            return orders
        return tuple(order for order in orders if order.ticket == ticket)

    def positions_get(**kwargs):
        if state["closed"]:
            return ()
        ticket = kwargs.get("ticket")
        if not ticket:
            return positions
        return tuple(pos for pos in positions if pos.ticket == ticket)

    def history_deals_get(*args, **kwargs):
        if state["deals_error"]:
            raise RuntimeError("history unavailable")
        return deals

    fake = types.SimpleNamespace(
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_PENDING=5,
        TRADE_ACTION_SLTP=6,
        TRADE_ACTION_MODIFY=7,
        TRADE_ACTION_REMOVE=8,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
        ORDER_TIME_GTC=0,
        order_send=order_send,
        orders_get=orders_get,
        positions_get=positions_get,
        symbol_info=lambda name: info,
        symbol_select=lambda name, enable=True: True,
        symbol_info_tick=lambda name: quote,
        order_calc_profit=lambda *args: -100.0,
        history_deals_get=history_deals_get,
        last_error=lambda: (-1, "boom"),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    monkeypatch.setattr(mt5_worker.time, "sleep", lambda seconds: None)
    return fake, state


@pytest.fixture()
def make(monkeypatch, tmp_path):
    def build(**over):
        fake, state = install(monkeypatch, **over)
        worker = Mt5Worker.__new__(Mt5Worker)
        worker.cfg = types.SimpleNamespace(
            magic=1, deviation_points=20, trailing_step_points=10
        )
        worker.store = FakeStore()
        worker._publish = lambda *args: None
        worker._emit = lambda *args: None
        worker._loop = None
        worker._account_id = "a"
        worker._connected = True
        worker._account = {
            "login": 111,
            "balance": 10000.0,
            "equity": 10000.0,
            "accountType": "demo",
            "tradeAllowed": True,
        }
        worker._positions = []
        worker._orders = []
        worker._limits = dict(LIMITS)
        worker._trade_mode = "demo"
        worker._risk = None
        worker._risk_tracked = {}
        worker._trailing = {}
        worker._trail_next = {}
        worker._auto_be = {}
        worker._pending_plans = {}
        worker._subs = {}
        worker._bar_subs = {}
        worker._guard_trade = lambda: worker._account
        worker._poll_trade_state = lambda: None
        worker._poll_risk = lambda force=False: None
        worker._save_pending_plans = lambda: None
        worker._save_trailing = lambda: None
        return worker, fake, state

    return build


def code_for(call) -> str:
    with pytest.raises(GatewayError) as exc:
        call()
    return exc.value.code


# ---------- 结果处理 ----------


def test_空结果报发送失败(make):
    worker, _, _ = make()

    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(None, "order.modify")
    assert exc.value.code == "SEND_FAILED"
    assert "order.modify 失败" in exc.value.message
    assert "boom" in exc.value.message


def test_成功结果写审计并返回载荷(make):
    worker, _, _ = make()
    result = types.SimpleNamespace(
        retcode=10009, order=7, deal=8, volume=0.5, price=2000.0, comment="ok"
    )

    payload = worker._result_or_raise(result, "position.close")

    assert payload == {
        "retcode": 10009,
        "order": 7,
        "deal": 8,
        "volume": 0.5,
        "price": 2000.0,
        "comment": "ok",
    }
    assert worker.store.audits == [("position.close.result", payload)]


def test_被拒绝时抛出retcode错误(make):
    worker, _, _ = make()
    result = types.SimpleNamespace(
        retcode=10016, order=0, deal=0, volume=0.0, price=0.0, comment=""
    )

    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(result, "order.modify")

    assert exc.value.code == "RET_10016"
    assert "止损/止盈" in exc.value.message
    assert exc.value.detail["retcode"] == 10016
    assert worker.store.kinds() == ["order.modify.result"]


def test_未知retcode用券商注释(make):
    worker, _, _ = make()
    result = types.SimpleNamespace(
        retcode=99999, order=0, deal=0, volume=0.0, price=0.0, comment="custom"
    )

    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(result, "order.cancel")
    assert exc.value.message == "custom"

    result.comment = ""
    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(result, "order.cancel")
    assert exc.value.message == "请求被拒绝"


def test_补全回调只在成功时执行且异常被吞掉(make):
    worker, _, _ = make()
    calls = []

    def enrich(payload):
        calls.append(dict(payload))
        payload["price"] = 2001.0
        raise RuntimeError("补充失败")

    ok = types.SimpleNamespace(
        retcode=10009, order=1, deal=1, volume=1.0, price=0.0, comment=""
    )
    payload = worker._result_or_raise(ok, "position.close", enrich)

    assert calls == [
        {
            "retcode": 10009,
            "order": 1,
            "deal": 1,
            "volume": 1.0,
            "price": 0.0,
            "comment": "",
        }
    ]
    assert payload["price"] == 2001.0

    bad = types.SimpleNamespace(
        retcode=10016, order=0, deal=0, volume=0.0, price=0.0, comment=""
    )
    with pytest.raises(GatewayError):
        worker._result_or_raise(bad, "position.close", enrich)
    assert len(calls) == 1


def test_成交价缺失时从历史成交补全(make):
    worker, _, _ = make()
    deal = types.SimpleNamespace(price=2001.25, ticket=77)
    mt5_worker.mt5 = types.SimpleNamespace(
        history_deals_get=lambda *args, **kwargs: [deal]
    )

    payload = {"price": 0.0, "deal": 0}
    worker._fill_deal_price(payload, 1)

    assert payload == {"price": 2001.25, "deal": 77}


def test_已有成交价时不查历史(make):
    worker, _, _ = make()
    calls = []
    mt5_worker.mt5 = types.SimpleNamespace(
        history_deals_get=lambda *args, **kwargs: calls.append(1) or []
    )

    payload = {"price": 1999.0, "deal": 3}
    worker._fill_deal_price(payload, 1)

    assert payload == {"price": 1999.0, "deal": 3}
    assert calls == []


# ---------- 改单 ----------


def test_改单找不到挂单(make):
    worker, _, _ = make()

    assert code_for(lambda: worker._modify_order({"ticket": 5})) == "NO_ORDER"


def test_改单缺省沿用原价与止损(make):
    worker, _, state = make(orders=[pending_order()])

    worker._modify_order({"ticket": 5})

    request = state["sent"][0]
    assert request["action"] == 7
    assert request["order"] == 5
    assert request["symbol"] == "EURUSD"
    assert request["price"] == pytest.approx(1999.0)
    assert request["sl"] == pytest.approx(1998.0)
    assert request["tp"] == pytest.approx(2002.0)
    assert request["magic"] == 1
    assert request["type_time"] == 0
    assert request["expiration"] == 0
    assert worker.store.kinds() == ["order.modify.result"]


def test_改单使用传入价格并校验(make):
    worker, _, state = make(orders=[pending_order()])

    out = worker._modify_order(
        {"ticket": 5, "price": 1998.567, "sl": 1997.111, "tp": 2003.999}
    )

    request = state["sent"][0]
    assert request["price"] == pytest.approx(1998.57)
    assert request["sl"] == pytest.approx(1997.11)
    assert request["tp"] == pytest.approx(2004.0)
    assert out["retcode"] == 10009


def test_改单被拒绝时抛错(make):
    worker, _, state = make(orders=[pending_order()])
    mt5_worker.mt5.order_send = lambda request: types.SimpleNamespace(
        retcode=10013, order=0, deal=0, volume=0.0, price=0.0, comment=""
    )

    assert code_for(lambda: worker._modify_order({"ticket": 5})) == "RET_10013"
    assert state["sent"] == []


# ---------- 撤单 ----------


def test_撤单不存在的挂单也会发请求(make):
    worker, _, state = make()

    worker._cancel_order({"ticket": 5})

    assert state["sent"] == [{"action": 8, "order": 5}]
    assert worker.store.updates == []
    assert worker.store.audits == [
        (
            "order.cancel.result",
            {
                "retcode": 10009,
                "order": 5,
                "deal": 9,
                "volume": 0.0,
                "price": 0.0,
                "comment": "ok",
            },
        )
    ]


def test_撤单更新意图并丢弃模板计划(make):
    worker, _, _ = make(orders=[pending_order(comment="cid-12345678901234567890")])
    worker.store.intents["cid-12345678901234567890"] = {"state": "accepted"}
    worker._pending_plans = {5: {"steps": []}}
    saved = []
    worker._save_pending_plans = lambda: saved.append(1)

    worker._cancel_order({"ticket": 5})

    assert (
        "cid-12345678901234567890",
        "cancelled",
        {"login": 111},
    ) in worker.store.updates
    assert worker._pending_plans == {}
    assert saved == [1]
    assert (
        "order.template_plan.dropped",
        {"ticket": 5, "reason": "cancelled"},
    ) in worker.store.audits


def test_撤单注释无对应意图时只撤单(make):
    worker, _, _ = make(orders=[pending_order(comment="other")])

    worker._cancel_order({"ticket": 5})

    assert worker.store.updates == []


def test_撤单被拒绝时抛错(make):
    worker, _, _ = make(orders=[pending_order()])
    mt5_worker.mt5.order_send = lambda request: types.SimpleNamespace(
        retcode=10013, order=0, deal=0, volume=0.0, price=0.0, comment=""
    )

    assert code_for(lambda: worker._cancel_order({"ticket": 5})) == "RET_10013"
    assert worker.store.updates == []


# ---------- 改持仓 ----------


def test_改持仓找不到持仓(make):
    worker, _, _ = make()

    assert code_for(lambda: worker._modify_position({"ticket": 1})) == "NO_POSITION"


def test_改持仓缺省沿用原止损止盈(make):
    worker, _, state = make(positions=[position(sl=1990.0, tp=2010.0)])

    worker._modify_position({"ticket": 1})

    request = state["sent"][0]
    assert request["action"] == 6
    assert request["position"] == 1
    assert request["sl"] == pytest.approx(1990.0)
    assert request["tp"] == pytest.approx(2010.0)
    assert worker.store.risks_rows == []
    assert worker.store.kinds() == ["position.modify.result"]


def test_补止损时记录初始风险(make):
    worker, _, _ = make(positions=[position(sl=0.0)])

    worker._modify_position({"ticket": 1, "sl": 1990.0, "tp": 2010.0})

    row = worker.store.risks_rows[0]
    assert row == {
        "login": 111,
        "position_id": 1,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 1.0,
        "entry": 2000.0,
        "sl": 1990.0,
        "risk": 100.0,
        "source": "position",
    }
    assert worker._risk_tracked == {1: 1990.0}


def test_已有止损或已记录风险时不重复记录(make):
    worker, _, _ = make(positions=[position(sl=1995.0)])
    worker._modify_position({"ticket": 1, "sl": 1990.0})
    assert worker.store.risks_rows == []

    worker2, _, _ = make(positions=[position(sl=0.0)])
    worker2._risk_tracked = {1: 1992.0}
    worker2._modify_position({"ticket": 1, "sl": 1990.0})
    assert worker2.store.risks_rows == []


def test_空头补止损记录卖出方向(make):
    worker, _, _ = make(positions=[position(type=1, sl=0.0)])

    worker._modify_position({"ticket": 1, "sl": 2010.0})

    assert worker.store.risks_rows[0]["side"] == "sell"


# ---------- 保本 ----------


def test_保本找不到持仓(make):
    worker, _, _ = make()

    assert code_for(lambda: worker._breakeven({"ticket": 1})) == "NO_POSITION"


def test_无报价时不能保本(make):
    worker, _, _ = make(positions=[position()])
    mt5_worker.mt5.symbol_info_tick = lambda name: None

    assert code_for(lambda: worker._breakeven({"ticket": 1})) == "NO_QUOTE"


def test_多头保本按开仓价加偏移(make):
    worker, _, state = make(positions=[position(price_open=2000.0)])

    out = worker._breakeven({"ticket": 1, "offsetPoints": 10})

    request = state["sent"][0]
    assert request["action"] == 6
    assert request["sl"] == pytest.approx(2000.1)
    assert request["tp"] == pytest.approx(0.0)
    assert out["changed"] is True
    assert out["sl"] == pytest.approx(2000.1)


def test_保本止损与现价保持最小距离(make):
    worker, _, state = make(
        positions=[position(price_open=2000.0)], quote=tick(bid=2000.02, ask=2000.04)
    )

    out = worker._breakeven({"ticket": 1})

    assert state["sent"][0]["sl"] == pytest.approx(1999.96)
    assert out["sl"] == pytest.approx(1999.96)


def test_空头保本按开仓价减偏移(make):
    worker, _, state = make(
        positions=[position(type=1, price_open=2000.0)],
        quote=tick(bid=2000.5, ask=2000.7),
    )

    worker._breakeven({"ticket": 1, "offsetPoints": 10})

    assert state["sent"][0]["sl"] == pytest.approx(2000.76)


def test_已有更优止损时不改单(make):
    worker, _, state = make(positions=[position(sl=2000.2)])

    out = worker._breakeven({"ticket": 1})

    assert out == {"ticket": 1, "sl": 2000.2, "changed": False}
    assert state["sent"] == []


def test_空头已有更低止损时不改单(make):
    worker, _, state = make(positions=[position(type=1, sl=1999.0)])

    out = worker._breakeven({"ticket": 1})

    assert out["changed"] is False
    assert state["sent"] == []


def test_保本使用券商的stops_level(make):
    worker, _, state = make(
        positions=[position()],
        info=symbol_info(trade_stops_level=20),
        quote=tick(bid=2000.1, ask=2000.12),
    )

    worker._breakeven({"ticket": 1})

    # (20 + 5) 个点 = 0.25，目标被压到现价下方
    assert state["sent"][0]["sl"] == pytest.approx(1999.85)


# ---------- 移动止损 ----------


def test_设置移动止损找不到持仓(make):
    worker, _, _ = make()

    assert (
        code_for(lambda: worker._set_trailing({"ticket": 1, "distancePoints": 20}))
        == "NO_POSITION"
    )


def test_移动止损距离必须大于零(make):
    worker, _, _ = make(positions=[position()])

    assert (
        code_for(lambda: worker._set_trailing({"ticket": 1, "distancePoints": 0}))
        == "BAD_TRAILING"
    )


def test_移动止损距离有最小值(make):
    worker, _, _ = make(positions=[position()])
    worker._save_trailing = lambda: worker.store.set_state(
        "trailing",
        {str(k): v for k, v in worker._trailing.items()},
        worker._login(),
    )

    out = worker._set_trailing({"ticket": 1, "distancePoints": 1})

    assert out["distancePoints"] == 3.0
    assert out["stepPoints"] == 10.0
    assert worker._trailing[1]["distancePoints"] == 3.0
    assert worker.store.get_state("trailing", 111) == {
        "1": {
            "distancePoints": 3.0,
            "stepPoints": 10.0,
            "activatedAt": out["activatedAt"],
        }
    }
    assert (
        "position.trailing.set",
        {"ticket": 1, **worker._trailing[1]},
    ) in worker.store.audits


def test_移动止损遵循券商stops_level(make):
    worker, _, _ = make(positions=[position()], info=symbol_info(trade_stops_level=15))

    out = worker._set_trailing({"ticket": 1, "distancePoints": 10})

    assert out["distancePoints"] == 17.0


def test_移动止损步长不能为负(make):
    worker, _, _ = make(positions=[position()])

    out = worker._set_trailing({"ticket": 1, "distancePoints": 20, "stepPoints": -5})

    assert out["stepPoints"] == 0.0


def test_清除移动止损(make):
    worker, _, _ = make()
    worker._trailing = {1: {"distancePoints": 20.0, "stepPoints": 5.0}}
    saved = []
    worker._save_trailing = lambda: saved.append(1)

    out = worker._clear_trailing({"ticket": 1})

    assert out == {"ticket": 1, "cleared": True}
    assert worker._trailing == {}
    assert saved == [1]
    assert ("position.trailing.clear", {"ticket": 1}) in worker.store.audits


def test_清除不存在的移动止损(make):
    worker, _, _ = make()

    out = worker._clear_trailing({"ticket": 1})

    assert out == {"ticket": 1, "cleared": False}
    assert worker.store.audits == []


# ---------- 平仓 ----------


def test_平仓找不到持仓(make):
    worker, _, _ = make()

    assert code_for(lambda: worker._close_position({"ticket": 1})) == "NO_POSITION"


def test_平仓无报价(make):
    worker, _, _ = make(positions=[position()])
    mt5_worker.mt5.symbol_info_tick = lambda name: None

    assert code_for(lambda: worker._close_position({"ticket": 1})) == "NO_QUOTE"


def test_平仓手数无效(make):
    worker, _, _ = make(positions=[position(volume=1.0)])

    assert (
        code_for(lambda: worker._close_position({"ticket": 1, "volume": 0}))
        == "BAD_VOLUME"
    )
    assert (
        code_for(lambda: worker._close_position({"ticket": 1, "volume": 2}))
        == "BAD_VOLUME"
    )


def test_多头按买价平仓(make):
    worker, _, state = make(positions=[position(type=0)])

    out = worker._close_position({"ticket": 1})

    request = state["sent"][0]
    assert request["action"] == 1
    assert request["type"] == 1
    assert request["price"] == pytest.approx(2000.5)
    assert request["position"] == 1
    assert request["volume"] == pytest.approx(1.0)
    assert request["comment"] == "close"
    assert request["type_filling"] == 2
    assert out["retcode"] == 10009


def test_空头按卖价平仓(make):
    worker, _, state = make(positions=[position(type=1)])

    worker._close_position({"ticket": 1})

    request = state["sent"][0]
    assert request["type"] == 0
    assert request["price"] == pytest.approx(2000.7)


def test_部分平仓后把剩余仓位移到保本(make):
    worker, _, state = make(positions=[position(volume=1.0)])
    calls = []
    worker._breakeven = lambda p: calls.append(p) or {"ticket": 1, "sl": 2000.0}

    out = worker._close_position(
        {"ticket": 1, "volume": 0.5, "moveToBe": True, "beOffsetPoints": 2}
    )

    assert calls == [{"ticket": 1, "offsetPoints": 2}]
    assert out["breakeven"] == {"ticket": 1, "sl": 2000.0}
    assert state["closed"] is False


def test_部分平仓保本失败不影响平仓结果(make):
    worker, _, _ = make(positions=[position(volume=1.0)])

    def fail(payload):
        raise GatewayError("NO_QUOTE", "当前无报价，无法设置保本")

    worker._breakeven = fail

    out = worker._close_position({"ticket": 1, "volume": 0.5, "moveToBe": True})

    assert out["breakeven"] == {"error": "当前无报价，无法设置保本"}


def test_平掉全部仓位时更新意图(make):
    worker, _, _ = make(positions=[position(comment="cid-1")])
    worker.store.intents["cid-1"] = {"state": "filled"}

    worker._close_position({"ticket": 1})

    assert ("cid-1", "closed", {"login": 111}) in worker.store.updates


def test_平仓结果价格为0时从历史补全(make):
    worker, _, state = make(positions=[position()])
    state["deal_price"] = 0.0
    mt5_worker.mt5.history_deals_get = lambda *args, **kwargs: [
        types.SimpleNamespace(price=2001.25, ticket=77)
    ]

    out = worker._close_position({"ticket": 1})

    assert out["price"] == pytest.approx(2001.25)


def test_全部平仓按品种过滤并收集错误(make):
    worker, _, _ = make()
    worker._positions = [
        {"ticket": 1, "symbol": "EURUSD"},
        {"ticket": 2, "symbol": "GBPUSD"},
        {"ticket": 3, "symbol": "EURUSD"},
    ]
    calls = []

    def close(p):
        calls.append(p["ticket"])
        if p["ticket"] == 3:
            raise GatewayError("NO_QUOTE", "无报价")
        return {"ticket": p["ticket"], "retcode": 10009}

    worker._close_position = close

    out = worker._close_all({"symbol": "EURUSD"})

    assert calls == [1, 3]
    assert out == {
        "results": [
            {"ticket": 1, "retcode": 10009},
            {"ticket": 3, "error": "无报价"},
        ]
    }


def test_全部平仓不传品种时平所有(make):
    worker, _, _ = make()
    worker._positions = [
        {"ticket": 1, "symbol": "EURUSD"},
        {"ticket": 2, "symbol": "GBPUSD"},
    ]
    worker._close_position = lambda p: {"ticket": p["ticket"]}

    out = worker._close_all({})

    assert [item["ticket"] for item in out["results"]] == [1, 2]


# ---------- 对账 ----------


def test_对账纠正发送中与未知意图(make):
    worker, _, _ = make()
    worker.store.intents["_recent"] = [
        {"client_id": "cid-order", "state": "sending"},
        {"client_id": "cid-position", "state": "unknown"},
        {"client_id": "cid-deal", "state": "sending"},
        {"client_id": "cid-missing", "state": "sending"},
        {"client_id": "cid-done", "state": "filled"},
    ]
    worker._orders = [{"ticket": 11, "comment": "cid-order-extra"}]
    worker._positions = [{"ticket": 22, "comment": "cid-position-extra"}]
    deal = types.SimpleNamespace(comment="cid-deal", position_id=33, order=0, ticket=0)
    mt5_worker.mt5.history_deals_get = lambda *args, **kwargs: [deal]

    stats = worker._reconcile()

    assert stats == {"checked": 4, "found": 3, "notFound": 1}
    assert (
        "cid-order",
        "accepted",
        {"ticket": 11, "error": None, "login": 111},
    ) in worker.store.updates
    assert (
        "cid-position",
        "accepted",
        {"ticket": 22, "error": None, "login": 111},
    ) in worker.store.updates
    assert (
        "cid-deal",
        "accepted",
        {"ticket": 33, "error": None, "login": 111},
    ) in worker.store.updates
    assert (
        "cid-missing",
        "not_found",
        {"error": "重启后未在挂单/持仓/成交中找到", "login": 111},
    ) in worker.store.updates
    assert (
        "reconcile.found",
        {"clientId": "cid-order", "ticket": 11},
    ) in worker.store.audits
    assert ("reconcile.not_found", {"clientId": "cid-missing"}) in worker.store.audits


def test_对账时历史查询失败仍按挂单持仓判断(make):
    worker, _, state = make()
    state["deals_error"] = True
    worker.store.intents["_recent"] = [{"client_id": "cid", "state": "sending"}]
    worker._orders = [{"ticket": 4, "comment": "cid"}]

    assert worker._reconcile() == {"checked": 1, "found": 1, "notFound": 0}


def test_对账忽略已完成意图(make):
    worker, _, _ = make()
    worker.store.intents["_recent"] = [
        {"client_id": "a", "state": "filled"},
        {"client_id": "b", "state": "rejected"},
        {"client_id": "c", "state": "accepted"},
    ]

    assert worker._reconcile() == {"checked": 0, "found": 0, "notFound": 0}
    assert worker.store.updates == []


def test_手动对账要求已连接(make):
    worker, _, _ = make()
    worker._connected = False

    assert code_for(lambda: worker._reconcile_now({})) == "DISCONNECTED"


def test_手动对账写审计(make):
    worker, _, _ = make()
    worker.store.intents["_recent"] = []
    worker._reconcile = lambda: {"checked": 2, "found": 1, "notFound": 1}

    assert worker._reconcile_now({}) == {"checked": 2, "found": 1, "notFound": 1}
    assert (
        "reconcile.manual",
        {"checked": 2, "found": 1, "notFound": 1},
    ) in worker.store.audits
