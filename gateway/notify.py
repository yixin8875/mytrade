from __future__ import annotations

import base64
import hashlib
import hmac
import json
import queue
import smtplib
import threading
import time
import urllib.parse
import urllib.request
from email.message import EmailMessage
from typing import Any

from store import Store


def alert_text(alert: dict) -> str:
    arrow = "上穿" if alert.get("kind") == "above" else "下穿"
    note = f"（{alert['note']}）" if alert.get("note") else ""
    market = alert.get("marketPrice")
    price_text = f"，现价 {market}" if market is not None else ""
    return f"[Tally] {alert.get('symbol')} {arrow} {alert.get('price')}{price_text}{note}"


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: float = 6.0) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = {"Content-Type": "application/json"}
    if headers:
        head.update({str(k): str(v) for k, v in headers.items()})
    request = urllib.request.Request(url, data=data, headers=head, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


def post_text(url: str, text: str, headers: dict | None = None, timeout: float = 6.0) -> None:
    """POST 纯文本（ntfy 这类以 body 为消息内容的服务）。"""
    data = text.encode("utf-8")
    head = {"Content-Type": "text/plain; charset=utf-8"}
    if headers:
        head.update({str(k): str(v) for k, v in headers.items()})
    request = urllib.request.Request(url, data=data, headers=head, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


class Channel:
    kind = "base"

    def __init__(self, config: dict, store: Store) -> None:
        self.config = config
        self.store = store
        self.label = str(config.get("name") or self.kind)

    def send(self, alert: dict) -> None:  # pragma: no cover - 子类实现
        raise NotImplementedError


class WebhookChannel(Channel):
    """通用 webhook：POST {"text": ..., "alert": {...}}，可自定义 headers。"""

    kind = "webhook"

    def send(self, alert: dict) -> None:
        post_json(
            str(self.config["url"]),
            {"text": alert_text(alert), "alert": alert},
            self.config.get("headers"),
        )


class DiscordChannel(Channel):
    kind = "discord"

    def send(self, alert: dict) -> None:
        post_json(str(self.config["url"]), {"content": alert_text(alert)})


class TelegramChannel(Channel):
    kind = "telegram"

    def send(self, alert: dict) -> None:
        token = str(self.config["token"])
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        post_json(url, {"chat_id": str(self.config["chatId"]), "text": alert_text(alert)})


class WecomChannel(Channel):
    """企业微信群机器人。"""

    kind = "wecom"

    def send(self, alert: dict) -> None:
        post_json(
            str(self.config["url"]),
            {"msgtype": "text", "text": {"content": alert_text(alert)}},
        )


def feishu_sign(timestamp: str, secret: str) -> str:
    """飞书自定义机器人签名：以 `timestamp\\nsecret` 为密钥做 HMAC-SHA256 再 base64。"""
    key = f"{timestamp}\n{secret}".encode("utf-8")
    digest = hmac.new(key, digestmod=hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def dingtalk_url(url: str, secret: str, timestamp_ms: int | None = None) -> str:
    """钉钉加签：把 timestamp 与 sign 拼到 webhook 地址后面。"""
    stamp = str(timestamp_ms if timestamp_ms is not None else int(time.time() * 1000))
    string_to_sign = f"{stamp}\n{secret}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), string_to_sign, hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(digest).decode("ascii"))
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}timestamp={stamp}&sign={sign}"


class FeishuChannel(Channel):
    """飞书 / Lark 自定义机器人；配置 secret 时附带签名。"""

    kind = "feishu"

    def __init__(self, config: dict, store: Store) -> None:
        super().__init__(config, store)
        self.url = str(config.get("url") or "")
        if not self.url:
            raise ValueError("feishu 需要 url")

    def send(self, alert: dict) -> None:
        payload: dict[str, Any] = {
            "msg_type": "text",
            "content": {"text": alert_text(alert)},
        }
        secret = str(self.config.get("secret") or "")
        if secret:
            stamp = str(int(time.time()))
            payload["timestamp"] = stamp
            payload["sign"] = feishu_sign(stamp, secret)
        post_json(self.url, payload)


class DingtalkChannel(Channel):
    """钉钉群机器人；配置 secret 时按加签规则拼接时间戳与签名。"""

    kind = "dingtalk"

    def __init__(self, config: dict, store: Store) -> None:
        super().__init__(config, store)
        self.url = str(config.get("url") or "")
        if not self.url:
            raise ValueError("dingtalk 需要 url")

    def send(self, alert: dict) -> None:
        url = self.url
        secret = str(self.config.get("secret") or "")
        if secret:
            url = dingtalk_url(url, secret)
        post_json(url, {"msgtype": "text", "text": {"content": alert_text(alert)}})


class BarkChannel(Channel):
    """Bark（iOS）：url 形如 https://api.day.app/<device-key>。"""

    kind = "bark"

    def __init__(self, config: dict, store: Store) -> None:
        super().__init__(config, store)
        self.url = str(config.get("url") or "")
        if not self.url:
            raise ValueError("bark 需要 url")

    def send(self, alert: dict) -> None:
        payload: dict[str, Any] = {"title": "Tally", "body": alert_text(alert)}
        for key in ("group", "sound", "level"):
            value = self.config.get(key)
            if value:
                payload[key] = str(value)
        post_json(self.url, payload)


class NtfyChannel(Channel):
    """ntfy：url 直接写到主题，如 https://ntfy.sh/mytrade；可选 headers 带 Authorization。"""

    kind = "ntfy"

    def __init__(self, config: dict, store: Store) -> None:
        super().__init__(config, store)
        self.url = str(config.get("url") or "")
        if not self.url:
            raise ValueError("ntfy 需要 url")

    def send(self, alert: dict) -> None:
        headers = {"Title": str(self.config.get("title") or "Tally")}
        extra = self.config.get("headers")
        if isinstance(extra, dict):
            headers.update({str(k): str(v) for k, v in extra.items()})
        priority = self.config.get("priority")
        if priority:
            headers["Priority"] = str(priority)
        post_text(self.url, alert_text(alert), headers)


class EmailChannel(Channel):
    """SMTP 邮件；默认 465 + SSL，587 可配 ssl=false + starttls=true。"""

    kind = "email"

    def __init__(self, config: dict, store: Store) -> None:
        super().__init__(config, store)
        self.host = str(config.get("host") or "")
        self.port = int(config.get("port") or 465)
        self.user = str(config.get("user") or "")
        self.password = str(config.get("password") or "")
        self.sender = str(config.get("from") or self.user)
        raw_to = config.get("to")
        if isinstance(raw_to, list):
            self.to = [str(item) for item in raw_to if item]
        else:
            self.to = [str(raw_to)] if raw_to else []
        if not self.to and self.sender:
            self.to = [self.sender]
        self.ssl = bool(config.get("ssl", True))
        self.starttls = bool(config.get("starttls", False))
        if not self.host or not self.sender:
            raise ValueError("email 需要 host / from")

    def send(self, alert: dict) -> None:
        message = EmailMessage()
        message["Subject"] = "Tally 告警"
        message["From"] = self.sender
        message["To"] = ", ".join(self.to)
        message.set_content(alert_text(alert))
        if self.ssl:
            client = smtplib.SMTP_SSL(self.host, self.port, timeout=15)
        else:
            client = smtplib.SMTP(self.host, self.port, timeout=15)
        with client:
            if self.starttls and not self.ssl:
                client.starttls()
            if self.user:
                client.login(self.user, self.password)
            client.send_message(message)


CHANNELS: dict[str, type[Channel]] = {
    WebhookChannel.kind: WebhookChannel,
    DiscordChannel.kind: DiscordChannel,
    TelegramChannel.kind: TelegramChannel,
    WecomChannel.kind: WecomChannel,
    FeishuChannel.kind: FeishuChannel,
    DingtalkChannel.kind: DingtalkChannel,
    BarkChannel.kind: BarkChannel,
    NtfyChannel.kind: NtfyChannel,
    EmailChannel.kind: EmailChannel,
}


class Notifier:
    """把告警推给第三方通道。发送在单独线程里排队，绝不阻塞 MT5 循环。"""

    def __init__(self, configs: list[dict] | None, store: Store) -> None:
        self.store = store
        self.channels: list[Channel] = []
        for config in configs or []:
            if not isinstance(config, dict):
                continue
            kind = str(config.get("type") or "")
            factory = CHANNELS.get(kind)
            if factory is None:
                store.audit("alert.channel.unknown", {"type": kind})
                continue
            try:
                self.channels.append(factory(config, store))
            except Exception as exc:  # noqa: BLE001 - 配置缺失就跳过这个通道
                store.audit("alert.channel.invalid", {"type": kind, "error": str(exc)})
        self._queue: queue.Queue[dict | None] = queue.Queue(maxsize=100)
        self._thread: threading.Thread | None = None
        self._stopped = False

    def start(self) -> None:
        if not self.channels or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="alert-notifier", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopped = True
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    def info(self) -> list[str]:
        return [channel.label for channel in self.channels]

    def send(self, alert: dict) -> None:
        if not self.channels:
            return
        try:
            self._queue.put_nowait(alert)
        except queue.Full:
            self.store.audit("alert.channel.drop", {"alert": alert, "reason": "queue full"})

    def _run(self) -> None:
        while not self._stopped:
            alert = self._queue.get()
            if alert is None:
                continue
            for channel in self.channels:
                try:
                    channel.send(alert)
                    self.store.audit(
                        "alert.channel.sent", {"channel": channel.label, "alertId": alert.get("id")}
                    )
                except Exception as exc:  # noqa: BLE001 - 单个通道失败不影响其他通道
                    self.store.audit(
                        "alert.channel.error",
                        {"channel": channel.label, "error": f"{type(exc).__name__}: {exc}"},
                    )
