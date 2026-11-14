"""第三方告警：文案、HTTP 请求体、通道选择与队列失败处理。"""

import json
import queue

import pytest

import notify
from notify import (
    DiscordChannel,
    Notifier,
    TelegramChannel,
    WebhookChannel,
    WecomChannel,
    alert_text,
    post_json,
)


class FakeStore:
    def __init__(self) -> None:
        self.audits: list[tuple[str, object]] = []

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]

    def payload(self, kind: str) -> dict:
        for item_kind, item_payload in self.audits:
            if item_kind == kind:
                return item_payload  # type: ignore[return-value]
        raise AssertionError(f"missing audit {kind}")


def make_alert(**over) -> dict:
    alert = {
        "id": 7,
        "kind": "above",
        "symbol": "XAUUSD",
        "price": 2000,
        "marketPrice": 2001.5,
        "note": "突破",
    }
    alert.update(over)
    return alert


# ---------- 文案 ----------


def test_上穿告警带现价与备注():
    text = alert_text(make_alert())
    assert text == "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"


def test_下穿告警没有现价与备注():
    text = alert_text(
        {"kind": "below", "symbol": "EURUSD", "price": 1.1, "marketPrice": None, "note": ""}
    )
    assert text == "[Tally] EURUSD 下穿 1.1"


def test_现价为零也会显示():
    text = alert_text(make_alert(kind="below", marketPrice=0, note=None))
    assert text == "[Tally] XAUUSD 下穿 2000，现价 0"


# ---------- HTTP 请求 ----------


class FakeResponse:
    def __init__(self) -> None:
        self.read_called = False
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def read(self) -> bytes:
        self.read_called = True
        return b"ok"


def test_post_json_发送_json_请求(monkeypatch):
    seen = {}
    response = FakeResponse()

    def fake_urlopen(request, timeout=None):
        seen["request"] = request
        seen["timeout"] = timeout
        return response

    monkeypatch.setattr(notify.urllib.request, "urlopen", fake_urlopen)

    post_json("https://example.com/hook", {"text": "你好"}, {"X-Token": 7}, timeout=3.5)

    request = seen["request"]
    assert request.full_url == "https://example.com/hook"
    assert request.method == "POST"
    assert json.loads(request.data.decode("utf-8")) == {"text": "你好"}
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers["content-type"] == "application/json"
    assert headers["x-token"] == "7"
    assert seen["timeout"] == 3.5
    assert response.read_called is True
    assert response.closed is True


def test_post_json_默认超时与无自定义头(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        notify.urllib.request,
        "urlopen",
        lambda request, timeout=None: seen.update(timeout=timeout) or FakeResponse(),
    )

    post_json("https://example.com/hook", {"ok": True})

    assert seen["timeout"] == 6.0


# ---------- 各通道请求体 ----------


def test_webhook_发送文本与完整告警(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    channel = WebhookChannel(
        {"url": "https://example.com/hook", "headers": {"X-Key": "v"}}, FakeStore()
    )

    channel.send(make_alert())

    url, payload, headers = sent[0]
    assert url == "https://example.com/hook"
    assert payload["text"] == "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"
    assert payload["alert"] == make_alert()
    assert headers == {"X-Key": "v"}


def test_discord_只发送内容(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    channel = DiscordChannel({"url": "https://discord.example/hook"}, FakeStore())

    channel.send(make_alert())

    assert sent[0] == (
        "https://discord.example/hook",
        {"content": "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"},
    )


def test_telegram_拼接机器人地址并转字符串_chat_id(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    channel = TelegramChannel({"token": "abc", "chatId": 123}, FakeStore())

    channel.send(make_alert())

    url, payload = sent[0]
    assert url == "https://api.telegram.org/botabc/sendMessage"
    assert payload["chat_id"] == "123"
    assert payload["text"].startswith("[Tally] XAUUSD 上穿")


def test_企业微信使用文本消息结构(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    channel = WecomChannel({"url": "https://qyapi.example/hook"}, FakeStore())

    channel.send(make_alert())

    assert sent[0] == (
        "https://qyapi.example/hook",
        {
            "msgtype": "text",
            "text": {"content": "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"},
        },
    )


def test_通道名称缺省用类型名():
    store = FakeStore()
    assert WebhookChannel({}, store).label == "webhook"
    assert DiscordChannel({"name": "团队频道"}, store).label == "团队频道"


# ---------- 通道装配 ----------


def test_没有配置时不创建通道():
    notifier = Notifier(None, FakeStore())
    assert notifier.channels == []
    assert notifier.info() == []


def test_非字典配置被忽略():
    store = FakeStore()
    notifier = Notifier(["bad", 3, None], store)
    assert notifier.channels == []
    assert store.audits == []


def test_未知通道类型会审计():
    store = FakeStore()
    notifier = Notifier([{"type": "sms"}], store)

    assert notifier.channels == []
    assert store.payload("alert.channel.unknown") == {"type": "sms"}


def test_通道构造失败会审计并跳过(monkeypatch):
    store = FakeStore()

    def boom(config, fake_store):
        raise RuntimeError("bad config")

    monkeypatch.setitem(notify.CHANNELS, "boom", boom)

    notifier = Notifier([{"type": "boom"}], store)

    assert notifier.channels == []
    assert store.payload("alert.channel.invalid") == {
        "type": "boom",
        "error": "bad config",
    }


def test_info_返回所有通道名称():
    notifier = Notifier(
        [
            {"type": "webhook", "name": "飞书", "url": "https://example.com"},
            {"type": "discord", "url": "https://discord.example"},
        ],
        FakeStore(),
    )

    assert notifier.info() == ["飞书", "discord"]


# ---------- 队列与发送线程 ----------


def test_没有通道时发送直接返回():
    notifier = Notifier(None, FakeStore())
    notifier.send(make_alert())
    assert notifier._queue.empty()


def test_队列满时丢弃并审计():
    store = FakeStore()
    notifier = Notifier([{"type": "discord", "url": "https://discord.example"}], store)
    notifier._queue = queue.Queue(maxsize=1)
    notifier._queue.put("occupied")

    notifier.send(make_alert())

    payload = store.payload("alert.channel.drop")
    assert payload["alert"] == make_alert()
    assert payload["reason"] == "queue full"


def test_发送线程逐个通道发送并审计():
    store = FakeStore()
    notifier = Notifier(
        [
            {"type": "webhook", "name": "坏通道", "url": "https://bad.example"},
            {"type": "discord", "name": "好通道", "url": "https://good.example"},
        ],
        store,
    )
    delivered = []

    def bad_send(alert):
        raise RuntimeError("boom")

    def good_send(alert):
        delivered.append(alert)
        notifier._stopped = True

    notifier.channels[0].send = bad_send
    notifier.channels[1].send = good_send
    notifier._queue.put(make_alert())

    notifier._run()

    assert delivered == [make_alert()]
    error = store.payload("alert.channel.error")
    assert error["channel"] == "坏通道"
    assert error["error"] == "RuntimeError: boom"
    sent = store.payload("alert.channel.sent")
    assert sent == {"channel": "好通道", "alertId": 7}


def test_启动线程只创建一次且无通道时不创建(monkeypatch):
    class FakeThread:
        instances: list["FakeThread"] = []

        def __init__(self, target=None, name=None, daemon=None):
            self.target = target
            self.name = name
            self.daemon = daemon
            self.started = False
            FakeThread.instances.append(self)

        def start(self):
            self.started = True

    monkeypatch.setattr(notify.threading, "Thread", FakeThread)

    empty = Notifier(None, FakeStore())
    empty.start()
    assert FakeThread.instances == []

    notifier = Notifier([{"type": "discord", "url": "https://discord.example"}], FakeStore())
    notifier.start()
    notifier.start()

    assert len(FakeThread.instances) == 1
    assert FakeThread.instances[0].started is True
    assert FakeThread.instances[0].name == "alert-notifier"
    assert FakeThread.instances[0].daemon is True


def test_停止时投递哨兵并允许队列已满():
    notifier = Notifier(None, FakeStore())

    notifier.stop()
    assert notifier._stopped is True
    assert notifier._queue.get_nowait() is None

    notifier = Notifier(None, FakeStore())
    notifier._queue = queue.Queue(maxsize=1)
    notifier._queue.put("occupied")
    notifier.stop()
    assert notifier._stopped is True
