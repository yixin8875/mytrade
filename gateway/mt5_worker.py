from __future__ import annotations

import asyncio
import concurrent.futures
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Any, Awaitable, Callable

import MetaTrader5 as mt5

from config import Config
from journal import TradeJournal
from notify import Notifier
from store import Store

TIMEFRAMES = {
    "1": mt5.TIMEFRAME_M1,
    "5": mt5.TIMEFRAME_M5,
    "15": mt5.TIMEFRAME_M15,
    "30": mt5.TIMEFRAME_M30,
    "60": mt5.TIMEFRAME_H1,
    "240": mt5.TIMEFRAME_H4,
    "1D": mt5.TIMEFRAME_D1,
    "1W": mt5.TIMEFRAME_W1,
    "1M": mt5.TIMEFRAME_MN1,
}

RES_SECONDS = {
    "1": 60,
    "5": 300,
    "15": 900,
    "30": 1800,
    "60": 3600,
    "240": 14400,
    "1D": 86400,
    "1W": 604800,
    "1M": 2592000,
}

RETCODE_TEXT = {
    10004: "价格变动，请重试",
    10006: "请求被拒绝",
    10007: "请求被交易者取消",
    10008: "挂单已放置",
    10009: "成交完成",
    10010: "部分成交",
    10011: "请求处理中",
    10012: "请求超时",
    10013: "请求参数无效",
    10014: "手数无效",
    10015: "价格无效",
    10016: "止损/止盈无效（距离过近或方向错误）",
    10017: "交易被禁用",
    10018: "市场已关闭",
    10019: "保证金不足",
    10020: "价格已变化",
    10021: "当前无报价",
    10022: "挂单有效期无效",
    10023: "订单状态已变化",
    10024: "请求过于频繁",
    10025: "没有变化",
    10026: "服务器禁止自动交易",
    10027: "客户端禁止自动交易",
    10028: "交易被锁定",
    10029: "订单/持仓已冻结",
    10030: "填充模式无效",
    10031: "与交易服务器无连接",
    10032: "仅允许实盘账户操作",
    10033: "挂单数量已达上限",
    10034: "交易量已达上限",
    10035: "订单类型无效",
    10036: "持仓已关闭",
}

OK_RETCODES = {10008, 10009, 10010}

ORDER_STATES = {
    0: "started",
    1: "working",
    2: "cancelled",
    3: "partial",
    4: "filled",
    5: "rejected",
    6: "expired",
    7: "request_add",
    8: "request_modify",
    9: "request_cancel",
}


class GatewayError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def round_volume(volume: float, step: float) -> float:
    if step <= 0:
        return volume
    d = Decimal(str(step))
    q = (Decimal(str(volume)) / d).to_integral_value(rounding=ROUND_DOWN)
    return float(q * d)


def align_price(price: float, info: Any) -> float:
    tick = float(getattr(info, "trade_tick_size", 0) or getattr(info, "point", 0) or 0)
    digits = int(info.digits)
    if tick <= 0:
        return round(price, digits)
    return round(round(price / tick) * tick, digits)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


class Mt5Worker:
    """唯一允许调用 MetaTrader5 API 的工作线程。"""

    def __init__(
        self,
        cfg: Config,
        store: Store,
        publish: Callable[[str, Any], Awaitable[None]],
    ) -> None:
        self.cfg = cfg
        self.store = store
        self._publish = publish
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: queue.Queue[tuple[concurrent.futures.Future, str, dict]] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="mt5-worker", daemon=True)
        self._stop = threading.Event()
        self._ready = threading.Event()

        self._connected = False
        self._last_error: dict | None = None
        self._account: dict | None = None
        self._positions: list[dict] = []
        self._orders: list[dict] = []
        self._subs: dict[str, int] = {}
        self._bar_subs: dict[tuple[str, str], dict] = {}
        self._trade_mode = cfg.trade_mode
        # 券商服务器时间与 UTC 的差（秒），供前端换算图表时区
        self._server_offset = 0
        # 风控状态（当日盈亏、开仓次数、连亏、冷却、停机），由 _poll_risk 刷新
        self._risk: dict | None = None
        # 停机开关：持久化，重启后仍然禁止开新仓
        self._halted: dict | None = None
        # 移动止损计划：ticket -> {distancePoints, stepPoints}
        self._trailing: dict[int, dict] = {}
        self._trail_next: dict[int, float] = {}
        # 模板开仓的自动保本：ticket -> {entry, risk, trigger, side}
        self._auto_be: dict[int, dict] = {}
        self._state_loaded = False
        # 交易日志（成交配对 + MFE/MAE + 统计）与第三方告警通道
        self._journal = TradeJournal(store)
        self._notifier = Notifier(cfg.alert_channels, store)
        # 价格告警：DB 里读出来缓存在内存，每 0.5 秒扫一遍
        self._alerts: list[dict] = []
        self._alert_last: dict[str, float] = {}
        self._watch_day: dict[str, tuple[float, float]] = {}

    # ---------- lifecycle ----------

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._thread.start()
        self._ready.wait(5)

    def stop(self) -> None:
        self._stop.set()
        self._notifier.stop()
        self._thread.join(timeout=3)
        try:
            mt5.shutdown()
        except Exception:
            pass

    def submit(self, method: str, params: dict) -> concurrent.futures.Future:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._queue.put((fut, method, params))
        return fut

    def _run(self) -> None:
        self._ready.set()
        last_init = 0.0
        last_tick = 0.0
        last_state = 0.0
        last_account = 0.0
        last_risk = 0.0
        last_trail = 0.0
        last_alert = 0.0
        last_journal = 0.0

        while not self._stop.is_set():
            try:
                while True:
                    fut, method, params = self._queue.get_nowait()
                    if fut.cancelled():
                        continue
                    try:
                        fut.set_result(self._dispatch(method, params))
                    except GatewayError as exc:
                        fut.set_exception(exc)
                    except Exception as exc:  # noqa: BLE001
                        fut.set_exception(GatewayError("INTERNAL", f"{type(exc).__name__}: {exc}"))
            except queue.Empty:
                pass

            now = time.monotonic()
            try:
                if not self._connected:
                    if now - last_init >= 3.0:
                        last_init = now
                        self._try_connect()
                else:
                    if now - last_tick >= 0.10:
                        last_tick = now
                        self._poll_ticks()
                    if now - last_state >= 0.30:
                        last_state = now
                        self._poll_trade_state()
                    if now - last_account >= 0.50:
                        last_account = now
                        self._poll_account()
                    if now - last_trail >= 0.40:
                        last_trail = now
                        self._trail_positions()
                        self._auto_breakeven()
                    if now - last_risk >= 2.0:
                        last_risk = now
                        self._poll_risk()
                    if now - last_alert >= 0.5:
                        last_alert = now
                        self._check_alerts()
                    if now - last_journal >= 2.0:
                        last_journal = now
                        self._journal.sync()
            except Exception as exc:  # noqa: BLE001
                self._last_error = {"code": -1, "message": str(exc)}

            time.sleep(0.02)

    # ---------- connection ----------

    def _try_connect(self) -> None:
        try:
            mt5.shutdown()
            kwargs: dict[str, Any] = {}
            if self.cfg.terminal_path:
                kwargs["path"] = self.cfg.terminal_path
            if not mt5.initialize(**kwargs):
                code, msg = mt5.last_error()
                self._last_error = {"code": int(code), "message": str(msg)}
                return
            terminal = mt5.terminal_info()
            account = mt5.account_info()
            if terminal is None or account is None:
                self._last_error = {"code": -1, "message": "终端已启动但账户未登录"}
                mt5.shutdown()
                return
            if self.cfg.expected_login and int(account.login) != int(self.cfg.expected_login):
                self._last_error = {
                    "code": "ACCOUNT_MISMATCH",
                    "message": (
                        f"连接到了账户 {account.login}，配置期望 {self.cfg.expected_login}；"
                        "请检查 gateway/config.json 的 terminal_path"
                    ),
                }
                mt5.shutdown()
                return
            self._connected = True
            self._last_error = None
            self._account = self._account_payload(account)
            self._sync_server_time()
            if not self._state_loaded:
                self._state_loaded = True
                self._halted = self.store.get_state("halted")
                stored = self.store.get_state("trailing") or {}
                try:
                    self._trailing = {int(k): v for k, v in stored.items()}
                except (TypeError, ValueError):
                    self._trailing = {}
                auto_be = self.store.get_state("autoBreakeven") or {}
                try:
                    self._auto_be = {int(k): v for k, v in auto_be.items()}
                except (TypeError, ValueError):
                    self._auto_be = {}
            self._poll_trade_state()
            self._poll_account()
            self._reconcile()
            self._poll_risk(force=True)
            self._alerts = self.store.alerts_list()
            self._notifier.start()
            try:
                self._journal.sync(force=True)
            except Exception:  # noqa: BLE001 - 日志同步失败不影响交易
                pass
            self._emit("gateway", self.health())
            self.store.audit("gateway.connected", {"login": self._account.get("login")})
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._last_error = {"code": -1, "message": f"{type(exc).__name__}: {exc}"}

    def health(self) -> dict:
        terminal = None
        if self._connected:
            info = mt5.terminal_info()
            if info is not None:
                terminal = {
                    "company": info.company,
                    "name": info.name,
                    "build": int(info.build),
                    "path": info.path,
                    "connected": bool(info.connected),
                    "tradeAllowed": bool(info.trade_allowed),
                    "dllsAllowed": bool(info.dlls_allowed),
                }
        return {
            "connected": self._connected,
            "terminal": terminal,
            "account": self._account,
            "tradeMode": self._trade_mode,
            "config": self.cfg.public(),
            "lastError": self._last_error,
            "risk": self._risk,
            "serverTime": int(time.time()),
            "serverOffset": int(self._server_offset),
            "version": "0.1.0",
        }

    # ---------- dispatch ----------

    def _dispatch(self, method: str, p: dict) -> Any:
        handlers: dict[str, Callable[[dict], Any]] = {
            "ping": lambda _: {"pong": time.time()},
            "system.health": lambda _: self.health(),
            "system.getConfig": lambda _: {
                "config": self.cfg.public(),
                "tradeMode": self._trade_mode,
            },
            "system.setTradeMode": self._set_trade_mode,
            "system.halt": self._halt,
            "system.resume": self._resume,
            "system.reconcile": self._reconcile_now,
            "risk.status": lambda _: self._risk or self._compute_risk(),
            "symbols.list": self._symbols_list,
            "symbol.info": self._symbol_info,
            "history.get": self._history,
            "quotes.subscribe": self._quotes_subscribe,
            "quotes.unsubscribe": self._quotes_unsubscribe,
            "bars.subscribe": self._bars_subscribe,
            "bars.unsubscribe": self._bars_unsubscribe,
            "account.get": lambda _: self._require_account(),
            "positions.get": lambda _: self._positions,
            "orders.get": lambda _: self._orders,
            "executions.get": self._executions,
            "executions.stats": lambda p: self.store.execution_stats(int(p.get("days") or 30)),
            "audit.query": lambda p: self.store.audit_query(
                str(p.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")),
                p.get("kind"),
                p.get("text"),
                int(p.get("limit") or 300),
            ),
            "trade.preview": self._preview,
            "trade.size": self._size,
            "order.place": self._place,
            "order.modify": self._modify_order,
            "order.cancel": self._cancel_order,
            "position.modify": self._modify_position,
            "position.breakeven": self._breakeven,
            "position.trailing.set": self._set_trailing,
            "position.trailing.clear": self._clear_trailing,
            "position.close": self._close_position,
            "position.closeAll": self._close_all,
            "journal.list": self._journal_list,
            "journal.stats": lambda p: self._journal.stats(int(p.get("days") or 30)),
            "journal.tag": self._journal_tag,
            "journal.sync": lambda _: {"written": self._journal.sync(force=True)},
            "journal.screenshot.save": self._journal_shot,
            "alerts.list": lambda _: self.store.alerts_list(),
            "alerts.create": self._alert_create,
            "alerts.update": self._alert_update,
            "alerts.delete": self._alert_delete,
            "alerts.test": self._alert_test,
            "watchlist.get": self._watchlist,
            "watchlist.set": self._watchlist_set,
            "intents.list": lambda p: self.store.recent_intents(int(p.get("limit") or 50)),
            "audit.tail": lambda p: self.store.audit_tail(int(p.get("limit") or 50)),
        }
        handler = handlers.get(method)
        if handler is None:
            raise GatewayError("UNKNOWN_METHOD", f"未知方法: {method}")
        return handler(p)

    # ---------- system ----------

    def _require_account(self) -> dict:
        if not self._connected or self._account is None:
            raise GatewayError("DISCONNECTED", "MT5 终端未连接")
        return self._account

    def _auto_trading_on(self) -> bool:
        info = mt5.terminal_info()
        return bool(info and info.trade_allowed)

    def _set_trade_mode(self, p: dict) -> dict:
        mode = str(p.get("mode") or "")
        if mode not in ("readonly", "demo", "live"):
            raise GatewayError("BAD_MODE", "未知交易模式")
        account = self._require_account()
        if mode != "readonly" and not self._auto_trading_on():
            raise GatewayError("TRADE_DISABLED", "请在 MT5 工具栏打开 Algo Trading（自动交易）")
        if mode == "live":
            if not self.cfg.allow_live:
                raise GatewayError("LIVE_DISABLED", "实盘交易未在 gateway/config.json 中开启")
            if account["accountType"] != "real":
                raise GatewayError("NOT_REAL", "当前账户不是实盘账户")
        if mode == "demo" and account["accountType"] == "real":
            raise GatewayError("REAL_ACCOUNT", "当前是实盘账户，模拟模式已被阻止")
        if mode != "readonly" and not account["tradeAllowed"]:
            raise GatewayError("TRADE_DISABLED", "请在 MT5 中开启 Algo Trading")
        self._trade_mode = mode
        self.store.audit("trade.mode", {"mode": mode, "login": account["login"]})
        self._emit("gateway", self.health())
        return self.health()

    def _guard_trade(self) -> dict:
        account = self._require_account()
        if self._trade_mode == "readonly":
            raise GatewayError("READ_ONLY", "只读模式：请先在顶部切换到模拟交易")
        if not self._auto_trading_on():
            raise GatewayError("TRADE_DISABLED", "请在 MT5 工具栏打开 Algo Trading（自动交易）")
        if not account["tradeAllowed"]:
            raise GatewayError("TRADE_DISABLED", "MT5 账户未允许交易")
        if self._trade_mode == "demo" and account["accountType"] == "real":
            raise GatewayError("REAL_ACCOUNT", "实盘账户不允许模拟模式下单")
        if self._trade_mode == "live" and account["accountType"] != "real":
            raise GatewayError("NOT_REAL", "非实盘账户不允许实盘模式下单")
        return account

    # ---------- 风控状态 ----------

    def _server_now(self) -> int:
        return int(time.time() + self._server_offset)

    def _day_start(self) -> int:
        now = self._server_now()
        return now - now % 86400

    def _compute_risk(self) -> dict:
        """当日盈亏、开仓次数、连亏、冷却和停机状态，全部按券商服务器时间算。"""
        account = self._account or {}
        cfg = self.cfg
        day_start = self._day_start()

        deals: list[Any] = []
        try:
            raw = mt5.history_deals_get(
                datetime.now() - timedelta(days=3), datetime.now() + timedelta(days=2)
            )
            if raw:
                deals = [d for d in raw if int(getattr(d, "time", 0)) >= day_start]
        except Exception:  # noqa: BLE001 - 历史读不到时按 0 处理
            deals = []

        # DEAL_TYPE_BALANCE(2) 及以后是出入金等非交易记录
        trades = [d for d in deals if int(getattr(d, "type", 2)) < 2]
        realized = sum(
            float(d.profit)
            + float(d.swap)
            + float(d.commission)
            + float(getattr(d, "fee", 0) or 0)
            for d in trades
        )
        floating = sum(
            float(p.get("profit") or 0) + float(p.get("swap") or 0) for p in self._positions
        )
        day_pnl = realized + floating

        balance = float(account.get("balance") or 0)
        day_start_balance = balance - realized
        limit = (
            max(0.0, day_start_balance * cfg.daily_loss_pct / 100.0)
            if cfg.daily_loss_pct > 0
            else 0.0
        )
        daily_loss = max(0.0, -day_pnl)
        remaining = max(0.0, limit - daily_loss) if limit > 0 else 0.0

        entries = [d for d in trades if int(getattr(d, "entry", 0)) == 0]
        closed = sorted(
            (d for d in trades if int(getattr(d, "entry", 0)) in (1, 3)),
            key=lambda d: int(getattr(d, "time", 0)),
        )
        consecutive = 0
        for deal in reversed(closed):
            net = (
                float(deal.profit)
                + float(deal.swap)
                + float(deal.commission)
                + float(getattr(deal, "fee", 0) or 0)
            )
            if net < 0:
                consecutive += 1
            else:
                break

        cooldown_until = 0
        if (
            cfg.max_consecutive_losses
            and consecutive >= cfg.max_consecutive_losses
            and closed
        ):
            cooldown_until = int(getattr(closed[-1], "time", 0)) + int(cfg.cooldown_minutes * 60)
        now = self._server_now()
        cooldown_remaining = max(0, cooldown_until - now) if cooldown_until else 0

        halted = bool(self._halted)
        block_reason = ""
        if halted:
            block_reason = "已停机：" + str((self._halted or {}).get("reason") or "手动停止")
        elif limit > 0 and daily_loss >= limit:
            block_reason = f"今日亏损 {daily_loss:.2f} 已达上限 {limit:.2f}"
        elif cooldown_remaining > 0:
            block_reason = (
                f"连续亏损 {consecutive} 次，冷却 {max(1, cooldown_remaining // 60)} 分钟"
            )
        elif cfg.max_trades_per_day and len(entries) >= cfg.max_trades_per_day:
            block_reason = f"今日开仓 {len(entries)} 次已达上限 {cfg.max_trades_per_day}"

        return {
            "dayStartBalance": round(day_start_balance, 2),
            "dayPnl": round(day_pnl, 2),
            "dailyLoss": round(daily_loss, 2),
            "dailyLossLimit": round(limit, 2),
            "remaining": round(remaining, 2),
            "tradesToday": len(entries),
            "maxTrades": int(cfg.max_trades_per_day or 0),
            "consecutiveLosses": consecutive,
            "maxConsecutiveLosses": int(cfg.max_consecutive_losses or 0),
            "cooldownUntil": cooldown_until,
            "cooldownRemainingSec": cooldown_remaining,
            "halted": halted,
            "haltReason": str((self._halted or {}).get("reason") or ""),
            "canTrade": not block_reason,
            "blockReason": block_reason,
        }

    def _poll_risk(self, force: bool = False) -> dict | None:
        if not self._connected or self._account is None:
            return self._risk
        try:
            risk = self._compute_risk()
        except Exception as exc:  # noqa: BLE001
            self._last_error = {"code": -1, "message": f"风控状态计算失败: {exc}"}
            return self._risk
        if force or risk != self._risk:
            self._risk = risk
            self._emit("risk", risk)
        return risk

    def _risk_block(self) -> str:
        """开新仓前的硬风控检查，返回拦截原因；空串表示可以开仓。"""
        risk = self._risk or self._compute_risk()
        return str(risk.get("blockReason") or "")

    def _halt(self, p: dict) -> dict:
        reason = str(p.get("reason") or "手动停机")
        close_all = bool(p.get("closeAll"))
        self._halted = {"reason": reason, "at": int(time.time())}
        self.store.set_state("halted", self._halted)
        self.store.audit("system.halt", {"reason": reason, "closeAll": close_all})
        closed: list[dict] = []
        if close_all:
            try:
                closed = self._close_all({}).get("results", [])
            except GatewayError as exc:
                closed = [{"error": exc.message}]
        self._poll_risk(force=True)
        self._emit("gateway", self.health())
        return {"halted": True, "reason": reason, "closed": closed}

    def _resume(self, p: dict) -> dict:
        self._halted = None
        self.store.set_state("halted", None)
        self.store.audit("system.resume", {})
        self._poll_risk(force=True)
        self._emit("gateway", self.health())
        return {"halted": False}

    # ---------- 交易日志 ----------

    def _journal_list(self, p: dict) -> list[dict]:
        days = int(p.get("days") or 30)
        limit = min(1000, int(p.get("limit") or 200))
        self._journal.sync()
        since = int(time.time()) - days * 86400 if days > 0 else 0
        return self.store.journal_list(limit=limit, since=since)

    def _journal_tag(self, p: dict) -> dict:
        position_id = int(p.get("positionId") or 0)
        if not self.store.journal_get(position_id):
            raise GatewayError("NO_TRADE", f"日志里没有这笔交易 {position_id}")
        tag = str(p.get("tag") or "").strip()[:40] or None
        self.store.journal_set_tag(position_id, tag)
        self.store.audit("journal.tag", {"positionId": position_id, "tag": tag})
        return self.store.journal_get(position_id) or {}

    def _journal_shot(self, p: dict) -> dict:
        position_id = int(p.get("positionId") or 0)
        data = str(p.get("data") or "")
        if position_id <= 0 or not data:
            raise GatewayError("BAD_SHOT", "缺少持仓号或截图数据")
        try:
            out = self._journal.save_shot(position_id, data)
        except ValueError as exc:
            raise GatewayError("BAD_SHOT", str(exc)) from exc
        self.store.audit("journal.screenshot", {"positionId": position_id, "bytes": out["bytes"]})
        return out

    # ---------- 告警 ----------

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
        alert = self.store.alert_create(
            symbol,
            kind,
            align_price(price, info),
            note,
            bool(p.get("repeat")),
            cooldown if p.get("repeat") else 0,
        )
        self._alerts = self.store.alerts_list()
        self.store.audit("alert.create", alert)
        return alert

    def _alert_update(self, p: dict) -> dict:
        alert_id = int(p.get("id") or 0)
        if not self.store.alert_get(alert_id):
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
        alert = self.store.alert_update(alert_id, fields) or {}
        self._alerts = self.store.alerts_list()
        self.store.audit("alert.update", {"id": alert_id, "fields": fields})
        return alert

    def _alert_delete(self, p: dict) -> dict:
        alert_id = int(p.get("id") or 0)
        self.store.alert_delete(alert_id)
        self._alerts = self.store.alerts_list()
        self.store.audit("alert.delete", {"id": alert_id})
        return {"deleted": alert_id}

    def _alert_test(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "").upper().strip()
        if not symbol:
            symbol = next((pos["symbol"] for pos in self._positions), "")
        info = mt5.symbol_info(symbol) if symbol else None
        tick = mt5.symbol_info_tick(symbol) if symbol else None
        price = float(tick.bid) if tick else 0.0
        payload = {
            "id": 0,
            "symbol": symbol or "TEST",
            "kind": "above",
            "price": align_price(price, info) if info and price else 0.0,
            "note": "测试告警",
            "marketPrice": price or None,
            "at": int(time.time()),
            "test": True,
        }
        self._notifier.send(payload)
        self._emit("alert", payload)
        self.store.audit("alert.test", payload)
        return {"sent": True, "channels": self._notifier.info()}

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
            self.store.alert_mark_triggered(int(alert["id"]), disable=not repeat)
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
            self._alerts = self.store.alerts_list()

    # ---------- 自选表 ----------

    def _watchlist(self, p: dict) -> list[dict]:
        names = [str(item).upper() for item in (p.get("symbols") or []) if str(item).strip()]
        if not names:
            names = [str(item) for item in (self.store.get_state("watchlist") or [])]
        if not names:
            infos = mt5.symbols_get() or ()
            names = [info.name for info in infos if getattr(info, "visible", False)][:12]
        held = {str(pos["symbol"]) for pos in self._positions}
        out: list[dict] = []
        for name in names[:50]:
            info = mt5.symbol_info(name)
            tick = mt5.symbol_info_tick(name)
            if info is None or tick is None:
                continue
            day_open = self._day_open(name)
            change = ((float(tick.bid) - day_open) / day_open * 100) if day_open else None
            out.append(
                {
                    "symbol": name,
                    "description": info.description or name,
                    "digits": int(info.digits),
                    "point": float(info.point),
                    "bid": float(tick.bid),
                    "ask": float(tick.ask),
                    "spreadPoints": round((tick.ask - tick.bid) / float(info.point), 1)
                    if info.point
                    else 0.0,
                    "changePct": round(change, 2) if change is not None else None,
                    "hasPosition": name in held,
                }
            )
        return out

    def _watchlist_set(self, p: dict) -> dict:
        names = [str(item).upper().strip() for item in (p.get("symbols") or []) if str(item).strip()]
        names = names[:50]
        self.store.set_state("watchlist", names)
        return {"symbols": names}

    def _day_open(self, symbol: str) -> float:
        cached = self._watch_day.get(symbol)
        now = time.time()
        if cached and now - cached[1] < 60:
            return cached[0]
        try:
            bars = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_D1, 0, 2)
        except Exception:  # noqa: BLE001
            bars = None
        value = float(bars[-1]["open"]) if bars is not None and len(bars) else 0.0
        self._watch_day[symbol] = (value, now)
        return value

    # ---------- symbols ----------

    def _symbol_payload(self, info: Any) -> dict:
        return {
            "name": info.name,
            "description": info.description or info.name,
            "digits": int(info.digits),
            "point": float(info.point),
            "tickSize": _num(getattr(info, "trade_tick_size", 0), float(info.point)),
            "tickValue": _num(getattr(info, "trade_tick_value", 0), 1.0),
            "contractSize": _num(getattr(info, "trade_contract_size", 0), 1.0),
            "minVolume": float(info.volume_min),
            "maxVolume": float(info.volume_max),
            "volumeStep": float(info.volume_step),
            "stopsLevelPoints": int(getattr(info, "trade_stops_level", 0) or 0),
            "freezeLevelPoints": int(getattr(info, "trade_freeze_level", 0) or 0),
            "spreadPoints": int(round(_num(info.spread))),
            "tradeMode": int(info.trade_mode),
            "fillingMode": int(info.filling_mode),
            "visible": bool(info.visible),
            "currency": info.currency_profit or "USD",
            "marginMode": (self._account or {}).get("marginMode", "netting"),
        }

    def _symbols_list(self, p: dict) -> list[dict]:
        if not self._connected:
            raise GatewayError("DISCONNECTED", "MT5 终端未连接")
        query = str(p.get("query") or "").strip().lower()
        limit = int(p.get("limit") or 300)
        infos = mt5.symbols_get()
        if infos is None:
            raise GatewayError("MT5_ERROR", str(mt5.last_error()))
        ordered = sorted(infos, key=lambda i: (0 if i.visible else 1, i.name))
        out: list[dict] = []
        for info in ordered:
            if query and query not in info.name.lower() and query not in (info.description or "").lower():
                continue
            out.append(self._symbol_payload(info))
            if len(out) >= limit:
                break
        return out

    def _symbol_info(self, p: dict) -> dict:
        name = str(p.get("symbol") or "")
        info = mt5.symbol_info(name)
        if info is None:
            raise GatewayError("BAD_SYMBOL", f"找不到品种: {name}")
        return self._symbol_payload(info)

    def _ensure_symbol(self, symbol: str) -> Any:
        info = mt5.symbol_info(symbol)
        if info is None:
            raise GatewayError("BAD_SYMBOL", f"找不到品种: {symbol}")
        if not info.visible:
            if not mt5.symbol_select(symbol, True):
                raise GatewayError("SYMBOL_SELECT", f"无法把 {symbol} 加入市场报价")
            info = mt5.symbol_info(symbol)
        return info

    # ---------- market data ----------

    def _history(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "")
        resolution = str(p.get("resolution") or "1")
        count = max(10, min(int(p.get("count") or 1000), 5000))
        tf = TIMEFRAMES.get(resolution)
        if tf is None:
            raise GatewayError("BAD_RESOLUTION", f"不支持的周期: {resolution}")
        info = self._ensure_symbol(symbol)

        # TradingView 往左滚时会带着 from/to 再要一段更早的 K 线。
        # copy_rates_from_pos 只能取「最近 N 根」，所以有 to 时改走区间查询。
        # MT5 的 K 线时间按券商服务器时间存，这里把 epoch 秒当 UTC 直接喂给库，
        # 和前端 datafeed 的「服务器时间当 UTC」约定保持一致。
        to_ts = p.get("to")
        from_ts = p.get("from")
        rates = None
        if to_ts:
            end_ts = float(to_ts)
            if from_ts:
                start_ts = float(from_ts)
            else:
                start_ts = end_ts - RES_SECONDS.get(resolution, 60) * count * 1.2
            try:
                # MetaTrader5 会把 datetime 当成本地墙钟时间换算成时间戳；
                # 而 K 线 time 我们按「服务器时间当作 UTC」处理，所以这里也要用
                # 本地墙钟构造，才能查到对应的服务器时间区间。
                date_to = datetime.fromtimestamp(end_ts)
                date_from = datetime.fromtimestamp(max(0.0, start_ts))
                rates = mt5.copy_rates_range(symbol, tf, date_from, date_to)
            except Exception:
                rates = None
            if rates is not None and len(rates) > count:
                rates = rates[-count:]
            # 请求的窗口可能正好落在周末/休市，直接返回空会让图表以为左侧
            # 再没有数据而停止翻页。这里往前找最近一段有数据的区间返回，
            # 图表跨过休市继续加载更早的 K 线。
            if (rates is None or len(rates) == 0) and from_ts:
                probe_end = float(from_ts)
                probe_span = RES_SECONDS.get(resolution, 60) * max(60, count) * 1.2
                for _ in range(6):
                    probe_start = probe_end - probe_span
                    try:
                        got = mt5.copy_rates_range(
                            symbol,
                            tf,
                            datetime.fromtimestamp(max(0.0, probe_start)),
                            datetime.fromtimestamp(probe_end),
                        )
                    except Exception:
                        got = None
                    if got is not None and len(got) > 0:
                        rates = got[-count:]
                        break
                    probe_end = probe_start
                else:
                    rates = []
            if rates is None:
                rates = []
        else:
            rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
        if rates is None:
            raise GatewayError("NO_DATA", f"无法读取 {symbol} 历史数据: {mt5.last_error()}")
        bars = [
            {
                "time": int(r["time"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["tick_volume"]),
            }
            for r in rates
        ]
        return {
            "symbol": symbol,
            "resolution": resolution,
            "digits": int(info.digits),
            "bars": bars,
        }

    def _quotes_subscribe(self, p: dict) -> dict:
        for symbol in p.get("symbols") or []:
            self._subs[symbol] = self._subs.get(symbol, 0) + 1
            self._emit_tick(symbol)
        return {"subscribed": list(self._subs)}

    def _quotes_unsubscribe(self, p: dict) -> dict:
        for symbol in p.get("symbols") or []:
            n = self._subs.get(symbol, 0) - 1
            if n <= 0:
                self._subs.pop(symbol, None)
            else:
                self._subs[symbol] = n
        return {"subscribed": list(self._subs)}

    def _bars_subscribe(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "")
        resolution = str(p.get("resolution") or "1")
        key = (symbol, resolution)
        if key not in self._bar_subs:
            tf = TIMEFRAMES.get(resolution)
            if tf is None:
                raise GatewayError("BAD_RESOLUTION", f"不支持的周期: {resolution}")
            self._ensure_symbol(symbol)
            rates = mt5.copy_rates_from_pos(symbol, tf, 0, 2)
            if rates is None or len(rates) == 0:
                raise GatewayError("NO_DATA", f"无法读取 {symbol} 当前 K 线")
            last = rates[-1]
            self._bar_subs[key] = {
                "bar": {
                    "time": int(last["time"]),
                    "open": float(last["open"]),
                    "high": float(last["high"]),
                    "low": float(last["low"]),
                    "close": float(last["close"]),
                    "volume": float(last["tick_volume"]),
                },
                "last_push": 0.0,
            }
        return {"symbol": symbol, "resolution": resolution}

    def _bars_unsubscribe(self, p: dict) -> dict:
        self._bar_subs.pop((str(p.get("symbol") or ""), str(p.get("resolution") or "")), None)
        return {"ok": True}

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

    def _sync_server_time(self) -> None:
        """刚连上时还没有行情订阅，先从一个品种的报价推算服务器时区。

        当日盈亏、开仓次数都按服务器日切分；offset 为 0 时会算错一整个时区。
        """
        try:
            symbols = mt5.symbols_get() or []
        except Exception:  # noqa: BLE001
            return
        for info in symbols[:300]:
            try:
                tick = mt5.symbol_info_tick(info.name)
            except Exception:  # noqa: BLE001
                continue
            if tick is not None and int(getattr(tick, "time", 0) or 0):
                self._note_server_time(tick)
                return

    def _note_server_time(self, tick: Any) -> None:
        server_time = int(getattr(tick, "time", 0) or 0)
        if not server_time:
            return
        raw = server_time - time.time()
        # 券商时区都是整小时或半小时，按 15 分钟取整吸收网络延迟
        self._server_offset = int(round(raw / 900.0)) * 900

    def _emit_tick(self, symbol: str) -> None:
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return
        self._note_server_time(tick)
        self._emit(
            "tick",
            {
                "symbol": symbol,
                "bid": float(tick.bid),
                "ask": float(tick.ask),
                "time": int(tick.time),
                "timeMs": int(getattr(tick, "time_msc", tick.time * 1000)),
                "serverOffset": int(self._server_offset),
            },
        )

    def _poll_ticks(self) -> None:
        if not self._subs and not self._bar_subs:
            return
        symbols = set(self._subs) | {key[0] for key in self._bar_subs}
        for symbol in symbols:
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                continue
            self._note_server_time(tick)
            if symbol in self._subs:
                self._emit(
                    "tick",
                    {
                        "symbol": symbol,
                        "bid": float(tick.bid),
                        "ask": float(tick.ask),
                        "time": int(tick.time),
                        "timeMs": int(getattr(tick, "time_msc", tick.time * 1000)),
                        "serverOffset": int(self._server_offset),
                    },
                )
            if self._bar_subs:
                for key, state in list(self._bar_subs.items()):
                    if key[0] != symbol:
                        continue
                    self._update_bar(key[0], key[1], state, float(tick.bid), int(tick.time))

    def _update_bar(self, symbol: str, resolution: str, state: dict, price: float, ts: int) -> None:
        seconds = RES_SECONDS.get(resolution, 60)
        bucket = (ts // seconds) * seconds
        bar = state["bar"]
        if bucket > int(bar["time"]):
            bar = {
                "time": bucket,
                "open": float(bar["close"]),
                "high": max(float(bar["close"]), price),
                "low": min(float(bar["close"]), price),
                "close": price,
                "volume": 0.0,
            }
        else:
            bar = {
                "time": int(bar["time"]),
                "open": float(bar["open"]),
                "high": max(float(bar["high"]), price),
                "low": min(float(bar["low"]), price),
                "close": price,
                "volume": float(bar["volume"]) + 1.0,
            }
        state["bar"] = bar
        now = time.monotonic()
        if now - state["last_push"] >= 0.25:
            state["last_push"] = now
            self._emit("bar", {"symbol": symbol, "resolution": resolution, "bar": bar})

    # ---------- account / positions / orders ----------

    def _account_payload(self, ai: Any) -> dict:
        return {
            "login": int(ai.login),
            "server": ai.server,
            "company": ai.company,
            "name": ai.name,
            "currency": ai.currency,
            "leverage": int(ai.leverage),
            "balance": float(ai.balance),
            "equity": float(ai.equity),
            "margin": float(ai.margin),
            "freeMargin": float(ai.margin_free),
            "marginLevel": float(ai.margin_level) if ai.margin_level else None,
            "marginSoCall": float(getattr(ai, "margin_so_call", 0) or 0),
            "marginSoSo": float(getattr(ai, "margin_so_so", 0) or 0),
            "marginMode": "hedging"
            if ai.margin_mode == mt5.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
            else "netting",
            "tradeAllowed": bool(ai.trade_allowed),
            "accountType": {0: "demo", 1: "contest", 2: "real"}.get(int(ai.trade_mode), "unknown"),
        }

    def _poll_account(self) -> None:
        ai = mt5.account_info()
        if ai is None:
            if self._connected:
                self._connected = False
                self._account = None
                self._positions = []
                self._orders = []
                self._last_error = {"code": -1, "message": "与 MT5 终端的连接已断开"}
                self._emit("gateway", self.health())
            return
        payload = self._account_payload(ai)
        if payload != self._account:
            self._account = payload
            self._emit("account", payload)

    def _poll_trade_state(self) -> None:
        positions = mt5.positions_get()
        orders = mt5.orders_get()
        next_positions = [self._position_payload(p) for p in positions] if positions else []
        next_orders = [self._order_payload(o) for o in orders] if orders else []
        if next_positions != self._positions:
            self._positions = next_positions
            self._emit("positions", next_positions)
        if next_orders != self._orders:
            self._orders = next_orders
            self._emit("orders", next_orders)

    def _stop_out_price(self, position: Any, info: Any) -> float | None:
        """只持有这一单时，账户净值跌到券商强平线对应的价格（估算）。"""
        account = self._account or {}
        margin_used = float(account.get("margin") or 0)
        equity = float(account.get("equity") or 0)
        level = float(account.get("marginSoSo") or 0)
        if margin_used <= 0 or equity <= 0 or level <= 0 or level > 100:
            return None
        buy = int(position.type) == 0
        base = mt5.ORDER_TYPE_BUY if buy else mt5.ORDER_TYPE_SELL
        volume = float(position.volume)
        entry = float(position.price_open)
        profit_now = float(position.profit)
        point = float(getattr(info, "point", 0) or 0)
        if point <= 0:
            return None
        target = level / 100.0 * margin_used - equity + profit_now
        delta = max(point * 100.0, entry * 0.001)
        test_price = entry - delta if buy else entry + delta
        p_entry = mt5.order_calc_profit(base, position.symbol, volume, entry, entry)
        p_test = mt5.order_calc_profit(base, position.symbol, volume, entry, test_price)
        if p_entry is None or p_test is None:
            return None
        slope = (float(p_test) - float(p_entry)) / delta
        if abs(slope) < 1e-12:
            return None
        price = entry + (target - float(p_entry)) / slope
        if buy and price >= entry:
            return None
        if not buy and price <= entry:
            return None
        # 手数很小、净值远高于保证金时算出来会离谱到负数，直接不显示
        if price <= 0 or abs(price - entry) > entry * 0.5:
            return None
        return align_price(price, info)

    def _position_payload(self, p: Any) -> dict:
        # 打到止损/止盈时的盈亏（账户货币），图表上直接显示金额
        sl_profit = tp_profit = None
        base = mt5.ORDER_TYPE_BUY if p.type == 0 else mt5.ORDER_TYPE_SELL
        try:
            if p.sl:
                result = mt5.order_calc_profit(
                    base, p.symbol, float(p.volume), float(p.price_open), float(p.sl)
                )
                sl_profit = None if result is None else float(result)
            if p.tp:
                result = mt5.order_calc_profit(
                    base, p.symbol, float(p.volume), float(p.price_open), float(p.tp)
                )
                tp_profit = None if result is None else float(result)
        except Exception:  # noqa: BLE001 - 显示用，算不出来就不显示
            pass
        trailing = self._trailing.get(int(p.ticket))
        stop_out = None
        try:
            info = mt5.symbol_info(p.symbol)
            if info is not None:
                stop_out = self._stop_out_price(p, info)
        except Exception:  # noqa: BLE001 - 估算失败就不显示
            stop_out = None
        return {
            "ticket": int(p.ticket),
            "identifier": int(getattr(p, "identifier", p.ticket)),
            "symbol": p.symbol,
            "side": "buy" if p.type == 0 else "sell",
            "volume": float(p.volume),
            "openPrice": float(p.price_open),
            "sl": float(p.sl) or None,
            "tp": float(p.tp) or None,
            "profit": float(p.profit),
            "slProfit": sl_profit,
            "tpProfit": tp_profit,
            "stopOutPrice": stop_out,
            "trailing": trailing,
            "swap": float(p.swap),
            "commission": _num(getattr(p, "commission", 0)),
            "magic": int(p.magic),
            "comment": p.comment,
            "openTime": int(p.time),
        }

    def _order_payload(self, o: Any) -> dict:
        otype = int(o.type)
        side = "buy" if otype in (0, 2, 4, 6) else "sell"
        kind = "market" if otype in (0, 1) else ("limit" if otype in (2, 3) else "stop")
        return {
            "ticket": int(o.ticket),
            "symbol": o.symbol,
            "type": kind,
            "side": side,
            "volume": float(o.volume_current),
            "initialVolume": float(o.volume_initial),
            "filledVolume": max(0.0, float(o.volume_initial) - float(o.volume_current)),
            "price": float(o.price_open),
            "sl": float(o.sl) or None,
            "tp": float(o.tp) or None,
            "state": ORDER_STATES.get(int(o.state), "unknown"),
            "comment": o.comment,
            "magic": int(o.magic),
            "createdAt": int(o.time_setup),
            "expiration": int(o.time_expiration) or None,
        }

    # ---------- trade analysis ----------

    def _analyze(self, p: dict) -> dict:
        if not self._connected:
            raise GatewayError("DISCONNECTED", "MT5 终端未连接")
        symbol = str(p.get("symbol") or "")
        side = str(p.get("side") or "")
        otype = str(p.get("type") or "market")
        if side not in ("buy", "sell"):
            raise GatewayError("BAD_SIDE", "方向必须是 buy 或 sell")
        if otype not in ("market", "limit", "stop"):
            raise GatewayError("BAD_TYPE", "订单类型必须是 market / limit / stop")

        info = self._ensure_symbol(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise GatewayError("NO_QUOTE", f"{symbol} 当前无报价")

        if info.trade_mode == mt5.SYMBOL_TRADE_MODE_DISABLED:
            raise GatewayError("SYMBOL_DISABLED", f"{symbol} 当前禁止交易")
        if info.trade_mode == mt5.SYMBOL_TRADE_MODE_CLOSEONLY:
            raise GatewayError("CLOSE_ONLY", f"{symbol} 当前只允许平仓")
        if side == "buy" and info.trade_mode == mt5.SYMBOL_TRADE_MODE_SHORTONLY:
            raise GatewayError("SHORT_ONLY", f"{symbol} 当前只允许卖出")
        if side == "sell" and info.trade_mode == mt5.SYMBOL_TRADE_MODE_LONGONLY:
            raise GatewayError("LONG_ONLY", f"{symbol} 当前只允许买入")

        volume = round_volume(_num(p.get("volume"), float(info.volume_min)), float(info.volume_step))
        if volume < float(info.volume_min):
            raise GatewayError("VOLUME_MIN", f"手数不能小于 {info.volume_min}")
        if volume > float(info.volume_max):
            raise GatewayError("VOLUME_MAX", f"手数不能大于 {info.volume_max}")

        if otype == "market":
            price = float(tick.ask if side == "buy" else tick.bid)
            order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
            action = mt5.TRADE_ACTION_DEAL
        else:
            raw_price = p.get("price")
            if not raw_price:
                raise GatewayError("PRICE_REQUIRED", "限价/停损单必须指定价格")
            price = align_price(_num(raw_price), info)
            if otype == "limit":
                order_type = mt5.ORDER_TYPE_BUY_LIMIT if side == "buy" else mt5.ORDER_TYPE_SELL_LIMIT
                if side == "buy" and price >= float(tick.ask):
                    raise GatewayError("BAD_LIMIT_PRICE", "买入限价必须低于当前卖价")
                if side == "sell" and price <= float(tick.bid):
                    raise GatewayError("BAD_LIMIT_PRICE", "卖出限价必须高于当前买价")
            else:
                order_type = mt5.ORDER_TYPE_BUY_STOP if side == "buy" else mt5.ORDER_TYPE_SELL_STOP
                if side == "buy" and price <= float(tick.ask):
                    raise GatewayError("BAD_STOP_PRICE", "买入停损必须高于当前卖价")
                if side == "sell" and price >= float(tick.bid):
                    raise GatewayError("BAD_STOP_PRICE", "卖出停损必须低于当前买价")
            action = mt5.TRADE_ACTION_PENDING

        sl = align_price(_num(p.get("sl")), info) if p.get("sl") else 0.0
        tp = align_price(_num(p.get("tp")), info) if p.get("tp") else 0.0
        stops = float(info.trade_stops_level) * float(info.point)

        if sl:
            if side == "buy" and sl >= price:
                raise GatewayError("BAD_SL", "买单止损必须低于入场价")
            if side == "sell" and sl <= price:
                raise GatewayError("BAD_SL", "卖单止损必须高于入场价")
            if stops > 0 and abs(price - sl) < stops:
                raise GatewayError(
                    "STOPS_LEVEL",
                    f"止损距离小于券商最小 {info.trade_stops_level} 点（{stops:.{info.digits}f}）",
                )
        if tp:
            if side == "buy" and tp <= price:
                raise GatewayError("BAD_TP", "买单止盈必须高于入场价")
            if side == "sell" and tp >= price:
                raise GatewayError("BAD_TP", "卖单止盈必须低于入场价")
            if stops > 0 and abs(tp - price) < stops:
                raise GatewayError(
                    "STOPS_LEVEL",
                    f"止盈距离小于券商最小 {info.trade_stops_level} 点（{stops:.{info.digits}f}）",
                )

        base_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        margin = mt5.order_calc_margin(base_type, symbol, volume, price)
        if margin is None:
            raise GatewayError("MARGIN_CALC", str(mt5.last_error()))
        risk = None
        if sl:
            profit = mt5.order_calc_profit(base_type, symbol, volume, price, sl)
            if profit is not None:
                risk = abs(float(profit))
        reward = None
        if tp:
            profit = mt5.order_calc_profit(base_type, symbol, volume, price, tp)
            if profit is not None:
                reward = abs(float(profit))

        spread_points = (float(tick.ask) - float(tick.bid)) / float(info.point or 1)
        return {
            "symbol": symbol,
            "side": side,
            "type": otype,
            "volume": volume,
            "price": price,
            "sl": sl or None,
            "tp": tp or None,
            "orderType": order_type,
            "action": action,
            "margin": float(margin),
            "riskAmount": risk,
            "rewardAmount": reward,
            "rr": (reward / risk) if reward is not None and risk not in (None, 0) else None,
            "spreadPoints": spread_points,
            "stopsLevelPoints": int(info.trade_stops_level),
            "digits": int(info.digits),
            "point": float(info.point),
            "tick": tick,
            "info": info,
            "freeMargin": float((self._account or {}).get("freeMargin", 0.0)),
            "equity": float((self._account or {}).get("equity", 0.0)),
        }

    def _preview(self, p: dict) -> dict:
        a = self._analyze(p)
        warnings: list[str] = []
        risk = self._risk or self._compute_risk()
        if risk.get("blockReason"):
            warnings.append(f"当前禁止开仓：{risk['blockReason']}")
        if not a["sl"]:
            warnings.append("未设置止损")
        if a["riskAmount"] is not None and a["equity"] > 0:
            risk_pct = a["riskAmount"] / a["equity"] * 100
            if risk_pct > self.cfg.max_risk_pct:
                warnings.append(f"风险 {risk_pct:.2f}% 超过上限 {self.cfg.max_risk_pct}%")
        if self.cfg.max_spread_points and a["spreadPoints"] > self.cfg.max_spread_points:
            warnings.append(f"点差 {a['spreadPoints']:.0f} 点超过上限 {self.cfg.max_spread_points}")
        if a["freeMargin"] and a["margin"] > a["freeMargin"] * 0.9:
            warnings.append("保证金占用接近可用保证金的 90%")
        return {
            "symbol": a["symbol"],
            "side": a["side"],
            "type": a["type"],
            "volume": a["volume"],
            "price": a["price"],
            "sl": a["sl"],
            "tp": a["tp"],
            "margin": a["margin"],
            "freeMargin": a["freeMargin"],
            "riskAmount": a["riskAmount"],
            "rewardAmount": a["rewardAmount"],
            "riskPct": (a["riskAmount"] / a["equity"] * 100)
            if a["riskAmount"] is not None and a["equity"] > 0
            else None,
            "rr": a["rr"],
            "spreadPoints": a["spreadPoints"],
            "stopsLevelPoints": a["stopsLevelPoints"],
            "digits": a["digits"],
            "warnings": warnings,
        }

    def _size(self, p: dict) -> dict:
        """按目标风险（固定金额或余额百分比）反推手数。

        用券商自己的 order_calc_profit 算「1 手打到止损亏多少」，再缩放，
        避免自己用 tick_value 近似算错交叉盘/黄金的合约价值。
        """
        a = self._analyze(p)
        info = a["info"]
        symbol = a["symbol"]
        entry = float(a["price"])
        sl = float(a["sl"] or 0.0)
        tp = float(a["tp"] or 0.0)
        if not sl:
            raise GatewayError("NO_SL", "先设置止损，才能按风险计算手数")

        # order_calc_profit 只认 BUY / SELL，不认 BUY_LIMIT / SELL_LIMIT
        base_type = mt5.ORDER_TYPE_BUY if a["side"] == "buy" else mt5.ORDER_TYPE_SELL
        per_lot = mt5.order_calc_profit(base_type, symbol, 1.0, entry, sl)
        if per_lot is None:
            raise GatewayError("RISK_CALC", str(mt5.last_error()))
        risk_per_lot = abs(float(per_lot))
        if risk_per_lot <= 0:
            raise GatewayError("RISK_CALC", "止损与入场价的距离为 0，无法计算")

        account = self._account or {}
        equity = float(account.get("equity") or 0.0)
        balance = float(account.get("balance") or 0.0)
        mode = str(p.get("riskMode") or "amount")
        risk_value = _num(p.get("riskValue"), 1.0 if mode == "percent" else 100.0)
        if risk_value <= 0:
            raise GatewayError("BAD_RISK", "风险值必须大于 0")
        target = balance * risk_value / 100.0 if mode == "percent" else risk_value
        if target <= 0:
            raise GatewayError("BAD_RISK", "目标风险金额必须大于 0")

        step = float(info.volume_step or 0.01)
        vmin = float(info.volume_min)
        vmax = min(float(info.volume_max), float(self.cfg.max_lot))
        volume = round_volume(target / risk_per_lot, step)
        capped: list[str] = []
        if volume < vmin:
            volume = vmin
            capped.append("min")
        if volume > vmax:
            volume = vmax
            capped.append("max")

        risk = None
        actual = mt5.order_calc_profit(base_type, symbol, volume, entry, sl)
        if actual is not None:
            risk = abs(float(actual))
        reward = None
        if tp:
            pl = mt5.order_calc_profit(base_type, symbol, volume, entry, tp)
            if pl is not None:
                reward = abs(float(pl))

        warnings: list[str] = []
        if "min" in capped:
            warnings.append(f"按最小手数 {vmin} 计算，实际风险 {risk:.2f}" if risk else "已按最小手数")
        if "max" in capped:
            warnings.append(f"手数已到上限 {vmax}，未达到目标风险")
        if risk is not None and equity > 0 and risk / equity * 100 > self.cfg.max_risk_pct:
            warnings.append(
                f"风险 {risk / equity * 100:.2f}% 超过上限 {self.cfg.max_risk_pct}%"
            )

        return {
            "symbol": symbol,
            "side": a["side"],
            "type": a["type"],
            "price": entry,
            "sl": sl or None,
            "tp": tp or None,
            "digits": int(info.digits),
            "step": step,
            "volume": volume,
            "targetRisk": target,
            "riskPerLot": risk_per_lot,
            "riskAmount": risk,
            "rewardAmount": reward,
            "riskPct": (risk / equity * 100) if risk is not None and equity > 0 else None,
            "rr": (reward / risk) if reward is not None and risk not in (None, 0) else None,
            "balance": balance,
            "equity": equity,
            "capped": capped,
            "warnings": warnings,
        }

    # ---------- trade execution ----------

    def _place(self, p: dict) -> dict:
        account = self._guard_trade()
        a = self._analyze(p)
        client_id = str(p.get("clientOrderId") or f"mt-{int(time.time() * 1000)}")[:31]

        if a["volume"] > self.cfg.max_lot:
            raise GatewayError("MAX_LOT", f"单笔手数 {a['volume']} 超过上限 {self.cfg.max_lot}")
        if self.cfg.max_spread_points and a["spreadPoints"] > self.cfg.max_spread_points:
            raise GatewayError("SPREAD_LIMIT", f"点差 {a['spreadPoints']:.0f} 点超过上限")
        if len(self._positions) >= self.cfg.max_positions:
            raise GatewayError("MAX_POSITIONS", f"持仓数已达上限 {self.cfg.max_positions}")
        if a["riskAmount"] is not None and a["equity"] > 0:
            risk_pct = a["riskAmount"] / a["equity"] * 100
            if risk_pct > self.cfg.max_risk_pct:
                raise GatewayError(
                    "RISK_LIMIT", f"本单风险 {risk_pct:.2f}% 超过上限 {self.cfg.max_risk_pct}%"
                )
        risk = self._risk or self._compute_risk()
        self._risk = risk
        if risk.get("blockReason"):
            raise GatewayError("RISK_BLOCK", str(risk["blockReason"]))
        if a["freeMargin"] and a["margin"] > a["freeMargin"] * 0.9:
            raise GatewayError("NO_MARGIN", "保证金占用过高，拒绝下单")
        if self.store.recent_duplicate(a["symbol"], a["side"], a["price"]):
            raise GatewayError("DUPLICATE", "3 秒内已提交相同方向/价格的订单")

        existing = self.store.get_intent(client_id)
        if existing and existing["state"] in ("sending", "accepted", "working", "filled"):
            return {
                "clientOrderId": client_id,
                "state": existing["state"],
                "ticket": existing["ticket"],
            }

        self.store.save_intent(
            {
                "client_id": client_id,
                "symbol": a["symbol"],
                "side": a["side"],
                "type": a["type"],
                "volume": a["volume"],
                "price": a["price"],
                "sl": a["sl"],
                "tp": a["tp"],
                "state": "sending",
                "ticket": None,
                "tag": str(p.get("tag") or "").strip()[:40] or None,
            }
        )
        self.store.audit(
            "order.place.request",
            {
                "clientId": client_id,
                "symbol": a["symbol"],
                "side": a["side"],
                "type": a["type"],
                "volume": a["volume"],
                "price": a["price"],
                "sl": a["sl"],
                "tp": a["tp"],
                "tradeMode": self._trade_mode,
            },
        )

        request = {
            "action": a["action"],
            "symbol": a["symbol"],
            "volume": a["volume"],
            "type": a["orderType"],
            "price": a["price"],
            "sl": a["sl"] or 0.0,
            "tp": a["tp"] or 0.0,
            "deviation": self.cfg.deviation_points,
            "magic": self.cfg.magic,
            # 这家券商只接受较短注释（30 字符以上直接 Invalid "comment"），
            # 前 20 位足够唯一，_enrich_place_payload 也按这 20 位前缀找成交
            "comment": client_id[:20],
            "type_time": mt5.ORDER_TIME_GTC,
        }
        if a["action"] == mt5.TRADE_ACTION_PENDING:
            request["expiration"] = 0
        else:
            request["type_filling"] = self._filling_mode(a["info"])

        started = time.perf_counter()
        try:
            result = mt5.order_send(request)
        except Exception as exc:  # noqa: BLE001
            latency = int((time.perf_counter() - started) * 1000)
            self.store.update_intent(client_id, "unknown", error=f"{type(exc).__name__}: {exc}")
            self.store.audit("order.place.exception", {"clientId": client_id, "error": str(exc)})
            self._record_execution(client_id, 0, a, 0, latency, "unknown", f"{type(exc).__name__}: {exc}")
            raise GatewayError("SEND_FAILED", f"下单异常: {exc}") from exc

        latency = int((time.perf_counter() - started) * 1000)
        if result is None:
            self.store.update_intent(client_id, "unknown", error=str(mt5.last_error()))
            self._record_execution(client_id, 0, a, 0, latency, "unknown", str(mt5.last_error()))
            raise GatewayError("SEND_FAILED", f"下单失败: {mt5.last_error()}")
        retcode = int(result.retcode)
        payload = {
            "clientOrderId": client_id,
            "retcode": retcode,
            "order": int(result.order or 0),
            "deal": int(result.deal or 0),
            "volume": float(result.volume or 0),
            "price": float(result.price or 0),
            "comment": getattr(result, "comment", ""),
        }
        if retcode not in OK_RETCODES:
            self.store.audit("order.place.result", payload)
            message = RETCODE_TEXT.get(retcode, result.comment or "下单被拒绝")
            self.store.update_intent(client_id, "rejected", error=f"{retcode}: {message}")
            self._record_execution(
                client_id, 0, a, payload["price"], latency, "rejected", f"{retcode}: {message}", retcode
            )
            raise GatewayError(f"RET_{retcode}", message, payload)

        # 部分终端对已成交的市价单只回 retcode，不回 deal/price，用实际持仓补齐
        self._poll_trade_state()
        self._poll_risk(force=True)
        self._enrich_place_payload(payload, client_id, a)
        self.store.audit("order.place.result", payload)

        state = "filled" if a["action"] == mt5.TRADE_ACTION_DEAL else "accepted"
        self.store.update_intent(client_id, state, ticket=payload["order"] or None)
        ticket = int(payload["order"] or 0)
        self._record_execution(
            client_id, ticket, a, payload["price"], latency, state, None, retcode
        )
        if a["action"] == mt5.TRADE_ACTION_DEAL and p.get("autoBreakeven") and a["sl"] and ticket:
            entry = float(payload["price"] or a["price"])
            risk = abs(entry - float(a["sl"]))
            if risk > 0:
                trigger = entry + risk if a["side"] == "buy" else entry - risk
                self._auto_be[ticket] = {
                    "entry": entry,
                    "risk": risk,
                    "trigger": trigger,
                    "side": a["side"],
                }
                self._save_auto_be()
                self.store.audit(
                    "position.auto_breakeven.set",
                    {"ticket": ticket, "entry": entry, "trigger": trigger},
                )
        self._emit("trade", {**payload, "state": state, "symbol": a["symbol"], "side": a["side"]})
        return {**payload, "state": state}

    def _record_execution(
        self,
        client_id: str,
        ticket: int,
        a: dict,
        fill_price: float,
        latency_ms: int,
        state: str,
        reason: str | None,
        retcode: int = 0,
    ) -> None:
        """记录一次实际发出的下单请求，用于执行质量统计。"""
        point = float(a.get("point") or 0)
        requested = float(a.get("price") or 0)
        fill = float(fill_price or 0)
        slippage = None
        if a.get("type") == "market" and requested > 0 and fill > 0 and point > 0:
            diff = fill - requested if a["side"] == "buy" else requested - fill
            slippage = round(diff / point, 1)
        try:
            self.store.record_execution(
                {
                    "client_id": client_id,
                    "ticket": ticket or None,
                    "symbol": a["symbol"],
                    "side": a["side"],
                    "type": a["type"],
                    "volume": a["volume"],
                    "requested_price": requested or None,
                    "fill_price": fill or None,
                    "spread_points": round(float(a.get("spreadPoints") or 0), 1),
                    "slippage_points": slippage,
                    "latency_ms": latency_ms,
                    "retcode": retcode,
                    "state": state,
                    "reason": reason,
                }
            )
        except Exception:  # noqa: BLE001 - 统计失败不能影响交易
            pass

    def _enrich_place_payload(self, payload: dict, client_id: str, a: dict) -> None:
        """终端可能只回 retcode，成交价要过几百毫秒才查得到，短暂重试补齐。"""
        ticket = int(payload["order"] or 0)
        prefix = client_id[:20]
        for attempt in range(4):
            try:
                if a["action"] == mt5.TRADE_ACTION_DEAL:
                    found = mt5.positions_get(ticket=ticket) or ()
                    pos = found[0] if found else None
                    if pos is None:
                        pos = next(
                            (
                                p
                                for p in (mt5.positions_get() or ())
                                if str(p.comment or "").startswith(prefix)
                            ),
                            None,
                        )
                    if pos is not None:
                        payload["ticket"] = int(pos.ticket)
                        payload["price"] = float(pos.price_open)
                        payload["volume"] = float(pos.volume)
                        return
                else:
                    found = mt5.orders_get(ticket=ticket) or ()
                    order = found[0] if found else None
                    if order is not None:
                        payload["price"] = float(order.price_open)
                        payload["volume"] = float(order.volume_current)
                        return
            except Exception:  # noqa: BLE001
                return
            if attempt < 3:
                time.sleep(0.12)

    def _filling_mode(self, info: Any) -> int:
        flags = int(getattr(info, "filling_mode", 0) or 0)
        if flags & 2:
            return mt5.ORDER_FILLING_IOC
        if flags & 1:
            return mt5.ORDER_FILLING_FOK
        return mt5.ORDER_FILLING_RETURN

    def _modify_order(self, p: dict) -> dict:
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.orders_get(ticket=ticket)
        if not found:
            raise GatewayError("NO_ORDER", f"找不到挂单 {ticket}")
        order = found[0]
        info = self._ensure_symbol(order.symbol)
        price = align_price(_num(p.get("price"), float(order.price_open)), info)
        sl = align_price(_num(p.get("sl")), info) if p.get("sl") else float(order.sl)
        tp = align_price(_num(p.get("tp")), info) if p.get("tp") else float(order.tp)
        request = {
            "action": mt5.TRADE_ACTION_MODIFY,
            "order": ticket,
            "symbol": order.symbol,
            "price": price,
            "sl": sl,
            "tp": tp,
            "magic": self.cfg.magic,
            "type_time": mt5.ORDER_TIME_GTC,
            "expiration": 0,
        }
        result = mt5.order_send(request)
        out = self._result_or_raise(result, "order.modify")
        self._poll_trade_state()
        return out

    def _cancel_order(self, p: dict) -> dict:
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.orders_get(ticket=ticket)
        comment = str(getattr(found[0], "comment", "") or "") if found else ""
        request = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}
        result = mt5.order_send(request)
        out = self._result_or_raise(result, "order.cancel")
        if comment and self.store.get_intent(comment):
            self.store.update_intent(comment, "cancelled")
        self._poll_trade_state()
        return out

    def _modify_position(self, p: dict) -> dict:
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}")
        position = found[0]
        info = self._ensure_symbol(position.symbol)
        sl = align_price(_num(p.get("sl")), info) if p.get("sl") is not None else float(position.sl)
        tp = align_price(_num(p.get("tp")), info) if p.get("tp") is not None else float(position.tp)
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": position.symbol,
            "position": ticket,
            "sl": sl,
            "tp": tp,
            "magic": self.cfg.magic,
        }
        result = mt5.order_send(request)
        out = self._result_or_raise(result, "position.modify")
        self._poll_trade_state()
        return out

    def _breakeven(self, p: dict) -> dict:
        """把止损移到开仓价（可加偏移点数），并避开券商最小止损距离。"""
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}")
        position = found[0]
        info = self._ensure_symbol(position.symbol)
        tick = mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise GatewayError("NO_QUOTE", "当前无报价，无法设置保本")
        point = float(info.point)
        buy = int(position.type) == 0
        offset = max(0.0, _num(p.get("offsetPoints"))) * point
        target = float(position.price_open) + offset if buy else float(position.price_open) - offset
        stops = max(
            int(getattr(info, "trade_stops_level", 0) or 0),
            int(getattr(info, "trade_freeze_level", 0) or 0),
        )
        # 止损必须和现价拉开一点距离，券商 stops_level 为 0 时也至少 1 个点。
        # 再加 5 个点缓冲：贴着实盘 stops 边界发单，报价一跳动就会 Invalid stops。
        min_dist = (max(stops, 1) + 5) * point
        current_price = float(tick.bid if buy else tick.ask)
        target = min(target, current_price - min_dist) if buy else max(target, current_price + min_dist)
        target = align_price(target, info)
        current_sl = float(position.sl or 0)
        if current_sl:
            if buy and target <= current_sl + point / 2:
                return {"ticket": ticket, "sl": current_sl, "changed": False}
            if not buy and target >= current_sl - point / 2:
                return {"ticket": ticket, "sl": current_sl, "changed": False}
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": position.symbol,
            "position": ticket,
            "sl": target,
            "tp": float(position.tp or 0),
            "magic": self.cfg.magic,
        }
        result = mt5.order_send(request)
        out = self._result_or_raise(result, "position.breakeven")
        self._poll_trade_state()
        return {"ticket": ticket, "sl": target, "changed": True, **out}

    def _set_trailing(self, p: dict) -> dict:
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}")
        position = found[0]
        info = self._ensure_symbol(position.symbol)
        distance = _num(p.get("distancePoints"))
        if distance <= 0:
            raise GatewayError("BAD_TRAILING", "移动止损距离必须大于 0 点")
        stops = max(
            int(getattr(info, "trade_stops_level", 0) or 0),
            int(getattr(info, "trade_freeze_level", 0) or 0),
        )
        # 同保本：贴着 stops 边界会被报价跳动打成 Invalid stops
        floor = float(max(stops, 1) + 2)
        if distance < floor:
            distance = floor
        step = _num(p.get("stepPoints"), float(self.cfg.trailing_step_points))
        record = {
            "distancePoints": round(distance, 1),
            "stepPoints": max(step, 0.0),
            "activatedAt": int(time.time()),
        }
        self._trailing[ticket] = record
        self._save_trailing()
        self.store.audit("position.trailing.set", {"ticket": ticket, **record})
        self._poll_trade_state()
        return {"ticket": ticket, **record}

    def _clear_trailing(self, p: dict) -> dict:
        ticket = int(p.get("ticket") or 0)
        existed = self._trailing.pop(ticket, None) is not None
        if existed:
            self._save_trailing()
            self.store.audit("position.trailing.clear", {"ticket": ticket})
            self._poll_trade_state()
        return {"ticket": ticket, "cleared": existed}

    def _save_trailing(self) -> None:
        self.store.set_state("trailing", {str(k): v for k, v in self._trailing.items()})

    def _save_auto_be(self) -> None:
        self.store.set_state("autoBreakeven", {str(k): v for k, v in self._auto_be.items()})

    def _auto_breakeven(self) -> None:
        """模板开仓的自动保本：浮盈到 1R 时把止损移到开仓价。"""
        if not self._auto_be or not self._connected:
            return
        changed = False
        for ticket, plan in list(self._auto_be.items()):
            position = next((x for x in self._positions if x["ticket"] == ticket), None)
            if position is None:
                self._auto_be.pop(ticket, None)
                changed = True
                continue
            if time.monotonic() < float(plan.get("next") or 0):
                continue
            info = mt5.symbol_info(position["symbol"])
            tick = mt5.symbol_info_tick(position["symbol"])
            if info is None or tick is None:
                continue
            point = float(info.point)
            buy = str(plan.get("side")) == "buy"
            price = float(tick.bid if buy else tick.ask)
            trigger = float(plan.get("trigger") or 0)
            if (buy and price < trigger) or (not buy and price > trigger):
                continue
            entry = float(plan.get("entry") or position["price_open"])
            current_sl = float(position["sl"] or 0)
            if buy and current_sl > 0 and current_sl >= entry - point / 2:
                self._auto_be.pop(ticket, None)
                changed = True
                continue
            if not buy and current_sl > 0 and current_sl <= entry + point / 2:
                self._auto_be.pop(ticket, None)
                changed = True
                continue
            stops = max(
                int(getattr(info, "trade_stops_level", 0) or 0),
                int(getattr(info, "trade_freeze_level", 0) or 0),
            )
            min_dist = (max(stops, 1) + 5) * point
            target = min(entry, price - min_dist) if buy else max(entry, price + min_dist)
            target = align_price(target, info)
            request = {
                "action": mt5.TRADE_ACTION_SLTP,
                "symbol": position["symbol"],
                "position": ticket,
                "sl": target,
                "tp": float(position["tp"] or 0),
                "magic": self.cfg.magic,
            }
            try:
                self._result_or_raise(mt5.order_send(request), "position.auto_breakeven")
            except GatewayError as exc:
                plan["next"] = time.monotonic() + 3.0
                self.store.audit(
                    "position.auto_breakeven.failed", {"ticket": ticket, "error": str(exc)}
                )
                continue
            self._auto_be.pop(ticket, None)
            changed = True
            self.store.audit("position.auto_breakeven", {"ticket": ticket, "sl": target})
            self._emit("autoBreakeven", {"ticket": ticket, "sl": target, "symbol": position["symbol"]})
        if changed:
            self._save_auto_be()
            self._poll_trade_state()

    def _trail_positions(self) -> None:
        """移动止损：价格往盈利方向走时，把 SL 保持在一定距离外，只进不退。"""
        if not self._trailing or not self._connected:
            return
        now = time.monotonic()
        changed = False
        removed = False
        for ticket, record in list(self._trailing.items()):
            if now < self._trail_next.get(ticket, 0):
                continue
            position = next((x for x in self._positions if x["ticket"] == ticket), None)
            if position is None:
                self._trailing.pop(ticket, None)
                self._trail_next.pop(ticket, None)
                removed = True
                continue
            info = mt5.symbol_info(position["symbol"])
            tick = mt5.symbol_info_tick(position["symbol"])
            if info is None or tick is None:
                continue
            point = float(info.point)
            dist = float(record.get("distancePoints") or 0) * point
            step = float(record.get("stepPoints") or 0) * point
            buy = position["side"] == "buy"
            current_sl = float(position["sl"] or 0)
            if buy:
                desired = float(tick.bid) - dist
                better = current_sl <= 0 or desired > current_sl + step - 1e-9
            else:
                desired = float(tick.ask) + dist
                better = current_sl <= 0 or desired < current_sl - step + 1e-9
            if not better:
                continue
            desired = align_price(desired, info)
            request = {
                "action": mt5.TRADE_ACTION_SLTP,
                "symbol": position["symbol"],
                "position": ticket,
                "sl": desired,
                "tp": float(position["tp"] or 0),
                "magic": self.cfg.magic,
            }
            try:
                self._result_or_raise(mt5.order_send(request), "position.trailing")
            except GatewayError:
                self._trail_next[ticket] = now + 3.0
                continue
            self._trail_next[ticket] = now + 0.5
            changed = True
        if removed:
            self._save_trailing()
        if changed:
            self._poll_trade_state()

    def _close_position(self, p: dict) -> dict:
        self._guard_trade()
        ticket = int(p.get("ticket") or 0)
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}")
        position = found[0]
        info = self._ensure_symbol(position.symbol)
        tick = mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise GatewayError("NO_QUOTE", "当前无报价，无法平仓")
        volume = round_volume(_num(p.get("volume"), float(position.volume)), float(info.volume_step))
        if volume <= 0 or volume > float(position.volume):
            raise GatewayError("BAD_VOLUME", f"平仓手数无效: {volume}")
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": position.symbol,
            "volume": volume,
            "type": mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY,
            "position": ticket,
            "price": float(tick.bid if position.type == 0 else tick.ask),
            "deviation": self.cfg.deviation_points,
            "magic": self.cfg.magic,
            "comment": "close",
            "type_filling": self._filling_mode(info),
        }
        result = mt5.order_send(request)
        out = self._result_or_raise(
            result,
            "position.close",
            lambda payload: self._fill_deal_price(payload, ticket),
        )
        # 券商侧平仓是异步完成的，等持仓真正消失再刷新缓存，避免前端读到旧持仓
        for _ in range(10):
            if not mt5.positions_get(ticket=ticket):
                break
            time.sleep(0.1)
        partial = volume < float(position.volume) - 1e-9
        comment = str(getattr(position, "comment", "") or "")
        still_open = bool(mt5.positions_get(ticket=ticket))
        if comment and not still_open and self.store.get_intent(comment):
            self.store.update_intent(comment, "closed")
        if partial and still_open and bool(p.get("moveToBe")):
            try:
                out["breakeven"] = self._breakeven(
                    {"ticket": ticket, "offsetPoints": p.get("beOffsetPoints")}
                )
            except GatewayError as exc:
                out["breakeven"] = {"error": exc.message}
        self._poll_trade_state()
        self._poll_risk(force=True)
        return out

    def _fill_deal_price(self, payload: dict, position_ticket: int) -> None:
        if payload.get("price"):
            return
        deals = mt5.history_deals_get(position=position_ticket)
        if deals:
            last = deals[-1]
            payload["price"] = float(last.price)
            if not payload.get("deal"):
                payload["deal"] = int(last.ticket)

    def _close_all(self, p: dict) -> dict:
        self._guard_trade()
        symbol = p.get("symbol")
        targets = [x for x in self._positions if not symbol or x["symbol"] == symbol]
        results = []
        for pos in targets:
            try:
                results.append(self._close_position({"ticket": pos["ticket"]}))
            except GatewayError as exc:
                results.append({"ticket": pos["ticket"], "error": exc.message})
        return {"results": results}

    def _result_or_raise(
        self, result: Any, kind: str, enrich: Callable[[dict], None] | None = None
    ) -> dict:
        if result is None:
            raise GatewayError("SEND_FAILED", f"{kind} 失败: {mt5.last_error()}")
        retcode = int(result.retcode)
        payload = {
            "retcode": retcode,
            "order": int(result.order or 0),
            "deal": int(result.deal or 0),
            "volume": float(result.volume or 0),
            "price": float(result.price or 0),
            "comment": getattr(result, "comment", ""),
        }
        if enrich is not None and retcode in OK_RETCODES:
            try:
                enrich(payload)
            except Exception:  # noqa: BLE001
                pass
        self.store.audit(f"{kind}.result", payload)
        if retcode not in OK_RETCODES:
            message = RETCODE_TEXT.get(retcode, result.comment or "请求被拒绝")
            raise GatewayError(f"RET_{retcode}", message, payload)
        return payload

    # ---------- reconciliation ----------

    def _reconcile(self) -> dict[str, int]:
        """把发送中/超时的意图和 MT5 实际状态对齐；成交后立刻平掉的单查历史成交。"""
        stats = {"checked": 0, "found": 0, "notFound": 0}
        deals: list[Any] = []
        try:
            deals = list(
                mt5.history_deals_get(datetime.now() - timedelta(days=7), datetime.now())
                or ()
            )
        except Exception:  # noqa: BLE001
            deals = []
        for intent in self.store.recent_intents(50):
            if intent["state"] not in ("sending", "unknown"):
                continue
            stats["checked"] += 1
            cid = intent["client_id"]
            found = None
            for collection in (self._orders, self._positions):
                for item in collection:
                    if str(item.get("comment") or "").startswith(cid[:20]):
                        found = item
                        break
                if found:
                    break
            if found is None:
                for deal in deals:
                    if str(getattr(deal, "comment", "") or "").startswith(cid[:20]):
                        found = {
                            "ticket": int(
                                getattr(deal, "position_id", 0)
                                or getattr(deal, "order", 0)
                                or getattr(deal, "ticket", 0)
                            )
                        }
                        break
            if found:
                self.store.update_intent(
                    cid,
                    "accepted",
                    ticket=int(found.get("ticket") or 0),
                    error=None,
                )
                stats["found"] += 1
                self.store.audit("reconcile.found", {"clientId": cid, "ticket": found.get("ticket")})
            else:
                self.store.update_intent(cid, "not_found", error="重启后未在挂单/持仓/成交中找到")
                stats["notFound"] += 1
                self.store.audit("reconcile.not_found", {"clientId": cid})
        return stats

    def _reconcile_now(self, _p: dict) -> dict:
        if not self._connected:
            raise GatewayError("DISCONNECTED", "MT5 终端未连接")
        stats = self._reconcile()
        self.store.audit("reconcile.manual", stats)
        return stats

    # ---------- events ----------

    def _emit(self, event: str, data: Any) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._publish(event, data), self._loop)
        except RuntimeError:
            pass
