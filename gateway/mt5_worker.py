from __future__ import annotations

import diagnostics
from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401
from worker_account import WorkerAccount
from worker_data import WorkerData
from worker_discipline import WorkerDiscipline
from worker_market import WorkerMarket
from worker_replay import WorkerReplay
from worker_risk import WorkerRisk
from worker_trading import WorkerTrading


class Mt5Worker(
    WorkerAccount,
    WorkerData,
    WorkerMarket,
    WorkerRisk,
    WorkerTrading,
    WorkerDiscipline,
    WorkerReplay,
):
    """唯一允许调用 MetaTrader5 API 的工作线程。"""

    # 观测字段的类级默认值：测试里用 __new__ 构造 worker 时 health() 也能正常返回
    _queue: queue.Queue | None = None
    _command_count = 0
    _slowest_command_ms = 0
    _last_command: dict | None = None
    _last_iteration_ms = 0
    _busy_since: float | None = None
    _busy_method: str | None = None
    _needs_reconcile = False
    _reconcile_reason: str | None = None
    # 崩溃排查：启动时间、数据库自检结果、备份互斥锁（测试用 __new__ 构造时可为空）
    _started_at = 0.0
    _db_integrity: dict | None = None
    _backup_lock: threading.Lock | None = None

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
        # 有界队列：工作线程卡住时宁可快速返回 BUSY，也不要无限堆积请求
        self._queue: queue.Queue[tuple[concurrent.futures.Future, str, dict]] = queue.Queue(
            maxsize=256
        )
        self._thread = threading.Thread(target=self._run, name="mt5-worker", daemon=True)
        self._stop = threading.Event()
        self._ready = threading.Event()

        # 命令执行观测：队列深度、慢命令、当前正在执行的命令
        self._command_count = 0
        self._slowest_command_ms = 0
        self._last_command: dict | None = None
        self._last_iteration_ms = 0
        self._busy_since: float | None = None
        self._busy_method: str | None = None
        # 超时后的补对账请求（由 app 层置位，工作线程空闲时执行）
        self._needs_reconcile = False
        self._reconcile_reason: str | None = None

        self._account_id = cfg.active_profile()["id"]
        self._connected = False
        self._connect_blocked = False
        self._auth_failures = 0
        self._last_error: dict | None = None
        self._account_mgr = AccountManager(
            cfg, CredentialStore(BASE_DIR / "data" / "credentials.json")
        )
        self._account: dict | None = None
        self._positions: list[dict] = []
        self._orders: list[dict] = []
        self._subs: dict[str, int] = {}
        self._bar_subs: dict[tuple[str, str], dict] = {}
        self._trade_mode = cfg.trade_mode
        # 当前账户真正生效的风控（全局默认 + 账户覆盖），切换账户/改配置时刷新
        self._limits: dict[str, float | int] = cfg.risk_limits(self._account_id)
        # 券商服务器时间与 UTC 的差（秒），供前端换算图表时区
        self._server_offset = 0
        # 只有从真实 tick 推算过才算已知；未知时不拿 0 冒充时区
        self._server_offset_known = False
        self._offset_checked_at = 0.0
        # 风控状态（当日盈亏、开仓次数、连亏、冷却、停机），由 _poll_risk 刷新
        self._risk: dict | None = None
        # 停机开关：持久化，重启后仍然禁止开新仓
        self._halted: dict | None = None
        # 移动止损计划：ticket -> {distancePoints, stepPoints}
        self._trailing: dict[int, dict] = {}
        self._trail_next: dict[int, float] = {}
        # 模板开仓的分批止盈 / 保本计划：ticket -> {entry, risk, side, steps, next}
        self._auto_be: dict[int, dict] = {}
        # 挂单的模板计划：order ticket -> {clientId, symbol, side, sl, steps, placedAt}
        # 成交后由 _adopt_pending_template_plans 迁移到实际持仓的 _auto_be
        self._pending_plans: dict[int, dict] = {}
        # 最近一次暂停模板阶段的原因（只读 / 停机），用于每次切换只审计一次
        self._auto_be_pause_reason = ""
        self._state_loaded = False
        # 已经记录过初始风险的持仓 ticket（重复轮询时不要反复写库）
        self._risk_tracked: dict[int, float] = {}
        # 交易日志（成交配对 + MFE/MAE + 统计）与第三方告警通道
        self._journal = TradeJournal(store)
        self._review = Review(store)
        self._routines = Routines(store)
        self._missed = Missed(store)
        self._score = Score(store, self._review)
        self._ai = AI(store, self._review, self._account_mgr.credentials, self._score)
        self._notifier = Notifier(cfg.alert_channels, store)
        # 价格告警：DB 里读出来缓存在内存，每 0.5 秒扫一遍
        self._alerts: list[dict] = []
        self._alert_last: dict[str, float] = {}
        self._watch_day: dict[str, tuple[float, float]] = {}

        # 启动自检 / 自动备份：独立守护线程，不占用行情与命令循环
        self._started_at = time.time()
        self._db_integrity = None
        self._backup_lock = threading.Lock()

    # ---------- lifecycle ----------

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._thread.start()
        threading.Thread(
            target=self._check_database, name="db-check", daemon=True
        ).start()
        threading.Thread(
            target=self._auto_backup_loop, name="auto-backup", daemon=True
        ).start()
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
        try:
            self._queue.put_nowait((fut, method, params))
        except queue.Full:
            raise GatewayError("BUSY", "网关命令队列已满，请稍后重试") from None
        return fut

    def request_reconcile(self, method: str) -> None:
        """命令超时后由 app 层调用：等工作线程空闲时补一次对账。"""
        self._reconcile_reason = method
        self._needs_reconcile = True

    # ---------- maintenance ----------

    def _create_backup(self, settings: dict | None = None, auto: bool = False) -> dict:
        """手动与自动备份共用同一把锁，避免两个 zip 同时写快照。"""
        lock = self._backup_lock
        if lock is None:
            return exporter.create_backup(self.store, self.cfg, settings, auto=auto)
        with lock:
            return exporter.create_backup(self.store, self.cfg, settings, auto=auto)

    def database_status(self) -> dict:
        status = self._db_integrity
        if status is None:
            return {"ok": None, "messages": [], "checkedAt": 0}
        return status

    def _check_database(self) -> None:
        try:
            result = self.store.integrity_check()
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "messages": [f"{type(exc).__name__}: {exc}"]}
        result["checkedAt"] = int(time.time())
        self._db_integrity = result
        if result["ok"]:
            return
        log.error("database integrity check failed: %s", result["messages"])
        try:
            self.store.audit("database.integrity_failed", result)
        except Exception:  # noqa: BLE001
            pass

    def _auto_backup_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._auto_backup_once()
            except Exception as exc:  # noqa: BLE001
                log.warning("auto backup failed: %s", exc)
            self._stop.wait(AUTO_BACKUP_INTERVAL)

    def _auto_backup_once(self) -> None:
        backups = exporter.list_backups(self.store.base_dir)
        newest = max(
            (item["createdAt"] for item in backups if item.get("auto")), default=0
        )
        if time.time() - newest < AUTO_BACKUP_MIN_AGE:
            return
        out = self._create_backup(auto=True)
        removed = exporter.prune_auto_backups(self.store.base_dir, AUTO_BACKUP_KEEP)
        self.store.audit(
            "data.backup.auto",
            {"name": out["name"], "bytes": out["bytes"], "removed": removed},
        )

    def _diagnostics(self, _p: dict) -> dict:
        return diagnostics.build(self, self.store, self._started_at)

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
            loop_started = time.monotonic()

            # 每轮最多处理固定条数，命令洪峰时也要给行情/持仓轮询留出时间片
            for _ in range(MAX_COMMANDS_PER_TICK):
                try:
                    fut, method, params = self._queue.get_nowait()
                except queue.Empty:
                    break
                if fut.cancelled():
                    continue
                started = time.monotonic()
                self._busy_since = started
                self._busy_method = method
                try:
                    fut.set_result(self._dispatch(method, params))
                except GatewayError as exc:
                    fut.set_exception(exc)
                except Exception as exc:  # noqa: BLE001
                    fut.set_exception(GatewayError("INTERNAL", f"{type(exc).__name__}: {exc}"))
                finally:
                    self._busy_since = None
                    self._busy_method = None
                    self._note_command(method, time.monotonic() - started)

            # 下单类命令超时后，等工作线程恢复空闲补一次对账
            if self._needs_reconcile and self._connected:
                self._needs_reconcile = False
                reason = self._reconcile_reason
                self._reconcile_reason = None
                try:
                    counts = self._reconcile()
                    self.store.audit(
                        "trade.reconcile_after_timeout",
                        {"method": reason, "counts": counts},
                    )
                    if any(counts.values()):
                        self._emit("gateway", self.health())
                except Exception as exc:  # noqa: BLE001
                    self._last_error = {"code": -1, "message": str(exc)}

            now = time.monotonic()
            try:
                if not self._connected and not self._connect_blocked:
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
                        login = self._login()
                        if login:
                            self._journal.sync(
                                login, server_offset=self._server_offset_value()
                            )
            except Exception as exc:  # noqa: BLE001
                self._last_error = {"code": -1, "message": str(exc)}

            self._last_iteration_ms = int((time.monotonic() - loop_started) * 1000)
            time.sleep(0.02)

    def _note_command(self, method: str, seconds: float) -> None:
        """记录命令耗时；超过服务端超时视为慢命令，写审计便于事后定位。"""
        self._command_count += 1
        ms = int(seconds * 1000)
        self._last_command = {"method": method, "ms": ms, "at": int(time.time())}
        self._slowest_command_ms = max(self._slowest_command_ms, ms)
        limit = command_timeout(method)
        if seconds < limit:
            return
        log.warning("command %s took %.1fs (limit %.1fs)", method, seconds, limit)
        try:
            self.store.audit(
                "command.slow",
                {"method": method, "ms": ms, "limitMs": int(limit * 1000)},
            )
        except Exception:  # noqa: BLE001
            pass

    # ---------- connection ----------

    def _profile(self) -> dict:
        return self.cfg.active_profile()

    def _login(self) -> int:
        return int((self._account or {}).get("login") or 0)














    def health(self) -> dict:
        self._refresh_server_offset()
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
        busy = None
        if self._busy_since is not None:
            busy = {
                "method": self._busy_method,
                "seconds": round(time.monotonic() - self._busy_since, 1),
            }
        return {
            "connected": self._connected,
            "terminal": terminal,
            "account": self._account,
            "accounts": self._accounts_payload(),
            "activeAccountId": self._account_id,
            "limits": self._limits,
            "accountRisk": self.cfg.account_risk(self._account_id),
            "tradeMode": self._trade_mode,
            "config": self.cfg.public(),
            "lastError": self._last_error,
            "risk": self._risk,
            "serverTime": int(time.time()),
            "serverOffset": int(self._server_offset),
            "version": "0.7.2",
            # 启动时的 SQLite 完整性自检结果（后台线程执行）
            "database": self.database_status(),
            # 运行观测：队列积压、慢命令、当前正在执行的命令、事件循环上一轮耗时
            "runtime": {
                "queueDepth": self._queue.qsize() if self._queue is not None else 0,
                "commands": self._command_count,
                "lastCommand": self._last_command,
                "slowestCommandMs": self._slowest_command_ms,
                "busy": busy,
                "pendingReconcile": self._needs_reconcile,
                "lastIterationMs": self._last_iteration_ms,
            },
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
            "system.setConfig": self._set_config,
            "system.setAccountRisk": self._set_account_risk,
            "system.setAccountDiscipline": self._set_account_discipline,
            "system.setAllowLive": self._set_allow_live,
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
            "accounts.list": lambda _: {
                "activeId": self._account_id,
                "accounts": self._accounts_payload(),
                "lastError": self._last_error,
            },
            "accounts.create": self._create_account,
            "accounts.update": self._update_account,
            "accounts.delete": self._delete_account,
            "account.switch": self._switch_account,
            "positions.get": lambda _: self._positions,
            "orders.get": lambda _: self._orders,
            "executions.get": self._executions,
            "executions.stats": lambda p: self.store.execution_stats(
                int(p["days"]) if p.get("days") is not None else 30, self._login()
            ),
            "audit.query": lambda p: self.store.audit_query(
                str(p.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")),
                p.get("kind"),
                p.get("text"),
                int(p.get("limit") or 300),
            ),
            "trade.preview": self._preview,
            "trade.size": self._size,
            "order.place": self._place,
            "discipline.start": self._discipline_start,
            "discipline.check": self._discipline_check,
            "discipline.state": self._discipline_state,
            "discipline.reset": self._discipline_reset,
            "order.modify": self._modify_order,
            "order.cancel": self._cancel_order,
            "position.modify": self._modify_position,
            "position.breakeven": self._breakeven,
            "position.trailing.set": self._set_trailing,
            "position.trailing.clear": self._clear_trailing,
            "position.close": self._close_position,
            "position.closeAll": self._close_all,
            "journal.list": self._journal_list,
            "journal.get": self._journal_get,
            "journal.stats": lambda p: self._journal.stats(
                int(p.get("days") if p.get("days") is not None else 30),
                self._login(),
                int(self._server_offset or 0),
                self._journal_filters(p),
            ),
            "journal.tag": self._journal_tag,
            "journal.sync": lambda _: {
                "written": self._journal.sync(
                    self._login(), force=True, server_offset=self._server_offset_value()
                )
            },
            "journal.screenshot.save": self._journal_shot,
            "score.get": lambda p: self._review_call(
                lambda: self._score.get(p, self._login(), self._server_offset)
            ),
            "review.trades": lambda p: self._review_call(
                lambda: self._review.trades(p, self._login(), self._server_offset)
            ),
            "diary.calendar": lambda p: self._review_call(
                lambda: self._review.calendar(p, self._login(), self._server_offset)
            ),
            "diary.day": lambda p: self._review_call(
                lambda: self._review.day(p, self._login(), self._server_offset)
            ),
            "diary.note.save": lambda p: self._review_call(
                lambda: self._review.note_save(p, self._login())
            ),
            "diary.templates": lambda p: self._review_call(
                lambda: self._review.templates(p, self._login())
            ),
            "diary.template.save": lambda p: self._review_call(
                lambda: self._review.template_save(p, self._login())
            ),
            "diary.template.delete": lambda p: self._review_call(
                lambda: self._review.template_delete(p, self._login())
            ),
            "strategy.list": lambda p: self._review_call(
                lambda: self._review.strategy_list(p, self._login())
            ),
            "strategy.save": lambda p: self._review_call(
                lambda: self._review.strategy_save(p, self._login())
            ),
            "strategy.delete": lambda p: self._review_call(
                lambda: self._review.strategy_delete(p, self._login())
            ),
            "strategy.tradeNote": lambda p: self._review_call(
                lambda: self._review.trade_note(p, self._login())
            ),
            "strategy.tradeNote.save": lambda p: self._review_call(
                lambda: self._review.trade_note_save(p, self._login())
            ),
            "strategy.tradeNote.reviewed": lambda p: self._review_call(
                lambda: self._review.trade_note_reviewed(p, self._login())
            ),
            "strategy.check": lambda p: self._review_call(
                lambda: self._review.check(p, self._login())
            ),
            "strategy.adherence": lambda p: self._review_call(
                lambda: self._review.adherence(p, self._login(), self._server_offset)
            ),
            "review.settings": lambda p: self._review_call(
                lambda: self._review.settings(p, self._login())
            ),
            "review.settings.save": lambda p: self._review_call(
                lambda: self._review.settings_save(p, self._login())
            ),
            "routine.list": lambda p: self._routine_call(
                lambda: self._routines.list(p, self._login())
            ),
            "routine.seed": lambda p: self._routine_call(
                lambda: self._routines.seed(p, self._login())
            ),
            "routine.day": lambda p: self._routine_call(
                lambda: self._routines.day(p, self._login())
            ),
            "routine.save": lambda p: self._routine_call(
                lambda: self._routines.save(p, self._login())
            ),
            "routine.delete": lambda p: self._routine_call(
                lambda: self._routines.delete(p, self._login())
            ),
            "routine.toggle": lambda p: self._routine_call(
                lambda: self._routines.toggle(p, self._login())
            ),
            "routine.heatmap": lambda p: self._routine_call(
                lambda: self._routines.heatmap(p, self._login())
            ),
            "missed.list": lambda p: self._missed_call(
                lambda: self._missed.list(p, self._login())
            ),
            "missed.save": lambda p: self._missed_call(
                lambda: self._missed.save(p, self._login())
            ),
            "missed.delete": lambda p: self._missed_call(
                lambda: self._missed.delete(p, self._login())
            ),
            "missed.simulate": lambda p: self._missed_call(
                lambda: self._missed.simulate(p, self._login(), self._missed_bars)
            ),
            "replay.list": self._replay_list,
            "replay.save": self._replay_save,
            "replay.delete": self._replay_delete,
            "ai.status": lambda _: self._ai_call(lambda: self._ai.status()),
            "ai.payload": lambda p: self._ai_call(
                lambda: self._ai.preview(p, self._login(), self._server_offset)
            ),
            "ai.settings.save": lambda p: self._ai_call(
                lambda: self._ai.settings_save(p)
            ),
            "ai.review": lambda p: self._ai_call(
                lambda: self._ai.review(p, self._login(), self._server_offset)
            ),
            "ai.cache.clear": lambda p: self._ai_call(
                lambda: self._ai.cache_clear(p, self._login(), self._server_offset)
            ),
            "calendar.week": lambda _: week_payload(),
            "data.export": self._data_export,
            "data.info": lambda _: {
                "dir": str(self.store.base_dir),
                "exports": str(self.store.base_dir / "exports"),
                "backups": str(self.store.base_dir / "backups"),
            },
            "data.backup.create": self._data_backup,
            "data.backup.list": lambda _: exporter.list_backups(self.store.base_dir),
            "alerts.list": lambda _: self.store.alerts_list(self._login()),
            "alerts.create": self._alert_create,
            "alerts.update": self._alert_update,
            "alerts.delete": self._alert_delete,
            "alerts.test": self._alert_test,
            "watchlist.get": self._watchlist,
            "watchlist.set": self._watchlist_set,
            "intents.list": lambda p: self.store.recent_intents(
                int(p.get("limit") or 50), self._login()
            ),
            "audit.tail": lambda p: self.store.audit_tail(int(p.get("limit") or 50)),
            "diagnostics.get": self._diagnostics,
        }
        handler = handlers.get(method)
        if handler is None:
            raise GatewayError("UNKNOWN_METHOD", f"未知方法: {method}")
        return handler(p)

    def _review_call(self, thunk: Callable[[], Any]) -> Any:
        """复盘层的校验错误转成统一的 GatewayError。"""
        try:
            return thunk()
        except ReviewError as exc:
            raise GatewayError(exc.code, exc.message) from exc

    def _routine_call(self, thunk: Callable[[], Any]) -> Any:
        try:
            return thunk()
        except RoutineError as exc:
            raise GatewayError(exc.code, exc.message) from exc

    def _missed_call(self, thunk: Callable[[], Any]) -> Any:
        try:
            return thunk()
        except MissedError as exc:
            raise GatewayError(exc.code, exc.message) from exc

    def _ai_call(self, thunk: Callable[[], Any]) -> Any:
        try:
            return thunk()
        except AIError as exc:
            raise GatewayError(exc.code, exc.message) from exc


    # ---------- system ----------





    # ---------- 风控状态 ----------








    # ---------- 交易日志 ----------




    # ---------- 导出 / 备份 ----------



    # ---------- 告警 ----------






    # ---------- 自选表 ----------




    # ---------- symbols ----------





    # ---------- market data ----------












    # ---------- account / positions / orders ----------









    # ---------- trade analysis ----------




    # ---------- trade execution ----------
































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
        login = self._login()
        for intent in self.store.recent_intents(50, login):
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
                    login=login,
                )
                stats["found"] += 1
                self.store.audit("reconcile.found", {"clientId": cid, "ticket": found.get("ticket")})
            else:
                self.store.update_intent(
                    cid,
                    "not_found",
                    error="重启后未在挂单/持仓/成交中找到",
                    login=login,
                )
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
