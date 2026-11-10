from __future__ import annotations

import json
import queue
import threading
import urllib.request
from typing import Any

from store import Store


def alert_text(alert: dict) -> str:
    arrow = "上穿" if alert.get("kind") == "above" else "下穿"
    note = f"（{alert['note']}）" if alert.get("note") else ""
    market = alert.get("marketPrice")
    price_text = f"，现价 {market}" if market is not None else ""
    return f"[MyTrade] {alert.get('symbol')} {arrow} {alert.get('price')}{price_text}{note}"


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: float = 6.0) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = {"Content-Type": "application/json"}
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


CHANNELS: dict[str, type[Channel]] = {
    WebhookChannel.kind: WebhookChannel,
    DiscordChannel.kind: DiscordChannel,
    TelegramChannel.kind: TelegramChannel,
    WecomChannel.kind: WecomChannel,
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
