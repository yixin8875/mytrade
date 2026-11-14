"""财经日历：抓取本周事件并做磁盘缓存，供图表标注和日历面板使用。

数据源是 ForexFactory 的公开周历 JSON。刷新在后台线程里进行，
调用方永远拿缓存立即返回，不会因为外网慢而卡住交易线程。
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from urllib.request import Request, urlopen

from paths import BASE_DIR

FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
TTL_SECONDS = 6 * 3600
CACHE_PATH = BASE_DIR / "data" / "calendar_cache.json"

_lock = threading.Lock()
_state: dict = {
    "events": [],
    "fetchedAt": 0,
    "error": None,
    "refreshing": False,
}


def _load_cache() -> None:
    try:
        raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(raw, dict):
        return
    events = raw.get("events")
    if isinstance(events, list):
        _state["events"] = events
    try:
        _state["fetchedAt"] = int(raw.get("fetchedAt") or 0)
    except (TypeError, ValueError):
        _state["fetchedAt"] = 0


def _normalize(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return []
    events: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:160]
        country = str(item.get("country") or "").strip().upper()[:8]
        date = str(item.get("date") or "").strip()
        if not title or not country or not date:
            continue
        try:
            ts = int(datetime.fromisoformat(date).timestamp())
        except ValueError:
            continue
        events.append(
            {
                "id": f"{country}-{ts}-{title}",
                "title": title,
                "country": country,
                "impact": str(item.get("impact") or "").strip()[:16],
                "forecast": str(item.get("forecast") or "").strip()[:32],
                "previous": str(item.get("previous") or "").strip()[:32],
                "date": date,
                "ts": ts,
            }
        )
    events.sort(key=lambda event: event["ts"])
    return events


def _fetch() -> list[dict]:
    request = Request(
        FEED_URL,
        headers={"User-Agent": "Tally/0.7.1 (Windows desktop; economic calendar)"},
    )
    with urlopen(request, timeout=15) as response:  # noqa: S310 - 固定的 https 地址
        raw = json.load(response)
    return _normalize(raw)


def _store(events: list[dict], fetched_at: int, error: str | None) -> None:
    with _lock:
        _state["events"] = events
        _state["fetchedAt"] = fetched_at
        _state["error"] = error
    if error:
        return
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(
            json.dumps(
                {"fetchedAt": fetched_at, "events": events},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def _refresh(force: bool = False) -> None:
    with _lock:
        if _state["refreshing"]:
            return
        if not force and _state["fetchedAt"] and time.time() - _state["fetchedAt"] < TTL_SECONDS:
            return
        _state["refreshing"] = True

    def run() -> None:
        try:
            events = _fetch()
            _store(events, int(time.time()), None)
        except Exception as exc:  # noqa: BLE001 - 外网失败沿用旧缓存
            with _lock:
                _state["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            with _lock:
                _state["refreshing"] = False

    threading.Thread(target=run, name="calendar-refresh", daemon=True).start()


def week_payload() -> dict:
    _refresh()
    with _lock:
        events = list(_state["events"])
        fetched_at = int(_state["fetchedAt"])
        error = _state["error"]
    now = int(time.time())
    return {
        "events": events,
        "fetchedAt": fetched_at,
        "stale": bool(fetched_at and now - fetched_at > TTL_SECONDS * 2),
        "error": error,
    }


_load_cache()
