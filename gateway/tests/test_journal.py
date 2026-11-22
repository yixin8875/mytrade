"""日志侧的纯函数：加权成交价、平仓分类、截图标注清洗。"""

import time

import journal as journal_module
from journal import (
    TradeJournal,
    _clean_shot_meta,
    _close_kind,
    _duration_bucket,
    _execution_cross,
    _plan_fidelity,
    _r_multiple,
    _r_summary,
    _row_offset,
    _weighted,
)
from store import Store


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


def test_row_offset_prefers_row_value_over_fallback():
    assert _row_offset({"server_offset": 3600}, 0) == 3600
    assert _row_offset({"server_offset": None}, 7200) == 7200
    assert _row_offset({}, -3600) == -3600


class _StatsStore:
    """只覆盖 journal.stats 需要的查询，用来验证时间口径。"""

    def __init__(self, base_dir, rows):
        self.base_dir = base_dir
        self.rows = rows
        self.since = None
        self.execution_since = None

    def journal_list(self, limit=200, since=0, login=0, filters=None):
        self.since = since
        self.filters = filters
        return list(self.rows[:limit])

    def position_risk_map(self, login, tickets):
        return {}

    def intent_sl_map(self, login, tickets):
        return {}

    def journal_set_risks(self, login, risks):
        pass

    def execution_entry_map(self, login, since):
        self.execution_since = since
        return {}


def _row(position_id=1, open_time=1_700_000_000, server_offset=0):
    return {
        "position_id": position_id,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.081,
        "profit": 10.0,
        "swap": 0.0,
        "commission": 0.0,
        "open_time": open_time,
        "close_time": open_time + 600,
        "duration_sec": 600,
        "mfe": 20.0,
        "mae": -5.0,
        "tag": None,
        "closed_by": "manual",
        "has_shot": 0,
        "risk": 10.0,
        "risk_source": "journal",
        "recorded_at": 0,
        "server_offset": server_offset,
    }


def _hour_key(stats):
    return int(stats["byHour"][0]["key"][:2])


def test_stats_by_hour_uses_row_server_offset(tmp_path):
    store = _StatsStore(tmp_path, [_row(server_offset=None)])
    journal = TradeJournal(store)

    fallback_zero = journal.stats(days=30, login=1, server_offset=0, timezone_offset_min=0)
    fallback_known = journal.stats(days=30, login=1, server_offset=3600, timezone_offset_min=0)

    # 单笔记录自己带偏移时，优先用它，而不是账户当前偏移
    store.rows = [_row(server_offset=3600)]
    row_offset = journal.stats(days=30, login=1, server_offset=0, timezone_offset_min=0)

    assert _hour_key(fallback_known) == (_hour_key(fallback_zero) - 1) % 24
    assert _hour_key(row_offset) == _hour_key(fallback_known)


def test_stats_by_hour_uses_close_time_in_review_timezone(tmp_path):
    # 开仓 23:50、平仓次日 00:10：应归入平仓后的本地小时
    open_time = 1_700_000_000
    row = _row(open_time=open_time)
    row["close_time"] = open_time + 20 * 60
    store = _StatsStore(tmp_path, [row])
    journal = TradeJournal(store)

    stats = journal.stats(days=30, login=1, server_offset=0, timezone_offset_min=480)

    expected_hour = ((open_time + 20 * 60 + 480 * 60) % 86400) // 3600
    assert _hour_key(stats) == expected_hour


def test_stats_window_is_local_calendar_days(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=2, login=1, server_offset=3600, timezone_offset_min=480)

    now = int(time.time())
    local_midnight = ((now + 480 * 60) // 86400) * 86400
    expected = local_midnight - 86400 - 480 * 60 + 3600
    assert abs(store.since - expected) <= 2


def test_stats_explicit_since_overrides_days(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=30, login=1, server_offset=3600, since=1_700_000_000)

    # 调用方指定「今天」的起点时，不再用 days 回推滚动窗口
    assert store.since == 1_700_000_000


def test_stats_explicit_since_never_negative(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=30, login=1, server_offset=3600, since=-100)

    assert store.since == 0


def test_stats_execution_window_uses_resolved_start(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=30, login=1, server_offset=0, timezone_offset_min=480)

    # 默认不传 since 时，执行成本查询必须用算出来的窗口起点；
    # 直接把 None 传下去会让 int(None) 抛 TypeError，报表整块打不开
    assert store.execution_since is not None
    assert store.execution_since == store.since


def test_stats_all_range_execution_window_is_zero(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=0, login=1, server_offset=0, timezone_offset_min=480)

    assert store.execution_since == 0


def test_stats_all_range_passes_filters_through(tmp_path):
    store = _StatsStore(tmp_path, [_row()])
    journal = TradeJournal(store)

    journal.stats(days=0, login=1, server_offset=3600, filters={"symbol": "EURUSD"})

    # 「全部」= 不设时间下限；筛选原样交给 store，保证列表与统计口径一致
    assert store.since == 0
    assert store.filters == {"symbol": "EURUSD"}


def _journal_record(position_id=9, server_offset=None):
    return {
        "login": 1,
        "position_id": position_id,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.085,
        "profit": 50.0,
        "open_time": 100,
        "close_time": 200,
        "duration_sec": 100,
        "server_offset": server_offset,
    }


def test_sync_backfills_offset_even_without_new_deals(tmp_path, monkeypatch):
    store = Store(tmp_path)
    store.upsert_journal(_journal_record())
    monkeypatch.setattr(journal_module.mt5, "history_deals_get", lambda *a, **k: [])
    journal = TradeJournal(store)

    assert journal.sync(1, force=True, server_offset=3600) == 0

    assert (store.journal_get(9, 1) or {})["server_offset"] == 3600
