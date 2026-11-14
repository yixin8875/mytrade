"""过程评分：样本门槛、分量映射与权重归一化。"""

from datetime import datetime, timezone

import pytest

from review import Review
from score import MIN_TRADES, Score, TALLY_SCORE_VERSION
from store import Store


def epoch_now(offset_seconds: int = 0) -> int:
    return int(datetime.now(timezone.utc).timestamp()) + offset_seconds


def epoch_noon(offset_seconds: int = 0) -> int:
    """今天 UTC 正午，保证同一批交易落在同一天。"""
    noon = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    return int(noon.timestamp()) + offset_seconds


def add_trade(
    store: Store, position_id: int, close_time: int, profit: float, risk: float | None = 10.0
) -> None:
    store.upsert_journal(
        {
            "login": 1,
            "position_id": position_id,
            "symbol": "EURUSD",
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


def make_score(store: Store) -> Score:
    return Score(store, Review(store))


def test_small_sample_gets_no_score(store: Store):
    for index in range(MIN_TRADES - 1):
        add_trade(store, index + 1, epoch_now(-index * 60), 10.0)
    result = make_score(store).get({"days": 90}, 1, 0)
    assert result["score"] is None
    assert result["note"] and "满 20 笔" in result["note"]
    assert result["sample"]["trades"] == MIN_TRADES - 1
    assert result["version"] == TALLY_SCORE_VERSION


def test_all_winners_score_high_and_skip_payoff(store: Store):
    for index in range(MIN_TRADES):
        add_trade(store, index + 1, epoch_noon(-index * 60), 10.0)
    result = make_score(store).get({"days": 90}, 1, 0)
    by_key = {item["key"]: item for item in result["components"]}
    assert by_key["expectancy"]["score"] == 100.0
    assert by_key["win_rate"]["score"] == 100.0
    assert by_key["drawdown"]["score"] == 100.0
    assert by_key["recovery"]["score"] == 100.0
    # 20 笔全在一天，日集中度得 0
    assert by_key["concentration"]["score"] == 0.0
    assert by_key["payoff"]["included"] is False
    assert by_key["payoff"]["reason"]
    assert by_key["discipline"]["included"] is False
    # (0.25 + 0.15 + 0.15 + 0.10) * 100 / 0.75（payoff 与 discipline 剔除）
    assert result["score"] == pytest.approx(86.7, abs=0.1)


def test_mixed_sequence_renormalizes_weights(store: Store):
    # 先 10 笔盈利再 10 笔亏损：累计 R 从 +10 回撤到 0，最大回撤 10R
    for index in range(10):
        add_trade(store, index + 1, epoch_noon(-(30 - index) * 60), 10.0)
    for index in range(10):
        add_trade(store, index + 11, epoch_noon(-(20 - index) * 60), -10.0)

    result = make_score(store).get({"days": 90}, 1, 0)
    by_key = {item["key"]: item for item in result["components"]}
    assert by_key["expectancy"]["score"] == 50.0
    assert by_key["win_rate"]["score"] == 60.0
    assert by_key["payoff"]["score"] == 25.0
    assert by_key["drawdown"]["score"] == 0.0
    assert by_key["recovery"]["score"] == 0.0
    # 当天净盈亏正好为 0，没有可衡量的日集中度
    assert by_key["concentration"]["included"] is False
    # 0.25*50 + 0.15*60 + 0.15*25 = 25.25，除以剩余权重 0.80
    assert result["score"] == pytest.approx(31.6, abs=0.1)


def test_discipline_component_uses_playbook_checks(store: Store):
    review = Review(store)
    book = review.strategy_save({"name": "突破", "rules": ["等回踩"]}, 1)["playbook"]
    for index in range(MIN_TRADES):
        position_id = index + 1
        add_trade(store, position_id, epoch_noon(-index * 60), 10.0)
        review.trade_note_save({"positionId": position_id, "playbookId": book["id"]}, 1)
        review.check(
            {
                "positionId": position_id,
                "playbookId": book["id"],
                "rule": "等回踩",
                "followed": True,
            },
            1,
        )

    result = Score(store, review).get({"days": 90}, 1, 0)
    by_key = {item["key"]: item for item in result["components"]}
    assert by_key["discipline"]["included"] is True
    assert by_key["discipline"]["score"] == 100.0
