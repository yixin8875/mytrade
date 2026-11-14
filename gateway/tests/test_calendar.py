"""财经日历：清洗、缓存、刷新节流与降级。"""

import json

import pytest

import calendar_feed


@pytest.fixture(autouse=True)
def reset_state(monkeypatch, tmp_path):
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", tmp_path / "calendar_cache.json")
    clean = {"events": [], "fetchedAt": 0, "error": None, "refreshing": False}
    calendar_feed._state.update(clean)
    yield
    calendar_feed._state.update(clean)


def raw_event(**over) -> dict:
    event = {
        "title": "CPI",
        "country": "USA",
        "date": "2024-01-15T08:30:00-05:00",
        "impact": "High",
        "forecast": "3.2%",
        "previous": "3.1%",
    }
    event.update(over)
    return event


class ImmediateThread:
    instances: list["ImmediateThread"] = []

    def __init__(self, target=None, name=None, daemon=None):
        self.target = target
        self.name = name
        self.daemon = daemon
        self.started = False
        ImmediateThread.instances.append(self)

    def start(self):
        self.started = True
        self.target()


@pytest.fixture
def immediate_threads(monkeypatch):
    ImmediateThread.instances = []
    monkeypatch.setattr(calendar_feed.threading, "Thread", ImmediateThread)
    return ImmediateThread


# ---------- 清洗 ----------


def test_清洗一条事件并生成稳定_id():
    events = calendar_feed._normalize([raw_event()])

    assert events == [
        {
            "id": "USA-1705325400-CPI",
            "title": "CPI",
            "country": "USA",
            "impact": "High",
            "forecast": "3.2%",
            "previous": "3.1%",
            "date": "2024-01-15T08:30:00-05:00",
            "ts": 1705325400,
        }
    ]


def test_国家大写并去掉首尾空白():
    events = calendar_feed._normalize([raw_event(country="  usa  ")])
    assert events[0]["country"] == "USA"


def test_长字段会被截断():
    events = calendar_feed._normalize(
        [
            raw_event(
                title="t" * 200,
                country="abcdefghij",
                impact="i" * 20,
                forecast="f" * 40,
                previous="p" * 40,
            )
        ]
    )

    assert len(events[0]["title"]) == 160
    assert events[0]["country"] == "ABCDEFGH"
    assert len(events[0]["impact"]) == 16
    assert len(events[0]["forecast"]) == 32
    assert len(events[0]["previous"]) == 32


def test_按时间升序排列():
    events = calendar_feed._normalize(
        [
            raw_event(title="later", date="2024-01-15T09:30:00-05:00"),
            raw_event(title="earlier", date="2024-01-15T08:30:00-05:00"),
        ]
    )
    assert [event["title"] for event in events] == ["earlier", "later"]


def test_缺字段或日期非法的条目被丢弃():
    events = calendar_feed._normalize(
        [
            None,
            "bad",
            {},
            raw_event(title=""),
            raw_event(country=""),
            raw_event(date=""),
            raw_event(date="not-a-date"),
            raw_event(title="ok"),
        ]
    )
    assert [event["title"] for event in events] == ["ok"]


def test_非列表输入返回空():
    assert calendar_feed._normalize(None) == []
    assert calendar_feed._normalize({"title": "x"}) == []
    assert calendar_feed._normalize("x") == []


# ---------- 缓存读取 ----------


def test_读取缓存事件与时间(monkeypatch, tmp_path):
    path = tmp_path / "cache.json"
    path.write_text(
        json.dumps({"fetchedAt": 123, "events": [{"id": "a"}]}), encoding="utf-8"
    )
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", path)

    calendar_feed._load_cache()

    assert calendar_feed._state["events"] == [{"id": "a"}]
    assert calendar_feed._state["fetchedAt"] == 123


def test_缓存时间非法按零处理(monkeypatch, tmp_path):
    path = tmp_path / "cache.json"
    path.write_text(
        json.dumps({"fetchedAt": "abc", "events": [{"id": "a"}]}), encoding="utf-8"
    )
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", path)

    calendar_feed._load_cache()

    assert calendar_feed._state["fetchedAt"] == 0
    assert calendar_feed._state["events"] == [{"id": "a"}]


def test_缓存结构不对时保持原状(monkeypatch, tmp_path):
    calendar_feed._state["events"] = [{"id": "old"}]
    calendar_feed._state["fetchedAt"] = 9

    path = tmp_path / "cache.json"
    path.write_text(json.dumps([{"id": "a"}]), encoding="utf-8")
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", path)
    calendar_feed._load_cache()
    assert calendar_feed._state["events"] == [{"id": "old"}]

    path.write_text(json.dumps({"fetchedAt": 5, "events": "bad"}), encoding="utf-8")
    calendar_feed._load_cache()
    assert calendar_feed._state["events"] == [{"id": "old"}]
    assert calendar_feed._state["fetchedAt"] == 5


def test_缓存文件损坏或不存在时不报错(monkeypatch, tmp_path):
    calendar_feed._state["events"] = [{"id": "old"}]

    path = tmp_path / "cache.json"
    path.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", path)
    calendar_feed._load_cache()
    assert calendar_feed._state["events"] == [{"id": "old"}]

    monkeypatch.setattr(calendar_feed, "CACHE_PATH", tmp_path / "missing.json")
    calendar_feed._load_cache()
    assert calendar_feed._state["events"] == [{"id": "old"}]


# ---------- 缓存写入 ----------


def test_写入缓存并更新状态():
    events = [{"id": "a"}]

    calendar_feed._store(events, 456, None)

    assert calendar_feed._state["events"] == events
    assert calendar_feed._state["fetchedAt"] == 456
    assert calendar_feed._state["error"] is None
    saved = json.loads(calendar_feed.CACHE_PATH.read_text(encoding="utf-8"))
    assert saved == {"fetchedAt": 456, "events": events}


def test_刷新失败时不覆盖缓存文件():
    calendar_feed._state["events"] = [{"id": "old"}]

    calendar_feed._store([{"id": "new"}], 789, "offline")

    assert calendar_feed._state["events"] == [{"id": "new"}]
    assert calendar_feed._state["fetchedAt"] == 789
    assert calendar_feed._state["error"] == "offline"
    assert not calendar_feed.CACHE_PATH.exists()


def test_缓存目录不可写时不抛错(monkeypatch, tmp_path):
    monkeypatch.setattr(calendar_feed, "CACHE_PATH", tmp_path)

    calendar_feed._store([{"id": "a"}], 1, None)

    assert calendar_feed._state["events"] == [{"id": "a"}]
    assert calendar_feed._state["error"] is None


# ---------- 刷新 ----------


def test_缓存还在有效期内不刷新(monkeypatch, immediate_threads):
    calendar_feed._state["fetchedAt"] = 1000
    monkeypatch.setattr(calendar_feed.time, "time", lambda: 1000 + calendar_feed.TTL_SECONDS - 1)

    calendar_feed._refresh()

    assert immediate_threads.instances == []


def test_已在刷新时不重复启动(monkeypatch, immediate_threads):
    calendar_feed._state["fetchedAt"] = 0
    calendar_feed._state["refreshing"] = True

    calendar_feed._refresh(force=True)

    assert immediate_threads.instances == []


def test_强制刷新会抓取并写缓存(monkeypatch, immediate_threads):
    monkeypatch.setattr(calendar_feed.time, "time", lambda: 5000)
    monkeypatch.setattr(calendar_feed, "_fetch", lambda: [{"id": "a"}])

    calendar_feed._refresh(force=True)

    assert len(immediate_threads.instances) == 1
    assert immediate_threads.instances[0].name == "calendar-refresh"
    assert immediate_threads.instances[0].daemon is True
    assert immediate_threads.instances[0].started is True
    assert calendar_feed._state["events"] == [{"id": "a"}]
    assert calendar_feed._state["fetchedAt"] == 5000
    assert calendar_feed._state["error"] is None
    assert calendar_feed._state["refreshing"] is False
    assert json.loads(calendar_feed.CACHE_PATH.read_text(encoding="utf-8"))["fetchedAt"] == 5000


def test_缓存过期后自动刷新(monkeypatch, immediate_threads):
    calendar_feed._state["fetchedAt"] = 100
    now = 100 + calendar_feed.TTL_SECONDS + 1
    monkeypatch.setattr(calendar_feed.time, "time", lambda: now)
    monkeypatch.setattr(calendar_feed, "_fetch", lambda: [])

    calendar_feed._refresh()

    assert len(immediate_threads.instances) == 1
    assert calendar_feed._state["fetchedAt"] == now


def test_抓取失败保留旧数据并记录错误(monkeypatch, immediate_threads):
    calendar_feed._state["events"] = [{"id": "old"}]
    calendar_feed._state["fetchedAt"] = 100

    def boom():
        raise RuntimeError("offline")

    monkeypatch.setattr(calendar_feed, "_fetch", boom)

    calendar_feed._refresh(force=True)

    assert calendar_feed._state["events"] == [{"id": "old"}]
    assert calendar_feed._state["fetchedAt"] == 100
    assert calendar_feed._state["error"] == "RuntimeError: offline"
    assert calendar_feed._state["refreshing"] is False
    assert not calendar_feed.CACHE_PATH.exists()


# ---------- 对外载荷 ----------


def test_载荷在缓存过旧时标记_stale(monkeypatch):
    monkeypatch.setattr(calendar_feed, "_refresh", lambda force=False: None)
    now = 10_000
    monkeypatch.setattr(calendar_feed.time, "time", lambda: now)
    calendar_feed._state["events"] = [{"id": "a"}]
    calendar_feed._state["fetchedAt"] = now - calendar_feed.TTL_SECONDS * 2 - 1
    calendar_feed._state["error"] = "boom"

    payload = calendar_feed.week_payload()

    assert payload == {
        "events": [{"id": "a"}],
        "fetchedAt": now - calendar_feed.TTL_SECONDS * 2 - 1,
        "stale": True,
        "error": "boom",
    }


def test_载荷在缓存较新或为空时不标记_stale(monkeypatch):
    monkeypatch.setattr(calendar_feed, "_refresh", lambda force=False: None)
    now = 10_000
    monkeypatch.setattr(calendar_feed.time, "time", lambda: now)

    calendar_feed._state["fetchedAt"] = now - 60
    assert calendar_feed.week_payload()["stale"] is False

    calendar_feed._state["fetchedAt"] = 0
    calendar_feed._state["events"] = []
    assert calendar_feed.week_payload()["stale"] is False


def test_载荷返回事件副本(monkeypatch):
    monkeypatch.setattr(calendar_feed, "_refresh", lambda force=False: None)
    calendar_feed._state["events"] = [{"id": "a"}]

    payload = calendar_feed.week_payload()
    payload["events"].append({"id": "b"})

    assert calendar_feed._state["events"] == [{"id": "a"}]
