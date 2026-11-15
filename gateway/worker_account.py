from __future__ import annotations

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401


class WorkerAccount:
    def _accounts_payload(self) -> list[dict]:
        active = self._account_id
        out: list[dict] = []
        for profile in self.cfg.account_profiles():
            is_active = profile["id"] == active
            connected = is_active and self._connected
            login = int(profile["login"])
            server = profile["server"]
            if is_active and self._account:
                login = int(self._account.get("login") or login)
                server = str(self._account.get("server") or server)
            item = {
                "id": profile["id"],
                "label": profile["label"],
                "login": login,
                "server": server,
                "terminalPath": profile["terminal_path"],
                "active": is_active,
                "connected": connected,
                "hasPassword": self._account_mgr.has_password(profile["id"]),
                "configured": bool(self.cfg.configured_accounts()),
            }
            discipline = profile.get("discipline") or {}
            if discipline:
                item["discipline"] = dict(discipline)
            out.append(item)
        return out

    def _try_connect(self, force_login: bool = False) -> None:
        if force_login:
            self._connect_blocked = False
            self._auth_failures = 0
        elif self._connect_blocked:
            return
        try:
            mt5.shutdown()
            profile = self._profile()
            self._account_id = profile["id"]
            path = str(profile.get("terminal_path") or "")
            expected = int(profile.get("login") or 0)
            kwargs: dict[str, Any] = {}
            if path:
                kwargs["path"] = path
            if not mt5.initialize(**kwargs):
                code, msg = mt5.last_error()
                self._last_error = {
                    "code": int(code),
                    "message": f"账户「{profile['label']}」连接失败：{msg}",
                }
                return

            try:
                password = self._account_mgr.password(profile["id"])
            except AccountError as exc:
                self._connect_blocked = True
                self._last_error = {"code": "CREDENTIAL_STORE", "message": str(exc)}
                mt5.shutdown()
                self._emit("gateway", self.health())
                return

            account = mt5.account_info()
            needs_login = (
                force_login
                or account is None
                or bool(expected and int(account.login) != expected)
            )
            if needs_login and password:
                if expected <= 0:
                    self._connect_blocked = True
                    self._last_error = {
                        "code": "AUTH_CONFIG",
                        "message": f"账户「{profile['label']}」未配置登录号，无法自动登录",
                    }
                    mt5.shutdown()
                    self._emit("gateway", self.health())
                    return
                try:
                    logged_in = mt5.login(
                        expected,
                        password=password,
                        server=str(profile.get("server") or ""),
                    )
                    code, msg = (0, "") if logged_in else mt5.last_error()
                except Exception as exc:  # noqa: BLE001 - 登录异常也按认证失败处理
                    logged_in = False
                    code, msg = -1, f"{type(exc).__name__}: {exc}"
                if not logged_in:
                    self._auth_failures += 1
                    # 给终端刚启动/网络抖动留两次重试，连续失败后再停下等用户改密码
                    if self._auth_failures >= 3:
                        self._connect_blocked = True
                    self._last_error = {
                        "code": "AUTH_FAILED",
                        "message": (
                            f"账户「{profile['label']}」自动登录失败：{msg}（错误 {code}）。"
                            "请检查登录号、服务器和密码。"
                        ),
                    }
                    self._connected = False
                    mt5.shutdown()
                    try:
                        self.store.audit(
                            "account.login_failed",
                            {
                                "accountId": profile["id"],
                                "login": expected,
                                "attempt": self._auth_failures,
                                "error": int(code),
                            },
                        )
                    except Exception:  # noqa: BLE001 - 审计失败不影响重试
                        pass
                    self._emit("gateway", self.health())
                    return
                account = mt5.account_info()

            terminal = mt5.terminal_info()
            if terminal is None or account is None:
                self._last_error = {
                    "code": "NOT_LOGGED_IN",
                    "message": (
                        "终端已启动但账户未登录；请在设置里为该账户保存密码，"
                        "或在 MT5 终端里手动登录"
                    ),
                }
                mt5.shutdown()
                return
            if expected and int(account.login) != expected:
                self._last_error = {
                    "code": "ACCOUNT_MISMATCH",
                    "message": (
                        f"账户「{profile['label']}」期望登录 {expected}，实际是 {account.login}；"
                        "请检查登录号、服务器、密码和终端路径"
                    ),
                }
                mt5.shutdown()
                return
            login = int(account.login)
            try:
                # 旧库没有账户维度，第一次连上真实账户时把历史数据归到该账户
                self.store.migrate_legacy(login)
            except Exception:  # noqa: BLE001 - 迁移失败不影响交易
                pass
            self._connected = True
            self._connect_blocked = False
            self._auth_failures = 0
            self._last_error = None
            self._account = self._account_payload(account)
            self._sync_server_time()
            if not self._state_loaded:
                self._state_loaded = True
                self._halted = self.store.get_state("halted", login)
                stored = self.store.get_state("trailing", login) or {}
                try:
                    self._trailing = {int(k): v for k, v in stored.items()}
                except (TypeError, ValueError):
                    self._trailing = {}
                auto_be = self.store.get_state("autoBreakeven", login) or {}
                self._auto_be = self._restore_auto_be(auto_be)
                pending = self.store.get_state("pendingTemplatePlans", login) or {}
                self._pending_plans = self._restore_pending_plans(pending)
                self._auto_be_pause_reason = ""
            self._poll_trade_state()
            self._poll_account()
            self._reconcile()
            self._poll_risk(force=True)
            self._alerts = self.store.alerts_list(login)
            self._notifier.start()
            try:
                self._journal.sync(
                    login, force=True, server_offset=self._server_offset_value()
                )
            except Exception:  # noqa: BLE001 - 日志同步失败不影响交易
                pass
            self._emit("gateway", self.health())
            self.store.audit(
                "gateway.connected", {"login": login, "accountId": profile["id"]}
            )
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._last_error = {"code": -1, "message": f"{type(exc).__name__}: {exc}"}

    def _refresh_limits(self) -> None:
        """重新计算当前账户的生效风控（全局默认被账户覆盖改写）。"""
        self._limits = self.cfg.risk_limits(self._account_id)

    def _reset_for_switch(self) -> None:
        """断开当前终端并清空账户相关内容，随后由 _try_connect 重新连到目标终端。"""
        self._refresh_limits()
        try:
            mt5.shutdown()
        except Exception:  # noqa: BLE001
            pass
        self._connected = False
        self._connect_blocked = False
        self._auth_failures = 0
        self._account = None
        self._positions = []
        self._orders = []
        self._risk = None
        self._last_error = None
        self._halted = None
        self._trailing = {}
        self._trail_next = {}
        self._auto_be = {}
        self._pending_plans = {}
        self._auto_be_pause_reason = ""
        self._alerts = []
        self._alert_last = {}
        self._watch_day = {}
        self._subs.clear()
        self._bar_subs.clear()
        self._risk_tracked = {}
        self._server_offset = 0
        # 换账户后默认回到只读，避免把上一个账户的交易模式带过去
        self._trade_mode = "readonly"
        self._state_loaded = False
        self._emit("positions", [])
        self._emit("orders", [])
        self._emit("gateway", self.health())

    def _switch_account(self, p: dict) -> dict:
        target = str(p.get("id") or "").strip()
        profile = next(
            (item for item in self.cfg.account_profiles() if item["id"] == target), None
        )
        if profile is None:
            raise GatewayError("BAD_ACCOUNT", f"未知账户: {target}")
        if self._positions and not bool(p.get("force")):
            raise GatewayError(
                "HAS_POSITIONS",
                f"当前账户还有 {len(self._positions)} 个持仓，切换后移动止损和自动保本将停止管理",
                {"positions": len(self._positions)},
            )
        if profile["id"] == self._account_id and self._connected:
            return {
                "activeId": self._account_id,
                "account": self._account,
                "accounts": self._accounts_payload(),
                "health": self.health(),
            }

        try:
            self.cfg.set_active_account(profile["id"])
        except (ValueError, OSError) as exc:
            raise GatewayError("CONFIG_SAVE", f"保存账户选择失败：{exc}") from exc

        previous = self._account_id
        self._account_id = profile["id"]
        # 不同券商服务器时区可能不同，切账户后重新推算
        self._server_offset = 0
        self._server_offset_known = False
        self._offset_checked_at = 0.0
        self.store.audit(
            "account.switch",
            {
                "from": previous,
                "to": profile["id"],
                "label": profile["label"],
                "login": profile["login"],
            },
        )
        self._reset_for_switch()
        self._try_connect()
        if not self._connected:
            message = str((self._last_error or {}).get("message") or "未知错误")
            raise GatewayError(
                "ACCOUNT_SWITCH_FAILED", f"已切换账户配置，但连接失败：{message}"
            )
        self._emit("gateway", self.health())
        return {
            "activeId": self._account_id,
            "account": self._account,
            "accounts": self._accounts_payload(),
            "health": self.health(),
        }

    def _account_hint(self) -> dict:
        return {
            "login": self._login(),
            "server": str((self._account or {}).get("server") or ""),
            "terminalPath": str(self._profile().get("terminal_path") or ""),
        }

    def _accounts_result(self) -> dict:
        return {
            "activeId": self._account_id,
            "accounts": self._accounts_payload(),
            "health": self.health(),
        }

    def _create_account(self, p: dict) -> dict:
        try:
            created = self._account_mgr.create(p, self._account_hint())
        except AccountError as exc:
            raise GatewayError("BAD_ACCOUNT", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存账户失败：{exc}") from exc

        self._account_id = self.cfg.active_profile()["id"]
        self._refresh_limits()
        self.store.audit(
            "account.create",
            {
                "id": created["id"],
                "activeId": self._account_id,
                "seeded": bool(created.get("seeded")),
            },
        )
        self._emit("gateway", self.health())
        return self._accounts_result()

    def _update_account(self, p: dict) -> dict:
        try:
            updated = self._account_mgr.update(p)
        except AccountError as exc:
            raise GatewayError("BAD_ACCOUNT", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存账户失败：{exc}") from exc

        self._account_id = self.cfg.active_profile()["id"]
        self._refresh_limits()
        reconnected = self._account_id == updated["id"] and (
            bool(updated.get("connectionChanged")) or bool(updated.get("passwordChanged"))
        )
        self.store.audit(
            "account.update",
            {
                "id": updated["id"],
                "connectionChanged": bool(updated.get("connectionChanged")),
                "passwordChanged": bool(updated.get("passwordChanged")),
            },
        )

        if reconnected:
            self._reset_for_switch()
            self._try_connect(force_login=True)
            message = str((self._last_error or {}).get("message") or "")
            if not self._connected:
                raise GatewayError(
                    "ACCOUNT_RECONNECT_FAILED",
                    f"账户已保存，但自动登录失败：{message or '未知错误'}",
                    {"health": self.health()},
                )
            self._emit("gateway", self.health())
        else:
            self._emit("gateway", self.health())
        return self._accounts_result()

    def _delete_account(self, p: dict) -> dict:
        try:
            deleted = self._account_mgr.delete(str(p.get("id") or ""))
        except AccountError as exc:
            raise GatewayError("BAD_ACCOUNT", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"删除账户失败：{exc}") from exc

        self.store.audit("account.delete", {"id": deleted["id"]})
        self._emit("gateway", self.health())
        return self._accounts_result()

    def _set_config(self, p: dict) -> dict:
        """设置页保存风控字段；立即生效并写回 config.json。"""
        try:
            updated = self.cfg.update(p)
        except ValueError as exc:
            raise GatewayError("BAD_CONFIG", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        self.store.audit("config.update", {"changes": p})
        self._refresh_limits()
        self._poll_risk(force=True)
        self._emit("gateway", self.health())
        return updated

    def _set_account_risk(self, p: dict) -> dict:
        """设置页保存账户级风控覆盖；risk 里值为 None 表示恢复跟随全局。"""
        account_id = str(p.get("id") or self._account_id).strip()
        patch = p.get("risk")
        if not isinstance(patch, dict) or not patch:
            raise GatewayError("BAD_CONFIG", "risk 必须是非空对象，值为 null 表示恢复全局")
        try:
            updated = self.cfg.set_account_risk(account_id, patch)
        except ValueError as exc:
            raise GatewayError("BAD_CONFIG", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        if account_id == self._account_id:
            self._refresh_limits()
            self._poll_risk(force=True)
        self.store.audit("config.account_risk", {"id": account_id, "changes": patch})
        self._emit("gateway", self.health())
        return {
            "config": updated,
            "limits": self._limits,
            "accountRisk": self.cfg.account_risk(self._account_id),
        }

    def _set_account_discipline(self, p: dict) -> dict:
        """设置页保存账户级门禁覆盖；discipline 里值为 null 表示恢复跟随全局。"""
        account_id = str(p.get("id") or self._account_id).strip()
        patch = p.get("discipline")
        if not isinstance(patch, dict) or not patch:
            raise GatewayError(
                "BAD_CONFIG", "discipline 必须是非空对象，值为 null 表示恢复全局"
            )
        try:
            updated = self.cfg.set_account_discipline(account_id, patch)
        except ValueError as exc:
            raise GatewayError("BAD_CONFIG", str(exc)) from exc
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        self.store.audit(
            "config.account_discipline", {"id": account_id, "changes": patch}
        )
        self._emit("gateway", self.health())
        return {
            "config": updated,
            "accounts": self._accounts_payload(),
            "accountDiscipline": self.cfg.account_discipline(self._account_id),
            "disciplineSettings": self.cfg.discipline_settings(self._account_id),
        }

    def _set_allow_live(self, p: dict) -> dict:
        """设置页的实盘开关：写回 config.json，立即生效。"""
        allow = p.get("allow")
        if not isinstance(allow, bool):
            raise GatewayError("BAD_CONFIG", "allow 必须是布尔值")
        try:
            updated = self.cfg.set_allow_live(allow)
        except OSError as exc:
            raise GatewayError("CONFIG_SAVE", f"保存配置失败：{exc}") from exc

        # 关闭实盘时如果正处在实盘模式，立即回到只读
        if not allow and self._trade_mode == "live":
            self._trade_mode = "readonly"
        self.store.audit("config.allow_live", {"allow": allow})
        self._emit("gateway", self.health())
        return {"config": updated, "tradeMode": self._trade_mode}

    def _server_now(self) -> int:
        return int(time.time() + self._server_offset)

    def _day_start(self) -> int:
        now = self._server_now()
        return now - now % 86400

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
        # 周末/停牌/异常 tick 会让差值漂到几十小时，宁可不更新
        if abs(raw) > 14 * 3600:
            return
        # 券商时区都是整小时或半小时，按 15 分钟取整吸收网络延迟
        self._server_offset = int(round(raw / 900.0)) * 900
        self._server_offset_known = True

    def _server_offset_value(self) -> int | None:
        """已知才返回偏移；未知时 None，让下游不要把 0 当成真实时区。"""
        return int(self._server_offset) if getattr(self, "_server_offset_known", False) else None

    def _refresh_server_offset(self) -> None:
        """health 被轮询时顺手校准一次，避免没订阅报价时偏移一直是 0。"""
        now = time.monotonic()
        if now - getattr(self, "_offset_checked_at", 0.0) < 30:
            return
        self._offset_checked_at = now
        if not self._connected:
            return
        symbols = list(getattr(self, "_subs", {}) or {})
        if not symbols:
            symbols = [
                str(item)
                for item in (self.store.get_state("watchlist", self._login()) or [])
            ]
        tick = None
        try:
            for symbol in symbols[:5]:
                tick = mt5.symbol_info_tick(symbol)
                if tick is not None and int(getattr(tick, "time", 0) or 0):
                    break
                tick = None
            if tick is None:
                info_getter = getattr(mt5, "symbols_get", None)
                for info in (info_getter() if callable(info_getter) else None) or ():
                    if not getattr(info, "visible", False):
                        continue
                    tick = mt5.symbol_info_tick(info.name)
                    if tick is not None and int(getattr(tick, "time", 0) or 0):
                        break
                    tick = None
        except Exception:  # noqa: BLE001 - 校准失败不能影响 health
            return
        if tick is None:
            return
        self._note_server_time(tick)

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
