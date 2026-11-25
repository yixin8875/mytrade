from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_KEEP = object()


def _positive_or_none(value: Any) -> float | None:
    """止损/止盈价只存正数，0 或坏值当没设置。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _json_list(value: Any) -> list[Any]:
    """复盘字段里的 JSON 数组；坏数据一律当成空数组。"""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    return value if isinstance(value, list) else []


def _fills_json(value: Any) -> str | None:
    """逐笔入场/出场成交：只存可用的 {side,time,price,volume}，坏数据丢弃。"""
    if not isinstance(value, list) or not value:
        return None
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or item.get("side") not in ("in", "out"):
            continue
        try:
            out.append(
                {
                    "side": item["side"],
                    "time": int(item["time"]),
                    "price": float(item["price"]),
                    "volume": float(item.get("volume") or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not out:
        return None
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def _journal_row(row: Any) -> dict[str, Any]:
    """journal 行 → 前端结构：fills 列是 JSON 文本，读取时还原成数组。"""
    data = dict(row)
    if "fills" in data:
        data["fills"] = _json_list(data.get("fills"))
    return data


def _journal_filter_sql(filters: dict[str, Any] | None) -> tuple[list[str], list[Any]]:
    """交易日志的统一筛选：列表与统计共用，保证两处行集合一致。"""
    clauses: list[str] = []
    args: list[Any] = []
    data = filters or {}
    symbol = str(data.get("symbol") or "").strip()
    if symbol:
        clauses.append("j.symbol=?")
        args.append(symbol)
    tag = str(data.get("tag") or "").strip()
    if tag == "未标记":
        clauses.append("(j.tag IS NULL OR j.tag = '')")
    elif tag:
        clauses.append("j.tag=?")
        args.append(tag)
    result = str(data.get("result") or "").strip()
    if result == "win":
        clauses.append("j.profit > 0")
    elif result == "loss":
        clauses.append("j.profit < 0")
    reviewed = data.get("reviewed")
    if reviewed is not None and str(reviewed) in ("0", "1"):
        clauses.append(
            "n.reviewed_at IS NULL" if str(reviewed) == "0" else "n.reviewed_at IS NOT NULL"
        )
    return clauses, args


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
                    login INTEGER NOT NULL DEFAULT 0,
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
                    login INTEGER NOT NULL DEFAULT 0,
                    position_id INTEGER NOT NULL,
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
                    risk REAL,
                    risk_source TEXT,
                    fills TEXT,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (login, position_id)
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS position_risk (
                    login INTEGER NOT NULL DEFAULT 0,
                    position_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    volume REAL NOT NULL,
                    entry REAL NOT NULL,
                    sl REAL NOT NULL,
                    risk REAL NOT NULL,
                    source TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (login, position_id)
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login INTEGER NOT NULL DEFAULT 0,
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
                    login INTEGER NOT NULL DEFAULT 0,
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
            # 复盘层：日笔记、策略手册、规则检查。全部与 journal 解耦，
            # journal 重建时这些注释不会跟着消失。
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS review_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS day_notes (
                    login INTEGER NOT NULL DEFAULT 0,
                    day TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    mood INTEGER,
                    tags TEXT NOT NULL DEFAULT '[]',
                    replay_session_id TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (login, day)
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS note_templates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login INTEGER NOT NULL DEFAULT 0,
                    name TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS playbooks (
                    id TEXT PRIMARY KEY,
                    login INTEGER NOT NULL DEFAULT 0,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    rules TEXT NOT NULL DEFAULT '[]',
                    archived_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS trade_notes (
                    login INTEGER NOT NULL,
                    position_id INTEGER NOT NULL,
                    playbook_id TEXT,
                    rating INTEGER,
                    mistakes TEXT NOT NULL DEFAULT '[]',
                    note TEXT NOT NULL DEFAULT '',
                    reviewed_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (login, position_id)
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS playbook_checks (
                    login INTEGER NOT NULL,
                    position_id INTEGER NOT NULL,
                    playbook_id TEXT NOT NULL,
                    rule TEXT NOT NULL,
                    followed INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (login, position_id, rule)
                )
                """
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_trade_notes_book ON trade_notes(login, playbook_id)"
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_checks_book ON playbook_checks(login, playbook_id)"
            )
            # 回放会话主体存 payload（订单/持仓/成交/笔记/权益曲线），
            # 图表状态与画线分列存放，便于单独覆盖而不重写整份 payload。
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS replay_sessions (
                    login INTEGER NOT NULL,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    status TEXT NOT NULL,
                    origin TEXT,
                    reference_key TEXT,
                    start_ts INTEGER NOT NULL,
                    end_ts INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    payload TEXT NOT NULL,
                    chart TEXT,
                    drawings TEXT,
                    PRIMARY KEY (login, id)
                )
                """
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_replay_sessions_updated "
                "ON replay_sessions(login, updated_at DESC)"
            )
            # 开仓纪律门禁：一次开仓尝试一行，client_id 与 order.place 的 clientOrderId 同键。
            # rules 存开单时的规则快照，清单后来被编辑/归档也不影响历史显示。
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS pre_trade_gate (
                    login INTEGER NOT NULL,
                    client_id TEXT NOT NULL,
                    playbook_id TEXT,
                    mode TEXT NOT NULL,
                    state TEXT NOT NULL,
                    rules TEXT NOT NULL DEFAULT '[]',
                    reason TEXT,
                    position_id INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (login, client_id)
                )
                """
            )
            # followed：1 遵守 / 0 违反 / NULL 不适用；行不存在 = 未评估
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS pre_trade_checks (
                    login INTEGER NOT NULL,
                    client_id TEXT NOT NULL,
                    playbook_id TEXT NOT NULL,
                    rule TEXT NOT NULL,
                    followed INTEGER,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (login, client_id, rule)
                )
                """
            )
            # 例行清单与错过机会：同样独立于 journal，不影响成交统计。
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS routines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login INTEGER NOT NULL DEFAULT 0,
                    title TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
                    sort INTEGER NOT NULL DEFAULT 0,
                    archived_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS routine_done (
                    login INTEGER NOT NULL DEFAULT 0,
                    routine_id INTEGER NOT NULL,
                    day TEXT NOT NULL,
                    done_at INTEGER NOT NULL,
                    PRIMARY KEY (login, routine_id, day)
                )
                """
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS missed_trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login INTEGER NOT NULL DEFAULT 0,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    observed_at INTEGER NOT NULL,
                    entry_price REAL,
                    sl REAL,
                    tp REAL,
                    playbook_id TEXT,
                    note TEXT NOT NULL DEFAULT '',
                    sim TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_routine_done_day ON routine_done(login, day)"
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_missed_login ON missed_trades(login, observed_at)"
            )
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL,
                    day TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    UNIQUE(login, kind, day, provider, model)
                )
                """
            )
            self._migrate()

    def _columns(self, table: str) -> set[str]:
        return {row["name"] for row in self._db.execute(f"PRAGMA table_info({table})")}

    def _migrate(self) -> None:
        """补账户维度：旧表没有 login 列时迁移，journal 改成 (login, position_id) 复合主键。"""
        for table in ("intents", "alerts", "executions"):
            if "login" not in self._columns(table):
                self._db.execute(
                    f"ALTER TABLE {table} ADD COLUMN login INTEGER NOT NULL DEFAULT 0"
                )
        # 老库补一列：下单时填的策略标签
        if "tag" not in self._columns("intents"):
            self._db.execute("ALTER TABLE intents ADD COLUMN tag TEXT")
        if "login" not in self._columns("journal"):
            self._rebuild_journal()
        # 初始风险（账户货币）与来源：成交止损 / 持仓止损 / 下单止损
        journal_columns = self._columns("journal")
        if "risk" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN risk REAL")
        if "risk_source" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN risk_source TEXT")
        # 交易图要画出开仓订单的止损/止盈线
        if "sl" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN sl REAL")
        if "tp" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN tp REAL")
        # 同步这笔交易时券商服务器与本机的时间差；展示时用它换成本地时间
        if "server_offset" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN server_offset INTEGER")
        # 逐笔入场/出场成交：交易图按每笔成交画点，不再只画加权均价
        if "fills" not in journal_columns:
            self._db.execute("ALTER TABLE journal ADD COLUMN fills TEXT")
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_journal_login ON journal(login, close_time)"
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_position_risk_login ON position_risk(login, position_id)"
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_executions_login ON executions(login, created_at)"
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_login ON alerts(login, id)"
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_intents_login ON intents(login, created_at)"
        )
        self._db.commit()

    def _rebuild_journal(self) -> None:
        # DDL 也放进显式事务，避免迁移中途崩溃留下缺失的 journal 表
        with self._db:
            self._db.execute("ALTER TABLE journal RENAME TO journal_legacy")
            self._db.execute(
                """
                CREATE TABLE journal (
                    login INTEGER NOT NULL DEFAULT 0,
                    position_id INTEGER NOT NULL,
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
                    risk REAL,
                    risk_source TEXT,
                    fills TEXT,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (login, position_id)
                )
                """
            )
            self._db.execute(
                """
                INSERT INTO journal
                    (login, position_id, symbol, side, volume, entry_price, exit_price, profit,
                     swap, commission, open_time, close_time, duration_sec, mfe, mae, tag,
                     closed_by, has_shot, risk, risk_source, fills, recorded_at)
                SELECT 0, position_id, symbol, side, volume, entry_price, exit_price, profit,
                       swap, commission, open_time, close_time, duration_sec, mfe, mae, tag,
                       closed_by, has_shot,
                       NULL, NULL, NULL,
                       recorded_at
                FROM journal_legacy
                """
            )
            self._db.execute("DROP TABLE journal_legacy")

    @staticmethod
    def _state_key(key: str, login: int) -> str:
        return f"{int(login)}:{key}"

    def migrate_legacy(self, login: int) -> None:
        """把旧版没有账户维度的数据归到第一个连上的真实账户。"""
        if login <= 0:
            return
        with self._lock:
            for table in ("journal", "executions", "alerts", "intents"):
                self._db.execute(
                    f"UPDATE {table} SET login=? WHERE login=0",
                    (int(login),),
                )
            for key in ("halted", "trailing", "autoBreakeven", "watchlist"):
                scoped = self._state_key(key, login)
                row = self._db.execute(
                    "SELECT value FROM state WHERE key=?", (scoped,)
                ).fetchone()
                legacy = self._db.execute(
                    "SELECT value FROM state WHERE key=?", (key,)
                ).fetchone()
                if legacy is not None:
                    if row is None:
                        self._db.execute(
                            "UPDATE state SET key=? WHERE key=?", (scoped, key)
                        )
                    else:
                        self._db.execute("DELETE FROM state WHERE key=?", (key,))
            self._db.commit()

    # ---------- 持久化的小状态（停机开关 / 移动止损计划） ----------

    def get_state(self, key: str, login: int = 0) -> Any:
        scoped = self._state_key(key, login) if login else key
        with self._lock:
            row = self._db.execute("SELECT value FROM state WHERE key=?", (scoped,)).fetchone()
        if row is None or row["value"] is None:
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return None

    def set_state(self, key: str, value: Any, login: int = 0) -> None:
        scoped = self._state_key(key, login) if login else key
        with self._lock:
            if value is None:
                self._db.execute("DELETE FROM state WHERE key=?", (scoped,))
            else:
                self._db.execute(
                    """
                    INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                    """,
                    (scoped, json.dumps(value, ensure_ascii=False), int(time.time())),
                )
            self._db.commit()

    # ---------- intents ----------

    def save_intent(self, intent: dict[str, Any]) -> None:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """
                INSERT INTO intents
                    (client_id, login, symbol, side, type, volume, price, sl, tp, state, ticket, created_at, updated_at, error, tag)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                    state=excluded.state,
                    ticket=excluded.ticket,
                    updated_at=excluded.updated_at,
                    error=excluded.error,
                    tag=COALESCE(excluded.tag, intents.tag)
                """,
                (
                    intent["client_id"],
                    int(intent.get("login") or 0),
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
        self,
        client_id: str,
        state: str,
        ticket: int | None = None,
        error: str | None = None,
        login: int = 0,
    ) -> None:
        with self._lock:
            self._db.execute(
                """UPDATE intents SET state=?, ticket=COALESCE(?, ticket), error=?, updated_at=?
                   WHERE client_id=? AND login=?""",
                (state, ticket, error, int(time.time()), client_id, int(login)),
            )
            self._db.commit()

    def get_intent(self, client_id: str, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM intents WHERE client_id=? AND login=?",
                (client_id, int(login)),
            ).fetchone()
        return dict(row) if row else None

    def recent_intents(self, limit: int = 50, login: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM intents WHERE login=? ORDER BY created_at DESC LIMIT ?",
                (int(login), int(limit)),
            ).fetchall()
        return [dict(r) for r in rows]

    def recent_duplicate(
        self, symbol: str, side: str, price: float, within_sec: int = 3, login: int = 0
    ) -> bool:
        since = int(time.time()) - within_sec
        with self._lock:
            row = self._db.execute(
                """
                SELECT 1 FROM intents
                WHERE symbol=? AND side=? AND ABS(COALESCE(price, 0) - ?) < 0.0000001
                  AND created_at >= ? AND login=?
                  AND state IN ('sending', 'accepted', 'filled', 'working')
                LIMIT 1
                """,
                (symbol, side, float(price), since, int(login)),
            ).fetchone()
        return row is not None

    # ---------- journal（闭合交易的日志与统计原料） ----------

    def upsert_journal(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO journal
                    (login, position_id, symbol, side, volume, entry_price, exit_price, profit,
                     swap, commission, open_time, close_time, duration_sec, mfe, mae,
                     tag, closed_by, risk, risk_source, sl, tp, recorded_at, server_offset, fills)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, position_id) DO UPDATE SET
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
                    risk=CASE
                        WHEN journal.risk IS NULL OR journal.risk <= 0
                        THEN excluded.risk ELSE journal.risk END,
                    risk_source=CASE
                        WHEN journal.risk IS NULL OR journal.risk <= 0
                        THEN excluded.risk_source ELSE journal.risk_source END,
                    sl=COALESCE(journal.sl, excluded.sl),
                    tp=COALESCE(journal.tp, excluded.tp),
                    tag=COALESCE(journal.tag, excluded.tag),
                    server_offset=COALESCE(journal.server_offset, excluded.server_offset),
                    fills=COALESCE(journal.fills, excluded.fills)
                """,
                (
                    int(record.get("login") or 0),
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
                    record.get("risk"),
                    record.get("risk_source"),
                    _positive_or_none(record.get("sl")),
                    _positive_or_none(record.get("tp")),
                    int(time.time()),
                    (
                        int(record["server_offset"])
                        if record.get("server_offset") is not None
                        else None
                    ),
                    _fills_json(record.get("fills")),
                ),
            )
            self._db.commit()

    def journal_list(
        self,
        limit: int = 200,
        since: int = 0,
        login: int = 0,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        clauses, args = _journal_filter_sql(filters)
        where = " AND ".join(["j.login=?", "j.close_time >= ?", *clauses])
        with self._lock:
            rows = self._db.execute(
                f"""SELECT j.*, n.reviewed_at AS reviewed_at
                   FROM journal j
                   LEFT JOIN trade_notes n
                     ON n.login = j.login AND n.position_id = j.position_id
                   WHERE {where}
                   ORDER BY j.close_time DESC LIMIT ?""",
                (int(login), int(since), *args, int(limit)),
            ).fetchall()
        return [_journal_row(r) for r in rows]

    def journal_get(self, position_id: int, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM journal WHERE login=? AND position_id=?",
                (int(login), int(position_id)),
            ).fetchone()
        return _journal_row(row) if row else None

    def journal_set_tag(self, position_id: int, tag: str | None, login: int = 0) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE journal SET tag=? WHERE login=? AND position_id=?",
                (tag, int(login), int(position_id)),
            )
            self._db.commit()

    def journal_set_shot(self, position_id: int, login: int = 0) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE journal SET has_shot=1 WHERE login=? AND position_id=?",
                (int(login), int(position_id)),
            )
            self._db.commit()

    def journal_backfill_offset(self, login: int, offset: int) -> int:
        """老记录没有服务器时区差时补一次；已有值的不覆盖。"""
        with self._lock:
            cursor = self._db.execute(
                "UPDATE journal SET server_offset=? WHERE login=? AND server_offset IS NULL",
                (int(offset), int(login)),
            )
            self._db.commit()
            return int(cursor.rowcount or 0)

    def journal_tag_for_position(self, position_id: int, login: int = 0) -> str | None:
        with self._lock:
            row = self._db.execute(
                """SELECT tag FROM intents
                   WHERE ticket=? AND login=? AND tag IS NOT NULL AND tag != ''
                   ORDER BY created_at DESC LIMIT 1""",
                (int(position_id), int(login)),
            ).fetchone()
        return str(row["tag"]) if row else None

    def intent_sl_map(self, login: int, tickets: list[int]) -> dict[int, float]:
        """每笔持仓最初下单时带的止损价，用来把盈亏折算成 R。

        同一 ticket 可能有多条意图（重试/改单），按时间取最早一条非空止损。
        """
        unique = sorted({int(ticket) for ticket in tickets if ticket})
        out: dict[int, float] = {}
        with self._lock:
            for start in range(0, len(unique), 500):
                chunk = unique[start : start + 500]
                marks = ",".join("?" * len(chunk))
                rows = self._db.execute(
                    f"""SELECT ticket, sl FROM intents
                        WHERE login=? AND sl IS NOT NULL AND ticket IN ({marks})
                        ORDER BY created_at ASC""",
                    (int(login), *chunk),
                ).fetchall()
                for row in rows:
                    out.setdefault(int(row["ticket"]), float(row["sl"]))
        return out

    def journal_export(self, login: int = 0, since: int = 0) -> list[dict[str, Any]]:
        """导出用：区间内全部已平仓交易，不设条数上限。"""
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM journal WHERE login=? AND close_time>=?
                   ORDER BY close_time ASC""",
                (int(login), int(since)),
            ).fetchall()
        return [dict(r) for r in rows]

    def journal_set_risks(
        self, login: int, values: dict[int, tuple[float, str]]
    ) -> None:
        """批量补写初始风险：只填空值，不覆盖已经记录的风险。"""
        if not values:
            return
        with self._lock:
            self._db.executemany(
                """UPDATE journal SET risk=?, risk_source=?
                   WHERE login=? AND position_id=? AND (risk IS NULL OR risk <= 0)""",
                [
                    (float(risk), source, int(login), int(ticket))
                    for ticket, (risk, source) in values.items()
                    if risk is not None and risk > 0
                ],
            )
            self._db.commit()

    def journal_set_levels(
        self, login: int, values: dict[int, tuple[float | None, float | None]]
    ) -> None:
        """批量补写开仓订单的止损/止盈价：只填空值，不覆盖已有的。"""
        if not values:
            return
        with self._lock:
            self._db.executemany(
                """UPDATE journal SET
                       sl=COALESCE(sl, ?),
                       tp=COALESCE(tp, ?)
                   WHERE login=? AND position_id=?""",
                [
                    (_positive_or_none(sl), _positive_or_none(tp), int(login), int(ticket))
                    for ticket, (sl, tp) in values.items()
                ],
            )
            self._db.commit()

    def journal_set_fills(
        self, login: int, values: dict[int, list[dict[str, Any]]]
    ) -> None:
        """批量补写逐笔成交：只填还没有明细的老记录，不覆盖新记录的。"""
        if not values:
            return
        rows = []
        for ticket, fills in values.items():
            stored = _fills_json(fills)
            if stored is None:
                continue
            rows.append((stored, int(login), int(ticket)))
        if not rows:
            return
        with self._lock:
            self._db.executemany(
                """UPDATE journal SET fills=?
                   WHERE login=? AND position_id=? AND fills IS NULL""",
                rows,
            )
            self._db.commit()

    # ---------- 持仓初始风险（开仓时/改止损时落库） ----------

    def record_position_risk(self, record: dict[str, Any]) -> bool:
        """记录一笔持仓的初始风险；同一 ticket 只保留第一次记录。"""
        with self._lock:
            cur = self._db.execute(
                """INSERT INTO position_risk
                       (login, position_id, symbol, side, volume, entry, sl, risk, source, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(login, position_id) DO NOTHING""",
                (
                    int(record.get("login") or 0),
                    int(record["position_id"]),
                    str(record["symbol"]),
                    str(record["side"]),
                    float(record["volume"]),
                    float(record["entry"]),
                    float(record["sl"]),
                    float(record["risk"]),
                    str(record.get("source") or "position"),
                    int(record.get("created_at") or time.time()),
                ),
            )
            self._db.commit()
            return cur.rowcount > 0

    def position_risk_map(self, login: int, tickets: list[int]) -> dict[int, dict[str, Any]]:
        unique = sorted({int(ticket) for ticket in tickets if ticket})
        out: dict[int, dict[str, Any]] = {}
        with self._lock:
            for start in range(0, len(unique), 500):
                chunk = unique[start : start + 500]
                marks = ",".join("?" * len(chunk))
                rows = self._db.execute(
                    f"""SELECT position_id, risk, source, entry, sl, volume
                        FROM position_risk
                        WHERE login=? AND position_id IN ({marks})""",
                    (int(login), *chunk),
                ).fetchall()
                for row in rows:
                    out[int(row["position_id"])] = {
                        "risk": float(row["risk"]),
                        "source": str(row["source"] or "position"),
                        "entry": float(row["entry"]),
                        "sl": float(row["sl"]),
                        "volume": float(row["volume"]),
                    }
        return out

    # ---------- alerts ----------

    def alerts_list(self, login: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM alerts WHERE login=? ORDER BY id DESC", (int(login),)
            ).fetchall()
        return [dict(r) for r in rows]

    def alert_get(self, alert_id: int, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM alerts WHERE id=? AND login=?",
                (int(alert_id), int(login)),
            ).fetchone()
        return dict(row) if row else None

    def alert_create(
        self,
        symbol: str,
        kind: str,
        price: float,
        note: str | None,
        repeat: bool,
        cooldown_sec: int,
        login: int = 0,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self._lock:
            cur = self._db.execute(
                """INSERT INTO alerts
                       (login, symbol, kind, price, note, enabled, repeat, cooldown_sec, created_at)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                (
                    int(login),
                    symbol,
                    kind,
                    float(price),
                    note,
                    1 if repeat else 0,
                    int(cooldown_sec),
                    now,
                ),
            )
            self._db.commit()
            alert_id = int(cur.lastrowid)
        return self.alert_get(alert_id, login) or {}

    def alert_update(
        self, alert_id: int, fields: dict[str, Any], login: int = 0
    ) -> dict[str, Any] | None:
        allowed = {"symbol", "kind", "price", "note", "enabled", "repeat", "cooldown_sec"}
        sets = {key: value for key, value in fields.items() if key in allowed}
        if not sets:
            return self.alert_get(alert_id, login)
        columns = ", ".join(f"{key}=?" for key in sets)
        with self._lock:
            self._db.execute(
                f"UPDATE alerts SET {columns} WHERE id=? AND login=?",
                (*sets.values(), int(alert_id), int(login)),
            )
            self._db.commit()
        return self.alert_get(alert_id, login)

    def alert_delete(self, alert_id: int, login: int = 0) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM alerts WHERE id=? AND login=?",
                (int(alert_id), int(login)),
            )
            self._db.commit()

    def alert_mark_triggered(self, alert_id: int, disable: bool, login: int = 0) -> None:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """UPDATE alerts SET triggered_at=?, trigger_count=trigger_count+1,
                       enabled=CASE WHEN ? THEN 0 ELSE enabled END
                   WHERE id=? AND login=?""",
                (now, 1 if disable else 0, int(alert_id), int(login)),
            )
            self._db.commit()

    # ---------- 执行质量（点差 / 滑点 / 延迟 / 拒单） ----------

    def record_execution(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO executions
                    (client_id, login, ticket, symbol, side, type, volume, requested_price,
                     fill_price, spread_points, slippage_points, latency_ms, retcode,
                     state, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["client_id"],
                    int(record.get("login") or 0),
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

    def execution_list(
        self, days: int = 30, limit: int = 200, login: int = 0
    ) -> list[dict[str, Any]]:
        since = int(time.time()) - max(1, days) * 86400
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM executions WHERE login=? AND created_at>=?
                   ORDER BY id DESC LIMIT ?""",
                (int(login), since, int(limit)),
            ).fetchall()
        return [dict(r) for r in rows]

    def _review_tz(self) -> int:
        """复盘时区，和报表/分析页共用一份设置。"""
        value = self.review_setting_get("timezone_offset_min")
        if isinstance(value, (int, float)) and -12 * 60 <= int(value) <= 14 * 60:
            return int(value)
        dst = time.daylight and time.localtime().tm_isdst
        return int(-(time.altzone if dst else time.timezone) // 60)

    def execution_stats(self, days: int = 30, login: int = 0) -> dict[str, Any]:
        # days<=0 表示全部历史；其余按复盘时区的自然日，与 journal.stats 一致
        tz = self._review_tz()
        if days <= 0:
            since = 0
        else:
            now = int(time.time())
            local_midnight = ((now + tz * 60) // 86400) * 86400
            since = max(0, local_midnight - (days - 1) * 86400 - tz * 60)
        with self._lock:
            rows = [
                dict(r)
                for r in self._db.execute(
                    """SELECT * FROM executions WHERE login=? AND created_at>=?
                       ORDER BY id ASC""",
                    (int(login), since),
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
            hour = datetime.fromtimestamp(
                int(row["created_at"]) + tz * 60, timezone.utc
            ).strftime("%H:00")
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

    def execution_entry_map(self, login: int, since: int) -> dict[int, dict[str, float | None]]:
        """每笔成交的入场执行成本（点差 / 滑点），每个 ticket 取第一条记录。"""
        with self._lock:
            rows = self._db.execute(
                """SELECT ticket, spread_points, slippage_points FROM executions
                   WHERE login=? AND created_at>=? AND ticket IS NOT NULL
                   ORDER BY id ASC""",
                (int(login), int(since)),
            ).fetchall()
        out: dict[int, dict[str, float | None]] = {}
        for row in rows:
            ticket = int(row["ticket"])
            if ticket in out:
                continue
            out[ticket] = {
                "spread": float(row["spread_points"])
                if row["spread_points"] is not None
                else None,
                "slippage": float(row["slippage_points"])
                if row["slippage_points"] is not None
                else None,
            }
        return out

    # ---------- 复盘：日笔记 / 策略 / 规则 ----------

    def review_setting_get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._db.execute(
                "SELECT value FROM review_settings WHERE key=?", (key,)
            ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return default

    def review_setting_set(self, key: str, value: Any) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO review_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (key, json.dumps(value, ensure_ascii=False)),
            )
            self._db.commit()

    # ---------- AI 复盘缓存 ----------

    def ai_review_get(
        self, login: int, kind: str, day: str, provider: str, model: str
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                """
                SELECT text, created_at FROM ai_reviews
                WHERE login=? AND kind=? AND day=? AND provider=? AND model=?
                """,
                (login, kind, day, provider, model),
            ).fetchone()
        if row is None:
            return None
        return {"text": row["text"], "createdAt": int(row["created_at"])}

    def ai_review_save(
        self,
        login: int,
        kind: str,
        day: str,
        provider: str,
        model: str,
        text: str,
        created_at: int,
    ) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO ai_reviews (login, kind, day, provider, model, created_at, text)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, kind, day, provider, model)
                DO UPDATE SET created_at=excluded.created_at, text=excluded.text
                """,
                (login, kind, day, provider, model, created_at, text),
            )
            self._db.commit()

    def ai_review_clear(self, login: int, kind: str, day: str) -> int:
        with self._lock:
            cursor = self._db.execute(
                "DELETE FROM ai_reviews WHERE login=? AND kind=? AND day=?",
                (login, kind, day),
            )
            self._db.commit()
            return cursor.rowcount

    def journal_between(
        self, start: int, end: int, login: int = 0, limit: int = 10000
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM journal
                   WHERE login=? AND close_time >= ? AND close_time < ?
                   ORDER BY close_time ASC LIMIT ?""",
                (int(login), int(start), int(end), int(limit)),
            ).fetchall()
        return [dict(row) for row in rows]

    def day_note_get(self, day: str, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM day_notes WHERE login=? AND day=?",
                (int(login), day),
            ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["tags"] = _json_list(data.get("tags"))
        data["replaySessionId"] = data.pop("replay_session_id", None)
        return data

    def day_note_save(
        self,
        day: str,
        note: str,
        mood: int | None,
        tags: list[str],
        replay_session_id: str | None,
        login: int = 0,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """
                INSERT INTO day_notes
                    (login, day, note, mood, tags, replay_session_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, day) DO UPDATE SET
                    note=excluded.note,
                    mood=excluded.mood,
                    tags=excluded.tags,
                    replay_session_id=excluded.replay_session_id,
                    updated_at=excluded.updated_at
                """,
                (
                    int(login),
                    day,
                    note,
                    mood,
                    json.dumps(tags, ensure_ascii=False),
                    replay_session_id,
                    now,
                    now,
                ),
            )
            self._db.commit()
        return self.day_note_get(day, login) or {}

    def note_templates_list(self, login: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, name, body FROM note_templates WHERE login=? ORDER BY id",
                (int(login),),
            ).fetchall()
        return [dict(row) for row in rows]

    def note_template_save(
        self,
        name: str,
        body: str,
        login: int = 0,
        template_id: int | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            if template_id:
                cursor = self._db.execute(
                    "UPDATE note_templates SET name=?, body=? WHERE id=? AND login=?",
                    (name, body, int(template_id), int(login)),
                )
                if cursor.rowcount == 0:
                    return None
                self._db.commit()
                row = self._db.execute(
                    "SELECT id, name, body FROM note_templates WHERE id=?",
                    (int(template_id),),
                ).fetchone()
            else:
                cursor = self._db.execute(
                    "INSERT INTO note_templates (login, name, body, created_at) VALUES (?, ?, ?, ?)",
                    (int(login), name, body, int(time.time())),
                )
                self._db.commit()
                row = self._db.execute(
                    "SELECT id, name, body FROM note_templates WHERE id=?",
                    (int(cursor.lastrowid),),
                ).fetchone()
        return dict(row) if row else None

    def note_template_delete(self, template_id: int, login: int = 0) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "DELETE FROM note_templates WHERE id=? AND login=?",
                (int(template_id), int(login)),
            )
            self._db.commit()
        return cursor.rowcount > 0

    def playbooks_list(
        self, login: int = 0, include_archived: bool = False
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM playbooks WHERE login=?"
        if not include_archived:
            sql += " AND archived_at IS NULL"
        sql += " ORDER BY created_at, id"
        with self._lock:
            rows = self._db.execute(sql, (int(login),)).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["rules"] = [str(rule) for rule in _json_list(item.get("rules"))]
            out.append(item)
        return out

    def playbook_get(self, playbook_id: str, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM playbooks WHERE id=? AND login=?",
                (playbook_id, int(login)),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["rules"] = [str(rule) for rule in _json_list(item.get("rules"))]
        return item

    def playbook_save(
        self,
        name: str,
        description: str,
        rules: list[str],
        login: int = 0,
        playbook_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = int(time.time())
        payload = json.dumps(rules, ensure_ascii=False)
        with self._lock:
            if playbook_id:
                cursor = self._db.execute(
                    """
                    UPDATE playbooks
                    SET name=?, description=?, rules=?, updated_at=?
                    WHERE id=? AND login=?
                    """,
                    (name, description, payload, now, playbook_id, int(login)),
                )
                if cursor.rowcount == 0:
                    return None
                target = playbook_id
            else:
                target = uuid.uuid4().hex
                self._db.execute(
                    """
                    INSERT INTO playbooks
                        (id, login, name, description, rules, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (target, int(login), name, description, payload, now, now),
                )
            self._db.commit()
        return self.playbook_get(target, login)

    def playbook_delete(self, playbook_id: str, login: int = 0) -> bool:
        """软删除：历史规则检查仍然保留，交易只解除关联。"""
        with self._lock:
            cursor = self._db.execute(
                "UPDATE playbooks SET archived_at=? WHERE id=? AND login=? AND archived_at IS NULL",
                (int(time.time()), playbook_id, int(login)),
            )
            self._db.commit()
        return cursor.rowcount > 0

    def trade_note_get(self, position_id: int, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM trade_notes WHERE login=? AND position_id=?",
                (int(login), int(position_id)),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["mistakes"] = [str(value) for value in _json_list(item.get("mistakes"))]
        return item

    def trade_note_save(
        self,
        position_id: int,
        playbook_id: str | None,
        rating: int | None,
        mistakes: list[str],
        note: str,
        login: int = 0,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """
                INSERT INTO trade_notes
                    (login, position_id, playbook_id, rating, mistakes, note, reviewed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, position_id) DO UPDATE SET
                    playbook_id=excluded.playbook_id,
                    rating=excluded.rating,
                    mistakes=excluded.mistakes,
                    note=excluded.note,
                    reviewed_at=excluded.reviewed_at,
                    updated_at=excluded.updated_at
                """,
                (
                    int(login),
                    int(position_id),
                    playbook_id,
                    rating,
                    json.dumps(mistakes, ensure_ascii=False),
                    note,
                    now,
                    now,
                ),
            )
            self._db.commit()
        return self.trade_note_get(position_id, login) or {}

    def trade_note_set_reviewed(
        self, position_id: int, reviewed: bool, login: int = 0
    ) -> dict[str, Any]:
        """只切换「已复盘」标记，不碰评分/笔记内容；没有记录时建一条空笔记。"""
        now = int(time.time())
        with self._lock:
            if reviewed:
                self._db.execute(
                    """
                    INSERT INTO trade_notes
                        (login, position_id, playbook_id, rating, mistakes, note, reviewed_at, updated_at)
                    VALUES (?, ?, NULL, NULL, '[]', '', ?, ?)
                    ON CONFLICT(login, position_id) DO UPDATE SET
                        reviewed_at=excluded.reviewed_at,
                        updated_at=excluded.updated_at
                    """,
                    (int(login), int(position_id), now, now),
                )
            else:
                self._db.execute(
                    "UPDATE trade_notes SET reviewed_at=NULL, updated_at=? WHERE login=? AND position_id=?",
                    (now, int(login), int(position_id)),
                )
            self._db.commit()
        return self.trade_note_get(position_id, login) or {}

    def trade_notes_all(
        self, login: int = 0, since: int = 0
    ) -> dict[int, dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """
                SELECT n.* FROM trade_notes n
                JOIN journal j ON j.login=n.login AND j.position_id=n.position_id
                WHERE n.login=? AND j.close_time >= ?
                """,
                (int(login), int(since)),
            ).fetchall()
        out: dict[int, dict[str, Any]] = {}
        for row in rows:
            item = dict(row)
            item["mistakes"] = [str(value) for value in _json_list(item.get("mistakes"))]
            out[int(item["position_id"])] = item
        return out

    def playbook_check_set(
        self,
        position_id: int,
        playbook_id: str,
        rule: str,
        followed: bool | None,
        login: int = 0,
    ) -> None:
        with self._lock:
            if followed is None:
                self._db.execute(
                    """DELETE FROM playbook_checks
                       WHERE login=? AND position_id=? AND rule=?""",
                    (int(login), int(position_id), rule),
                )
            else:
                self._db.execute(
                    """
                    INSERT INTO playbook_checks
                        (login, position_id, playbook_id, rule, followed, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(login, position_id, rule) DO UPDATE SET
                        playbook_id=excluded.playbook_id,
                        followed=excluded.followed,
                        updated_at=excluded.updated_at
                    """,
                    (
                        int(login),
                        int(position_id),
                        playbook_id,
                        rule,
                        1 if followed else 0,
                        int(time.time()),
                    ),
                )
            self._db.commit()

    def playbook_checks_clear(self, position_id: int, login: int = 0) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM playbook_checks WHERE login=? AND position_id=?",
                (int(login), int(position_id)),
            )
            self._db.commit()

    def playbook_checks_get(
        self, position_id: int, login: int = 0
    ) -> dict[str, bool]:
        with self._lock:
            rows = self._db.execute(
                "SELECT rule, followed FROM playbook_checks WHERE login=? AND position_id=?",
                (int(login), int(position_id)),
            ).fetchall()
        return {str(row["rule"]): bool(row["followed"]) for row in rows}

    def playbook_checks_all(
        self, login: int = 0, since: int = 0
    ) -> dict[int, dict[str, bool]]:
        with self._lock:
            rows = self._db.execute(
                """
                SELECT c.position_id, c.rule, c.followed FROM playbook_checks c
                JOIN journal j ON j.login=c.login AND j.position_id=c.position_id
                WHERE c.login=? AND j.close_time >= ?
                """,
                (int(login), int(since)),
            ).fetchall()
        out: dict[int, dict[str, bool]] = {}
        for row in rows:
            out.setdefault(int(row["position_id"]), {})[str(row["rule"])] = bool(
                row["followed"]
            )
        return out

    # ---------- 开仓纪律门禁 ----------

    @staticmethod
    def _pre_trade_gate_row(row: Any) -> dict[str, Any]:
        item = dict(row)
        item["rules"] = [str(rule) for rule in _json_list(item.get("rules"))]
        return item

    def pre_trade_gate_get(self, login: int, client_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM pre_trade_gate WHERE login=? AND client_id=?",
                (int(login), str(client_id)),
            ).fetchone()
        return None if row is None else self._pre_trade_gate_row(row)

    def pre_trade_gate_for_position(
        self, login: int, position_id: int
    ) -> dict[str, Any] | None:
        """按持仓反查开仓时的清单快照；一个持仓只应命中一行，取最近一次。"""
        with self._lock:
            row = self._db.execute(
                """
                SELECT * FROM pre_trade_gate
                WHERE login=? AND position_id=?
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (int(login), int(position_id)),
            ).fetchone()
        return None if row is None else self._pre_trade_gate_row(row)

    def pre_trade_gates_between(
        self, login: int, since: int, until: int
    ) -> list[dict[str, Any]]:
        """统计窗口内的开仓尝试（按 created_at，Unix 秒）。"""
        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM pre_trade_gate
                WHERE login=? AND created_at>=? AND created_at<?
                ORDER BY created_at, rowid
                """,
                (int(login), int(since), int(until)),
            ).fetchall()
        return [self._pre_trade_gate_row(row) for row in rows]

    def pre_trade_gate_start(
        self,
        login: int,
        client_id: str,
        playbook_id: str | None,
        mode: str,
        rules: list[str],
    ) -> dict[str, Any]:
        """建 pending 行并快照规则；同 client_id 重复打开返回已有行（幂等）。"""
        now = int(time.time())
        with self._lock:
            self._db.execute(
                """
                INSERT INTO pre_trade_gate
                    (login, client_id, playbook_id, mode, state, rules, reason,
                     position_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)
                ON CONFLICT(login, client_id) DO NOTHING
                """,
                (
                    int(login),
                    str(client_id),
                    playbook_id,
                    mode,
                    json.dumps(rules, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            self._db.commit()
        gate = self.pre_trade_gate_get(login, client_id)
        if gate is None:
            raise RuntimeError("pre_trade_gate 写入失败")
        return gate

    def pre_trade_gate_update(
        self,
        login: int,
        client_id: str,
        state: str,
        *,
        reason: Any = _KEEP,
        position_id: Any = _KEEP,
    ) -> dict[str, Any] | None:
        fields = ["state=?", "updated_at=?"]
        values: list[Any] = [state, int(time.time())]
        if reason is not _KEEP:
            fields.append("reason=?")
            values.append(reason)
        if position_id is not _KEEP:
            fields.append("position_id=?")
            values.append(position_id)
        values.extend([int(login), str(client_id)])
        with self._lock:
            self._db.execute(
                f"UPDATE pre_trade_gate SET {', '.join(fields)} WHERE login=? AND client_id=?",
                tuple(values),
            )
            self._db.commit()
        return self.pre_trade_gate_get(login, client_id)

    def pre_trade_gate_link(
        self, login: int, client_id: str, position_id: int
    ) -> dict[str, Any] | None:
        """成交后回填持仓号，供复盘抽屉按交易反查开仓时的清单。"""
        return self.pre_trade_gate_update(
            login, client_id, self._gate_state(login, client_id), position_id=int(position_id)
        )

    def _gate_state(self, login: int, client_id: str) -> str:
        gate = self.pre_trade_gate_get(login, client_id)
        return str(gate["state"]) if gate else "pending"

    def pre_trade_gate_reset(self, login: int, client_id: str) -> dict[str, Any] | None:
        """清空勾选，回到 pending；保留规则快照与播放的 client_id。"""
        with self._lock:
            self._db.execute(
                "DELETE FROM pre_trade_checks WHERE login=? AND client_id=?",
                (int(login), str(client_id)),
            )
            self._db.execute(
                """
                UPDATE pre_trade_gate
                SET state='pending', reason=NULL, updated_at=?
                WHERE login=? AND client_id=?
                """,
                (int(time.time()), int(login), str(client_id)),
            )
            self._db.commit()
        return self.pre_trade_gate_get(login, client_id)

    def pre_trade_check_set(
        self,
        login: int,
        client_id: str,
        playbook_id: str,
        rule: str,
        followed: bool | None,
    ) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO pre_trade_checks
                    (login, client_id, playbook_id, rule, followed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, client_id, rule) DO UPDATE SET
                    playbook_id=excluded.playbook_id,
                    followed=excluded.followed,
                    updated_at=excluded.updated_at
                """,
                (
                    int(login),
                    str(client_id),
                    playbook_id,
                    rule,
                    None if followed is None else (1 if followed else 0),
                    int(time.time()),
                ),
            )
            self._db.commit()

    def pre_trade_checks_get(
        self, login: int, client_id: str
    ) -> dict[str, bool | None]:
        """返回已评估的规则；值为 None 表示「不适用」，键不存在表示未评估。"""
        with self._lock:
            rows = self._db.execute(
                "SELECT rule, followed FROM pre_trade_checks WHERE login=? AND client_id=?",
                (int(login), str(client_id)),
            ).fetchall()
        return {
            str(row["rule"]): (None if row["followed"] is None else bool(row["followed"]))
            for row in rows
        }

    def pre_trade_checks_clear(self, login: int, client_id: str) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM pre_trade_checks WHERE login=? AND client_id=?",
                (int(login), str(client_id)),
            )
            self._db.commit()

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

    def integrity_check(self) -> dict:
        """启动自检：SQLite 文件结构是否完整（只读，不修复）。"""
        with self._lock:
            rows = self._db.execute("PRAGMA integrity_check").fetchall()
        messages = [str(row[0]) for row in rows]
        return {"ok": messages == ["ok"], "messages": messages[:10]}

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

    # ---------- 例行清单 ----------

    @staticmethod
    def _routine_row(row: Any) -> dict[str, Any]:
        item = dict(row)
        item["weekdays"] = [
            int(value)
            for value in _json_list(item.get("weekdays"))
            if isinstance(value, (int, float, str)) and str(value).isdigit()
        ]
        return item

    def routines_list(
        self, login: int = 0, include_archived: bool = False
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM routines WHERE login=?"
        if not include_archived:
            sql += " AND archived_at IS NULL"
        sql += " ORDER BY sort, id"
        with self._lock:
            rows = self._db.execute(sql, (int(login),)).fetchall()
        return [self._routine_row(row) for row in rows]

    def routine_get(self, routine_id: int, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM routines WHERE id=? AND login=?",
                (int(routine_id), int(login)),
            ).fetchone()
        return self._routine_row(row) if row else None

    def routine_save(
        self,
        title: str,
        phase: str,
        weekdays: list[int],
        sort: int,
        login: int = 0,
        routine_id: int | None = None,
    ) -> dict[str, Any] | None:
        now = int(time.time())
        payload = json.dumps(weekdays, ensure_ascii=False)
        with self._lock:
            if routine_id:
                cursor = self._db.execute(
                    """
                    UPDATE routines
                    SET title=?, phase=?, weekdays=?, sort=?, updated_at=?
                    WHERE id=? AND login=? AND archived_at IS NULL
                    """,
                    (title, phase, payload, int(sort), now, int(routine_id), int(login)),
                )
                if cursor.rowcount == 0:
                    return None
                target = int(routine_id)
            else:
                cursor = self._db.execute(
                    """
                    INSERT INTO routines
                        (login, title, phase, weekdays, sort, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (int(login), title, phase, payload, int(sort), now, now),
                )
                target = int(cursor.lastrowid)
            self._db.commit()
        return self.routine_get(target, login)

    def routine_archive(self, routine_id: int, login: int = 0) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "UPDATE routines SET archived_at=? WHERE id=? AND login=? AND archived_at IS NULL",
                (int(time.time()), int(routine_id), int(login)),
            )
            self._db.commit()
        return cursor.rowcount > 0

    def routine_done_set(
        self, routine_id: int, day: str, done: bool, login: int = 0
    ) -> None:
        now = int(time.time())
        with self._lock:
            if done:
                self._db.execute(
                    """
                    INSERT INTO routine_done (login, routine_id, day, done_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(login, routine_id, day) DO UPDATE SET done_at=excluded.done_at
                    """,
                    (int(login), int(routine_id), day, now),
                )
            else:
                self._db.execute(
                    "DELETE FROM routine_done WHERE login=? AND routine_id=? AND day=?",
                    (int(login), int(routine_id), day),
                )
            self._db.commit()

    def routine_done_range(
        self, login: int, start_day: str, end_day: str
    ) -> dict[tuple[int, str], int]:
        with self._lock:
            rows = self._db.execute(
                """SELECT routine_id, day, done_at FROM routine_done
                   WHERE login=? AND day >= ? AND day <= ?""",
                (int(login), start_day, end_day),
            ).fetchall()
        return {(int(row["routine_id"]), str(row["day"])): int(row["done_at"]) for row in rows}

    # ---------- 错过机会 ----------

    @staticmethod
    def _missed_row(row: Any) -> dict[str, Any]:
        item = dict(row)
        raw = item.pop("sim", None)
        try:
            item["sim"] = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            item["sim"] = None
        return item

    def missed_list(self, login: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM missed_trades WHERE login=?
                   ORDER BY observed_at DESC, id DESC LIMIT ?""",
                (int(login), int(limit)),
            ).fetchall()
        return [self._missed_row(row) for row in rows]

    def missed_get(self, missed_id: int, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM missed_trades WHERE id=? AND login=?",
                (int(missed_id), int(login)),
            ).fetchone()
        return self._missed_row(row) if row else None

    def missed_save(
        self,
        symbol: str,
        side: str,
        observed_at: int,
        entry_price: float | None,
        sl: float | None,
        tp: float | None,
        playbook_id: str | None,
        note: str,
        login: int = 0,
        missed_id: int | None = None,
    ) -> dict[str, Any] | None:
        now = int(time.time())
        with self._lock:
            if missed_id:
                cursor = self._db.execute(
                    """
                    UPDATE missed_trades
                    SET symbol=?, side=?, observed_at=?, entry_price=?, sl=?, tp=?,
                        playbook_id=?, note=?, sim=NULL, updated_at=?
                    WHERE id=? AND login=?
                    """,
                    (
                        symbol,
                        side,
                        int(observed_at),
                        entry_price,
                        sl,
                        tp,
                        playbook_id,
                        note,
                        now,
                        int(missed_id),
                        int(login),
                    ),
                )
                if cursor.rowcount == 0:
                    return None
                target = int(missed_id)
            else:
                cursor = self._db.execute(
                    """
                    INSERT INTO missed_trades
                        (login, symbol, side, observed_at, entry_price, sl, tp,
                         playbook_id, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        int(login),
                        symbol,
                        side,
                        int(observed_at),
                        entry_price,
                        sl,
                        tp,
                        playbook_id,
                        note,
                        now,
                        now,
                    ),
                )
                target = int(cursor.lastrowid)
            self._db.commit()
        return self.missed_get(target, login)

    def missed_update_sim(
        self, missed_id: int, sim: dict[str, Any], login: int = 0
    ) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE missed_trades SET sim=?, updated_at=? WHERE id=? AND login=?",
                (
                    json.dumps(sim, ensure_ascii=False),
                    int(time.time()),
                    int(missed_id),
                    int(login),
                ),
            )
            self._db.commit()

    def missed_delete(self, missed_id: int, login: int = 0) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "DELETE FROM missed_trades WHERE id=? AND login=?",
                (int(missed_id), int(login)),
            )
            self._db.commit()
        return cursor.rowcount > 0

    # ------------------------------------------------------------ 回放会话
    # updated_at 用毫秒（与前端 session.updatedAt 同源），只做顺序比较，
    # 不参与复盘层的按日分桶。

    @staticmethod
    def _replay_row(row: Any) -> dict[str, Any]:
        item = dict(row)
        raw = item.pop("payload", None)
        try:
            session = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            session = {}
        if not isinstance(session, dict):
            session = {}
        return {
            "id": item["id"],
            "updatedAt": int(item["updated_at"]),
            "session": session,
            "chart": item.get("chart"),
            "drawings": item.get("drawings"),
        }

    def replay_list(self, login: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM replay_sessions WHERE login=?
                   ORDER BY updated_at DESC LIMIT ?""",
                (int(login), int(limit)),
            ).fetchall()
        return [self._replay_row(row) for row in rows]

    def replay_get(self, replay_id: str, login: int = 0) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM replay_sessions WHERE id=? AND login=?",
                (replay_id, int(login)),
            ).fetchone()
        return self._replay_row(row) if row else None

    def replay_save(
        self,
        login: int,
        session: dict[str, Any],
        payload: str,
        chart: str | None = None,
        drawings: str | None = None,
    ) -> bool:
        """写入一条会话；磁盘上的 updated_at 比 payload 新时返回 False（冲突）。

        chart / drawings 未提供时保留原值，便于前端只保存图表视图。
        """
        replay_id = str(session.get("id") or "")
        updated_at = int(session.get("updatedAt") or 0)
        created_at = int(session.get("createdAt") or updated_at)
        reference = session.get("reference") or {}
        reference_key = reference.get("key") if isinstance(reference, dict) else None
        archived = 1 if session.get("status") == "archived" else 0
        with self._lock:
            existing = self._db.execute(
                "SELECT updated_at FROM replay_sessions WHERE login=? AND id=?",
                (int(login), replay_id),
            ).fetchone()
            if existing is not None and int(existing["updated_at"]) > updated_at:
                return False
            self._db.execute(
                """
                INSERT INTO replay_sessions
                    (login, id, name, symbol, status, origin, reference_key,
                     start_ts, end_ts, created_at, updated_at, archived,
                     payload, chart, drawings)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(login, id) DO UPDATE SET
                    name=excluded.name,
                    symbol=excluded.symbol,
                    status=excluded.status,
                    origin=excluded.origin,
                    reference_key=excluded.reference_key,
                    start_ts=excluded.start_ts,
                    end_ts=excluded.end_ts,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at,
                    archived=excluded.archived,
                    payload=excluded.payload,
                    chart=COALESCE(excluded.chart, replay_sessions.chart),
                    drawings=COALESCE(excluded.drawings, replay_sessions.drawings)
                """,
                (
                    int(login),
                    replay_id,
                    str(session.get("name") or ""),
                    str(session.get("symbol") or ""),
                    str(session.get("status") or ""),
                    session.get("origin"),
                    reference_key,
                    int(session.get("startTs") or 0),
                    int(session.get("endTs") or 0),
                    created_at,
                    updated_at,
                    archived,
                    payload,
                    chart,
                    drawings,
                ),
            )
            self._db.commit()
        return True

    def replay_save_view(
        self,
        login: int,
        replay_id: str,
        chart: str | None = None,
        drawings: str | None = None,
    ) -> bool:
        """只更新图表视图与画线；不推进 updated_at，避免和会话保存互相覆盖。"""
        sets: list[str] = []
        args: list[Any] = []
        if chart is not None:
            sets.append("chart=?")
            args.append(chart)
        if drawings is not None:
            sets.append("drawings=?")
            args.append(drawings)
        if not sets:
            return False
        args.extend([replay_id, int(login)])
        with self._lock:
            cursor = self._db.execute(
                f"UPDATE replay_sessions SET {', '.join(sets)} WHERE id=? AND login=?",
                tuple(args),
            )
            self._db.commit()
        return cursor.rowcount > 0

    def replay_delete(self, replay_id: str, login: int = 0) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "DELETE FROM replay_sessions WHERE id=? AND login=?",
                (replay_id, int(login)),
            )
            self._db.commit()
        return cursor.rowcount > 0
