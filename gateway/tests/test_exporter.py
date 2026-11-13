"""导出与备份：CSV 编码/列、R 折算、zip 内容。"""

import json
import time
import zipfile

from exporter import create_backup, export_journal, list_backups
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
