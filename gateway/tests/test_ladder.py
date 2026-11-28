"""分批止盈计划：校验、增删改查、到价执行与幂等。"""

import types

import pytest

import mt5_worker
from mt5_worker import GatewayError, Mt5Worker


class FakeStore:
    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}
        self.risks: dict[int, dict] = {}

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def position_risk_map(self, login: int, tickets: list[int]) -> dict[int, dict]:
        return {ticket: self.risks[ticket] for ticket in tickets if ticket in self.risks}

    def record_position_risk(self, record: dict) -> bool:
        self.risks.setdefault(int(record["position_id"]), record)
        return True

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]

    def payload(self, kind: str) -> dict:
        for item_kind, item_payload in self.audits:
            if item_kind == kind:
                return item_payload  # type: ignore[return-value]
        raise AssertionError(f"missing audit {kind}")


def symbol_info(**over) -> types.SimpleNamespace:
    info = types.SimpleNamespace(
        point=0.00001,
        digits=5,
        trade_tick_size=0.00001,
        trade_stops_level=0,
        trade_freeze_level=0,
        volume_min=0.01,
        volume_step=0.01,
        volume_max=100.0,
        visible=True,
    )
    for key, value in over.items():
        setattr(info, key, value)
    return info


def position(**over) -> types.SimpleNamespace:
    data = types.SimpleNamespace(
        ticket=11,
        identifier=11,
        symbol="EURUSD",
        type=0,
        volume=1.0,
        price_open=1.1,
        sl=1.0,
        tp=1.2,
        profit=0.0,
        swap=0.0,
        commission=0.0,
        magic=1,
        comment="",
        time=1763200000,
    )
    for key, value in over.items():
        setattr(data, key, value)
    return data


def make_worker(monkeypatch, *, positions=None, deals=None, info=None):
    positions = list(positions if positions is not None else [position()])
    deals = list(deals or [])
    sent: list[dict] = []

    def order_send(request):
        sent.append(request)
        return types.SimpleNamespace(
            retcode=10009, order=0, deal=0, volume=0.0, price=0.0, comment="ok"
        )

    fake = types.SimpleNamespace(
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_SLTP=6,
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
        order_send=order_send,
        last_error=lambda: (0, "ok"),
        symbol_info=lambda name: info or symbol_info(),
        symbol_select=lambda name, value: True,
        symbol_info_tick=lambda name: types.SimpleNamespace(bid=1.2, ask=1.2),
        positions_get=lambda ticket=None, **kwargs: tuple(
            item for item in positions if ticket is None or item.ticket == ticket
        ),
        orders_get=lambda **kwargs: (),
        history_orders_get=lambda **kwargs: (),
        history_deals_get=lambda *args, **kwargs: tuple(deals),
        order_calc_profit=lambda *args, **kwargs: 10.0,
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    worker = Mt5Worker.__new__(Mt5Worker)
    worker.cfg = types.SimpleNamespace(magic=1, deviation_points=20)
    worker.store = FakeStore()
    worker._loop = None
    worker._connected = True
    worker._account = {"login": 1}
    worker._trade_mode = "demo"
    worker._halted = None
    worker._positions = [
        {
            "ticket": item.ticket,
            "symbol": item.symbol,
            "side": "buy" if item.type == 0 else "sell",
            "openPrice": item.price_open,
            "sl": item.sl,
            "tp": item.tp,
        }
        for item in positions
    ]
    worker._orders = []
    worker._auto_be = {}
    worker._pending_plans = {}
    worker._auto_be_pause_reason = ""
    worker._risk_tracked = {}
    worker._trailing = {}
    worker._trail_next = {}
    worker._emit = lambda *args: None
    return worker, sent, positions


def seed_plan(worker, **over) -> dict:
    step = {
        "id": "step1",
        "price": 1.105,
        "atR": None,
        "closePercent": 50.0,
        "moveBreakeven": False,
        "done": False,
        "skipped": False,
    }
    step.update(over.pop("step", {}))
    plan = {
        "entry": 1.1,
        "risk": 0.1,
        "side": "buy",
        "next": 0.0,
        "steps": [step],
        "source": "manual",
        "templateId": None,
        "templateName": None,
    }
    plan.update(over)
    worker._auto_be[11] = plan
    return plan


# ---------- 计划编辑 ----------


def test_add_step_persists_and_audits(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    out = worker._plan_add({"ticket": 11, "price": 1.105, "closePercent": 50})

    plan = out["plan"]
    assert plan["entry"] == 1.1
    assert plan["source"] == "manual"
    assert len(plan["steps"]) == 1
    step = plan["steps"][0]
    assert step["price"] == pytest.approx(1.105)
    assert step["closePercent"] == 50
    assert step["done"] is False
    assert step["atR"] == pytest.approx(0.05)
    assert worker.store.state["autoBreakeven"]["11"]["steps"][0]["id"] == step["id"]
    assert worker.store.payload("position.plan.add")["ticket"] == 11


def test_add_rejects_price_on_wrong_side(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    with pytest.raises(GatewayError) as exc:
        worker._plan_add({"ticket": 11, "price": 1.09, "closePercent": 50})

    assert exc.value.code == "PLAN_WRONG_SIDE"
    assert worker._auto_be == {}


def test_add_rejects_step_beyond_take_profit(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    with pytest.raises(GatewayError) as exc:
        worker._plan_add({"ticket": 11, "price": 1.2, "closePercent": 50})

    assert exc.value.code == "PLAN_BEYOND_TP"
    assert "最终止盈" in exc.value.message


def test_add_rejects_duplicate_price(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    seed_plan(worker)

    with pytest.raises(GatewayError) as exc:
        worker._plan_add({"ticket": 11, "price": 1.105, "closePercent": 30})

    assert exc.value.code == "PLAN_DUPLICATE"


def test_add_rejects_bad_percent(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    for value in (0, 100, -5, "abc", None):
        with pytest.raises(GatewayError) as exc:
            worker._plan_add({"ticket": 11, "price": 1.11, "closePercent": value})
        assert exc.value.code == "BAD_PERCENT"


def test_add_rejects_unknown_ticket(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, positions=[])

    with pytest.raises(GatewayError) as exc:
        worker._plan_add({"ticket": 99, "price": 1.105, "closePercent": 50})

    assert exc.value.code == "NO_POSITION"


def test_add_uses_recorded_stop_when_position_has_no_sl(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, positions=[position(sl=0)])
    worker.store.risks[11] = {"risk": 60.0, "entry": 1.1, "sl": 1.0}

    out = worker._plan_add({"ticket": 11, "price": 1.11, "closePercent": 50})

    # 落库的 risk 是金额，1R 的价格距离要用 entry - sl 折算
    assert out["plan"]["risk"] == pytest.approx(0.1)
    assert out["plan"]["steps"][0]["atR"] == pytest.approx(0.1)


def test_update_moves_price_and_keeps_order(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    seed_plan(worker)

    out = worker._plan_update({"ticket": 11, "stepId": "step1", "price": 1.115})

    assert out["plan"]["steps"][0]["price"] == pytest.approx(1.115)
    assert out["plan"]["steps"][0]["closePercent"] == 50
    assert worker.store.payload("position.plan.update")["stepId"] == "step1"


def test_update_requires_existing_plan(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    with pytest.raises(GatewayError) as exc:
        worker._plan_update({"ticket": 11, "stepId": "step1", "price": 1.11})

    assert exc.value.code == "NO_PLAN"


def test_remove_and_clear(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    seed_plan(worker)

    out = worker._plan_remove({"ticket": 11, "stepId": "step1"})
    assert out["plan"]["steps"] == []

    cleared = worker._plan_clear({"ticket": 11})
    assert cleared == {"plan": None}
    assert 11 not in worker._auto_be
    assert worker.store.kinds()[-1] == "position.plan.clear"


def test_remove_unknown_step_raises(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    seed_plan(worker)

    with pytest.raises(GatewayError) as exc:
        worker._plan_remove({"ticket": 11, "stepId": "nope"})

    assert exc.value.code == "NO_STEP"


def test_sell_steps_sort_descending(monkeypatch):
    worker, _, _ = make_worker(
        monkeypatch, positions=[position(type=1, sl=1.2, tp=0.9)]
    )
    worker._plan_add({"ticket": 11, "price": 1.05, "closePercent": 50})
    worker._plan_add({"ticket": 11, "price": 1.02, "closePercent": 30})

    steps = worker._auto_be[11]["steps"]
    assert [step["price"] for step in steps] == [1.05, 1.02]


# ---------- 执行 ----------


def test_trigger_closes_percent_and_marks_done(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    seed_plan(worker, step={"price": 1.19})

    worker._auto_breakeven()

    assert [item["volume"] for item in sent] == [pytest.approx(0.5)]
    assert sent[0]["comment"] == "plan-step1"
    step = worker._auto_be[11]["steps"][0]
    assert step["done"] is True
    assert step["skipped"] is False
    payload = worker.store.payload("position.plan.step")
    assert payload["ticket"] == 11
    assert payload["closedVolume"] == pytest.approx(0.5)
    # 全部完成也保留计划，供面板显示历史
    assert 11 in worker._auto_be


def test_initial_volume_thirds_across_two_tiers(monkeypatch):
    """两档 + 最终止盈共三份：每档按开仓手数的 1/3 平仓。"""
    worker, sent, positions = make_worker(monkeypatch)
    worker._plan_add({"ticket": 11, "price": 1.15, "closePercent": 33.33})
    worker._plan_add({"ticket": 11, "price": 1.17, "closePercent": 33.33})

    plan = worker._auto_be[11]
    assert plan["initialVolume"] == pytest.approx(1.0)
    assert plan["volumeBase"] == "initial"
    payload = worker._plan_payload(plan)
    assert payload["initialVolume"] == pytest.approx(1.0)
    assert payload["volumeBase"] == "initial"

    worker._auto_breakeven()
    assert [item["volume"] for item in sent] == [pytest.approx(0.33)]

    positions[0].volume = 0.67
    worker._auto_breakeven()
    assert [item["volume"] for item in sent] == [
        pytest.approx(0.33),
        pytest.approx(0.33),
    ]


def test_percent_sum_cannot_exceed_100(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    worker._plan_add({"ticket": 11, "price": 1.12, "closePercent": 60})

    with pytest.raises(GatewayError) as exc:
        worker._plan_add({"ticket": 11, "price": 1.14, "closePercent": 50})

    assert exc.value.code == "PLAN_PERCENT_SUM"


def test_initial_base_eats_sub_min_remainder(monkeypatch):
    info = symbol_info(volume_step=0.1, volume_min=0.1)
    worker, sent, _ = make_worker(monkeypatch, info=info, positions=[position(volume=0.25)])
    seed_plan(
        worker,
        initialVolume=0.25,
        volumeBase="initial",
        step={"price": 1.15, "closePercent": 99},
    )

    worker._auto_breakeven()

    # 99% 取整后 0.2，剩 0.05 不足最小手数，这一档把余量一起平掉
    assert [item["volume"] for item in sent] == [pytest.approx(0.25)]


def test_no_execution_before_trigger(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    seed_plan(worker, step={"price": 1.25})

    worker._auto_breakeven()

    assert sent == []
    assert worker._auto_be[11]["steps"][0]["done"] is False


def test_step_beyond_take_profit_is_not_executed(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    seed_plan(worker, step={"price": 1.21})

    worker._auto_breakeven()

    assert sent == []
    assert worker._auto_be[11]["steps"][0]["done"] is False


def test_unsplittable_step_is_skipped_once(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch, positions=[position(volume=0.01)])
    seed_plan(worker, step={"price": 1.15})

    worker._auto_breakeven()
    worker._auto_breakeven()

    assert sent == []
    step = worker._auto_be[11]["steps"][0]
    assert step["done"] is True
    assert step["skipped"] is True
    assert worker.store.kinds().count("position.plan.step") == 1
    assert worker.store.payload("position.plan.step")["skipped"] is True


def test_already_filled_step_is_not_repeated(monkeypatch):
    deal = types.SimpleNamespace(comment="plan-step1")
    worker, sent, _ = make_worker(monkeypatch, deals=[deal])
    seed_plan(worker, step={"price": 1.15})

    worker._auto_breakeven()

    assert sent == []
    assert worker._auto_be[11]["steps"][0]["done"] is True
    assert worker.store.kinds().count("position.plan.step.recovered") == 1


def test_step_breakeven_uses_plan_offset(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    plan = seed_plan(worker, step={"price": 1.1001, "moveBreakeven": True})
    plan["breakevenOffsetPoints"] = 3.0

    worker._auto_breakeven()

    sltp = next(item for item in sent if item["action"] == 6)
    # 3 个点 = 0.00003，多单保本价加在开仓价上方
    assert sltp["sl"] == pytest.approx(1.10003)


def test_add_step_persists_breakeven_offset(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)

    out = worker._plan_add(
        {"ticket": 11, "price": 1.105, "closePercent": 50, "breakevenOffsetPoints": 4}
    )

    assert out["plan"]["breakevenOffsetPoints"] == pytest.approx(4)
    assert worker.store.state["autoBreakeven"]["11"]["breakevenOffsetPoints"] == pytest.approx(4)


def test_step_skips_breakeven_but_still_closes(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    seed_plan(worker, step={"price": 1.10002, "moveBreakeven": True})
    # 到价了，但现价还没离开仓价足够远（不足 6 个点），保本放不下
    mt5_worker.mt5.symbol_info_tick = lambda name: types.SimpleNamespace(bid=1.10002, ask=1.10002)

    worker._auto_breakeven()

    assert [item for item in sent if item["action"] == 6] == []
    deals = [item for item in sent if item["action"] == 1]
    assert len(deals) == 1
    payload = worker.store.payload("position.plan.step")
    assert payload["breakeven"] is None
    assert payload["breakevenSkipped"] is True
    assert payload["closedVolume"] == pytest.approx(0.5)


def test_plan_dropped_when_position_is_gone(monkeypatch):
    worker, _, _ = make_worker(monkeypatch, positions=[])
    seed_plan(worker)

    worker._auto_breakeven()

    assert worker._auto_be == {}


def test_plan_dropped_when_trigger_cannot_be_computed(monkeypatch):
    worker, _, _ = make_worker(monkeypatch)
    seed_plan(
        worker,
        risk=0.0,
        step={"price": None, "atR": 1.0},
    )

    worker._auto_breakeven()

    assert worker._auto_be == {}


def test_steps_run_in_price_order(monkeypatch):
    worker, sent, _ = make_worker(monkeypatch)
    plan = seed_plan(
        worker,
        steps=[
            {
                "id": "far",
                "price": 1.18,
                "atR": None,
                "closePercent": 25.0,
                "moveBreakeven": False,
                "done": False,
                "skipped": False,
            },
            {
                "id": "near",
                "price": 1.15,
                "atR": None,
                "closePercent": 25.0,
                "moveBreakeven": False,
                "done": False,
                "skipped": False,
            },
        ],
    )

    worker._auto_breakeven()

    # 现价 1.2 已经越过两档；每轮只执行一档，先近后远
    by_id = {step["id"]: step for step in plan["steps"]}
    assert by_id["near"]["done"] is True
    assert by_id["far"]["done"] is False
    assert len(sent) == 1
