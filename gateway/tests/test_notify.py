"""第三方告警：文案、HTTP 请求体、通道选择与队列失败处理。"""

import json
import queue

import pytest

import notify
from notify import (
    BarkChannel,
    DingtalkChannel,
    DiscordChannel,
    EmailChannel,
    FeishuChannel,
    Notifier,
    NtfyChannel,
    TelegramChannel,
    WebhookChannel,
    WecomChannel,
    alert_text,
    post_json,
    post_text,
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


def test_post_text_发送纯文本(monkeypatch):
    seen = {}
    response = FakeResponse()
    monkeypatch.setattr(
        notify.urllib.request,
        "urlopen",
        lambda request, timeout=None: seen.update(request=request, timeout=timeout) or response,
    )

    post_text("https://ntfy.sh/mytrade", "你好", {"Title": "Tally"}, timeout=2.0)

    request = seen["request"]
    assert request.full_url == "https://ntfy.sh/mytrade"
    assert request.data.decode("utf-8") == "你好"
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers["content-type"] == "text/plain; charset=utf-8"
    assert headers["title"] == "Tally"
    assert seen["timeout"] == 2.0
    assert response.read_called is True


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


# ---------- 新增通道 ----------


def test_飞书使用文本消息结构(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    FeishuChannel({"url": "https://open.feishu.cn/hook"}, FakeStore()).send(make_alert())

    assert sent[0] == (
        "https://open.feishu.cn/hook",
        {
            "msg_type": "text",
            "content": {"text": "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"},
        },
    )


def test_飞书配置密钥时附带官方签名(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    monkeypatch.setattr(notify.time, "time", lambda: 1_700_000_000)
    FeishuChannel(
        {"url": "https://open.feishu.cn/hook", "secret": "secret"}, FakeStore()
    ).send(make_alert())

    payload = sent[0][1]
    assert payload["timestamp"] == "1700000000"
    assert payload["sign"] == "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA="


def test_钉钉加签拼接时间戳与签名(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    monkeypatch.setattr(notify.time, "time", lambda: 1_700_000_000)
    DingtalkChannel(
        {"url": "https://oapi.dingtalk.com/robot/send?access_token=t", "secret": "SEC"},
        FakeStore(),
    ).send(make_alert())

    url, payload = sent[0]
    assert url == (
        "https://oapi.dingtalk.com/robot/send?access_token=t"
        "&timestamp=1700000000000"
        "&sign=r%2B2we0q01lkZqz38LA5IPNbHN81U1leRf3Au4PSQb6Q%3D"
    )
    assert payload == {
        "msgtype": "text",
        "text": {"content": "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"},
    }


def test_钉钉没有密钥时用原地址(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    DingtalkChannel(
        {"url": "https://oapi.dingtalk.com/robot/send?access_token=t"}, FakeStore()
    ).send(make_alert())

    assert sent[0][0] == "https://oapi.dingtalk.com/robot/send?access_token=t"


def test_bark_发送标题正文与可选字段(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_json", lambda *args: sent.append(args))
    BarkChannel(
        {
            "url": "https://api.day.app/key",
            "group": "交易",
            "sound": "alarm",
            "level": "timeSensitive",
        },
        FakeStore(),
    ).send(make_alert())

    assert sent[0] == (
        "https://api.day.app/key",
        {
            "title": "Tally",
            "body": "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）",
            "group": "交易",
            "sound": "alarm",
            "level": "timeSensitive",
        },
    )


def test_ntfy_用纯文本与标题头(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "post_text", lambda *args: sent.append(args))
    NtfyChannel(
        {
            "url": "https://ntfy.sh/mytrade",
            "priority": 4,
            "headers": {"Authorization": "Bearer t"},
        },
        FakeStore(),
    ).send(make_alert())

    url, text, headers = sent[0]
    assert url == "https://ntfy.sh/mytrade"
    assert text == "[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）"
    assert headers == {"Title": "Tally", "Authorization": "Bearer t", "Priority": "4"}


def test_邮件用_ssl_登录并发送(monkeypatch):
    clients = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            self.host = host
            self.port = port
            self.timeout = timeout
            self.logged = None
            self.messages = []
            self.tls = False
            self.closed = False
            clients.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

        def starttls(self):
            self.tls = True

        def login(self, user, password):
            self.logged = (user, password)

        def send_message(self, message):
            self.messages.append(message)

    monkeypatch.setattr(notify.smtplib, "SMTP_SSL", FakeSMTP)
    EmailChannel(
        {
            "host": "smtp.example.com",
            "port": 465,
            "user": "u@example.com",
            "password": "pw",
            "from": "bot@example.com",
            "to": ["a@example.com", "b@example.com"],
        },
        FakeStore(),
    ).send(make_alert())

    client = clients[0]
    assert (client.host, client.port, client.timeout) == ("smtp.example.com", 465, 15)
    assert client.logged == ("u@example.com", "pw")
    assert client.closed is True
    message = client.messages[0]
    assert message["Subject"] == "Tally 告警"
    assert message["From"] == "bot@example.com"
    assert message["To"] == "a@example.com, b@example.com"
    assert "XAUUSD 上穿 2000" in message.get_content()


def test_邮件_非_ssl_走_starttls(monkeypatch):
    clients = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            self.host = host
            self.port = port
            self.logged = None
            self.messages = []
            self.tls = False
            clients.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def starttls(self):
            self.tls = True

        def login(self, user, password):
            self.logged = (user, password)

        def send_message(self, message):
            self.messages.append(message)

    monkeypatch.setattr(notify.smtplib, "SMTP", FakeSMTP)
    EmailChannel(
        {
            "host": "smtp.example.com",
            "port": 587,
            "ssl": False,
            "starttls": True,
            "from": "bot@example.com",
            "to": "a@example.com",
        },
        FakeStore(),
    ).send(make_alert())

    assert clients[0].tls is True
    assert clients[0].logged is None
    assert clients[0].messages


def test_新增通道已注册():
    assert {"feishu", "dingtalk", "bark", "ntfy", "email"} <= set(notify.CHANNELS)


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


def test_缺少必填字段的通道在装配时跳过():
    for kind in ("feishu", "dingtalk", "bark", "ntfy"):
        store = FakeStore()
        notifier = Notifier([{"type": kind}], store)
        assert notifier.channels == []
        assert store.payload("alert.channel.invalid")["type"] == kind

    store = FakeStore()
    notifier = Notifier([{"type": "email", "to": ["a@example.com"]}], store)
    assert notifier.channels == []
    assert store.payload("alert.channel.invalid")["type"] == "email"


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
