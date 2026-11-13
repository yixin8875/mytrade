"""日志侧的纯函数：加权成交价、平仓分类、截图标注清洗。"""

from journal import (
    _clean_shot_meta,
    _close_kind,
    _duration_bucket,
    _execution_cross,
    _plan_fidelity,
    _r_multiple,
    _r_summary,
    _weighted,
)


def test_weighted_price_uses_volume():
    assert _weighted([(1.0, 100.0), (3.0, 200.0)]) == 175.0
    assert _weighted([]) == 0.0


def test_close_kind_reads_comment_prefix():
    assert _close_kind("tp 106.0") == "tp"
    assert _close_kind(" SL ") == "sl"
    assert _close_kind("so margin") == "stop_out"
    assert _close_kind("tpl-partial") == "manual"
    assert _close_kind("") == "manual"


def test_clean_shot_meta_needs_two_anchors():
    assert _clean_shot_meta(None) is None
    assert _clean_shot_meta({"anchors": [{"price": 1, "y": 0.5}]}) is None
    assert _clean_shot_meta({"anchors": [{"price": "x", "y": 0.5}]}) is None


def test_clean_shot_meta_clamps_and_truncates():
    meta = {
        "digits": 99,
        "symbol": "X" * 60,
        "interval": "1".ljust(20, "0"),
        "anchors": [
            {"price": 1.23456789012345, "y": 2},
            {"price": 2.0, "y": -1},
            *[{"price": index, "y": 0.5} for index in range(20)],
        ],
    }
    clean = _clean_shot_meta(meta)
    assert clean is not None
    assert clean["digits"] == 8
    assert len(clean["symbol"]) == 40
    assert len(clean["interval"]) == 12
    assert len(clean["anchors"]) == 8
    assert clean["anchors"][0]["price"] == 1.2345678901
    assert clean["anchors"][0]["y"] == 1.0
    assert clean["anchors"][1]["y"] == 0.0


def test_duration_bucket_splits_by_holding_time():
    assert _duration_bucket(0) == "15 分内"
    assert _duration_bucket(899) == "15 分内"
    assert _duration_bucket(900) == "15 分–1 时"
    assert _duration_bucket(3599) == "15 分–1 时"
    assert _duration_bucket(3600) == "1–4 时"
    assert _duration_bucket(4 * 3600) == "4–24 时"
    assert _duration_bucket(24 * 3600) == "1 天以上"


def test_r_multiple_needs_positive_risk():
    assert _r_multiple(50.0, 25.0) == 2.0
    assert _r_multiple(-12.5, 25.0) == -0.5
    assert _r_multiple(50.0, None) is None
    assert _r_multiple(50.0, 0) is None


def test_r_summary_reports_drawdown_in_r():
    curve = [
        {"t": 1, "r": 1.0, "cum": 1.0},
        {"t": 2, "r": -2.0, "cum": -1.0},
        {"t": 3, "r": 0.5, "cum": -0.5},
        {"t": 4, "r": 1.5, "cum": 1.0},
    ]
    summary = _r_summary(curve, hit1r=2, total_trades=8)
    assert summary["trades"] == 4
    assert summary["coverage"] == 50.0
    assert summary["avgR"] == 0.25
    assert summary["totalR"] == 1.0
    assert summary["maxDrawdownR"] == 2.0
    assert summary["bestR"] == 1.5
    assert summary["worstR"] == -2.0
    assert summary["hit1R"] == 50.0


def test_plan_fidelity_counts_reached_breakeven_and_held():
    rows = [
        {"position_id": 1, "profit": 40.0, "mfe": 60.0},
        {"position_id": 2, "profit": -20.0, "mfe": 30.0},
        {"position_id": 3, "profit": 10.0, "mfe": 8.0},
        {"position_id": 4, "profit": 10.0, "mfe": 50.0},
    ]
    risks = {1: 20.0, 2: 20.0, 3: 20.0, 4: 20.0}
    plans = {1: {}, 2: {}, 3: {}, 4: {}}
    steps = {
        1: [{"atR": 1.0, "breakeven": 1.085, "closedVolume": None}],
        2: [{"atR": 1.0, "breakeven": None, "closedVolume": 0.05}],
        4: [{"atR": 2.0, "breakeven": None}],
    }
    fidelity = _plan_fidelity(rows, risks, plans, steps)
    assert fidelity["planned"] == 4
    assert fidelity["reached1R"] == 3  # 第 3 笔最高只走到 0.4R
    assert fidelity["breakeven"] == 1  # 只有第 1 笔真的移了保本
    assert fidelity["held"] == 1
    assert fidelity["breakevenRate"] == 33.3
    assert fidelity["heldRate"] == 100.0
    assert fidelity["avgR"] == 0.5


def test_plan_fidelity_without_risk_skips_r():
    rows = [{"position_id": 9, "profit": 10.0, "mfe": 50.0}]
    fidelity = _plan_fidelity(rows, {}, {9: {}}, {})
    assert fidelity["reached1R"] == 0
    assert fidelity["avgR"] is None
    assert fidelity["breakevenRate"] is None


def test_execution_cross_groups_winners_and_losers():
    rows = [
        {"position_id": 1, "profit": 10.0},
        {"position_id": 2, "profit": -4.0},
        {"position_id": 3, "profit": 2.0},
        {"position_id": 99, "profit": 1.0},
    ]
    entries = {
        1: {"spread": 1.0, "slippage": 0.0},
        2: {"spread": 2.0, "slippage": -0.5},
        3: {"spread": 1.0, "slippage": 0.5},
    }
    cross = _execution_cross(rows, entries)
    assert cross["matched"] == 3
    assert cross["wins"]["trades"] == 2
    assert cross["wins"]["avgSlippage"] == 0.25
    assert cross["wins"]["avgSpread"] == 1.0
    assert cross["losses"]["trades"] == 1
    assert cross["losses"]["avgSlippage"] == -0.5
