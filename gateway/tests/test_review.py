"""复盘层：日历日归属、日笔记、策略规则与遵守度。"""

from datetime import datetime, timezone

import pytest

from review import Review, ReviewError
from store import Store


def epoch(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())


def add_trade(
    store: Store,
    position_id: int,
    close_time: int,
    profit: float,
    risk: float | None = None,
    login: int = 1,
    symbol: str = "EURUSD",
) -> None:
    store.upsert_journal(
        {
            "login": login,
            "position_id": position_id,
            "symbol": symbol,
            "side": "buy",
            "volume": 1.0,
            "entry_price": 1.1,
            "exit_price": 1.1 + profit / 10000,
            "profit": profit,
            "swap": 0,
            "commission": 0,
            "open_time": close_time - 600,
            "close_time": close_time,
            "duration_sec": 600,
            "mfe": max(profit, 0),
            "mae": min(profit, 0),
            "tag": None,
            "closed_by": "manual",
            "risk": risk,
            "risk_source": "order" if risk else None,
        }
    )


@pytest.fixture()
def store(tmp_path):
    instance = Store(tmp_path)
    instance.review_setting_set("timezone_offset_min", 0)
    return instance


class _RiskJournal:
    """替身：只验证 Review 会把缺失风险交给台账补齐。"""

    def ensure_risks(self, rows, login):
        for row in rows:
            if not row.get("risk"):
                row["risk"] = 50.0


def test_trades_backfills_missing_risk_from_journal(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 100.0, risk=None)

    payload = Review(store, _RiskJournal()).trades({"days": 30}, 1, 0)

    assert payload["trades"][0]["r"] == 2.0
    assert payload["trades"][0]["risk"] == 50.0


def test_trades_without_journal_keeps_r_empty(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 100.0, risk=None)

    payload = Review(store).trades({"days": 30}, 1, 0)

    assert payload["trades"][0]["r"] is None


def test_calendar_groups_days_and_weeks(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 100.0)
    add_trade(store, 2, epoch(2026, 11, 3, 12), -40.0)
    add_trade(store, 3, epoch(2026, 11, 4, 9), 30.0)

    payload = Review(store).calendar({"month": "2026-11"}, 1, 0)
    days = {
        day["date"]: day
        for week in payload["weeks"]
        for day in week["days"]
        if day is not None
    }
    assert days["2026-11-03"]["net"] == 60.0
    assert days["2026-11-03"]["trades"] == 2
    assert days["2026-11-03"]["wins"] == 1
    assert days["2026-11-03"]["losses"] == 1
    assert days["2026-11-04"]["net"] == 30.0
    assert payload["summary"]["net"] == 90.0
    assert payload["summary"]["tradingDays"] == 2
    assert payload["summary"]["winDays"] == 2


def test_calendar_week_total_keeps_adjacent_month(store: Store):
    add_trade(store, 1, epoch(2026, 10, 27, 10), 50.0)
    add_trade(store, 2, epoch(2026, 11, 1, 10), 20.0)
    add_trade(store, 3, epoch(2026, 11, 3, 10), 100.0)

    payload = Review(store).calendar({"month": "2026-11"}, 1, 0)
    # 2026-11-01 是周日，周一起点的那一周从 10-26 开始
    week = next(week for week in payload["weeks"] if week["days"][6] is not None)
    assert week["days"][6]["date"] == "2026-11-01"
    assert week["days"][1] is None  # 10-27 属于上个月，不显示格子
    assert week["total"] == 70.0
    assert payload["summary"]["net"] == 120.0


def test_day_key_applies_server_and_timezone_offsets(store: Store):
    store.review_setting_set("timezone_offset_min", 480)
    # 本地 2026-11-04 00:30 = UTC 11-03 16:30；券商服务器 UTC+3，raw 再加 3 小时
    raw = epoch(2026, 11, 3, 19, 30)
    add_trade(store, 1, raw, 10.0)
    payload = Review(store).calendar({"month": "2026-11"}, 1, 3 * 3600)
    days = [
        day
        for week in payload["weeks"]
        for day in week["days"]
        if day is not None and day["trades"] > 0
    ]
    assert days[0]["date"] == "2026-11-04"


def test_day_returns_note_and_rule_annotation(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 100.0)
    review = Review(store)
    book = review.strategy_save({"name": "突破", "rules": ["A", "B"]}, 1)["playbook"]
    review.trade_note_save({"positionId": 1, "playbookId": book["id"]}, 1)
    review.check(
        {"positionId": 1, "playbookId": book["id"], "rule": "A", "followed": True}, 1
    )
    review.check(
        {"positionId": 1, "playbookId": book["id"], "rule": "B", "followed": False}, 1
    )
    review.note_save({"date": "2026-11-03", "note": "盘前计划"}, 1)

    payload = review.day({"date": "2026-11-03"}, 1, 0)
    assert payload["note"]["note"] == "盘前计划"
    record = payload["records"][0]
    assert record["annotation"]["playbookName"] == "突破"
    assert record["annotation"]["followed"] == 1
    assert record["annotation"]["broken"] == 1
    assert record["r"] is None


def test_note_and_templates_round_trip(store: Store):
    review = Review(store)
    saved = review.note_save(
        {"date": "2026-11-03", "note": "hello", "mood": 4, "tags": ["耐心"]}, 1
    )
    assert saved["note"]["tags"] == ["耐心"]
    assert store.day_note_get("2026-11-03", 1)["mood"] == 4

    template = review.template_save({"name": "盘后", "body": "今天做对了什么？"}, 1)
    assert review.templates({}, 1)["templates"][0]["name"] == "盘后"
    review.template_delete({"id": template["template"]["id"]}, 1)
    assert review.templates({}, 1)["templates"] == []

    with pytest.raises(ReviewError):
        review.note_save({"date": "2026/11/03", "note": "bad"}, 1)


def test_trade_note_returns_pre_trade_snapshot(store: Store):
    add_trade(store, 5, epoch(2026, 11, 3, 12), 10.0, risk=5.0)
    review = Review(store)
    book = review.strategy_save({"name": "突破", "rules": ["A", "B"]}, 1)["playbook"]

    store.pre_trade_gate_start(1, "cid", book["id"], "block", ["A", "B"])
    store.pre_trade_check_set(1, "cid", book["id"], "A", True)
    store.pre_trade_check_set(1, "cid", book["id"], "B", False)
    store.pre_trade_gate_update(
        1, "cid", "overridden", reason="急单", position_id=5
    )

    pre = review.trade_note({"positionId": 5}, 1)["preTrade"]

    assert pre["playbookName"] == "突破"
    assert pre["mode"] == "block"
    assert pre["state"] == "overridden"
    assert pre["reason"] == "急单"
    assert pre["rules"] == [
        {"rule": "A", "followed": True, "evaluated": True},
        {"rule": "B", "followed": False, "evaluated": True},
    ]
    assert pre["missing"] == []
    assert pre["violated"] == ["B"]


def test_trade_note_without_gate_has_no_pre_trade(store: Store):
    add_trade(store, 6, epoch(2026, 11, 3, 12), 10.0)

    assert Review(store).trade_note({"positionId": 6}, 1)["preTrade"] is None


def test_adherence_counts_pre_trade_completion(store: Store):
    review = Review(store)
    book = review.strategy_save({"name": "突破", "rules": ["A"]}, 1)["playbook"]

    for client, state in (
        ("g1", "passed"),
        ("g2", "overridden"),
        ("g3", "skipped"),
        ("g4", "pending"),
    ):
        store.pre_trade_gate_start(1, client, book["id"], "confirm", ["A"])
        if state != "pending":
            store.pre_trade_gate_update(1, client, state)

    pre = review.adherence({"days": 90}, 1, 0)["books"][0]["preTrade"]

    assert pre == {
        "total": 4,
        "passed": 1,
        "overridden": 1,
        "skipped": 1,
        "pending": 1,
        "completionRate": 0.5,
        "overrideRate": 0.5,
    }


def test_adherence_classifies_followed_broken_and_unassessed(store: Store):
    now = epoch(2026, 11, 3, 12)
    for position_id in (1, 2, 3):
        add_trade(store, position_id, now, 10.0, risk=5.0)
    review = Review(store)
    book = review.strategy_save(
        {"name": "突破", "rules": ["A", "B"]}, 1
    )["playbook"]
    for position_id in (1, 2, 3):
        review.trade_note_save(
            {"positionId": position_id, "playbookId": book["id"]}, 1
        )
    review.check(
        {"positionId": 1, "playbookId": book["id"], "rule": "A", "followed": True}, 1
    )
    review.check(
        {"positionId": 1, "playbookId": book["id"], "rule": "B", "followed": True}, 1
    )
    review.check(
        {"positionId": 2, "playbookId": book["id"], "rule": "A", "followed": True}, 1
    )
    review.check(
        {"positionId": 2, "playbookId": book["id"], "rule": "B", "followed": False}, 1
    )

    payload = review.adherence({"days": 90}, 1, 0)
    result = payload["books"][0]
    assert result["total"] == 3
    assert result["followed"]["trades"] == 1
    assert result["broken"]["trades"] == 1
    assert result["unassessed"] == 1
    assert result["rate"] == pytest.approx(0.75)
    stats = {item["rule"]: item for item in result["ruleStats"]}
    assert stats["A"]["rate"] == 1.0
    assert stats["B"]["rate"] == 0.5


def test_changing_playbook_clears_rule_checks(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 10.0)
    review = Review(store)
    first = review.strategy_save({"name": "突破", "rules": ["A"]}, 1)["playbook"]
    second = review.strategy_save({"name": "回踩", "rules": ["A"]}, 1)["playbook"]
    review.trade_note_save({"positionId": 1, "playbookId": first["id"]}, 1)
    review.check(
        {"positionId": 1, "playbookId": first["id"], "rule": "A", "followed": True}, 1
    )
    assert store.playbook_checks_get(1, 1) == {"A": True}

    review.trade_note_save({"positionId": 1, "playbookId": second["id"]}, 1)
    assert store.playbook_checks_get(1, 1) == {}


def test_playbook_delete_is_soft_and_keeps_notes(store: Store):
    add_trade(store, 1, epoch(2026, 11, 3, 10), 10.0)
    review = Review(store)
    book = review.strategy_save({"name": "突破", "rules": ["A"]}, 1)["playbook"]
    review.trade_note_save({"positionId": 1, "playbookId": book["id"]}, 1)
    review.strategy_delete({"id": book["id"]}, 1)
    assert review.strategy_list({}, 1)["playbooks"] == []
    assert store.trade_note_get(1, 1)["playbook_id"] == book["id"]
    assert (
        review.strategy_list({"includeArchived": True}, 1)["playbooks"][0][
            "tradeCount"
        ]
        == 1
    )


def test_trades_series_sorted_with_r(store: Store):
    now = int(datetime.now(timezone.utc).timestamp())
    add_trade(store, 1, now - 3600, 100.0, risk=50.0)
    add_trade(store, 2, now - 1800, -25.0, risk=50.0)
    add_trade(store, 3, now - 900, 10.0)  # 没有止损 → 不计 R

    result = Review(store).trades({"days": 7}, 1, 0)
    assert result["days"] == 7
    assert [trade["positionId"] for trade in result["trades"]] == [1, 2, 3]
    assert result["trades"][0]["r"] == pytest.approx(2.0)
    assert result["trades"][1]["r"] == pytest.approx(-0.5)
    assert result["trades"][2]["r"] is None
    expected_day = datetime.fromtimestamp(now - 3600, timezone.utc).strftime("%Y-%m-%d")
    assert result["trades"][0]["day"] == expected_day


def test_trades_clamps_days_and_ignores_other_logins(store: Store):
    now = int(datetime.now(timezone.utc).timestamp())
    add_trade(store, 1, now - 600, 5.0, login=1)
    add_trade(store, 2, now - 600, 5.0, login=2)

    result = Review(store).trades({"days": 1}, 1, 0)
    assert result["days"] == 7
    assert len(result["trades"]) == 1
    assert result["trades"][0]["positionId"] == 1



def test_trade_note_reviewed_toggles_without_touching_content(store: Store):
    add_trade(store, 11, epoch(2026, 11, 3, 12), 10.0)
    review = Review(store)

    marked = review.trade_note_reviewed({"positionId": 11, "reviewed": True}, 1)
    assert marked["reviewedAt"] > 0
    note = store.trade_note_get(11, 1) or {}
    assert note["note"] == ""
    assert note["rating"] is None
    assert note["mistakes"] == []
    # journal.list 带上复盘标记，日志行才能显示徽标
    assert store.journal_list(100, 0, 1)[0]["reviewed_at"] == marked["reviewedAt"]

    cleared = review.trade_note_reviewed({"positionId": 11, "reviewed": False}, 1)
    assert cleared["reviewedAt"] is None
    assert store.journal_list(100, 0, 1)[0]["reviewed_at"] is None


def test_trade_note_reviewed_requires_owned_trade(store: Store):
    review = Review(store)

    with pytest.raises(ReviewError) as missing:
        review.trade_note_reviewed({}, 1)
    assert missing.value.code == "BAD_ID"

    # 别的账户的交易不能标记已复盘
    add_trade(store, 12, epoch(2026, 11, 3, 12), 10.0, login=2)
    with pytest.raises(ReviewError):
        review.trade_note_reviewed({"positionId": 12, "reviewed": True}, 1)
