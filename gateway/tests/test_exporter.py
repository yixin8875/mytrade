"""导出与备份：CSV 编码/列、R 折算、zip 内容。"""

import json
import os
import time
import zipfile

from exporter import (
    create_backup,
    export_journal,
    export_replay,
    list_backups,
    prune_auto_backups,
)
from store import Store


def _record(ticket: int = 9) -> dict:
    now = int(time.time())
    return {
        "login": 1,
        "position_id": ticket,
        "symbol": "EURUSD",
        "side": "buy",
        "volume": 0.1,
        "entry_price": 1.08,
        "exit_price": 1.085,
        "profit": 50.0,
        "swap": 0.0,
        "commission": -0.7,
        "open_time": now - 3600,
        "close_time": now,
        "duration_sec": 3600,
        "mfe": 60.0,
        "mae": -10.0,
        "risk": 25.0,
        "risk_source": "intent",
    }


def test_export_journal_writes_utf8_bom_and_r(tmp_path):
    store = Store(tmp_path)
    store.upsert_journal(_record())
    out = export_journal(store, login=1, days=30)
    assert out["rows"] == 1
    raw = (tmp_path / "exports" / out["name"]).read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    header, row = text.splitlines()[:2]
    assert header.startswith("登录,持仓号,品种")
    assert row.split(",")[12] == "2.0"
    assert "intent" in row


def test_export_replay_writes_sessions_json(tmp_path):
    store = Store(tmp_path)
    session = {
        "id": "rp-1",
        "name": "黄金复盘",
        "symbol": "XAUUSD",
        "status": "running",
        "startTs": 1_763_190_000,
        "endTs": 1_763_276_400,
        "createdAt": 1_763_190_000_000,
        "updatedAt": 1_763_200_000_000,
    }
    assert (
        store.replay_save(1, session, json.dumps(session), chart="{}", drawings="{}")
        is True
    )

    out = export_replay(store, login=1)

    assert out["rows"] == 1
    assert out["name"].startswith("tally-replay-")
    payload = json.loads((tmp_path / "exports" / out["name"]).read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert payload["login"] == 1
    assert payload["sessions"][0]["id"] == "rp-1"
    assert payload["sessions"][0]["session"]["symbol"] == "XAUUSD"
    assert payload["sessions"][0]["chart"] == "{}"
    # 会话按登录号隔离：别的账户导出不到
    assert export_replay(store, login=2)["rows"] == 0


def test_backup_zip_contains_database_and_manifest(tmp_path):
    store = Store(tmp_path)
    store.upsert_journal(_record())
    (tmp_path / "audit").mkdir(exist_ok=True)
    (tmp_path / "audit" / "2026-11-13.jsonl").write_text(
        json.dumps({"kind": "test", "payload": {}}) + "\n", encoding="utf-8"
    )
    out = create_backup(store, object(), {"theme": "dark"})
    path = tmp_path / "backups" / out["name"]
    assert path.is_file()
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        assert "data/mytrade.db" in names
        assert "manifest.json" in names
        assert "settings.json" in names
        assert "audit/2026-11-13.jsonl" in names
        settings = json.loads(archive.read("settings.json"))
        assert settings["ui"]["theme"] == "dark"
    assert list_backups(tmp_path)[0]["name"] == out["name"]


def test_auto_backup_name_flag_and_listing(tmp_path):
    store = Store(tmp_path)
    out = create_backup(store, object(), auto=True)

    assert out["auto"] is True
    assert out["name"].startswith("tally-auto-")
    listed = list_backups(tmp_path)
    assert listed[0]["name"] == out["name"]
    assert listed[0]["auto"] is True


def test_prune_auto_backups_keeps_latest_and_spares_manual(tmp_path):
    folder = tmp_path / "backups"
    folder.mkdir()
    names = []
    for day in range(9):
        path = folder / f"tally-auto-2026010{day}-000000.zip"
        path.write_bytes(b"x")
        stamp = 1_700_000_000 + day
        os.utime(path, (stamp, stamp))
        names.append(path.name)
    manual = folder / "tally-backup-20260101-000000.zip"
    manual.write_bytes(b"x")

    removed = prune_auto_backups(tmp_path, keep=7)

    assert sorted(removed) == sorted(names[:2])
    assert manual.exists()
    remaining = {path.name for path in folder.glob("tally-auto-*.zip")}
    assert remaining == set(names[2:])
    assert any(item["auto"] for item in list_backups(tmp_path))
