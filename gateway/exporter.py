"""数据导出与备份：CSV、设置 JSON、整库 zip。

所有文件都写在网关数据目录下（exports / backups），由桌面端负责在资源管理器中定位。
备份只包含交易数据、审计日志、截图和可公开的设置，不包含 config.json 里的凭据。
"""

from __future__ import annotations

import csv
import json
import sqlite3
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from store import Store

APP_VERSION = "0.5.9"
JOURNAL_HEADER = [
    "登录",
    "持仓号",
    "品种",
    "方向",
    "手数",
    "开仓价",
    "平仓价",
    "盈亏",
    "掉期",
    "佣金",
    "初始风险",
    "风险来源",
    "R",
    "开仓时间",
    "平仓时间",
    "持有秒",
    "MFE",
    "MAE",
    "标签",
    "平仓方式",
]
EXECUTION_HEADER = [
    "时间",
    "登录",
    "持仓号",
    "品种",
    "方向",
    "类型",
    "手数",
    "请求价",
    "成交价",
    "点差",
    "滑点",
    "延迟毫秒",
    "返回码",
    "状态",
    "原因",
]
CONFIG_FIELDS = (
    "max_lot",
    "max_risk_pct",
    "max_positions",
    "daily_loss_pct",
    "max_trades_per_day",
    "max_consecutive_losses",
    "cooldown_minutes",
    "max_spread_points",
)


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _folder(base: Path, name: str) -> Path:
    path = base / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _time_text(value: Any) -> str:
    try:
        return datetime.fromtimestamp(int(value)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return ""


def _optional(value: Any) -> Any:
    return "" if value is None else value


def _write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> dict:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)
    return {
        "kind": "csv",
        "name": path.name,
        "path": str(path),
        "rows": len(rows),
        "bytes": path.stat().st_size,
    }


def export_journal(store: Store, login: int, days: int) -> dict:
    since = 0 if days <= 0 else int(time.time()) - max(1, days) * 86400
    records = store.journal_export(login, since)
    rows: list[list[Any]] = []
    for record in records:
        risk = record.get("risk")
        r = ""
        if risk not in (None, 0) and float(risk) > 0:
            r = round(float(record["profit"]) / float(risk), 2)
        rows.append(
            [
                int(record["login"]),
                int(record["position_id"]),
                record["symbol"],
                record["side"],
                record["volume"],
                record["entry_price"],
                record["exit_price"],
                round(float(record["profit"]), 2),
                round(float(record["swap"]), 2),
                round(float(record["commission"]), 2),
                round(float(risk), 2) if risk not in (None, 0) else "",
                record.get("risk_source") or "",
                r,
                _time_text(record["open_time"]),
                _time_text(record["close_time"]),
                int(record["duration_sec"]),
                _optional(record.get("mfe")),
                _optional(record.get("mae")),
                record.get("tag") or "",
                record.get("closed_by") or "",
            ]
        )
    path = _folder(store.base_dir, "exports") / f"tally-journal-{_stamp()}.csv"
    return _write_csv(path, JOURNAL_HEADER, rows)


def export_executions(store: Store, login: int, days: int) -> dict:
    days = max(1, days if days > 0 else 3650)
    records = store.execution_list(days=days, limit=1_000_000, login=login)
    rows: list[list[Any]] = []
    for record in reversed(records):
        rows.append(
            [
                _time_text(record["created_at"]),
                int(record["login"]),
                _optional(record.get("ticket")),
                record["symbol"],
                record["side"],
                record["type"],
                record["volume"],
                _optional(record.get("requested_price")),
                _optional(record.get("fill_price")),
                _optional(record.get("spread_points")),
                _optional(record.get("slippage_points")),
                _optional(record.get("latency_ms")),
                int(record.get("retcode") or 0),
                record["state"],
                record.get("reason") or "",
            ]
        )
    path = _folder(store.base_dir, "exports") / f"tally-executions-{_stamp()}.csv"
    return _write_csv(path, EXECUTION_HEADER, rows)


def export_audit(store: Store, days: int) -> dict:
    days = max(1, days if days > 0 else 3650)
    today = datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=days)
    files = []
    for path in sorted((store.base_dir / "audit").glob("*.jsonl")):
        try:
            dated = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if dated >= cutoff:
            files.append(path)
    target = _folder(store.base_dir, "exports") / f"tally-audit-{_stamp()}.jsonl"
    lines = 0
    with target.open("w", encoding="utf-8", newline="\n") as out:
        for path in files:
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            if not text:
                continue
            if not text.endswith("\n"):
                text += "\n"
            out.write(text)
            lines += text.count("\n")
    return {
        "kind": "jsonl",
        "name": target.name,
        "path": str(target),
        "rows": lines,
        "bytes": target.stat().st_size,
    }


def _settings_payload(cfg: Any, settings: dict | None) -> dict:
    config = {name: getattr(cfg, name, None) for name in CONFIG_FIELDS}
    config.update(
        {
            "trade_mode": getattr(cfg, "trade_mode", "readonly"),
            "allow_live": bool(getattr(cfg, "allow_live", False)),
            "deviation_points": getattr(cfg, "deviation_points", 20),
            "trailing_step_points": getattr(cfg, "trailing_step_points", 5),
            "magic": getattr(cfg, "magic", 0),
        }
    )
    return {
        "version": 1,
        "app": {"name": "Tally", "version": APP_VERSION},
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config": config,
        # 前端 localStorage 里的主题、模板、通知偏好等；不含 MT5 凭据
        "ui": settings or {},
    }


def export_settings(
    store: Store, cfg: Any, login: int, settings: dict | None
) -> dict:
    path = _folder(store.base_dir, "exports") / f"tally-settings-{_stamp()}.json"
    payload = _settings_payload(cfg, settings)
    payload["login"] = int(login)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {
        "kind": "json",
        "name": path.name,
        "path": str(path),
        "rows": 1,
        "bytes": path.stat().st_size,
    }


def _snapshot_database(base: Path, target: Path) -> None:
    source = base / "data" / "mytrade.db"
    if not source.is_file():
        return
    src = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(target)
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def create_backup(store: Store, cfg: Any, settings: dict | None = None) -> dict:
    base = store.base_dir
    folder = _folder(base, "backups")
    stamp = _stamp()
    name = f"tally-backup-{stamp}.zip"
    path = folder / name
    snapshot = folder / f".{stamp}.db"
    created = int(time.time())
    audits: list[Path] = []
    shots: list[Path] = []
    try:
        _snapshot_database(base, snapshot)
        shots = [
            item for item in (base / "data" / "shots").rglob("*") if item.is_file()
        ]
        audits = sorted((base / "audit").glob("*.jsonl"))
        manifest = {
            "version": 1,
            "name": name,
            "createdAt": created,
            "createdAtText": _time_text(created),
            "app": {"name": "Tally", "version": APP_VERSION},
            "files": {
                "database": snapshot.is_file(),
                "auditDays": len(audits),
                "screenshots": len(shots),
            },
        }
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            if snapshot.is_file():
                archive.write(snapshot, "data/mytrade.db")
            for item in audits:
                archive.write(item, f"audit/{item.name}")
            for item in shots:
                rel = item.relative_to(base / "data" / "shots").as_posix()
                archive.write(item, f"data/shots/{rel}")
            archive.writestr(
                "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2)
            )
            archive.writestr(
                "settings.json",
                json.dumps(_settings_payload(cfg, settings), ensure_ascii=False, indent=2),
            )
    finally:
        snapshot.unlink(missing_ok=True)
    return {
        "kind": "zip",
        "name": name,
        "path": str(path),
        "bytes": path.stat().st_size,
        "createdAt": created,
        "auditDays": len(audits),
        "screenshots": len(shots),
    }


def list_backups(base: Path) -> list[dict]:
    folder = base / "backups"
    if not folder.is_dir():
        return []
    out = []
    for path in folder.glob("tally-backup-*.zip"):
        stat = path.stat()
        out.append(
            {
                "name": path.name,
                "path": str(path),
                "bytes": stat.st_size,
                "createdAt": int(stat.st_mtime),
            }
        )
    out.sort(key=lambda item: item["createdAt"], reverse=True)
    return out[:50]
