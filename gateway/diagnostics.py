"""诊断包：把排查崩溃需要的只读信息汇总成一份 JSON。

不包含凭据：配置只用 cfg.public()/health()，日志尾部按常见密钥名脱敏。
"""

from __future__ import annotations

import platform
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import exporter

MAX_LOG_CHARS = 64 * 1024
LOG_LINES = 200
_SECRET = re.compile(
    r"(?i)(?<![A-Za-z0-9])(password|passwd|token|secret|api[_-]?key|authorization)"
    r"(\s*[\"']?\s*[:=]\s*)"
    r"((?:Bearer|Basic)\s+)?"
    r"([\"']?)"
    r"([^\"'\s,}]+)"
)


def log_path(base: Path) -> Path:
    return base / "logs" / "gateway.log"


def redact(text: str) -> str:
    return _SECRET.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{m.group(3) or ''}{m.group(4)}***",
        text,
    )


def tail_log(base: Path, lines: int = LOG_LINES) -> list[str]:
    path = log_path(base)
    try:
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - MAX_LOG_CHARS))
            data = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    return [line for line in redact(data).splitlines() if line][-lines:]


def build(worker: Any, store: Any, started_at: float) -> dict:
    return {
        "kind": "tally-diagnostics",
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "app": {
            "name": "Tally",
            "version": exporter.APP_VERSION,
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "uptimeSec": max(0, int(time.time() - started_at)),
        "health": worker.health(),
        "database": worker.database_status(),
        "backups": exporter.list_backups(store.base_dir),
        "paths": {
            "base": str(store.base_dir),
            "database": str(store.base_dir / "data" / "mytrade.db"),
            "log": str(log_path(store.base_dir)),
        },
        "log": tail_log(store.base_dir),
    }
