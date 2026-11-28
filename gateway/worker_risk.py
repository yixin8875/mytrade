from __future__ import annotations

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401


class WorkerRisk:
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

    def _compute_risk(self) -> dict:
        """当日盈亏、开仓次数、连亏、冷却和停机状态，全部按券商服务器时间算。"""
        account = self._account or {}
        limits = self._limits
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
            max(0.0, day_start_balance * limits["daily_loss_pct"] / 100.0)
            if limits["daily_loss_pct"] > 0
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
            limits["max_consecutive_losses"]
            and consecutive >= limits["max_consecutive_losses"]
            and closed
        ):
            cooldown_until = int(getattr(closed[-1], "time", 0)) + int(
                limits["cooldown_minutes"] * 60
            )
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
        elif limits["max_trades_per_day"] and len(entries) >= limits["max_trades_per_day"]:
            block_reason = f"今日开仓 {len(entries)} 次已达上限 {limits['max_trades_per_day']}"

        return {
            "dayStartBalance": round(day_start_balance, 2),
            "dayPnl": round(day_pnl, 2),
            "dailyLoss": round(daily_loss, 2),
            "dailyLossLimit": round(limit, 2),
            "remaining": round(remaining, 2),
            "tradesToday": len(entries),
            "maxTrades": int(limits["max_trades_per_day"] or 0),
            "consecutiveLosses": consecutive,
            "maxConsecutiveLosses": int(limits["max_consecutive_losses"] or 0),
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
        self.store.set_state("halted", self._halted, self._login())
        self.store.audit("system.halt", {"reason": reason, "closeAll": close_all})
        closed: list[dict] = []
        cancelled: list[dict] = []
        if close_all:
            # 停机必须连挂单一起撤：只平仓的话，券商侧挂单仍可能成交，
            # 等于绕过了「禁止再开仓」。
            try:
                result = self._flatten({})
                closed = result.get("closed", [])
                cancelled = result.get("cancelled", [])
            except GatewayError as exc:
                closed = [{"error": exc.message}]
        self._poll_risk(force=True)
        self._emit("gateway", self.health())
        return {
            "halted": True,
            "reason": reason,
            "closed": closed,
            "cancelled": cancelled,
        }

    def _resume(self, p: dict) -> dict:
        self._halted = None
        self.store.set_state("halted", None, self._login())
        self.store.audit("system.resume", {})
        self._poll_risk(force=True)
        self._emit("gateway", self.health())
        return {"halted": False}

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
        self._capture_position_risks(positions)

    def _risk_for(
        self, symbol: str, side: str, volume: float, entry: float, sl: float
    ) -> float | None:
        """按开仓价与止损价折算初始风险（账户货币的绝对值）。"""
        if entry <= 0 or sl <= 0 or volume <= 0:
            return None
        base = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        try:
            value = mt5.order_calc_profit(base, symbol, volume, entry, sl)
        except Exception:  # noqa: BLE001
            return None
        if value is None:
            return None
        risk = abs(float(value))
        return risk if math.isfinite(risk) and risk > 0 else None

    def _capture_position_risks(self, positions: Any) -> None:
        """持仓一旦带上止损就把初始风险落库，之后统计 R 不再依赖下单意图。

        手动在终端开的单、先开仓后补止损的单也能被覆盖。
        """
        login = self._login()
        if login <= 0:
            return
        for position in positions or []:
            ticket = int(position.ticket)
            sl = float(position.sl or 0)
            if sl <= 0 or ticket in self._risk_tracked:
                continue
            side = "buy" if int(position.type) == 0 else "sell"
            risk = self._risk_for(
                str(position.symbol), side, float(position.volume), float(position.price_open), sl
            )
            if risk is None:
                continue
            self.store.record_position_risk(
                {
                    "login": login,
                    "position_id": ticket,
                    "symbol": str(position.symbol),
                    "side": side,
                    "volume": float(position.volume),
                    "entry": float(position.price_open),
                    "sl": sl,
                    "risk": risk,
                    "source": "position",
                }
            )
            self._risk_tracked[ticket] = sl

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
        # test_price 对多头是向下、对空头是向上，斜率的分母要跟着方向取符号，
        # 否则多头算出的强平价会跑到入场价上方被当成无效值丢掉。
        move = -delta if buy else delta
        slope = (float(p_test) - float(p_entry)) / move
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
            # 分批止盈计划随持仓一起下发，图上的拖拽线和面板都由它驱动
            "plan": self._position_plan(int(p.ticket)),
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

    def _auto_move_breakeven(
        self, ticket: int, plan: dict, position: dict, info: Any, tick: Any
    ) -> float | None:
        """把止损移到开仓价；已在保本或更好、或保本放不下时返回 None。

        position 是 `_position_payload` 的 dict（openPrice/sl/tp），不是 MT5 的
        TradePosition 对象；早期版本按对象取属性，导致所有移保本阶段抛 AttributeError。
        """
        point = float(info.point)
        buy = str(plan.get("side")) == "buy"
        entry = float(plan.get("entry") or position.get("openPrice") or 0)
        stops = max(
            int(getattr(info, "trade_stops_level", 0) or 0),
            int(getattr(info, "trade_freeze_level", 0) or 0),
        )
        min_dist = (max(stops, 1) + 5) * point
        offset = self._plan_offset_points(plan.get("breakevenOffsetPoints")) * point
        price = float(tick.bid if buy else tick.ask)
        target = align_price(entry + offset if buy else entry - offset, info)
        # 开仓价还不在现价有利一侧、或留不出最小止损距离：保持原止损，
        # 不能像旧版那样把它压到现价旁边，否则一次正常回撤就会打掉剩余仓位。
        if buy and target > price - min_dist:
            return None
        if not buy and target < price + min_dist:
            return None
        current_sl = float(position.get("sl") or 0)
        if current_sl:
            if buy and current_sl >= target - point / 2:
                return None
            if not buy and current_sl <= target + point / 2:
                return None
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": position["symbol"],
            "position": ticket,
            "sl": target,
            "tp": float(position.get("tp") or 0),
            "magic": self.cfg.magic,
        }
        self._result_or_raise(mt5.order_send(request), "position.template_step.breakeven")
        return target

    def _template_pause_reason(self) -> str:
        """只读或停机时暂停模板阶段：保护性动作也不发单，恢复可交易后继续。"""
        if str(self._trade_mode or "").lower() == "readonly":
            return "readonly"
        if self._halted:
            return "halted"
        return ""

    def _auto_breakeven(self) -> None:
        """模板开仓的分批止盈 / 保本：每轮最多推进一步，失败 3 秒后重试。"""
        if not self._connected:
            return
        self._adopt_pending_template_plans()
        if not self._auto_be:
            return
        changed = False
        # 暂停期间也要清掉已不存在的持仓，避免状态越积越多
        for ticket in list(self._auto_be):
            if not any(item["ticket"] == ticket for item in self._positions):
                self._auto_be.pop(ticket, None)
                changed = True
        reason = self._template_pause_reason()
        if reason:
            if reason != self._auto_be_pause_reason:
                self._auto_be_pause_reason = reason
                self.store.audit(
                    "position.template_plan.paused",
                    {
                        "reason": reason,
                        "tradeMode": self._trade_mode,
                        "halted": bool(self._halted),
                        "plans": len(self._auto_be),
                    },
                )
            if changed:
                self._save_auto_be()
            return
        if self._auto_be_pause_reason:
            self.store.audit(
                "position.template_plan.resumed",
                {"plans": len(self._auto_be)},
            )
            self._auto_be_pause_reason = ""
            changed = True
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
            buy = str(plan.get("side")) == "buy"
            price = float(tick.bid if buy else tick.ask)
            # 按触发价排序后再取第一档：手动计划的数组顺序不代表执行顺序
            steps = self._sort_plan_steps(self._plan_steps(plan), plan)
            step = next(
                (item for item in steps if not item.get("done") and not item.get("skipped")),
                None,
            )
            if step is None:
                # 全部走完也保留计划：面板要显示历史，持仓消失时上面才清理
                continue
            trigger = self._step_trigger(step, plan)
            if trigger is None:
                # 旧模板算不出触发价（例如 risk=0），留着只会每轮空转
                self._auto_be.pop(ticket, None)
                changed = True
                continue
            tp = float(position.get("tp") or 0)
            half = self._plan_tick(info) / 2 or 1e-9
            if tp > 0 and (trigger >= tp - half if buy else trigger <= tp + half):
                # 最终止盈被拖到某一档之前：这一档永远轮不到，等用户调整，不执行也不报错
                continue
            if (buy and price < trigger) or (not buy and price > trigger):
                continue
            at_r = self._step_at_r(trigger, plan)
            if at_r is None:
                at_r = float(step.get("atR") or 0)
            step_id = str(step.get("id") or "step")
            # 备注带档位 id：发单成功但响应丢失时，下一轮靠它查到已成交，避免重复平仓
            comment = f"plan-{step_id}"[:31]
            percent = step.get("closePercent")
            moved = None
            closed = None
            recovered = False
            try:
                if self._step_filled(ticket, comment):
                    recovered = True
                    self.store.audit(
                        "position.plan.step.recovered",
                        {"ticket": ticket, "stepId": step_id, "comment": comment},
                    )
                else:
                    # 先移止损再分批：移保本是幂等的（已到保本就返回 None），
                    # 这样即使平仓失败重试，也不会把同一阶段平两次。
                    moved = (
                        self._auto_move_breakeven(ticket, plan, position, info, tick)
                        if step.get("moveBreakeven")
                        else None
                    )
                    if percent is not None:
                        closed = self._auto_partial_close(ticket, percent, comment, plan)
            except Exception as exc:  # noqa: BLE001 - 单条计划失败不能中断整轮轮询
                plan["next"] = time.monotonic() + 3.0
                self.store.audit(
                    "position.template_step.failed",
                    {
                        "ticket": ticket,
                        "stepId": step_id,
                        "atR": at_r,
                        "error": str(exc),
                        "type": type(exc).__name__,
                    },
                )
                continue
            step["done"] = True
            # 有比例却平不出来 = 仓位拆不开；只移保本的档位不算跳过
            skipped = percent is not None and closed is None and not recovered
            step["skipped"] = skipped
            changed = True
            source = str(plan.get("source") or "template")
            # 勾了移保本却没动止损：多半是还没回本或离现价太近（保本放不下）
            breakeven_skipped = bool(step.get("moveBreakeven")) and not recovered and moved is None
            self.store.audit(
                "position.plan.step",
                {
                    "ticket": ticket,
                    "stepId": step_id,
                    "price": trigger,
                    "atR": at_r,
                    "closedVolume": closed,
                    "breakeven": moved,
                    "breakevenSkipped": breakeven_skipped,
                    "skipped": skipped,
                    "recovered": recovered,
                    "source": source,
                },
            )
            if source == "template":
                # 旧审计名保留：历史日志仍按模板阶段读取
                self.store.audit(
                    "position.template_step",
                    {
                        "ticket": ticket,
                        "atR": at_r,
                        "closedVolume": closed,
                        "breakeven": moved,
                    },
                )
            if closed is not None or skipped:
                self._emit(
                    "templateStep",
                    {
                        "ticket": ticket,
                        "symbol": position["symbol"],
                        "stepId": step_id,
                        "price": trigger,
                        "atR": at_r,
                        "volume": closed or 0.0,
                        "skipped": skipped,
                        "source": source,
                    },
                )
            if moved is not None:
                self._emit(
                    "autoBreakeven",
                    {
                        "ticket": ticket,
                        "sl": moved,
                        "symbol": position["symbol"],
                        "r": at_r,
                    },
                )
            self._poll_trade_state()
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
