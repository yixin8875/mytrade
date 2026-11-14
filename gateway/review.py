"""复盘层：盈亏日历、日笔记、策略手册与规则遵守度。

只读 journal 的成交记录，写独立的复盘表；不参与下单决策。
日期口径：journal 里存的是券商服务器时间，先减去 server_offset 得到 UTC，
再按复盘时区（默认本机偏移）折算成 YYYY-MM-DD。
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from store import Store

DAY_FMT = "%Y-%m-%d"
MONTH_FMT = "%Y-%m"
MAX_RULES = 20
MAX_RULE_LEN = 200
BREAKEVEN = 0.005


class ReviewError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _local_offset_min() -> int:
    """本机时区相对 UTC 的分钟数（东八区 = 480）。"""
    dst = time.daylight and time.localtime().tm_isdst
    seconds = time.altzone if dst else time.timezone
    return int(-seconds // 60)


def _clean_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _clean_list(value: Any, max_items: int, max_len: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _clean_text(item, max_len)
        if text and text not in out:
            out.append(text)
        if len(out) >= max_items:
            break
    return out


def _int_or_none(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


class Review:
    def __init__(self, store: Store) -> None:
        self.store = store

    # ---------- 时间口径 ----------

    def timezone_offset_min(self) -> int:
        value = self.store.review_setting_get("timezone_offset_min")
        if isinstance(value, (int, float)) and -12 * 60 <= int(value) <= 14 * 60:
            return int(value)
        return _local_offset_min()

    def _day_start_utc(self, day: date) -> int:
        midnight = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        return int(midnight.timestamp()) - self.timezone_offset_min() * 60

    def _day_key(self, raw_ts: int, server_offset: int) -> str:
        local = int(raw_ts) - int(server_offset) + self.timezone_offset_min() * 60
        return datetime.fromtimestamp(local, timezone.utc).strftime(DAY_FMT)

    def _raw_range(
        self, start: date, end: date, server_offset: int
    ) -> tuple[int, int]:
        """[start, end) 的本地日期，换算成 journal 里存的服务器时间戳。"""
        return (
            self._day_start_utc(start) + int(server_offset),
            self._day_start_utc(end) + int(server_offset),
        )

    def _today(self) -> str:
        local = time.time() + self.timezone_offset_min() * 60
        return datetime.fromtimestamp(local, timezone.utc).strftime(DAY_FMT)

    # ---------- 汇总 ----------

    @staticmethod
    def _r(row: dict[str, Any]) -> float | None:
        try:
            risk = float(row.get("risk") or 0)
            if risk <= 0:
                return None
            return round(float(row.get("profit") or 0) / risk, 4)
        except (TypeError, ValueError):
            return None

    def _aggregate(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        net = 0.0
        wins = losses = 0
        r_values: list[float] = []
        for row in rows:
            profit = float(row.get("profit") or 0)
            net += profit
            if profit > BREAKEVEN:
                wins += 1
            elif profit < -BREAKEVEN:
                losses += 1
            r_value = self._r(row)
            if r_value is not None:
                r_values.append(r_value)
        return {
            "net": round(net, 2),
            "trades": len(rows),
            "wins": wins,
            "losses": losses,
            "r": round(sum(r_values), 2) if r_values else None,
            "rTrades": len(r_values),
        }

    def _summary(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        base = self._aggregate(rows)
        trades = base["trades"]
        durations = [
            int(row.get("duration_sec") or 0)
            for row in rows
            if row.get("duration_sec") is not None
        ]
        r_values = [self._r(row) for row in rows]
        r_values = [value for value in r_values if value is not None]
        return {
            **base,
            "winRate": (base["wins"] / trades) if trades else None,
            "expectancy": (base["net"] / trades) if trades else None,
            "avgR": (round(sum(r_values) / len(r_values), 4) if r_values else None),
            "totalR": round(sum(r_values), 2) if r_values else 0.0,
            "avgDurationSec": (sum(durations) / len(durations)) if durations else 0,
        }

    # ---------- 趋势与散点 ----------

    def trades(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        """按平仓时间升序返回区间内每笔交易，供滚动趋势与散点使用。"""
        days = _int_or_none(params.get("days")) or 180
        days = max(7, min(730, days))
        today = datetime.strptime(self._today(), DAY_FMT).date()
        start = today - timedelta(days=days - 1)
        raw_start, raw_end = self._raw_range(
            start, today + timedelta(days=1), server_offset
        )
        rows = self.store.journal_between(raw_start, raw_end, login)
        rows.sort(key=lambda row: int(row["close_time"]))
        trades: list[dict[str, Any]] = []
        for row in rows:
            close_time = int(row["close_time"])
            trades.append(
                {
                    "positionId": int(row["position_id"]),
                    "symbol": row["symbol"],
                    "side": row["side"],
                    "volume": float(row["volume"] or 0),
                    "openTime": int(row["open_time"]),
                    "closeTime": close_time,
                    "profit": round(float(row["profit"] or 0), 2),
                    "r": self._r(row),
                    "risk": row.get("risk"),
                    "durationSec": row.get("duration_sec"),
                    "mfe": row.get("mfe"),
                    "mae": row.get("mae"),
                    "tag": row.get("tag"),
                    "day": self._day_key(close_time, server_offset),
                }
            )
        return {
            "days": days,
            "start": start.strftime(DAY_FMT),
            "end": today.strftime(DAY_FMT),
            "timezoneOffsetMin": self.timezone_offset_min(),
            "trades": trades,
        }

    # ---------- 日历 ----------

    def calendar(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        month = _clean_text(params.get("month"), 7)
        try:
            anchor = datetime.strptime(month, MONTH_FMT).date().replace(day=1)
        except ValueError:
            today = datetime.strptime(self._today(), DAY_FMT).date()
            anchor = today.replace(day=1)
        start = anchor
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        grid_start = start - timedelta(days=start.weekday())
        last = end - timedelta(days=1)
        grid_end = last + timedelta(days=6 - last.weekday())

        raw_start, raw_end = self._raw_range(
            grid_start, grid_end + timedelta(days=1), server_offset
        )
        rows = self.store.journal_between(raw_start, raw_end, login)
        by_day: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            key = self._day_key(int(row["close_time"]), server_offset)
            by_day.setdefault(key, []).append(row)

        weeks: list[dict[str, Any]] = []
        cursor = grid_start
        while cursor <= grid_end:
            days: list[dict[str, Any] | None] = []
            total = 0.0
            for index in range(7):
                current = cursor + timedelta(days=index)
                key = current.strftime(DAY_FMT)
                aggregate = self._aggregate(by_day.get(key, []))
                total += aggregate["net"]
                if start <= current < end:
                    days.append({"date": key, **aggregate})
                else:
                    days.append(None)
            weeks.append({"days": days, "total": round(total, 2)})
            cursor += timedelta(days=7)

        month_rows: list[dict[str, Any]] = []
        month_days: list[dict[str, Any]] = []
        for key, bucket in by_day.items():
            current = datetime.strptime(key, DAY_FMT).date()
            if start <= current < end:
                month_rows.extend(bucket)
                month_days.append({"date": key, **self._aggregate(bucket)})

        traded_days = [day for day in month_days if day["trades"] > 0]
        win_days = [day for day in traded_days if day["net"] > BREAKEVEN]
        loss_days = [day for day in traded_days if day["net"] < -BREAKEVEN]
        summary = self._summary(month_rows)
        summary.update(
            {
                "tradingDays": len(traded_days),
                "winDays": len(win_days),
                "lossDays": len(loss_days),
                "dayWinRate": (len(win_days) / len(traded_days)) if traded_days else None,
                "bestDay": max(traded_days, key=lambda item: item["net"]) if traded_days else None,
                "worstDay": min(traded_days, key=lambda item: item["net"]) if traded_days else None,
            }
        )
        return {
            "month": start.strftime(MONTH_FMT),
            "today": self._today(),
            "timezoneOffsetMin": self.timezone_offset_min(),
            "weeks": weeks,
            "summary": summary,
        }

    # ---------- 日详情 ----------

    def day(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        raw_day = _clean_text(params.get("date"), 10)
        try:
            anchor = datetime.strptime(raw_day, DAY_FMT).date()
        except ValueError as exc:
            raise ReviewError("BAD_DATE", "日期格式应为 YYYY-MM-DD") from exc
        raw_start, raw_end = self._raw_range(anchor, anchor + timedelta(days=1), server_offset)
        rows = self.store.journal_between(raw_start, raw_end, login)

        books = self.store.playbooks_list(login)
        book_map = {book["id"]: book for book in books}
        notes = self.store.trade_notes_all(login)
        checks = self.store.playbook_checks_all(login)

        records: list[dict[str, Any]] = []
        for row in rows:
            position_id = int(row["position_id"])
            annotation = None
            note = notes.get(position_id)
            if note:
                book = book_map.get(note.get("playbook_id") or "")
                if book is None and note.get("playbook_id"):
                    book = self.store.playbook_get(str(note["playbook_id"]), login)
                rule_checks = checks.get(position_id, {})
                rules: list[dict[str, Any]] = []
                followed = broken = 0
                if book:
                    for rule in book["rules"]:
                        value = rule_checks.get(rule)
                        rules.append({"rule": rule, "followed": value})
                        if value is True:
                            followed += 1
                        elif value is False:
                            broken += 1
                annotation = {
                    "playbookId": note.get("playbook_id"),
                    "playbookName": book["name"] if book else None,
                    "rating": note.get("rating"),
                    "mistakes": note.get("mistakes") or [],
                    "note": note.get("note") or "",
                    "reviewedAt": note.get("reviewed_at"),
                    "rules": rules,
                    "followed": followed,
                    "broken": broken,
                }
            records.append({**row, "r": self._r(row), "annotation": annotation})

        note_row = self.store.day_note_get(raw_day, login) or {
            "day": raw_day,
            "note": "",
            "mood": None,
            "tags": [],
            "replaySessionId": None,
            "updated_at": None,
        }
        return {
            "date": raw_day,
            "summary": self._summary(rows),
            "records": records,
            "note": note_row,
            "templates": self.store.note_templates_list(login),
            "playbooks": books,
            "timezoneOffsetMin": self.timezone_offset_min(),
        }

    # ---------- 日笔记 ----------

    def note_save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        day = _clean_text(params.get("date"), 10)
        try:
            datetime.strptime(day, DAY_FMT)
        except ValueError as exc:
            raise ReviewError("BAD_DATE", "日期格式应为 YYYY-MM-DD") from exc
        note = str(params.get("note") or "")[:20000]
        mood = _int_or_none(params.get("mood"))
        if mood is not None and not 1 <= mood <= 5:
            raise ReviewError("BAD_MOOD", "心情只能是 1–5")
        tags = _clean_list(params.get("tags"), 12, 24)
        replay_session_id = _clean_text(params.get("replaySessionId"), 80) or None
        saved = self.store.day_note_save(
            day, note, mood, tags, replay_session_id, login
        )
        return {"saved": True, "note": saved}

    def templates(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        return {"templates": self.store.note_templates_list(login)}

    def template_save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        name = _clean_text(params.get("name"), 60)
        body = str(params.get("body") or "")[:6000]
        if not name:
            raise ReviewError("BAD_NAME", "模板名不能为空")
        template_id = _int_or_none(params.get("id"))
        saved = self.store.note_template_save(name, body, login, template_id)
        if saved is None:
            raise ReviewError("NOT_FOUND", "模板不存在")
        return {"template": saved}

    def template_delete(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        template_id = _int_or_none(params.get("id"))
        if template_id is None:
            raise ReviewError("BAD_ID", "缺少模板 id")
        if not self.store.note_template_delete(template_id, login):
            raise ReviewError("NOT_FOUND", "模板不存在")
        return {"deleted": True}

    # ---------- 策略手册 ----------

    def strategy_list(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        books = self.store.playbooks_list(
            login, include_archived=bool(params.get("includeArchived"))
        )
        notes = self.store.trade_notes_all(login)
        counts: dict[str, int] = {}
        for note in notes.values():
            book_id = note.get("playbook_id")
            if book_id:
                counts[str(book_id)] = counts.get(str(book_id), 0) + 1
        return {
            "playbooks": [
                {**book, "tradeCount": counts.get(book["id"], 0)} for book in books
            ]
        }

    def strategy_save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        name = _clean_text(params.get("name"), 40)
        if not name:
            raise ReviewError("BAD_NAME", "策略名不能为空")
        description = str(params.get("description") or "")[:500]
        rules = _clean_list(params.get("rules"), MAX_RULES, MAX_RULE_LEN)
        playbook_id = _clean_text(params.get("id"), 40) or None
        saved = self.store.playbook_save(
            name, description, rules, login, playbook_id
        )
        if saved is None:
            raise ReviewError("NOT_FOUND", "策略不存在")
        return {"playbook": saved}

    def strategy_delete(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        playbook_id = _clean_text(params.get("id"), 40)
        if not playbook_id or not self.store.playbook_delete(playbook_id, login):
            raise ReviewError("NOT_FOUND", "策略不存在")
        return {"deleted": True}

    # ---------- 单笔复盘 ----------

    def _require_trade(self, position_id: int, login: int) -> dict[str, Any]:
        row = self.store.journal_get(position_id, login)
        if row is None:
            raise ReviewError("NOT_FOUND", "交易不存在")
        return row

    def trade_note(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        position_id = _int_or_none(params.get("positionId"))
        if position_id is None:
            raise ReviewError("BAD_ID", "缺少 positionId")
        row = self._require_trade(position_id, login)
        note = self.store.trade_note_get(position_id, login) or {
            "playbook_id": None,
            "rating": None,
            "mistakes": [],
            "note": "",
            "reviewed_at": None,
        }
        book = (
            self.store.playbook_get(str(note["playbook_id"]), login)
            if note.get("playbook_id")
            else None
        )
        checks = self.store.playbook_checks_get(position_id, login)
        rules = [
            {"rule": rule, "followed": checks.get(rule)}
            for rule in (book["rules"] if book else [])
        ]
        return {
            "positionId": position_id,
            "playbookId": note.get("playbook_id"),
            "playbookName": book["name"] if book else None,
            "rating": note.get("rating"),
            "mistakes": note.get("mistakes") or [],
            "note": note.get("note") or "",
            "reviewedAt": note.get("reviewed_at"),
            "rules": rules,
            "playbooks": self.store.playbooks_list(login),
            "trade": {
                "positionId": position_id,
                "symbol": row["symbol"],
                "side": row["side"],
                "volume": row["volume"],
                "openTime": row["open_time"],
                "closeTime": row["close_time"],
                "profit": row["profit"],
                "r": self._r(row),
            },
        }

    def trade_note_save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        position_id = _int_or_none(params.get("positionId"))
        if position_id is None:
            raise ReviewError("BAD_ID", "缺少 positionId")
        self._require_trade(position_id, login)
        playbook_id = _clean_text(params.get("playbookId"), 40) or None
        if playbook_id and self.store.playbook_get(playbook_id, login) is None:
            raise ReviewError("NOT_FOUND", "策略不存在")
        rating = _int_or_none(params.get("rating"))
        if rating is not None and not 1 <= rating <= 5:
            raise ReviewError("BAD_RATING", "评分只能是 1–5")
        mistakes = _clean_list(params.get("mistakes"), 10, 40)
        note = str(params.get("note") or "")[:4000]

        existing = self.store.trade_note_get(position_id, login)
        if existing and existing.get("playbook_id") != playbook_id:
            # 换策略后旧的规则勾选不再属于当前策略，清掉避免串味
            self.store.playbook_checks_clear(position_id, login)
        self.store.trade_note_save(
            position_id, playbook_id, rating, mistakes, note, login
        )
        return {"saved": True, "note": self.trade_note({"positionId": position_id}, login)}

    def check(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        position_id = _int_or_none(params.get("positionId"))
        if position_id is None:
            raise ReviewError("BAD_ID", "缺少 positionId")
        self._require_trade(position_id, login)
        playbook_id = _clean_text(params.get("playbookId"), 40)
        rule = _clean_text(params.get("rule"), MAX_RULE_LEN)
        book = self.store.playbook_get(playbook_id, login)
        if book is None:
            raise ReviewError("NOT_FOUND", "策略不存在")
        if rule not in book["rules"]:
            raise ReviewError("BAD_RULE", "这条规则不属于当前策略")
        followed = params.get("followed")
        if followed is not None and not isinstance(followed, bool):
            raise ReviewError("BAD_VALUE", "followed 只能是 true / false / null")
        self.store.playbook_check_set(
            position_id, playbook_id, rule, followed, login
        )
        return {"saved": True}

    # ---------- 遵守度 ----------

    @staticmethod
    def _classify(rule_checks: dict[str, bool], rules: list[str]) -> str:
        values = [rule_checks.get(rule) for rule in rules]
        if any(value is False for value in values):
            return "broken"
        if rules and all(value is True for value in values):
            return "followed"
        return "unassessed"

    def adherence(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        days = _int_or_none(params.get("days")) or 90
        days = max(1, min(3650, days))
        now_raw = int(time.time()) + int(server_offset)
        since_raw = now_raw - days * 86400
        rows = self.store.journal_between(since_raw, now_raw + 86400, login)
        notes = self.store.trade_notes_all(login, since_raw)
        checks = self.store.playbook_checks_all(login, since_raw)
        books = self.store.playbooks_list(login, include_archived=True)
        playbook_filter = _clean_text(params.get("playbookId"), 40)

        result: list[dict[str, Any]] = []
        for book in books:
            if playbook_filter and book["id"] != playbook_filter:
                continue
            rules = book["rules"]
            linked = [
                row
                for row in rows
                if str(notes.get(int(row["position_id"]), {}).get("playbook_id") or "")
                == book["id"]
            ]
            followed_rows: list[dict[str, Any]] = []
            broken_rows: list[dict[str, Any]] = []
            assessed_checks = followed_checks = 0
            for row in linked:
                rule_checks = checks.get(int(row["position_id"]), {})
                for rule in rules:
                    value = rule_checks.get(rule)
                    if value is None:
                        continue
                    assessed_checks += 1
                    if value:
                        followed_checks += 1
                outcome = self._classify(rule_checks, rules)
                if outcome == "followed":
                    followed_rows.append(row)
                elif outcome == "broken":
                    broken_rows.append(row)

            rule_stats = []
            for rule in rules:
                rule_followed = [
                    row
                    for row in linked
                    if checks.get(int(row["position_id"]), {}).get(rule) is True
                ]
                rule_broken = [
                    row
                    for row in linked
                    if checks.get(int(row["position_id"]), {}).get(rule) is False
                ]
                evaluated = len(rule_followed) + len(rule_broken)
                rule_stats.append(
                    {
                        "rule": rule,
                        "evaluated": evaluated,
                        "rate": (len(rule_followed) / evaluated) if evaluated else None,
                        "followed": self._summary(rule_followed),
                        "broken": self._summary(rule_broken),
                    }
                )

            if not linked and book.get("archived_at"):
                continue
            assessed_trades = len(followed_rows) + len(broken_rows)
            result.append(
                {
                    "id": book["id"],
                    "name": book["name"],
                    "description": book["description"],
                    "rules": rules,
                    "archivedAt": book.get("archived_at"),
                    "total": len(linked),
                    "evaluated": assessed_trades,
                    "possible": len(linked) * len(rules),
                    "rate": (followed_checks / assessed_checks) if assessed_checks else None,
                    "followed": self._summary(followed_rows),
                    "broken": self._summary(broken_rows),
                    "unassessed": len(linked) - assessed_trades,
                    "ruleStats": rule_stats,
                }
            )
        result.sort(key=lambda item: item["total"], reverse=True)
        return {
            "days": days,
            "timezoneOffsetMin": self.timezone_offset_min(),
            "books": result,
        }

    # ---------- 复盘设置 ----------

    def settings(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        return {
            "timezoneOffsetMin": self.timezone_offset_min(),
            "localOffsetMin": _local_offset_min(),
        }

    def settings_save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        value = _int_or_none(params.get("timezoneOffsetMin"))
        if value is None or not -12 * 60 <= value <= 14 * 60:
            raise ReviewError("BAD_VALUE", "时区偏移必须在 -720 到 840 分钟之间")
        self.store.review_setting_set("timezone_offset_min", value)
        return self.settings(params, login)
