"""诊断包：日志尾部脱敏、结构稳定、不泄露凭据。"""

import json

from diagnostics import build, redact, tail_log
from store import Store


class FakeWorker:
    def health(self):
        return {"connected": False, "config": {"allowed_origins": []}}

    def database_status(self):
        return {"ok": True, "messages": ["ok"], "checkedAt": 1_700_000_000}


def test_tail_log_redacts_secrets(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "gateway.log").write_text(
        'login password="hunter2"\ntoken=abc123\n普通日志\n', encoding="utf-8"
    )

    lines = tail_log(tmp_path)
    text = "\n".join(lines)

    assert "hunter2" not in text
    assert "abc123" not in text
    assert "普通日志" in text
    assert "***" in text


def test_tail_log_missing_file_is_empty(tmp_path):
    assert tail_log(tmp_path) == []


def test_redact_keeps_key_names():
    assert redact('password: "x"') == 'password: "***"'
    assert redact("authorization: Bearer abc") == "authorization: Bearer ***"


def test_build_shape_has_no_credentials(tmp_path):
    store = Store(tmp_path)

    payload = build(FakeWorker(), store, started_at=0)

    assert payload["kind"] == "tally-diagnostics"
    assert payload["version"] == 1
    assert payload["database"]["ok"] is True
    assert payload["health"]["connected"] is False
    assert set(payload["paths"]) == {"base", "database", "log"}
    assert payload["log"] == []
    assert payload["uptimeSec"] >= 0
    json.dumps(payload, ensure_ascii=False)
