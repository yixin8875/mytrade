"""回放会话：SQLite 持久化、乐观校验与单文件保护。"""

import pytest

from mt5_worker import Mt5Worker
from store import Store
from worker_base import GatewayError
from worker_replay import BLOB_LIMIT, PAYLOAD_LIMIT


def _session(replay_id: str = "replay-1", updated_at: int = 1_752_631_200_000) -> dict:
    return {
        "id": replay_id,
        "name": "EURUSD · 复盘",
        "symbol": "EURUSD",
        "status": "paused",
        "origin": "manual",
        "startTs": 1_752_627_600,
        "endTs": 1_752_634_800,
        "createdAt": updated_at - 60_000,
        "updatedAt": updated_at,
        "balance": 10_000,
        "orders": [],
        "positions": [],
        "trades": [],
        "notes": [],
        "equityCurve": [{"t": 1_752_627_600, "v": 10_000, "peak": 10_000}],
    }


@pytest.fixture()
def worker(tmp_path):
    w = Mt5Worker.__new__(Mt5Worker)
    w.store = Store(tmp_path)
    w._account = {"login": 111}
    return w


def test_save_list_delete_roundtrip(worker):
    saved = worker._replay_save({"session": _session()})
    assert saved == {"id": "replay-1", "updatedAt": 1_752_631_200_000, "saved": True}

    listed = worker._replay_list({})["sessions"]
    assert len(listed) == 1
    assert listed[0]["id"] == "replay-1"
    assert listed[0]["session"]["symbol"] == "EURUSD"
    assert listed[0]["session"]["equityCurve"] == [
        {"t": 1_752_627_600, "v": 10_000, "peak": 10_000}
    ]

    assert worker._replay_delete({"id": "replay-1"}) == {
        "id": "replay-1",
        "deleted": True,
    }
    assert worker._replay_list({})["sessions"] == []


def test_sessions_are_scoped_by_login(worker):
    worker._replay_save({"session": _session()})
    worker._account = {"login": 222}
    assert worker._replay_list({})["sessions"] == []
    worker._replay_save({"session": _session("replay-2")})
    assert [row["id"] for row in worker._replay_list({})["sessions"]] == ["replay-2"]
    worker._account = {"login": 111}
    assert [row["id"] for row in worker._replay_list({})["sessions"]] == ["replay-1"]


def test_stale_payload_is_rejected(worker):
    worker._replay_save({"session": _session(updated_at=2_000)})
    with pytest.raises(GatewayError) as exc:
        worker._replay_save({"session": _session(updated_at=1_000)})
    assert exc.value.code == "REPLAY_CONFLICT"
    assert worker._replay_list({})["sessions"][0]["session"]["updatedAt"] == 2_000


def test_view_save_keeps_progress_and_timestamp(worker):
    worker._replay_save({"session": _session(updated_at=2_000)})
    result = worker._replay_save(
        {"id": "replay-1", "chart": '{"symbol":"EURUSD"}', "drawings": '{"tools":[]}'}
    )
    assert result == {"id": "replay-1", "saved": True}
    row = worker._replay_list({})["sessions"][0]
    assert row["chart"] == '{"symbol":"EURUSD"}'
    assert row["drawings"] == '{"tools":[]}'
    assert row["updatedAt"] == 2_000
    assert row["session"]["status"] == "paused"

    # 只改画线时图表的旧值保留
    worker._replay_save({"id": "replay-1", "drawings": '{"tools":[1]}'})
    row = worker._replay_list({})["sessions"][0]
    assert row["chart"] == '{"symbol":"EURUSD"}'
    assert row["drawings"] == '{"tools":[1]}'


def test_oversized_payload_is_refused(worker):
    session = _session()
    session["notes"] = [{"id": "n", "text": "x" * PAYLOAD_LIMIT}]
    with pytest.raises(GatewayError) as exc:
        worker._replay_save({"session": session})
    assert exc.value.code == "REPLAY_TOO_LARGE"
    assert worker._replay_list({})["sessions"] == []


def test_oversized_view_is_refused(worker):
    worker._replay_save({"session": _session()})
    with pytest.raises(GatewayError) as exc:
        worker._replay_save({"id": "replay-1", "chart": "x" * (BLOB_LIMIT + 1)})
    assert exc.value.code == "REPLAY_TOO_LARGE"
    assert worker._replay_list({})["sessions"][0]["chart"] is None


def test_archived_flag_and_ordering(worker):
    worker._replay_save({"session": _session("old", updated_at=1_000)})
    archived = _session("archived", updated_at=2_000)
    archived["status"] = "archived"
    worker._replay_save({"session": archived})

    ids = [row["id"] for row in worker._replay_list({})["sessions"]]
    assert ids == ["archived", "old"]
    with worker.store._lock:
        row = worker.store._db.execute(
            "SELECT archived FROM replay_sessions WHERE id='archived'"
        ).fetchone()
    assert row["archived"] == 1


def test_bad_session_is_reported(worker):
    with pytest.raises(GatewayError) as exc:
        worker._replay_save({"session": {**_session(), "status": "nope"}})
    assert exc.value.code == "BAD_SESSION"
    with pytest.raises(GatewayError) as exc:
        worker._replay_save({"session": {**_session(), "symbol": ""}})
    assert exc.value.code == "BAD_SESSION"
