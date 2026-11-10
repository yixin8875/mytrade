from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class Store:
    """订单意图 + 审计日志。只允许 MT5 工作线程调用。"""

    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        (base_dir / "data").mkdir(parents=True, exist_ok=True)
        (base_dir / "audit").mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(base_dir / "data" / "mytrade.db", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS intents (
                    client_id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    type TEXT NOT NULL,
                    volume REAL NOT NULL,
                    price REAL,
                    sl REAL,
                    tp REAL,
                    state TEXT NOT NULL,
                    ticket INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    error TEXT
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS journal (
                    position_id INTEGER PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    volume REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    exit_price REAL NOT NULL,
                    profit REAL NOT NULL,
                    swap REAL NOT NULL DEFAULT 0,
                    commission REAL NOT NULL DEFAULT 0,
                    open_time INTEGER NOT NULL,
                    close_time INTEGER NOT NULL,
                    duration_sec INTEGER NOT NULL,
                    mfe REAL,
                    mae REAL,
                    tag TEXT,
                    closed_by TEXT,
                    has_shot INTEGER NOT NULL DEFAULT 0,
                    recorded_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    price REAL NOT NULL,
                    note TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    repeat INTEGER NOT NULL DEFAULT 0,
                    cooldown_sec INTEGER NOT NULL DEFAULT 60,
                    created_at INTEGER NOT NULL,
                    triggered_at INTEGER,
                    trigger_count INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS executions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_id TEXT NOT NULL,
                    ticket INTEGER,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    type TEXT NOT NULL,
                    volume REAL NOT NULL,
                    requested_price REAL,
                    fill_price REAL,
                    spread_points REAL,
                    slippage_points REAL,
                    latency_ms INTEGER,
                    retcode INTEGER,
                    state TEXT NOT NULL,
                    reason TEXT,
                    created_at INTEGER NOT NULL
                )
                """
            )
            # 老库补一列：下单时填的策略标签
            cols = {row["name"] for row in self._db.execute("PRAGMA table_info(intents)")}
            if "tag" not in cols:
                self._db.execute("ALTER TABLE intents ADD COLUMN tag TEXT")
            self._db.commit()

    # ---------- 持久化的小状态（停机开关 / 移动止损计划） ----------

    def get_state(self, key: str) -> Any:
        with self._lock:
            row = self._db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        if row is None or row["value"] is None:
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return None

    def set_state(self, key: str, value: Any) -> None:
        with self._lock:
            if value is None:
                self._db.execute("DELETE FROM state WHERE key=?", (key,))
            else:
                self._db.execute(
                    """
                    INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                    """,
                    (key, json.dumps(value, ensure_ascii=False), int(time.time())),
                )
            self._db.commit()

    # ---------- intents ----------

    def save_intent(self, intent: dict[str, Any]) -> None:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """
                INSERT INTO intents
                    (client_id, symbol, side, type, volume, price, sl, tp, state, ticket, created_at, updated_at, error, tag)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                    state=excluded.state,
                    ticket=excluded.ticket,
                    updated_at=excluded.updated_at,
                    error=excluded.error,
                    tag=COALESCE(excluded.tag, intents.tag)
                """,
                (
                    intent["client_id"],
                    intent["symbol"],
                    intent["side"],
                    intent["type"],
                    float(intent["volume"]),
                    intent.get("price"),
                    intent.get("sl"),
                    intent.get("tp"),
                    intent["state"],
                    intent.get("ticket"),
                    intent.get("created_at", now),
                    now,
                    intent.get("error"),
                    intent.get("tag"),
                ),
            )
            self._db.commit()

    def update_intent(
        self, client_id: str, state: str, ticket: int | None = None, error: str | None = None
    ) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE intents SET state=?, ticket=COALESCE(?, ticket), error=?, updated_at=? WHERE client_id=?",
                (state, ticket, error, int(time.time()), client_id),
            )
            self._db.commit()

    def get_intent(self, client_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM intents WHERE client_id=?", (client_id,)).fetchone()
        return dict(row) if row else None

    def recent_intents(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM intents ORDER BY created_at DESC LIMIT ?", (int(limit),)
            ).fetchall()
        return [dict(r) for r in rows]

    def recent_duplicate(self, symbol: str, side: str, price: float, within_sec: int = 3) -> bool:
        since = int(time.time()) - within_sec
        with self._lock:
            row = self._db.execute(
                """
                SELECT 1 FROM intents
                WHERE symbol=? AND side=? AND ABS(COALESCE(price, 0) - ?) < 0.0000001
                  AND created_at >= ? AND state IN ('sending', 'accepted', 'filled', 'working')
                LIMIT 1
                """,
                (symbol, side, float(price), since),
            ).fetchone()
        return row is not None

    # ---------- journal（闭合交易的日志与统计原料） ----------

    def upsert_journal(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO journal
                    (position_id, symbol, side, volume, entry_price, exit_price, profit,
                     swap, commission, open_time, close_time, duration_sec, mfe, mae,
                     tag, closed_by, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(position_id) DO UPDATE SET
                    exit_price=excluded.exit_price,
                    profit=excluded.profit,
                    swap=excluded.swap,
                    commission=excluded.commission,
                    close_time=excluded.close_time,
                    duration_sec=excluded.duration_sec,
                    mfe=excluded.mfe,
                    mae=excluded.mae,
                    closed_by=excluded.closed_by,
                    recorded_at=excluded.recorded_at,
                    tag=COALESCE(journal.tag, excluded.tag)
                """,
                (
                    int(record["position_id"]),
                    record["symbol"],
                    record["side"],
                    float(record["volume"]),
                    float(record["entry_price"]),
                    float(record["exit_price"]),
                    float(record["profit"]),
                    float(record.get("swap") or 0),
                    float(record.get("commission") or 0),
                    int(record["open_time"]),
                    int(record["close_time"]),
                    int(record["duration_sec"]),
                    record.get("mfe"),
                    record.get("mae"),
                    record.get("tag"),
                    record.get("closed_by"),
                    int(time.time()),
                ),
            )
            self._db.commit()

    def journal_list(self, limit: int = 200, since: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM journal WHERE close_time >= ? ORDER BY close_time DESC LIMIT ?",
                (int(since), int(limit)),
            ).fetchall()
        return [dict(r) for r in rows]

    def journal_get(self, position_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM journal WHERE position_id=?", (int(position_id),)
            ).fetchone()
        return dict(row) if row else None

    def journal_set_tag(self, position_id: int, tag: str | None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE journal SET tag=? WHERE position_id=?", (tag, int(position_id))
            )
            self._db.commit()

    def journal_set_shot(self, position_id: int) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE journal SET has_shot=1 WHERE position_id=?", (int(position_id),)
            )
            self._db.commit()

    def journal_tag_for_position(self, position_id: int) -> str | None:
        with self._lock:
            row = self._db.execute(
                """SELECT tag FROM intents
                   WHERE ticket=? AND tag IS NOT NULL AND tag != ''
                   ORDER BY created_at DESC LIMIT 1""",
                (int(position_id),),
            ).fetchone()
        return str(row["tag"]) if row else None

    # ---------- alerts ----------

    def alerts_list(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM alerts ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    def alert_get(self, alert_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM alerts WHERE id=?", (int(alert_id),)).fetchone()
        return dict(row) if row else None

    def alert_create(
        self,
        symbol: str,
        kind: str,
        price: float,
        note: str | None,
        repeat: bool,
        cooldown_sec: int,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self._lock:
            cur = self._db.execute(
                """INSERT INTO alerts
                       (symbol, kind, price, note, enabled, repeat, cooldown_sec, created_at)
                   VALUES (?, ?, ?, ?, 1, ?, ?, ?)""",
                (symbol, kind, float(price), note, 1 if repeat else 0, int(cooldown_sec), now),
            )
            self._db.commit()
            alert_id = int(cur.lastrowid)
        return self.alert_get(alert_id) or {}

    def alert_update(self, alert_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {"symbol", "kind", "price", "note", "enabled", "repeat", "cooldown_sec"}
        sets = {key: value for key, value in fields.items() if key in allowed}
        if not sets:
            return self.alert_get(alert_id)
        columns = ", ".join(f"{key}=?" for key in sets)
        with self._lock:
            self._db.execute(
                f"UPDATE alerts SET {columns} WHERE id=?", (*sets.values(), int(alert_id))
            )
            self._db.commit()
        return self.alert_get(alert_id)

    def alert_delete(self, alert_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM alerts WHERE id=?", (int(alert_id),))
            self._db.commit()

    def alert_mark_triggered(self, alert_id: int, disable: bool) -> None:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """UPDATE alerts SET triggered_at=?, trigger_count=trigger_count+1,
                       enabled=CASE WHEN ? THEN 0 ELSE enabled END
                   WHERE id=?""",
                (now, 1 if disable else 0, int(alert_id)),
            )
            self._db.commit()

    # ---------- 执行质量（点差 / 滑点 / 延迟 / 拒单） ----------

    def record_execution(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO executions
                    (client_id, ticket, symbol, side, type, volume, requested_price,
                     fill_price, spread_points, slippage_points, latency_ms, retcode,
                     state, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["client_id"],
                    record.get("ticket"),
                    record["symbol"],
                    record["side"],
                    record["type"],
                    float(record["volume"]),
                    record.get("requested_price"),
                    record.get("fill_price"),
                    record.get("spread_points"),
                    record.get("slippage_points"),
                    record.get("latency_ms"),
                    int(record.get("retcode") or 0),
                    record["state"],
                    record.get("reason"),
                    int(record.get("created_at") or time.time()),
                ),
            )
            self._db.commit()

    def execution_list(self, days: int = 30, limit: int = 200) -> list[dict[str, Any]]:
        since = int(time.time()) - max(1, days) * 86400
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM executions WHERE created_at>=? ORDER BY id DESC LIMIT ?",
                (since, int(limit)),
            ).fetchall()
        return [dict(r) for r in rows]

    def execution_stats(self, days: int = 30) -> dict[str, Any]:
        since = int(time.time()) - max(1, days) * 86400
        with self._lock:
            rows = [
                dict(r)
                for r in self._db.execute(
                    "SELECT * FROM executions WHERE created_at>=? ORDER BY id ASC", (since,)
                ).fetchall()
            ]
        filled = [r for r in rows if r["state"] in ("filled", "accepted", "working")]
        rejected = [r for r in rows if r["state"] == "rejected"]
        unknown = [r for r in rows if r["state"] == "unknown"]
        spreads = [float(r["spread_points"]) for r in rows if r["spread_points"] is not None]
        slips = [
            float(r["slippage_points"])
            for r in filled
            if r["slippage_points"] is not None
        ]
        latencies = sorted(float(r["latency_ms"]) for r in rows if r["latency_ms"] is not None)

        def percentile(items: list[float], pct: float) -> float | None:
            if not items:
                return None
            index = min(len(items) - 1, max(0, round((len(items) - 1) * pct)))
            return round(items[index], 1)

        def avg(items: list[float]) -> float | None:
            return round(sum(items) / len(items), 2) if items else None

        def pct(items: list[float], pct_value: float) -> float | None:
            return round(sum(1 for item in items if item > 0) / len(items) * 100, 1) if items else None

        buckets: dict[str, dict[str, Any]] = {}
        for row in rows:
            key = str(row["symbol"])
            item = buckets.setdefault(
                key,
                {"key": key, "count": 0, "filled": 0, "rejected": 0, "spreadSum": 0.0,
                 "spreadN": 0, "slipSum": 0.0, "slipN": 0, "latSum": 0.0, "latN": 0},
            )
            item["count"] += 1
            if row["state"] in ("filled", "accepted", "working"):
                item["filled"] += 1
            if row["state"] == "rejected":
                item["rejected"] += 1
            if row["spread_points"] is not None:
                item["spreadSum"] += float(row["spread_points"])
                item["spreadN"] += 1
            if row["slippage_points"] is not None:
                item["slipSum"] += float(row["slippage_points"])
                item["slipN"] += 1
            if row["latency_ms"] is not None:
                item["latSum"] += float(row["latency_ms"])
                item["latN"] += 1
        by_symbol = []
        for item in buckets.values():
            by_symbol.append(
                {
                    "key": item["key"],
                    "count": item["count"],
                    "filled": item["filled"],
                    "rejected": item["rejected"],
                    "avgSpread": round(item["spreadSum"] / item["spreadN"], 1)
                    if item["spreadN"]
                    else None,
                    "avgSlippage": round(item["slipSum"] / item["slipN"], 2)
                    if item["slipN"]
                    else None,
                    "avgLatency": round(item["latSum"] / item["latN"], 0)
                    if item["latN"]
                    else None,
                }
            )
        by_symbol.sort(key=lambda x: x["count"], reverse=True)

        reasons: dict[str, int] = {}
        for row in rejected + unknown:
            key = str(row.get("reason") or "未记录原因")
            reasons[key] = reasons.get(key, 0) + 1
        reject_reasons = [
            {"key": key, "count": count}
            for key, count in sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)
        ]

        by_hour: dict[str, dict[str, Any]] = {}
        for row in rows:
            hour = datetime.fromtimestamp(int(row["created_at"])).strftime("%H:00")
            item = by_hour.setdefault(hour, {"key": hour, "count": 0, "rejected": 0})
            item["count"] += 1
            if row["state"] in ("rejected", "unknown"):
                item["rejected"] += 1
        hours = sorted(by_hour.values(), key=lambda x: x["key"])

        return {
            "days": days,
            "summary": {
                "total": len(rows),
                "filled": len(filled),
                "rejected": len(rejected),
                "unknown": len(unknown),
                "avgSpread": avg(spreads),
                "avgSlippage": avg(slips),
                "slipPositivePct": pct(slips, 0),
                "maxSlippage": round(max(slips), 2) if slips else None,
                "avgLatency": round(sum(latencies) / len(latencies), 0) if latencies else None,
                "p50Latency": percentile(latencies, 0.5),
                "p90Latency": percentile(latencies, 0.9),
                "maxLatency": round(max(latencies), 0) if latencies else None,
            },
            "bySymbol": by_symbol,
            "byHour": hours,
            "rejectReasons": reject_reasons,
            "rows": list(reversed(rows))[: int(200)],
        }

    # ---------- audit ----------

    def audit(self, kind: str, payload: Any) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "kind": kind,
            "payload": payload,
        }
        path = self.base_dir / "audit" / f"{datetime.now(timezone.utc):%Y-%m-%d}.jsonl"
        with self._lock:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    def audit_tail(self, limit: int = 50) -> list[dict[str, Any]]:
        path = self.base_dir / "audit" / f"{datetime.now(timezone.utc):%Y-%m-%d}.jsonl"
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()[-int(limit) :]
        out: list[dict[str, Any]] = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def audit_query(
        self,
        day: str,
        kind: str | None = None,
        text: str | None = None,
        limit: int = 300,
    ) -> list[dict[str, Any]]:
        """按 UTC 日期读审计文件；kind 前缀过滤，text 在整行里模糊匹配。"""
        path = self.base_dir / "audit" / f"{day}.jsonl"
        if not path.exists():
            return []
        kind = (kind or "").strip()
        needle = (text or "").strip().lower()
        out: list[dict[str, Any]] = []
        lines = path.read_text(encoding="utf-8").splitlines()
        for line in reversed(lines):
            if needle and needle not in line.lower():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if kind and not str(record.get("kind") or "").startswith(kind):
                continue
            out.append(record)
            if len(out) >= int(limit):
                break
        return out
