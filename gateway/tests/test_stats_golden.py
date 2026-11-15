"""跨端统计口径：同一份黄金样本，后端 journal.stats 与前端 analysis.summarize 必须一致。"""

import json
from pathlib import Path

from journal import TradeJournal

FIXTURE = Path(__file__).resolve().parents[2] / "testdata" / "stats_golden.json"


class FakeStore:
    def __init__(self, base_dir: Path, rows: list[dict]) -> None:
        self.base_dir = base_dir
        self.rows = rows

    def journal_list(self, limit=200, since=0, login=0, filters=None):
        return self.rows[:limit]

    def position_risk_map(self, login, tickets):
        return {}

    def intent_sl_map(self, login, tickets):
        return {}

    def journal_set_risks(self, login, risks):
        pass

    def execution_entry_map(self, login, since):
        return {}


def load_rows() -> tuple[dict, list[dict], int]:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    rows = []
    for trade in data["trades"]:
        rows.append(
            {
                "position_id": trade["positionId"],
                "symbol": trade["symbol"],
                "side": trade["side"],
                "volume": trade["volume"],
                "entry_price": 1.0,
                "exit_price": 1.0,
                "profit": trade["profit"],
                "swap": 0.0,
                "commission": 0.0,
                "open_time": trade["openTime"],
                "close_time": trade["closeTime"],
                "duration_sec": trade["durationSec"],
                "mfe": trade["mfe"],
                "mae": trade["mae"],
                "tag": trade["tag"],
                "closed_by": "manual",
                "has_shot": 0,
                "risk": trade["risk"],
                "risk_source": "journal" if trade["risk"] is not None else None,
                "recorded_at": 0,
            }
        )
    return data["expected"], rows, int(data.get("serverOffset") or 0)


def _by_key(groups: list[dict]) -> dict[str, dict]:
    return {group["key"]: group for group in groups}


def _assert_groups(groups: list[dict], expected: dict[str, dict]) -> None:
    actual = _by_key(groups)
    assert sorted(actual) == sorted(expected)
    for key, values in expected.items():
        row = actual[key]
        assert row["trades"] == values["trades"], key
        assert row["wins"] == values["wins"], key
        assert row["pnl"] == values["pnl"], key
        assert row["winRate"] == values["winRate"], key
        assert row["avgR"] == values["avgR"], key


def test_golden_stats_match_shared_expectations(tmp_path):
    expected, rows, server_offset = load_rows()
    journal = TradeJournal(FakeStore(tmp_path, rows))

    stats = journal.stats(days=30, login=1, server_offset=server_offset)
    summary = stats["summary"]

    assert summary["trades"] == expected["trades"]
    assert summary["wins"] == expected["wins"]
    assert summary["losses"] == expected["losses"]
    assert summary["netPnl"] == expected["net"]
    # 后端返回百分数，共享样本用比例，便于前端直接对照
    assert summary["winRate"] == round(expected["winRate"] * 100, 1)
    assert summary["truncated"] is False
    assert summary["avgDurationSec"] == expected["avgDurationSec"]
    assert summary["profitFactor"] == expected["profitFactor"]
    assert summary["expectancy"] == expected["expectancy"]
    assert stats["r"]["trades"] == expected["rTrades"]
    assert stats["r"]["avgR"] == expected["avgR"]

    _assert_groups(stats["byTag"], expected["byTag"])
    _assert_groups(stats["byDuration"], expected["byDuration"])
    _assert_groups(stats["byHour"], expected["byHour"])


def test_golden_by_hour_follows_server_offset(tmp_path):
    expected, rows, server_offset = load_rows()
    journal = TradeJournal(FakeStore(tmp_path, rows))

    shifted = journal.stats(days=30, login=1, server_offset=server_offset + 3600)

    # 偏移 +1 小时后每个开仓小时桶整体前移一小时，笔数不变
    assert {key: item["trades"] for key, item in _by_key(shifted["byHour"]).items()} == {
        f"{(int(key[:2]) - 1) % 24:02d}:00": values["trades"]
        for key, values in expected["byHour"].items()
    }
