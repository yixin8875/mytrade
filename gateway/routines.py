"""例行清单：盘前 / 盘中 / 盘后三组可打勾的流程，以及 13 周完成率热力图。

与交易数据完全独立：盈亏、胜率、R 都不参与。
日期口径与复盘层一致：本地复盘时区的 YYYY-MM-DD。
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from store import Store

DAY_FMT = "%Y-%m-%d"
PHASES = ("pre", "during", "post")
MAX_TITLE = 80
BACKFILL_DAYS = 7
MAX_WEEKS = 26

DEFAULT_ROUTINES: list[dict[str, Any]] = [
    {"title": "看财经日历与重大数据", "phase": "pre", "sort": 0},
    {"title": "检查点差、流动性与隔夜跳空", "phase": "pre", "sort": 1},
    {"title": "写下当日计划与最大亏损", "phase": "pre", "sort": 2},
    {"title": "只做计划内的 setup", "phase": "during", "sort": 0},
    {"title": "亏损达到上限立即停手", "phase": "during", "sort": 1},
    {"title": "逐笔复盘并写当天笔记", "phase": "post", "sort": 0},
    {"title": "整理明日观察名单", "phase": "post", "sort": 1},
]


class RoutineError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _local_offset_min() -> int:
    dst = time.daylight and time.localtime().tm_isdst
    seconds = time.altzone if dst else time.timezone
    return int(-seconds // 60)


def _parse_day(value: Any) -> date:
    try:
        return datetime.strptime(str(value or ""), DAY_FMT).date()
    except ValueError as exc:
        raise RoutineError("BAD_DATE", "日期格式应为 YYYY-MM-DD") from exc


def _weekday_monday(day: date) -> int:
    """周一 = 1 … 周日 = 7"""
    return day.isoweekday()


class Routines:
    def __init__(self, store: Store) -> None:
        self.store = store

    # ---------- 时间 ----------

    def _offset_min(self) -> int:
        value = self.store.review_setting_get("timezone_offset_min")
        if isinstance(value, (int, float)) and -12 * 60 <= int(value) <= 14 * 60:
            return int(value)
        return _local_offset_min()

    def _today(self) -> date:
        local = time.time() + self._offset_min() * 60
        return datetime.fromtimestamp(local, timezone.utc).date()

    def _day_of(self, ts: int | None) -> date | None:
        if not ts:
            return None
        local = int(ts) + self._offset_min() * 60
        return datetime.fromtimestamp(local, timezone.utc).date()

    # ---------- 清单 ----------

    def _payload(self, routine: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(routine["id"]),
            "title": routine["title"],
            "phase": routine["phase"],
            "weekdays": list(routine["weekdays"]),
            "sort": int(routine["sort"]),
            "archivedAt": routine.get("archived_at"),
            "createdAt": routine["created_at"],
            "updatedAt": routine["updated_at"],
        }

    def list(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        books = self.store.routines_list(
            login, include_archived=bool(params.get("includeArchived"))
        )
        return {"routines": [self._payload(item) for item in books]}

    def seed(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        existing = self.store.routines_list(login, include_archived=True)
        if existing:
            return {"created": 0, "routines": [self._payload(item) for item in existing]}
        for item in DEFAULT_ROUTINES:
            self.store.routine_save(
                item["title"],
                item["phase"],
                [1, 2, 3, 4, 5],
                item["sort"],
                login,
            )
        return {
            "created": len(DEFAULT_ROUTINES),
            "routines": [
                self._payload(item) for item in self.store.routines_list(login)
            ],
        }

    def save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        title = str(params.get("title") or "").strip()[:MAX_TITLE]
        if not title:
            raise RoutineError("BAD_TITLE", "例行标题不能为空")
        phase = str(params.get("phase") or "")
        if phase not in PHASES:
            raise RoutineError("BAD_PHASE", "阶段只能是 pre / during / post")
        weekdays = self._clean_weekdays(params.get("weekdays"))
        sort = self._int_or(params.get("sort"), 0)
        sort = max(0, min(999, sort))
        routine_id = self._int_or(params.get("id"), 0) or None
        saved = self.store.routine_save(
            title, phase, weekdays, sort, login, routine_id
        )
        if saved is None:
            raise RoutineError("NOT_FOUND", "例行不存在或已归档")
        return {"routine": self._payload(saved)}

    def delete(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        routine_id = self._int_or(params.get("id"), 0)
        if not routine_id or not self.store.routine_archive(routine_id, login):
            raise RoutineError("NOT_FOUND", "例行不存在")
        return {"deleted": True}

    def day(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        anchor = _parse_day(params.get("date")) if params.get("date") else self._today()
        today = self._today()
        weekday = _weekday_monday(anchor)

        stored = self.store.routines_list(login, include_archived=True)
        key = anchor.strftime(DAY_FMT)
        done = self.store.routine_done_range(login, key, key)
        items: list[dict[str, Any]] = []
        for routine in stored:
            created = self._day_of(routine.get("created_at"))
            archived = self._day_of(routine.get("archived_at"))
            due = (
                weekday in routine["weekdays"]
                and created is not None
                and created <= anchor
                and (archived is None or archived >= anchor)
            )
            if not due:
                continue
            items.append(
                {
                    **self._payload(routine),
                    "due": True,
                    "done": (int(routine["id"]), key) in done,
                }
            )

        items.sort(key=lambda item: (PHASES.index(item["phase"]), item["sort"], item["id"]))
        completed = sum(1 for item in items if item["done"])
        return {
            "date": key,
            "today": today.strftime(DAY_FMT),
            "weekday": weekday,
            "editable": self._editable(anchor, today),
            "items": items,
            "summary": {
                "total": len(items),
                "done": completed,
                "rate": (completed / len(items)) if items else None,
            },
            "phases": {
                phase: [item for item in items if item["phase"] == phase]
                for phase in PHASES
            },
        }

    def toggle(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        routine_id = self._int_or(params.get("id"), 0)
        if not routine_id:
            raise RoutineError("BAD_ID", "缺少例行 id")
        routine = self.store.routine_get(routine_id, login)
        if routine is None or routine.get("archived_at"):
            raise RoutineError("NOT_FOUND", "例行不存在或已归档")
        anchor = _parse_day(params.get("date")) if params.get("date") else self._today()
        today = self._today()
        if not self._editable(anchor, today):
            raise RoutineError("LOCKED", "只能补勾最近 7 天，更早的日期只读")
        done = bool(params.get("done"))
        key = anchor.strftime(DAY_FMT)
        self.store.routine_done_set(routine_id, key, done, login)
        return self.day({"date": key}, login)

    def heatmap(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        weeks = max(1, min(MAX_WEEKS, self._int_or(params.get("weeks"), 13)))
        today = self._today()
        this_monday = today - timedelta(days=today.isoweekday() - 1)
        start = this_monday - timedelta(weeks=weeks - 1)
        end = start + timedelta(days=weeks * 7 - 1)

        routines = self.store.routines_list(login, include_archived=True)
        done = self.store.routine_done_range(
            login, start.strftime(DAY_FMT), end.strftime(DAY_FMT)
        )

        cells: list[dict[str, Any]] = []
        cursor = start
        while cursor <= end:
            key = cursor.strftime(DAY_FMT)
            weekday = _weekday_monday(cursor)
            future = cursor > today
            due = 0
            hit = 0
            if not future:
                for routine in routines:
                    created = self._day_of(routine.get("created_at"))
                    archived = self._day_of(routine.get("archived_at"))
                    if weekday not in routine["weekdays"]:
                        continue
                    if created is None or created > cursor:
                        continue
                    if archived is not None and archived < cursor:
                        continue
                    due += 1
                    if (int(routine["id"]), key) in done:
                        hit += 1
            cells.append(
                {
                    "date": key,
                    "weekday": weekday,
                    "due": due,
                    "done": hit,
                    "rate": (hit / due) if due else None,
                    "future": future,
                }
            )
            cursor += timedelta(days=1)

        counted = [cell for cell in cells if cell["due"] > 0 and not cell["future"]]
        total_due = sum(cell["due"] for cell in counted)
        total_done = sum(cell["done"] for cell in counted)
        streak = 0
        for cell in reversed([cell for cell in cells if not cell["future"]]):
            if cell["due"] > 0 and cell["rate"] == 1:
                streak += 1
            elif cell["due"] > 0:
                break
        return {
            "start": start.strftime(DAY_FMT),
            "end": end.strftime(DAY_FMT),
            "today": today.strftime(DAY_FMT),
            "weeks": weeks,
            "cells": cells,
            "summary": {
                "rate": (total_done / total_due) if total_due else None,
                "done": total_done,
                "due": total_due,
                "streak": streak,
            },
        }

    # ---------- 工具 ----------

    @staticmethod
    def _editable(anchor: date, today: date) -> bool:
        delta = (today - anchor).days
        return 0 <= delta <= BACKFILL_DAYS

    @staticmethod
    def _int_or(value: Any, fallback: int) -> int:
        try:
            if value is None or value == "":
                return fallback
            return int(value)
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _clean_weekdays(value: Any) -> list[int]:
        if not isinstance(value, list):
            return [1, 2, 3, 4, 5]
        days = []
        for item in value:
            try:
                day = int(item)
            except (TypeError, ValueError):
                continue
            if 1 <= day <= 7 and day not in days:
                days.append(day)
        return sorted(days) or [1, 2, 3, 4, 5]
