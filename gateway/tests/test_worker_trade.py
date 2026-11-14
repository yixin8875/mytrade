"""网关交易核心：取整、风控、下单预检、按风险反推手数与持仓风险。

这些函数决定「下多大、能不能下、会不会越限」，出错直接亏钱，
所以全部用假 mt5 覆盖边界，不依赖终端、网络和真实账户。
"""

import types

import pytest

import mt5_worker
from mt5_worker import GatewayError, Mt5Worker, align_price, round_volume

NOW = 1_700_000_000
DAY_START = NOW - NOW % 86400

DEFAULT_LIMITS = {
    "max_lot": 1000.0,
    "max_risk_pct": 1.0,
    "max_positions": 3,
    "daily_loss_pct": 2.0,
    "max_trades_per_day": 8,
    "max_consecutive_losses": 3,
    "cooldown_minutes": 30,
    "max_spread_points": 0,
}


class FakeStore:
    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}
        self.risks: list[dict] = []
        self.duplicate = False
        self.intents: dict[str, dict] = {}
        self.saved_intents: list[dict] = []
        self.updated_intents: list[tuple[str, str, dict]] = []
        self.executions: list[dict] = []

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def record_position_risk(self, row: dict) -> None:
        self.risks.append(row)

    def recent_duplicate(self, symbol: str, side: str, price: float, login: int = 0) -> bool:
        return self.duplicate

    def get_intent(self, client_id: str, login: int = 0) -> dict | None:
        return self.intents.get(client_id)

    def save_intent(self, row: dict) -> None:
        item = dict(row)
        # 保存当时的快照，后续 update_intent 不应改写它
        self.saved_intents.append(dict(item))
        self.intents[item["client_id"]] = item

    def update_intent(self, client_id: str, state: str, **fields) -> None:
        self.updated_intents.append((client_id, state, fields))
        self.intents.setdefault(client_id, {"client_id": client_id}).update(
            {"state": state, **fields}
        )

    def record_execution(self, row: dict) -> None:
        self.executions.append(row)

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]

    def payload(self, kind: str) -> dict:
        for item_kind, item_payload in self.audits:
            if item_kind == kind:
                return item_payload  # type: ignore[return-value]
        raise AssertionError(f"missing audit {kind}")


def deal(
    ts: int = NOW - 60,
    *,
    type_: int = 0,
    entry: int = 0,
    profit: float = 0.0,
    swap: float = 0.0,
    commission: float = 0.0,
    fee: float = 0.0,
) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        time=ts,
        type=type_,
        entry=entry,
        profit=profit,
        swap=swap,
        commission=commission,
        fee=fee,
    )


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
        trade_mode=4,
        visible=True,
        filling_mode=0,
    )
    for key, value in over.items():
        setattr(info, key, value)
    return info


def fake_tick(bid: float = 2000.5, ask: float = 2000.7) -> types.SimpleNamespace:
    return types.SimpleNamespace(bid=bid, ask=ask)


def default_profit(
    order_type: int, symbol: str, volume: float, price_open: float, price_close: float
) -> float:
    sign = 1.0 if order_type == 0 else -1.0
    return (price_close - price_open) * volume * 10.0 * sign


def make_worker(
    monkeypatch,
    *,
    info=None,
    tick=None,
    deals=(),
    positions=None,
    calc_profit=None,
    calc_margin=None,
    terminal_allowed: bool = True,
    mode: str = "demo",
    account=None,
    limits=None,
    balance: float = 10_000.0,
    equity=None,
    connected: bool = True,
):
    info = fake_symbol_info() if info is None else info
    tick = fake_tick() if tick is None else tick
    calc_profit = default_profit if calc_profit is None else calc_profit
    if calc_margin is None:
        calc_margin = lambda order_type, symbol, volume, price: 100.0 * volume  # noqa: E731

    sent: list[dict] = []

    def order_send(request: dict):
        sent.append(request)
        return types.SimpleNamespace(
            retcode=10009,
            order=1,
            deal=1,
            volume=float(request.get("volume") or 0.0),
            price=float(request.get("price") or 0.0),
            comment="ok",
        )

    symbols = {"EURUSD": info}

    fake = types.SimpleNamespace(
        SYMBOL_TRADE_MODE_DISABLED=0,
        SYMBOL_TRADE_MODE_LONGONLY=1,
        SYMBOL_TRADE_MODE_SHORTONLY=2,
        SYMBOL_TRADE_MODE_CLOSEONLY=3,
        SYMBOL_TRADE_MODE_FULL=4,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        ORDER_TYPE_BUY_LIMIT=2,
        ORDER_TYPE_SELL_LIMIT=3,
        ORDER_TYPE_BUY_STOP=4,
        ORDER_TYPE_SELL_STOP=5,
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_PENDING=5,
        TRADE_ACTION_SLTP=6,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
        ORDER_TIME_GTC=0,
        order_send=order_send,
        symbol_info=lambda name: symbols.get(name),
        symbol_select=lambda name, enable=True: True,
        symbol_info_tick=lambda name: tick,
        order_calc_profit=calc_profit,
        order_calc_margin=calc_margin,
        positions_get=lambda **kwargs: positions or (),
        orders_get=lambda **kwargs: (),
        history_deals_get=lambda *args, **kwargs: deals,
        terminal_info=lambda: types.SimpleNamespace(trade_allowed=terminal_allowed),
        last_error=lambda: (-1, "calc failed"),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    monkeypatch.setattr(Mt5Worker, "_server_now", lambda self: NOW)

    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(magic=1, deviation_points=20)
    worker.store = FakeStore()
    worker._connected = connected
    if account is None:
        account = {
            "login": 1,
            "balance": balance,
            "equity": balance if equity is None else equity,
            "freeMargin": 5000.0,
            "margin": 0.0,
            "marginSoSo": 0.0,
            "accountType": "demo",
            "tradeAllowed": True,
        }
    worker._account = account
    worker._positions = list(positions or [])
    worker._orders = []
    worker._limits = {**DEFAULT_LIMITS, **(limits or {})}
    worker._trade_mode = mode
    worker._halted = None
    worker._server_offset = 0
    worker._risk = None
    worker._risk_tracked = {}
    worker._auto_be = {}
    worker._pending_plans = {}
    worker._trailing = {}
    worker._auto_be_pause_reason = ""
    worker._account_id = "default"
    return worker, fake, sent


def error_code(worker, params: dict) -> str:
    with pytest.raises(GatewayError) as exc:
        worker._analyze(params)
    return exc.value.code


def order(**over) -> dict:
    params = {"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 1}
    params.update(over)
    return params


# ---------- 纯函数取整 ----------


def test_round_volume_向下取整到步长():
    assert round_volume(1.239, 0.01) == pytest.approx(1.23)
    assert round_volume(0.019, 0.01) == pytest.approx(0.01)
    assert round_volume(0.0199, 0.01) == pytest.approx(0.01)
    assert round_volume(0.009, 0.01) == 0.0
    assert round_volume(2.0, 0.1) == pytest.approx(2.0)
    assert round_volume(0.3, 0.1) == pytest.approx(0.3)
    assert round_volume(0.29, 0.1) == pytest.approx(0.2)


def test_round_volume_非法步长原样返回():
    assert round_volume(1.234, 0) == 1.234
    assert round_volume(1.234, -0.01) == 1.234


def test_align_price_按最小跳动对齐():
    info = fake_symbol_info()
    assert align_price(2000.234, info) == pytest.approx(2000.23)
    assert align_price(2000.236, info) == pytest.approx(2000.24)
    assert align_price(
        1.086543, fake_symbol_info(trade_tick_size=0.00001, point=0.00001, digits=5)
    ) == pytest.approx(1.08654)


def test_align_price_没有跳动时退回点位或小数位():
    info = fake_symbol_info(trade_tick_size=0, point=0.05, digits=2)
    assert align_price(1.024, info) == pytest.approx(1.0)
    info = fake_symbol_info(trade_tick_size=0, point=0, digits=3)
    assert align_price(1.23456, info) == pytest.approx(1.235)


# ---------- 风控状态 ----------


def test_风控无成交时的默认状态(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    risk = worker._compute_risk()

    assert risk["dayStartBalance"] == 10000.0
    assert risk["dayPnl"] == 0.0
    assert risk["dailyLoss"] == 0.0
    assert risk["dailyLossLimit"] == 200.0
    assert risk["remaining"] == 200.0
    assert risk["tradesToday"] == 0
    assert risk["consecutiveLosses"] == 0
    assert risk["canTrade"] is True
    assert risk["blockReason"] == ""


def test_风控把已实现与浮动盈亏都算进当日盈亏(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[deal(profit=-150, commission=-5, entry=1)],
        positions=[{"profit": -30.0, "swap": -2.0}],
    )

    risk = worker._compute_risk()

    assert risk["dayPnl"] == -187.0
    assert risk["dailyLoss"] == 187.0
    assert risk["dayStartBalance"] == 10155.0
    assert risk["dailyLossLimit"] == pytest.approx(203.1)
    assert risk["remaining"] == pytest.approx(16.1)
    assert risk["consecutiveLosses"] == 1
    assert risk["canTrade"] is True


def test_当日亏损达到上限后禁止开仓(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, deals=[deal(profit=-250, commission=-5, entry=1)]
    )

    risk = worker._compute_risk()

    assert risk["dailyLoss"] == 255.0
    assert risk["dailyLossLimit"] == pytest.approx(205.1)
    assert risk["remaining"] == 0.0
    assert risk["canTrade"] is False
    assert risk["blockReason"] == "今日亏损 255.00 已达上限 205.10"


def test_浮动亏损也能触发当日亏损上限(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[deal(profit=-100, entry=1)],
        positions=[{"profit": -120.0, "swap": 0.0}],
    )

    risk = worker._compute_risk()

    assert risk["dayPnl"] == -220.0
    assert risk["canTrade"] is False
    assert risk["blockReason"].startswith("今日亏损 220.00")


def test_出入金记录不计入盈亏和开仓次数(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[
            deal(type_=2, entry=0, profit=5000),
            deal(type_=0, entry=0, profit=0),
        ],
    )

    risk = worker._compute_risk()

    assert risk["dayPnl"] == 0.0
    assert risk["tradesToday"] == 1


def test_开仓次数达到上限后禁止开仓(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[deal(entry=0) for _ in range(2)],
        limits={"max_trades_per_day": 2, "daily_loss_pct": 0.0},
    )

    risk = worker._compute_risk()

    assert risk["tradesToday"] == 2
    assert risk["canTrade"] is False
    assert risk["blockReason"] == "今日开仓 2 次已达上限 2"
    assert risk["dailyLossLimit"] == 0.0
    assert risk["remaining"] == 0.0


def test_连亏进入冷却且按最后一笔亏损计时(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[
            deal(NOW - 3600, entry=1, profit=-10),
            deal(NOW - 1800, entry=1, profit=-10),
            deal(NOW - 120, entry=1, profit=-10),
        ],
        limits={"max_consecutive_losses": 3, "daily_loss_pct": 0.0},
    )

    risk = worker._compute_risk()

    assert risk["consecutiveLosses"] == 3
    assert risk["cooldownUntil"] == NOW - 120 + 1800
    assert risk["cooldownRemainingSec"] == 1680
    assert risk["canTrade"] is False
    assert risk["blockReason"] == "连续亏损 3 次，冷却 28 分钟"


def test_冷却到期后恢复开仓但仍保留截止时间(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[
            deal(NOW - 3700, entry=1, profit=-10),
            deal(NOW - 3600, entry=1, profit=-10),
            deal(NOW - 3500, entry=1, profit=-10),
        ],
        limits={"max_consecutive_losses": 3, "daily_loss_pct": 0.0},
    )

    risk = worker._compute_risk()

    assert risk["consecutiveLosses"] == 3
    assert risk["cooldownUntil"] == NOW - 3500 + 1800
    assert risk["cooldownRemainingSec"] == 0
    assert risk["canTrade"] is True


def test_盈利打断连亏计数(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[
            deal(NOW - 500, entry=1, profit=-10),
            deal(NOW - 400, entry=1, profit=-10),
            deal(NOW - 300, entry=1, profit=5),
            deal(NOW - 200, entry=1, profit=-10),
            deal(NOW - 100, entry=1, profit=-10),
        ],
        limits={"max_consecutive_losses": 3, "daily_loss_pct": 0.0},
    )

    risk = worker._compute_risk()

    assert risk["consecutiveLosses"] == 2
    assert risk["canTrade"] is True


def test_停机状态优先于其他拦截原因(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, deals=[deal(entry=0) for _ in range(99)]
    )
    worker._halted = {"reason": "manual stop"}

    risk = worker._compute_risk()

    assert risk["halted"] is True
    assert risk["haltReason"] == "manual stop"
    assert risk["canTrade"] is False
    assert risk["blockReason"] == "已停机：manual stop"


def test_停机没写原因时用中文占位(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._halted = {"at": NOW}

    risk = worker._compute_risk()

    assert risk["blockReason"] == "已停机：手动停止"


def test_历史成交读不到时按零处理(monkeypatch):
    worker, fake, _ = make_worker(monkeypatch)

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    fake.history_deals_get = boom

    risk = worker._compute_risk()

    assert risk["tradesToday"] == 0
    assert risk["dayPnl"] == 0.0
    assert risk["canTrade"] is True


def test_只统计服务器当日之后的成交(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        deals=[deal(DAY_START - 10, entry=1, profit=-999), deal(NOW - 10, entry=1, profit=-1)],
        limits={"daily_loss_pct": 0.0, "max_consecutive_losses": 0},
    )

    risk = worker._compute_risk()

    assert risk["dayPnl"] == -1.0
    assert risk["consecutiveLosses"] == 1


def test_轮询风控只在变化或强制时推送(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    emitted: list[tuple[str, object]] = []
    worker._emit = lambda kind, payload: emitted.append((kind, payload))

    first = worker._poll_risk()
    assert first is not None
    assert len(emitted) == 1
    assert emitted[0][0] == "risk"

    worker._poll_risk()
    assert len(emitted) == 1

    worker._poll_risk(force=True)
    assert len(emitted) == 2


def test_风控计算出错时保留上一次结果并记录错误(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._risk = {"canTrade": True}
    worker._last_error = None

    def boom():
        raise RuntimeError("bad")

    worker._compute_risk = boom

    result = worker._poll_risk(force=True)

    assert result == {"canTrade": True}
    assert "风控状态计算失败" in worker._last_error["message"]


def test_未连接时不轮询风控(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._connected = False
    worker._risk = {"canTrade": True}

    assert worker._poll_risk(force=True) == {"canTrade": True}


def test_开仓拦截读取缓存的风控原因(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._risk = {"blockReason": "今日亏损达到上限"}
    assert worker._risk_block() == "今日亏损达到上限"

    worker._risk = None
    assert worker._risk_block() == ""


# ---------- 交易守卫 ----------


def test_守卫在正常模拟账户下放行(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert worker._guard_trade()["login"] == 1


def test_守卫拒绝未连接(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, connected=False)
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "DISCONNECTED"


def test_守卫拒绝只读模式(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, mode="readonly")
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "READ_ONLY"


def test_守卫要求终端打开自动交易(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, terminal_allowed=False)
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "TRADE_DISABLED"
    assert "Algo Trading" in exc.value.message


def test_守卫拒绝账户未允许交易(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._account["tradeAllowed"] = False
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "TRADE_DISABLED"
    assert "未允许交易" in exc.value.message


def test_守卫拒绝模拟模式下的实盘账户(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, mode="demo")
    worker._account["accountType"] = "real"
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "REAL_ACCOUNT"


def test_守卫拒绝实盘模式下的模拟账户(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, mode="live")
    with pytest.raises(GatewayError) as exc:
        worker._guard_trade()
    assert exc.value.code == "NOT_REAL"


def test_守卫放行实盘模式下的实盘账户(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, mode="live")
    worker._account["accountType"] = "real"
    assert worker._guard_trade()["login"] == 1


# ---------- 下单预检 ----------


def test_预检拒绝未连接与非法方向类型(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, connected=False)
    assert error_code(worker, order()) == "DISCONNECTED"

    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(side="long")) == "BAD_SIDE"
    assert error_code(worker, order(type="now")) == "BAD_TYPE"


def test_预检找不到品种与无报价(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(symbol="NOPE")) == "BAD_SYMBOL"

    worker, fake, _ = make_worker(monkeypatch)
    fake.symbol_info_tick = lambda name: None
    assert error_code(worker, order()) == "NO_QUOTE"


def test_预检会尝试把隐藏品种加入报价(monkeypatch):
    info = fake_symbol_info(visible=False)
    worker, fake, _ = make_worker(monkeypatch, info=info)
    fake.symbol_select = lambda name, enable=True: False
    assert error_code(worker, order()) == "SYMBOL_SELECT"


def test_预检按品种交易模式拒绝(monkeypatch):
    for mode, side, code in (
        (0, "buy", "SYMBOL_DISABLED"),
        (3, "sell", "CLOSE_ONLY"),
        (2, "buy", "SHORT_ONLY"),
        (1, "sell", "LONG_ONLY"),
    ):
        worker, _, _ = make_worker(
            monkeypatch, info=fake_symbol_info(trade_mode=mode)
        )
        assert error_code(worker, order(side=side)) == code


def test_预检手数边界(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(volume=0.004)) == "VOLUME_MIN"
    assert error_code(worker, order(volume=-1)) == "VOLUME_MIN"
    assert error_code(worker, order(volume=500)) == "VOLUME_MAX"


def test_预检把未填手数按最小手数处理(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    result = worker._analyze(order(volume=None))
    assert result["volume"] == pytest.approx(0.01)


def test_市价买单按卖价成交并算出风险收益比(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._analyze(order(sl=1999.7, tp=2003.7))

    assert result["price"] == pytest.approx(2000.7)
    assert result["orderType"] == 0
    assert result["action"] == 1
    assert result["margin"] == pytest.approx(100.0)
    assert result["riskAmount"] == pytest.approx(10.0)
    assert result["rewardAmount"] == pytest.approx(30.0)
    assert result["rr"] == pytest.approx(3.0)
    assert result["spreadPoints"] == pytest.approx(20.0)
    assert result["freeMargin"] == 5000.0
    assert result["equity"] == 10000.0


def test_市价卖单按买价成交(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._analyze(order(side="sell", sl=2001.5, tp=1997.5))

    assert result["price"] == pytest.approx(2000.5)
    assert result["side"] == "sell"
    assert result["riskAmount"] == pytest.approx(10.0)
    assert result["rewardAmount"] == pytest.approx(30.0)


def test_市价单没止损止盈时风险收益为空(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._analyze(order())

    assert result["sl"] is None
    assert result["tp"] is None
    assert result["riskAmount"] is None
    assert result["rewardAmount"] is None
    assert result["rr"] is None


def test_限价单价格必须在有利一侧(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(type="limit", price=0)) == "PRICE_REQUIRED"
    assert error_code(worker, order(type="limit", price=2000.7)) == "BAD_LIMIT_PRICE"
    assert error_code(worker, order(type="limit", price=2001)) == "BAD_LIMIT_PRICE"
    assert error_code(
        worker, order(type="limit", side="sell", price=2000.5)
    ) == "BAD_LIMIT_PRICE"
    assert error_code(worker, order(type="limit", side="sell", price=2000)) == "BAD_LIMIT_PRICE"

    buy = worker._analyze(order(type="limit", price=1999))
    assert buy["price"] == pytest.approx(1999.0)
    assert buy["orderType"] == 2
    assert buy["action"] == 5

    sell = worker._analyze(order(type="limit", side="sell", price=2002))
    assert sell["price"] == pytest.approx(2002.0)
    assert sell["orderType"] == 3


def test_停损单价格必须突破当前价(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(type="stop", price=2000.7)) == "BAD_STOP_PRICE"
    assert error_code(worker, order(type="stop", price=2000)) == "BAD_STOP_PRICE"
    assert error_code(
        worker, order(type="stop", side="sell", price=2000.5)
    ) == "BAD_STOP_PRICE"
    assert error_code(worker, order(type="stop", side="sell", price=2001)) == "BAD_STOP_PRICE"

    buy = worker._analyze(order(type="stop", price=2000.71))
    assert buy["orderType"] == 4
    sell = worker._analyze(order(type="stop", side="sell", price=2000.49))
    assert sell["orderType"] == 5


def test_止损止盈必须放在盈利方向(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert error_code(worker, order(sl=2000.7)) == "BAD_SL"
    assert error_code(worker, order(sl=2001)) == "BAD_SL"
    assert error_code(worker, order(tp=2000.7)) == "BAD_TP"
    assert error_code(worker, order(side="sell", sl=2000.5)) == "BAD_SL"
    assert error_code(worker, order(side="sell", tp=2000.5)) == "BAD_TP"

    assert worker._analyze(order(sl=2000.69, tp=2000.71))["sl"] == pytest.approx(2000.69)
    assert worker._analyze(order(side="sell", sl=2000.51, tp=2000.49))["tp"] == pytest.approx(
        2000.49
    )


def test_止损止盈距离小于券商最小点数会被拒绝(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, info=fake_symbol_info(trade_stops_level=100)
    )
    assert error_code(worker, order(sl=2000.2)) == "STOPS_LEVEL"
    assert error_code(worker, order(tp=2001.5)) == "STOPS_LEVEL"

    result = worker._analyze(order(sl=1999.6, tp=2002.0))
    assert result["stopsLevelPoints"] == 100


def test_保证金算不出来时拒绝下单(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, calc_margin=lambda *args: None)
    assert error_code(worker, order()) == "MARGIN_CALC"


def test_券商算不出盈亏时风险收益留空(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, calc_profit=lambda *args: None)

    result = worker._analyze(order(sl=1999.7, tp=2003.7))

    assert result["riskAmount"] is None
    assert result["rewardAmount"] is None
    assert result["rr"] is None


# ---------- 下单预览 ----------


def test_预览汇总所有警告(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        account={
            "login": 1,
            "balance": 10000.0,
            "equity": 10000.0,
            "freeMargin": 100.0,
            "margin": 0.0,
            "marginSoSo": 0.0,
            "accountType": "demo",
            "tradeAllowed": True,
        },
        limits={"max_risk_pct": 0.05, "max_spread_points": 10},
    )
    worker._risk = {"blockReason": "今日亏损达到上限"}

    result = worker._preview(order(sl=1999.7))

    assert result["riskPct"] == pytest.approx(0.1)
    assert result["warnings"] == [
        "当前禁止开仓：今日亏损达到上限",
        "风险 0.10% 超过上限 0.05%",
        "点差 20 点超过上限 10",
        "保证金占用接近可用保证金的 90%",
    ]


def test_预览提示未设置止损(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._preview(order())

    assert "未设置止损" in result["warnings"]
    assert result["riskPct"] is None


def test_预览在没有风险时不给警告(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._preview(order(sl=1999.7, tp=2003.7))

    assert result["warnings"] == []
    assert result["rr"] == pytest.approx(3.0)


# ---------- 按风险反推手数 ----------


def test_按余额百分比反推手数(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._size(
        order(sl=1999.7, tp=2003.7, riskMode="percent", riskValue=1)
    )

    assert result["targetRisk"] == pytest.approx(100.0)
    assert result["riskPerLot"] == pytest.approx(10.0)
    assert result["volume"] == pytest.approx(10.0)
    assert result["riskAmount"] == pytest.approx(100.0)
    assert result["riskPct"] == pytest.approx(1.0)
    assert result["rewardAmount"] == pytest.approx(300.0)
    assert result["rr"] == pytest.approx(3.0)
    assert result["capped"] == []
    assert result["warnings"] == []


def test_按固定金额反推手数且金额缺省为一百(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    explicit = worker._size(order(sl=1999.7, riskMode="amount", riskValue=250))
    default = worker._size(order(sl=1999.7, riskMode="amount"))

    assert explicit["volume"] == pytest.approx(25.0)
    assert explicit["targetRisk"] == 250.0
    assert default["targetRisk"] == 100.0
    assert default["volume"] == pytest.approx(10.0)


def test_百分比模式风险值缺省为一(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._size(order(sl=1999.7, riskMode="percent"))

    assert result["targetRisk"] == pytest.approx(100.0)


def test_没有止损不能按风险算手数(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    with pytest.raises(GatewayError) as exc:
        worker._size(order())
    assert exc.value.code == "NO_SL"


@pytest.mark.parametrize("value", [0, -1, -100])
def test_风险值必须大于零(monkeypatch, value):
    worker, _, _ = make_worker(monkeypatch)
    with pytest.raises(GatewayError) as exc:
        worker._size(order(sl=1999.7, riskValue=value))
    assert exc.value.code == "BAD_RISK"


def test_券商算不出单手风险时拒绝(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, calc_profit=lambda *args: None)
    with pytest.raises(GatewayError) as exc:
        worker._size(order(sl=1999.7))
    assert exc.value.code == "RISK_CALC"


def test_止损距离为零时拒绝(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        calc_profit=lambda order_type, symbol, volume, price_open, price_close: 0.0,
    )
    with pytest.raises(GatewayError) as exc:
        worker._size(order(sl=1999.7))
    assert exc.value.code == "RISK_CALC"
    assert "距离为 0" in exc.value.message


def test_目标手数低于最小手数时按最小手数并提示(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    result = worker._size(order(sl=1999.7, riskValue=0.001))

    assert result["volume"] == pytest.approx(0.01)
    assert result["capped"] == ["min"]
    assert result["warnings"] == ["按最小手数 0.01 计算，实际风险 0.10"]


def test_手数被封顶到风控上限并提示(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, limits={"max_lot": 0.5})

    result = worker._size(order(sl=1999.7, riskValue=100))

    assert result["volume"] == pytest.approx(0.5)
    assert result["capped"] == ["max"]
    assert result["warnings"] == ["手数已到上限 0.5，未达到目标风险"]


def test_手数也会被封顶到品种最大手数(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, info=fake_symbol_info(volume_max=1.0)
    )

    result = worker._size(order(sl=1999.7, riskValue=100))

    assert result["volume"] == pytest.approx(1.0)
    assert result["capped"] == ["max"]


def test_手数按步长向下取整(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, info=fake_symbol_info(volume_step=0.1, volume_min=0.1)
    )

    result = worker._size(order(sl=1999.7, riskValue=12.9))

    assert result["volume"] == pytest.approx(1.2)
    assert result["step"] == pytest.approx(0.1)
    assert result["riskAmount"] == pytest.approx(12.0)


def test_实际风险超过账户上限时提示(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch,
        account={
            "login": 1,
            "balance": 10000.0,
            "equity": 100.0,
            "freeMargin": 5000.0,
            "margin": 0.0,
            "marginSoSo": 0.0,
            "accountType": "demo",
            "tradeAllowed": True,
        },
    )

    result = worker._size(order(sl=1999.7, riskMode="percent", riskValue=1))

    assert result["riskPct"] == pytest.approx(100.0)
    assert "风险 100.00% 超过上限 1.0%" in result["warnings"]


# ---------- 持仓风险 ----------


def test_按开仓价与止损折算初始风险(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) == pytest.approx(10.0)
    assert worker._risk_for("EURUSD", "sell", 1.0, 2000.5, 2001.5) == pytest.approx(10.0)


def test_风险换算的非法输入返回空(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    assert worker._risk_for("EURUSD", "buy", 1.0, 0, 1999.7) is None
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 0) is None
    assert worker._risk_for("EURUSD", "buy", 0, 2000.7, 1999.7) is None


def test_风险换算异常或非有限值返回空(monkeypatch):
    worker, fake, _ = make_worker(monkeypatch)
    fake.order_calc_profit = lambda *args: None
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) is None

    fake.order_calc_profit = lambda *args: 0.0
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) is None

    fake.order_calc_profit = lambda *args: float("nan")
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) is None

    fake.order_calc_profit = lambda *args: float("inf")
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) is None

    def boom(*args):
        raise RuntimeError("bad")

    fake.order_calc_profit = boom
    assert worker._risk_for("EURUSD", "buy", 1.0, 2000.7, 1999.7) is None


def position(**over):
    base = types.SimpleNamespace(
        ticket=11,
        identifier=11,
        symbol="EURUSD",
        type=0,
        volume=1.0,
        price_open=2000.7,
        sl=1999.7,
        tp=2003.7,
        profit=0.0,
        swap=0.0,
        commission=0.0,
        magic=1,
        comment="",
        time=NOW - 100,
    )
    for key, value in over.items():
        setattr(base, key, value)
    return base


def test_有止损的持仓会落库初始风险(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._capture_position_risks([position()])

    assert worker.store.risks == [
        {
            "login": 1,
            "position_id": 11,
            "symbol": "EURUSD",
            "side": "buy",
            "volume": 1.0,
            "entry": 2000.7,
            "sl": 1999.7,
            "risk": pytest.approx(10.0),
            "source": "position",
        }
    ]
    assert worker._risk_tracked == {11: 1999.7}


def test_同一持仓不会重复落库(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._capture_position_risks([position()])
    worker._capture_position_risks([position(sl=1999.0)])

    assert len(worker.store.risks) == 1
    assert worker._risk_tracked == {11: 1999.7}


def test_没有止损或登录号为空的持仓跳过(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._capture_position_risks([position(sl=0.0)])
    assert worker.store.risks == []

    worker._account = {"login": 0}
    worker._capture_position_risks([position()])
    assert worker.store.risks == []


def test_风险算不出来时不落库(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._risk_for = lambda *args: None

    worker._capture_position_risks([position()])

    assert worker.store.risks == []
    assert worker._risk_tracked == {}


def test_空头持仓按卖出方向换算风险(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._capture_position_risks(
        [position(type=1, price_open=2000.5, sl=2001.5)]
    )

    assert worker.store.risks[0]["side"] == "sell"
    assert worker.store.risks[0]["risk"] == pytest.approx(10.0)


# ---------- 强平价估算 ----------


def risk_account(**over):
    account = {
        "login": 1,
        "balance": 1000.0,
        "equity": 900.0,
        "freeMargin": 0.0,
        "margin": 1000.0,
        "marginSoSo": 50.0,
        "accountType": "demo",
        "tradeAllowed": True,
    }
    account.update(over)
    return account


def test_多头强平价按净值跌到强平线估算(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, account=risk_account())

    price = worker._stop_out_price(position(price_open=2000.0, sl=0.0), fake_symbol_info())

    assert price == pytest.approx(1960.0)


def test_空头强平价按净值跌到强平线估算(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, account=risk_account())

    price = worker._stop_out_price(
        position(type=1, price_open=2000.0, sl=0.0), fake_symbol_info()
    )

    assert price == pytest.approx(2040.0)


def test_浮动盈利会把强平价推远(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, account=risk_account())

    price = worker._stop_out_price(
        position(price_open=2000.0, sl=0.0, profit=100.0), fake_symbol_info()
    )

    assert price == pytest.approx(1970.0)


def test_账户或点位条件不足时不估算强平价(monkeypatch):
    for account in (
        risk_account(margin=0.0),
        risk_account(equity=0.0),
        risk_account(marginSoSo=0.0),
        risk_account(marginSoSo=101.0),
    ):
        worker, _, _ = make_worker(monkeypatch, account=account)
        assert worker._stop_out_price(position(), fake_symbol_info()) is None

    worker, _, _ = make_worker(monkeypatch, account=risk_account())
    assert worker._stop_out_price(position(), fake_symbol_info(point=0.0)) is None


def test_强平价算不出来或落在反方向时返回空(monkeypatch):
    worker, fake, _ = make_worker(monkeypatch, account=risk_account())
    fake.order_calc_profit = lambda *args: None
    assert worker._stop_out_price(position(price_open=2000.0), fake_symbol_info()) is None

    worker, fake, _ = make_worker(monkeypatch, account=risk_account())
    fake.order_calc_profit = lambda *args: 0.0
    assert worker._stop_out_price(position(price_open=2000.0), fake_symbol_info()) is None

    worker, _, _ = make_worker(
        monkeypatch, account=risk_account(equity=100.0, margin=1000.0)
    )
    # 净值远高于强平线时算出的是「盈利价」，不应显示
    assert worker._stop_out_price(position(price_open=2000.0), fake_symbol_info()) is None


# ---------- 持仓/挂单展示 ----------


def test_持仓展示带止损止盈金额与移动止损(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._trailing[11] = {"distancePoints": 10, "stepPoints": 5}

    payload = worker._position_payload(position())

    assert payload["ticket"] == 11
    assert payload["side"] == "buy"
    assert payload["slProfit"] == pytest.approx(-10.0)
    assert payload["tpProfit"] == pytest.approx(30.0)
    assert payload["sl"] == pytest.approx(1999.7)
    assert payload["trailing"] == {"distancePoints": 10, "stepPoints": 5}
    assert payload["stopOutPrice"] is None
    assert payload["openTime"] == NOW - 100


def test_持仓展示跳过空止损止盈(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    payload = worker._position_payload(position(sl=0.0, tp=0.0))

    assert payload["sl"] is None
    assert payload["tp"] is None
    assert payload["slProfit"] is None
    assert payload["tpProfit"] is None


def order_ticket(**over):
    base = types.SimpleNamespace(
        ticket=21,
        symbol="EURUSD",
        type=2,
        volume_current=0.4,
        volume_initial=1.0,
        price_open=1999.0,
        sl=0.0,
        tp=2005.0,
        state=1,
        comment="",
        magic=1,
        time_setup=NOW - 50,
        time_expiration=0,
    )
    for key, value in over.items():
        setattr(base, key, value)
    return base


def test_挂单展示方向类型与成交量(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    payload = worker._order_payload(order_ticket())

    assert payload["side"] == "buy"
    assert payload["type"] == "limit"
    assert payload["filledVolume"] == pytest.approx(0.6)
    assert payload["state"] == "working"
    assert payload["tp"] == pytest.approx(2005.0)
    assert payload["expiration"] is None

    assert worker._order_payload(order_ticket(type=5))["type"] == "stop"
    assert worker._order_payload(order_ticket(type=1))["side"] == "sell"


# ---------- 分批平仓 ----------


def test_分批平仓按百分比发反向市价单(monkeypatch):
    worker, _, sent = make_worker(
        monkeypatch, positions=[position(ticket=11, type=0, volume=1.0)]
    )

    closed = worker._auto_partial_close(11, 50)

    assert closed == pytest.approx(0.5)
    request = sent[0]
    assert request["action"] == 1
    assert request["type"] == 1
    assert request["position"] == 11
    assert request["volume"] == pytest.approx(0.5)
    assert request["price"] == pytest.approx(2000.5)
    assert request["comment"] == "tpl-partial"
    assert "position.template_step.partial.result" in worker.store.kinds()


def test_空头分批平仓用卖价并买入(monkeypatch):
    worker, _, sent = make_worker(
        monkeypatch, positions=[position(ticket=11, type=1, volume=1.0)]
    )

    worker._auto_partial_close(11, 25)

    assert sent[0]["type"] == 0
    assert sent[0]["price"] == pytest.approx(2000.7)
    assert sent[0]["volume"] == pytest.approx(0.25)


def test_分批平仓忽略非法比例(monkeypatch):
    worker, _, sent = make_worker(
        monkeypatch, positions=[position(ticket=11, volume=1.0)]
    )
    for value in ("abc", None, 0, 100, -5, 150):
        assert worker._auto_partial_close(11, value) is None
    assert sent == []


def test_分批平仓找不到持仓或报价时不下单(monkeypatch):
    worker, _, sent = make_worker(monkeypatch)
    assert worker._auto_partial_close(11, 50) is None

    worker, fake, sent = make_worker(monkeypatch, positions=[position(volume=1.0)])
    fake.symbol_info_tick = lambda name: None
    with pytest.raises(GatewayError) as exc:
        worker._auto_partial_close(11, 50)
    assert exc.value.code == "NO_QUOTE"
    assert sent == []


def test_分批平仓拆不开时不发单(monkeypatch):
    worker, _, sent = make_worker(
        monkeypatch, positions=[position(volume=0.01)]
    )
    assert worker._auto_partial_close(11, 50) is None

    info = fake_symbol_info(volume_step=0.1, volume_min=0.1)
    worker, _, sent = make_worker(
        monkeypatch, info=info, positions=[position(volume=0.25)]
    )
    # 0.25 * 99% 向下取整到 0.2，剩 0.05 小于最小手数
    assert worker._auto_partial_close(11, 99) is None
    assert sent == []


# ---------- 挂单计划匹配 ----------


def test_挂单成交后按备注前缀匹配持仓(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._positions = [
        {"ticket": 1, "comment": "other"},
        {"ticket": 2, "comment": "abc123"},
    ]

    matched = worker._match_pending_position({"clientId": "abc"}, None)

    assert matched["ticket"] == 2


def test_备注匹配不到时用历史持仓号兜底(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._positions = [
        {"ticket": 1, "identifier": 0, "comment": ""},
        {"ticket": 2, "identifier": 77, "comment": ""},
    ]

    assert worker._match_pending_position({}, types.SimpleNamespace(position_id=1))[
        "ticket"
    ] == 1
    assert worker._match_pending_position({}, types.SimpleNamespace(position_id=77))[
        "ticket"
    ] == 2


def test_匹配不到持仓时返回空(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._positions = [{"ticket": 1, "comment": ""}]

    assert worker._match_pending_position({"clientId": "abc"}, None) is None
    assert worker._match_pending_position({}, types.SimpleNamespace(position_id=0)) is None
    assert worker._match_pending_position({"clientId": ""}, None) is None


# ---------- 成交结果与填充模式 ----------


def test_成交结果成功时审计并返回关键字段(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    result = types.SimpleNamespace(
        retcode=10009, order=7, deal=8, volume=0.5, price=2000.7, comment="done"
    )

    payload = worker._result_or_raise(result, "order.place")

    assert payload == {
        "retcode": 10009,
        "order": 7,
        "deal": 8,
        "volume": 0.5,
        "price": 2000.7,
        "comment": "done",
    }
    assert worker.store.payload("order.place.result") == payload


def test_成交结果失败时抛带券商文案的错误(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    result = types.SimpleNamespace(
        retcode=10016, order=0, deal=0, volume=0.0, price=0.0, comment=""
    )

    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(result, "order.place")

    assert exc.value.code == "RET_10016"
    assert exc.value.message == mt5_worker.RETCODE_TEXT[10016]
    assert exc.value.detail["retcode"] == 10016


def test_成交结果为空时抛发送失败(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    with pytest.raises(GatewayError) as exc:
        worker._result_or_raise(None, "order.place")

    assert exc.value.code == "SEND_FAILED"
    assert "calc failed" in exc.value.message


def test_填充模式按品种标志选择(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    assert worker._filling_mode(fake_symbol_info(filling_mode=0)) == 2
    assert worker._filling_mode(fake_symbol_info(filling_mode=1)) == 0
    assert worker._filling_mode(fake_symbol_info(filling_mode=2)) == 1
    assert worker._filling_mode(fake_symbol_info(filling_mode=3)) == 1


# ---------- 下单前置风控 ----------


def analyze_base(**over) -> dict:
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
        "stopsLevelPoints": 0,
        "digits": 2,
        "point": 0.01,
        "tick": fake_tick(),
        "info": fake_symbol_info(),
        "freeMargin": 5000.0,
        "equity": 10000.0,
    }
    base.update(over)
    return base


def place_setup(monkeypatch, **over):
    worker, fake, sent = make_worker(monkeypatch)
    analysis = analyze_base(**over)
    worker._analyze = lambda params: analysis
    worker._guard_trade = lambda: worker._account
    worker._compute_risk = lambda: {"blockReason": ""}
    worker._poll_trade_state = lambda: None
    worker._poll_risk = lambda force=False: None
    worker._enrich_place_payload = lambda payload, client_id, a: None
    worker._record_execution = lambda *args, **kwargs: None
    worker._emit = lambda *args: None
    worker._save_auto_be = lambda: None
    return worker, fake, sent, analysis


def place_error(worker, params: dict) -> str:
    with pytest.raises(GatewayError) as exc:
        worker._place(params)
    return exc.value.code


def test_下单前拒绝超过单笔手数上限(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch, volume=1.0)
    worker._limits["max_lot"] = 0.5

    assert place_error(worker, order()) == "MAX_LOT"
    assert sent == []


def test_下单前拒绝点差过大(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch, spreadPoints=20.0)
    worker._limits["max_spread_points"] = 10

    assert place_error(worker, order()) == "SPREAD_LIMIT"
    assert sent == []


def test_下单前拒绝持仓数量超限(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)
    worker._limits["max_positions"] = 1
    worker._positions = [{"ticket": 1}]

    assert place_error(worker, order()) == "MAX_POSITIONS"
    assert sent == []


def test_下单前拒绝单笔风险超限(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch, riskAmount=100.0, equity=1000.0)
    worker._limits["max_risk_pct"] = 1.0

    assert place_error(worker, order()) == "RISK_LIMIT"
    assert sent == []


def test_下单前拒绝风控拦截(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)
    worker._compute_risk = lambda: {"blockReason": "今日亏损 100.00 已达上限 100.00"}

    with pytest.raises(GatewayError) as exc:
        worker._place(order())
    assert exc.value.code == "RISK_BLOCK"
    assert "今日亏损" in exc.value.message
    assert sent == []


def test_下单前拒绝保证金占用过高(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch, margin=91.0, freeMargin=100.0)

    assert place_error(worker, order()) == "NO_MARGIN"
    assert sent == []


def test_下单前拒绝三秒内重复订单(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)
    worker.store.duplicate = True

    assert place_error(worker, order()) == "DUPLICATE"
    assert sent == []


def test_守卫先于下单分析执行(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)
    analyzed = []
    worker._analyze = lambda params: analyzed.append(params) or analyze_base()

    def blocked():
        raise GatewayError("READ_ONLY", "只读模式")

    worker._guard_trade = blocked

    with pytest.raises(GatewayError) as exc:
        worker._place(order())
    assert exc.value.code == "READ_ONLY"
    assert analyzed == []
    assert sent == []


def test_相同_client_id_已成交时直接返回(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)
    worker.store.intents["cid-1"] = {"state": "filled", "ticket": 9}

    result = worker._place(order(clientOrderId="cid-1"))

    assert result == {"clientOrderId": "cid-1", "state": "filled", "ticket": 9}
    assert sent == []
    assert worker.store.saved_intents == []


def test_市价单成功时记录意图与初始风险(monkeypatch):
    worker, _, sent, _ = place_setup(monkeypatch)

    result = worker._place(order(sl=1999.7, clientOrderId="cid-1"))

    assert result["state"] == "filled"
    assert result["order"] == 1
    assert result["price"] == pytest.approx(2000.7)

    request = sent[0]
    assert request["action"] == 1
    assert request["type"] == 0
    assert request["volume"] == pytest.approx(1.0)
    assert request["sl"] == pytest.approx(1999.7)
    assert request["tp"] == 0.0
    assert request["deviation"] == 20
    assert request["magic"] == 1
    assert request["comment"] == "cid-1"
    assert request["type_filling"] == 2
    assert "expiration" not in request

    assert worker.store.saved_intents[0]["state"] == "sending"
    assert worker.store.intents["cid-1"]["state"] == "filled"
    assert worker.store.intents["cid-1"]["ticket"] == 1
    assert worker.store.risks[0]["position_id"] == 1
    assert worker.store.risks[0]["risk"] == pytest.approx(10.0)
    assert worker.store.risks[0]["source"] == "order"
    assert worker._risk_tracked == {1: 1999.7}
    assert "order.place.request" in worker.store.kinds()
    assert "order.place.result" in worker.store.kinds()


def test_挂单成功时登记模板计划(monkeypatch):
    worker, _, sent, _ = place_setup(
        monkeypatch, type="limit", action=5, orderType=2, price=1999.0
    )
    remembered = []
    worker._remember_pending_plan = lambda *args: remembered.append(args)

    result = worker._place(
        order(
            type="limit",
            price=1999.0,
            clientOrderId="cid-2",
            plan={
                "steps": [{"atR": 1, "closePercent": 50, "moveBreakeven": True}],
                "templateId": "t1",
                "templateName": "日内",
            },
        )
    )

    assert result["state"] == "accepted"
    assert sent[0]["expiration"] == 0
    assert "type_filling" not in sent[0]
    assert worker.store.risks == []
    steps = remembered[0][3]
    assert steps == [
        {
            "atR": 1.0,
            "closePercent": 50.0,
            "moveBreakeven": True,
            "done": False,
        }
    ]
    assert remembered[0][4]["templateName"] == "日内"


def test_下单被券商拒绝时记录并抛错(monkeypatch):
    worker, fake, sent, _ = place_setup(monkeypatch)

    def reject(request):
        sent.append(request)
        return types.SimpleNamespace(
            retcode=10016, order=0, deal=0, volume=0.0, price=0.0, comment=""
        )

    fake.order_send = reject

    with pytest.raises(GatewayError) as exc:
        worker._place(order(clientOrderId="cid-3"))

    assert exc.value.code == "RET_10016"
    assert exc.value.message == "止损/止盈无效（距离过近或方向错误）"
    assert worker.store.intents["cid-3"]["state"] == "rejected"
    assert "10016" in worker.store.intents["cid-3"]["error"]
    assert "order.place.result" in worker.store.kinds()


def test_下单抛异常时标记未知(monkeypatch):
    worker, fake, _, _ = place_setup(monkeypatch)

    def boom(request):
        raise RuntimeError("socket")

    fake.order_send = boom

    with pytest.raises(GatewayError) as exc:
        worker._place(order(clientOrderId="cid-4"))

    assert exc.value.code == "SEND_FAILED"
    assert "下单异常: socket" in exc.value.message
    assert worker.store.intents["cid-4"]["state"] == "unknown"
    assert "order.place.exception" in worker.store.kinds()


def test_下单返回空时标记未知(monkeypatch):
    worker, fake, _, _ = place_setup(monkeypatch)
    fake.order_send = lambda request: None

    with pytest.raises(GatewayError) as exc:
        worker._place(order(clientOrderId="cid-5"))

    assert exc.value.code == "SEND_FAILED"
    assert "下单失败" in exc.value.message
    assert worker.store.intents["cid-5"]["state"] == "unknown"


# ---------- 执行质量记录 ----------


def test_执行记录计算滑点(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._record_execution(
        "cid", 1, analyze_base(side="buy", price=2000.7), 2000.9, 42, "filled", None, 10009
    )

    row = worker.store.executions[0]
    assert row["client_id"] == "cid"
    assert row["login"] == 1
    assert row["ticket"] == 1
    assert row["requested_price"] == pytest.approx(2000.7)
    assert row["fill_price"] == pytest.approx(2000.9)
    assert row["slippage_points"] == pytest.approx(20.0)
    assert row["latency_ms"] == 42
    assert row["state"] == "filled"
    assert row["retcode"] == 10009


def test_空头滑点按买价方向计算(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._record_execution(
        "cid", 1, analyze_base(side="sell", price=2000.7), 2000.5, 10, "filled", None
    )

    assert worker.store.executions[0]["slippage_points"] == pytest.approx(20.0)


def test_挂单与非行情成交不计算滑点(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    worker._record_execution(
        "cid", 1, analyze_base(type="limit", price=1999.0), 1999.0, 10, "accepted", None
    )
    worker._record_execution(
        "cid", 1, analyze_base(price=0.0), 0.0, 10, "rejected", "bad", 10016
    )

    assert worker.store.executions[0]["slippage_points"] is None
    assert worker.store.executions[1]["slippage_points"] is None
    assert worker.store.executions[1]["reason"] == "bad"


def test_执行记录写库失败不影响交易(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    def boom(row):
        raise RuntimeError("db locked")

    worker.store.record_execution = boom

    worker._record_execution("cid", 1, analyze_base(), 2000.7, 1, "filled", None)
