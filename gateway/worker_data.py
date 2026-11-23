from __future__ import annotations

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401

import alert_channels
from notify import CHANNELS


class WorkerData:
    def _journal_filters(self, p: dict) -> dict:
        raw = p.get("filters")
        if not isinstance(raw, dict):
            return {}
        out: dict = {}
        for key in ("symbol", "tag", "result", "reviewed"):
            value = raw.get(key)
            if value is not None and str(value) != "":
                out[key] = value
        return out

    def _journal_list(self, p: dict) -> list[dict]:
        days = int(p.get("days") if p.get("days") is not None else 30)
        limit = min(1000, int(p.get("limit") or 200))
        login = self._login()
        if login:
            self._journal.sync(login, server_offset=self._server_offset_value())
        # 库里是服务器时间：窗口按复盘时区的本地自然日切分；days=0 表示全部历史。
        # 调用方也可以直接给 since（例如「今天」按券商日切分），与 journal.stats 保持一致。
        explicit = p.get("since")
        if explicit is not None:
            since = max(0, int(explicit))
        elif days > 0:
            resolver = getattr(self._journal, "_review_timezone", None)
            tz = int(resolver()) if callable(resolver) else 0
            now = int(time.time())
            local_midnight = ((now + tz * 60) // 86400) * 86400
            since = max(
                0,
                local_midnight
                - (days - 1) * 86400
                - tz * 60
                + int(self._server_offset or 0),
            )
        else:
            since = 0
        return self.store.journal_list(
            limit=limit,
            since=since,
            login=login,
            filters=self._journal_filters(p),
        )

    def _journal_get(self, p: dict) -> dict:
        """按持仓号取完整交易记录，供散点等入口打开回放。"""
        position_id = int(p.get("positionId") or 0)
        login = self._login()
        row = self.store.journal_get(position_id, login)
        if row is None:
            raise GatewayError("NOT_FOUND", f"日志里没有这笔交易 {position_id}")
        return row

    def _journal_tag(self, p: dict) -> dict:
        position_id = int(p.get("positionId") or 0)
        login = self._login()
        if not self.store.journal_get(position_id, login):
            raise GatewayError("NO_TRADE", f"日志里没有这笔交易 {position_id}")
        tag = str(p.get("tag") or "").strip()[:40] or None
        self.store.journal_set_tag(position_id, tag, login)
        self.store.audit(
            "journal.tag", {"positionId": position_id, "tag": tag, "login": login}
        )
        return self.store.journal_get(position_id, login) or {}

    def _journal_shot(self, p: dict) -> dict:
        position_id = int(p.get("positionId") or 0)
        data = str(p.get("data") or "")
        login = self._login()
        if position_id <= 0 or not data:
            raise GatewayError("BAD_SHOT", "缺少持仓号或截图数据")
        try:
            out = self._journal.save_shot(login, position_id, data, p.get("meta"))
        except ValueError as exc:
            raise GatewayError("BAD_SHOT", str(exc)) from exc
        self.store.audit(
            "journal.screenshot",
            {"positionId": position_id, "bytes": out["bytes"], "login": login},
        )
        return out

    def _data_export(self, p: dict) -> dict:
        kind = str(p.get("kind") or "journal")
        days = int(p.get("days") or 30)
        login = self._login()
        try:
            if kind == "journal":
                return exporter.export_journal(self.store, login, days)
            if kind == "executions":
                return exporter.export_executions(self.store, login, days)
            if kind == "audit":
                return exporter.export_audit(self.store, days)
            if kind == "replay":
                return exporter.export_replay(self.store, login)
            if kind == "settings":
                settings = p.get("settings") if isinstance(p.get("settings"), dict) else None
                return exporter.export_settings(self.store, self.cfg, login, settings)
        except OSError as exc:
            raise GatewayError("EXPORT_FAILED", f"导出失败: {exc}") from exc
        raise GatewayError("BAD_EXPORT", f"未知导出类型: {kind}")

    def _data_backup(self, p: dict) -> dict:
        settings = p.get("settings") if isinstance(p.get("settings"), dict) else None
        try:
            out = self._create_backup(settings)
        except OSError as exc:
            raise GatewayError("BACKUP_FAILED", f"备份失败: {exc}") from exc
        self.store.audit(
            "data.backup",
            {"name": out["name"], "bytes": out["bytes"], "login": self._login()},
        )
        return out

    def _alert_create(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "").upper().strip()
        kind = str(p.get("kind") or "above")
        price = _num(p.get("price"))
        if kind not in ("above", "below"):
            raise GatewayError("BAD_ALERT", "告警方向必须是 above 或 below")
        if not symbol or price <= 0:
            raise GatewayError("BAD_ALERT", "缺少品种或价格")
        info = mt5.symbol_info(symbol)
        if info is None:
            raise GatewayError("NO_SYMBOL", f"找不到品种 {symbol}")
        note = str(p.get("note") or "").strip()[:80] or None
        cooldown = max(0, int(_num(p.get("cooldownSec"), 60)))
        login = self._login()
        alert = self.store.alert_create(
            symbol,
            kind,
            align_price(price, info),
            note,
            bool(p.get("repeat")),
            cooldown if p.get("repeat") else 0,
            login,
        )
        self._alerts = self.store.alerts_list(login)
        self.store.audit("alert.create", alert)
        return alert

    def _alert_update(self, p: dict) -> dict:
        alert_id = int(p.get("id") or 0)
        login = self._login()
        if not self.store.alert_get(alert_id, login):
            raise GatewayError("NO_ALERT", f"找不到告警 {alert_id}")
        fields: dict[str, Any] = {}
        for key in ("kind", "note", "price"):
            if key in p:
                fields[key] = p[key]
        if "price" in fields:
            fields["price"] = _num(fields["price"])
        for key in ("enabled", "repeat"):
            if key in p:
                fields[key] = 1 if p[key] else 0
        if "cooldownSec" in p:
            fields["cooldown_sec"] = max(0, int(_num(p.get("cooldownSec"), 60)))
        alert = self.store.alert_update(alert_id, fields, login) or {}
        self._alerts = self.store.alerts_list(login)
        self.store.audit("alert.update", {"id": alert_id, "fields": fields})
        return alert

    def _alert_delete(self, p: dict) -> dict:
        alert_id = int(p.get("id") or 0)
        login = self._login()
        self.store.alert_delete(alert_id, login)
        self._alerts = self.store.alerts_list(login)
        self.store.audit("alert.delete", {"id": alert_id})
        return {"deleted": alert_id}

    def _test_alert_payload(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "").upper().strip()
        if not symbol:
            symbol = next((pos["symbol"] for pos in self._positions), "")
        info = mt5.symbol_info(symbol) if symbol else None
        tick = mt5.symbol_info_tick(symbol) if symbol else None
        price = float(tick.bid) if tick else 0.0
        return {
            "id": 0,
            "symbol": symbol or "TEST",
            "kind": "above",
            "price": align_price(price, info) if info and price else 0.0,
            "note": "测试告警",
            "marketPrice": price or None,
            "at": int(time.time()),
            "test": True,
        }

    def _alert_test(self, p: dict) -> dict:
        payload = self._test_alert_payload(p)
        self._notifier.send(payload)
        self._emit("alert", payload)
        self.store.audit("alert.test", payload)
        return {"sent": True, "channels": self._notifier.info()}

    # ---------- 告警推送通道管理 ----------

    def _alerts_channels_list(self, _p: dict) -> dict:
        return {
            "channels": self.cfg.channels_public(),
            "schema": alert_channels.schema(),
        }

    def _alerts_channel_save(self, p: dict) -> dict:
        incoming = p.get("channel")
        if not isinstance(incoming, dict):
            raise GatewayError("BAD_CHANNEL", "channel 必须是对象")
        try:
            result = self.cfg.save_channel(incoming)
        except ValueError as exc:
            raise GatewayError("BAD_CHANNEL", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        self._reload_notifier()
        saved = result["channel"]
        # 审计只记标识，不写地址与密钥
        self.store.audit(
            "alert.channel.save",
            {"id": saved["id"], "type": saved["type"], "name": saved["name"]},
        )
        self._emit("gateway", self.health())
        return {"channels": result["channels"], "saved": result["channel"]}

    def _alerts_channel_delete(self, p: dict) -> dict:
        channel_id = str(p.get("id") or "").strip()
        if not channel_id:
            raise GatewayError("BAD_CHANNEL", "缺少通道 id")
        try:
            result = self.cfg.delete_channel(channel_id)
        except ValueError as exc:
            raise GatewayError("BAD_CHANNEL", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        self._reload_notifier()
        deleted = result["deleted"]
        self.store.audit(
            "alert.channel.delete",
            {
                "id": deleted.get("id"),
                "type": deleted.get("type"),
                "name": deleted.get("name"),
            },
        )
        self._emit("gateway", self.health())
        return result

    def _alerts_channel_test(self, p: dict) -> dict:
        channel_id = str(p.get("id") or "").strip()
        if not channel_id:
            raise GatewayError("BAD_CHANNEL", "缺少通道 id")
        channels = self.cfg.ensure_channel_ids()
        entry = next((item for item in channels if item.get("id") == channel_id), None)
        if entry is None:
            raise GatewayError("NO_CHANNEL", "通道不存在，可能已被删除")
        factory = CHANNELS.get(str(entry.get("type") or ""))
        if factory is None:
            raise GatewayError("BAD_CHANNEL", "未知通道类型")
        try:
            target = factory(entry, self.store)
        except Exception as exc:  # noqa: BLE001 - 配置错误直接回给界面
            raise GatewayError(
                "BAD_CHANNEL", alert_channels.redact_error(exc, entry)
            ) from exc

        request_id = str(p.get("requestId") or "")
        payload = self._test_alert_payload({})
        # 只发这一个通道；SMTP 可能等 15 秒，不能占用工作线程
        threading.Thread(
            target=self._run_channel_test,
            args=(entry, target, payload, request_id),
            name="alert-channel-test",
            daemon=True,
        ).start()
        return {"queued": True, "id": channel_id}

    def _run_channel_test(self, entry: dict, target: Any, payload: dict, request_id: str) -> None:
        channel_id = str(entry.get("id") or "")
        ok = True
        error = ""
        try:
            target.send(payload)
        except Exception as exc:  # noqa: BLE001 - 结果通过事件回给界面
            ok = False
            error = alert_channels.redact_error(exc, entry)
        self.store.audit(
            "alert.channel.test",
            {"id": channel_id, "type": entry.get("type"), "ok": ok},
        )
        event: dict = {
            "id": channel_id,
            "requestId": request_id,
            "label": target.label,
            "type": entry.get("type"),
            "ok": ok,
        }
        if not ok:
            event["error"] = error
        self._emit("alertChannelTest", event)

    def _check_alerts(self) -> None:
        if not self._alerts:
            return
        now = time.time()
        changed = False
        for alert in list(self._alerts):
            if not int(alert.get("enabled") or 0):
                continue
            symbol = str(alert["symbol"])
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                continue
            price = float(tick.bid)
            prev = self._alert_last.get(symbol)
            self._alert_last[symbol] = price
            target = float(alert["price"])
            if alert["kind"] == "above":
                hit = price >= target and (prev is None or prev < target)
            else:
                hit = price <= target and (prev is None or prev > target)
            if not hit:
                continue
            repeat = bool(alert.get("repeat"))
            triggered = float(alert.get("triggered_at") or 0)
            if triggered and not repeat:
                continue
            if repeat and triggered and now - triggered < float(alert.get("cooldown_sec") or 60):
                continue
            self.store.alert_mark_triggered(
                int(alert["id"]), disable=not repeat, login=self._login()
            )
            payload = {
                "id": int(alert["id"]),
                "symbol": symbol,
                "kind": alert["kind"],
                "price": target,
                "note": alert.get("note") or "",
                "marketPrice": price,
                "at": int(now),
            }
            self._emit("alert", payload)
            self._notifier.send(payload)
            self.store.audit("alert.triggered", payload)
            changed = True
        if changed:
            self._alerts = self.store.alerts_list(self._login())

    def _executions(self, p: dict) -> list[dict]:
        days = int(p.get("days") or 7)
        limit = int(p.get("limit") or 100)
        symbol = p.get("symbol")
        start = datetime.now() - timedelta(days=days)
        deals = mt5.history_deals_get(start, datetime.now())
        if deals is None:
            return []
        out: list[dict] = []
        for d in reversed(deals):
            if symbol and d.symbol != symbol:
                continue
            out.append(
                {
                    "ticket": int(d.ticket),
                    "order": int(d.order),
                    "positionId": int(getattr(d, "position_id", 0) or 0),
                    "symbol": d.symbol,
                    "side": "buy" if d.type == 0 else "sell",
                    "volume": float(d.volume),
                    "price": float(d.price),
                    "profit": float(d.profit),
                    "commission": float(d.commission),
                    "swap": float(d.swap),
                    "time": int(d.time),
                    "comment": d.comment,
                    "magic": int(d.magic),
                    "entry": int(getattr(d, "entry", 0) or 0),
                }
            )
            if len(out) >= limit:
                break
        return out
