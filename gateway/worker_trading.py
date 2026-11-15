from __future__ import annotations

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401


def _check_stops(side: str, ref: float, sl: float, tp: float, info: Any, label: str) -> None:
    """改单时先按方向/最小距离校验；0 表示清除该价位，不参与校验。"""
    stops = float(getattr(info, "trade_stops_level", 0) or 0) * float(
        getattr(info, "point", 0) or 0
    )
    if sl > 0:
        if side == "buy" and sl >= ref:
            raise GatewayError("BAD_STOPS", f"{label}止损必须低于入场价")
        if side == "sell" and sl <= ref:
            raise GatewayError("BAD_STOPS", f"{label}止损必须高于入场价")
        if stops > 0 and abs(ref - sl) < stops:
            raise GatewayError(
                "STOPS_LEVEL",
                f"止损距离小于券商最小 {info.trade_stops_level} 点（{stops:.{info.digits}f}）",
            )
    if tp > 0:
        if side == "buy" and tp <= ref:
            raise GatewayError("BAD_STOPS", f"{label}止盈必须高于入场价")
        if side == "sell" and tp >= ref:
            raise GatewayError("BAD_STOPS", f"{label}止盈必须低于入场价")
        if stops > 0 and abs(ref - tp) < stops:
            raise GatewayError(
                "STOPS_LEVEL",
                f"止盈距离小于券商最小 {info.trade_stops_level} 点（{stops:.{info.digits}f}）",
            )


class WorkerTrading:
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
            if risk_pct > self._limits["max_risk_pct"]:
                warnings.append(f"风险 {risk_pct:.2f}% 超过上限 {self._limits['max_risk_pct']}%")
        if (
            self._limits["max_spread_points"]
            and a["spreadPoints"] > self._limits["max_spread_points"]
        ):
            warnings.append(f"点差 {a['spreadPoints']:.0f} 点超过上限 {self._limits['max_spread_points']}")
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
        vmax = min(float(info.volume_max), float(self._limits["max_lot"]))
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
        if risk is not None and equity > 0 and risk / equity * 100 > self._limits["max_risk_pct"]:
            warnings.append(
                f"风险 {risk / equity * 100:.2f}% 超过上限 {self._limits['max_risk_pct']}%"
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

    def _place(self, p: dict) -> dict:
        account = self._guard_trade()
        login = self._login()
        a = self._analyze(p)
        client_id = str(p.get("clientOrderId") or f"mt-{int(time.time() * 1000)}")[:31]

        if a["volume"] > self._limits["max_lot"]:
            raise GatewayError(
                "MAX_LOT", f"单笔手数 {a['volume']} 超过上限 {self._limits['max_lot']}"
            )
        if (
            self._limits["max_spread_points"]
            and a["spreadPoints"] > self._limits["max_spread_points"]
        ):
            raise GatewayError("SPREAD_LIMIT", f"点差 {a['spreadPoints']:.0f} 点超过上限")
        if len(self._positions) >= self._limits["max_positions"]:
            raise GatewayError("MAX_POSITIONS", f"持仓数已达上限 {self._limits['max_positions']}")
        if a["riskAmount"] is not None and a["equity"] > 0:
            risk_pct = a["riskAmount"] / a["equity"] * 100
            if risk_pct > self._limits["max_risk_pct"]:
                raise GatewayError(
                    "RISK_LIMIT",
                    f"本单风险 {risk_pct:.2f}% 超过上限 {self._limits['max_risk_pct']}%",
                )
        risk = self._risk or self._compute_risk()
        self._risk = risk
        if risk.get("blockReason"):
            raise GatewayError("RISK_BLOCK", str(risk["blockReason"]))
        if a["freeMargin"] and a["margin"] > a["freeMargin"] * 0.9:
            raise GatewayError("NO_MARGIN", "保证金占用过高，拒绝下单")
        if self.store.recent_duplicate(a["symbol"], a["side"], a["price"], login=login):
            raise GatewayError("DUPLICATE", "3 秒内已提交相同方向/价格的订单")

        existing = self.store.get_intent(client_id, login)
        if existing and existing["state"] in ("sending", "accepted", "working", "filled"):
            return {
                "clientOrderId": client_id,
                "state": existing["state"],
                "ticket": existing["ticket"],
            }

        # 开仓纪律门禁：放在只读/风控/重复单检查之后，避免被拒绝时先弹清单；
        # 平仓、改单、保本、移动止损等方法不会走到这里。
        self._discipline_gate(
            login,
            client_id,
            p.get("discipline") if isinstance(p.get("discipline"), dict) else {},
        )

        self.store.save_intent(
            {
                "client_id": client_id,
                "login": login,
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
            self.store.update_intent(
                client_id, "unknown", error=f"{type(exc).__name__}: {exc}", login=login
            )
            self.store.audit("order.place.exception", {"clientId": client_id, "error": str(exc)})
            self._record_execution(client_id, 0, a, 0, latency, "unknown", f"{type(exc).__name__}: {exc}")
            raise GatewayError("SEND_FAILED", f"下单异常: {exc}") from exc

        latency = int((time.perf_counter() - started) * 1000)
        if result is None:
            self.store.update_intent(
                client_id, "unknown", error=str(mt5.last_error()), login=login
            )
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
            self.store.update_intent(
                client_id, "rejected", error=f"{retcode}: {message}", login=login
            )
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
        self.store.update_intent(
            client_id, state, ticket=payload["order"] or None, login=login
        )
        ticket = int(payload["order"] or 0)
        self._record_execution(
            client_id, ticket, a, payload["price"], latency, state, None, retcode
        )
        if state == "filled":
            # 市价单的持仓号可能与 order ticket 不同（netting 合并），优先用补齐后的 ticket
            position_ticket = int(payload.get("ticket") or ticket or 0)
            if position_ticket:
                self._discipline_link(login, client_id, position_ticket)
        if state == "filled" and ticket and a["sl"]:
            entry = float(payload["price"] or a["price"])
            risk = self._risk_for(a["symbol"], a["side"], a["volume"], entry, float(a["sl"]))
            if risk is not None:
                self.store.record_position_risk(
                    {
                        "login": login,
                        "position_id": ticket,
                        "symbol": a["symbol"],
                        "side": a["side"],
                        "volume": a["volume"],
                        "entry": entry,
                        "sl": float(a["sl"]),
                        "risk": risk,
                        "source": "order",
                    }
                )
                self._risk_tracked[ticket] = float(a["sl"])
        plan = p.get("plan") if isinstance(p.get("plan"), dict) else {}
        steps = self._normalize_plan_steps(plan.get("steps"))
        if not steps and p.get("autoBreakeven"):
            # 旧客户端只发 autoBreakeven / autoBreakevenR，按单条「移保本」阶段处理
            try:
                be_r = float(p.get("autoBreakevenR") or 1)
            except (TypeError, ValueError):
                be_r = 1.0
            if be_r > 0:
                steps = [
                    {
                        "atR": be_r,
                        "closePercent": None,
                        "moveBreakeven": True,
                        "done": False,
                    }
                ]
        if a["action"] == mt5.TRADE_ACTION_DEAL and a["sl"] and steps:
            # 市价单的 order ticket 不一定等于持仓 ticket（netting 下会被合并），
            # _enrich_place_payload 已经按 comment 找到了真正成交的持仓
            position_ticket = int(payload.get("ticket") or ticket or 0)
            if position_ticket:
                if ticket and position_ticket != ticket:
                    self.store.audit(
                        "position.template_plan.ticket_replaced",
                        {"order": ticket, "position": position_ticket},
                    )
                entry = float(payload["price"] or a["price"])
                risk = abs(entry - float(a["sl"]))
                if risk > 0:
                    self._auto_be[position_ticket] = {
                        "entry": entry,
                        "risk": risk,
                        "side": a["side"],
                        "steps": steps,
                        "next": 0.0,
                        "templateId": str(plan.get("templateId") or "")[:40] or None,
                        "templateName": str(plan.get("templateName") or "")[:40] or None,
                    }
                    self._save_auto_be()
                    self.store.audit(
                        "position.template_plan.set",
                        {
                            "ticket": position_ticket,
                            "order": ticket,
                            "entry": entry,
                            "steps": steps,
                            "source": "market",
                            "templateId": plan.get("templateId"),
                            "templateName": plan.get("templateName"),
                        },
                    )
        elif a["action"] == mt5.TRADE_ACTION_PENDING and ticket and steps:
            self._remember_pending_plan(ticket, client_id, a, steps, plan)
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
                    "login": self._login(),
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
        # 传 0 = 清除该价位；不传才保留原值
        sl = align_price(_num(p.get("sl")), info) if p.get("sl") is not None else float(order.sl)
        tp = align_price(_num(p.get("tp")), info) if p.get("tp") is not None else float(order.tp)
        side = "buy" if int(order.type) % 2 == 0 else "sell"
        _check_stops(side, float(order.price_open), sl, tp, info, "挂单")
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
        if comment and self.store.get_intent(comment, self._login()):
            self.store.update_intent(comment, "cancelled", login=self._login())
        if self._pending_plans.pop(ticket, None) is not None:
            self._save_pending_plans()
            self.store.audit(
                "order.template_plan.dropped", {"ticket": ticket, "reason": "cancelled"}
            )
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
        side = "buy" if int(position.type) == 0 else "sell"
        # 方向校验用当前可平仓价：买单按 bid、卖单按 ask；拿不到报价时退回开仓价
        tick = mt5.symbol_info_tick(position.symbol)
        ref = float(position.price_open)
        if tick is not None:
            ref = float(tick.bid if side == "buy" else tick.ask)
        _check_stops(side, ref, sl, tp, info, "持仓")
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
        # 原本没有止损、这次才补上的，按补止损时的价格记录初始风险
        if (
            sl > 0
            and float(position.sl or 0) <= 0
            and ticket not in self._risk_tracked
        ):
            side = "buy" if int(position.type) == 0 else "sell"
            risk = self._risk_for(
                position.symbol, side, float(position.volume), float(position.price_open), sl
            )
            if risk is not None:
                self.store.record_position_risk(
                    {
                        "login": self._login(),
                        "position_id": ticket,
                        "symbol": position.symbol,
                        "side": side,
                        "volume": float(position.volume),
                        "entry": float(position.price_open),
                        "sl": sl,
                        "risk": risk,
                        "source": "position",
                    }
                )
                self._risk_tracked[ticket] = sl
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
        self.store.set_state(
            "trailing", {str(k): v for k, v in self._trailing.items()}, self._login()
        )

    def _remember_pending_plan(
        self, ticket: int, client_id: str, a: dict, steps: list[dict], plan: dict
    ) -> None:
        """挂单带上模板计划：成交后由 _adopt_pending_template_plans 接手。"""
        if not a["sl"]:
            # 没有止损就算不出 R，阶段无从触发；只审计，不影响下单
            self.store.audit(
                "order.template_plan.skipped",
                {"ticket": ticket, "reason": "no-sl", "symbol": a["symbol"]},
            )
            return
        self._pending_plans[ticket] = {
            "clientId": client_id,
            "symbol": a["symbol"],
            "side": a["side"],
            "sl": float(a["sl"]),
            "steps": steps,
            "placedAt": time.time(),
            "goneAt": None,
            "templateId": str(plan.get("templateId") or "")[:40] or None,
            "templateName": str(plan.get("templateName") or "")[:40] or None,
        }
        self._save_pending_plans()
        self.store.audit(
            "order.template_plan.pending",
            {
                "ticket": ticket,
                "symbol": a["symbol"],
                "side": a["side"],
                "sl": float(a["sl"]),
                "steps": steps,
                "templateId": plan.get("templateId"),
                "templateName": plan.get("templateName"),
            },
        )

    def _save_pending_plans(self) -> None:
        # goneAt 是这一轮进程里的宽限计时，不落盘
        self.store.set_state(
            "pendingTemplatePlans",
            {
                str(k): {key: value for key, value in record.items() if key != "goneAt"}
                for k, record in self._pending_plans.items()
            },
            self._login(),
        )

    @staticmethod
    def _restore_pending_plans(raw: Any) -> dict[int, dict]:
        """读回挂单计划；超过 TTL 的挂单早就不在了，直接丢弃。"""
        plans: dict[int, dict] = {}
        if not isinstance(raw, dict):
            return plans
        now = time.time()
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            try:
                ticket = int(key)
                placed_at = float(value.get("placedAt") or 0)
            except (TypeError, ValueError):
                continue
            if placed_at <= 0 or now - placed_at > PENDING_PLAN_TTL:
                continue
            record = dict(value)
            record["goneAt"] = None
            plans[ticket] = record
        return plans

    def _save_auto_be(self) -> None:
        # next 是 time.monotonic() 的值，跨进程没有意义，不落盘
        self.store.set_state(
            "autoBreakeven",
            {
                str(k): {key: value for key, value in plan.items() if key != "next"}
                for k, plan in self._auto_be.items()
            },
            self._login(),
        )

    @staticmethod
    def _restore_auto_be(raw: Any) -> dict[int, dict]:
        """读回持久化的计划；monotonic 的 next 在新进程里没有意义，一律清零。"""
        plans: dict[int, dict] = {}
        if not isinstance(raw, dict):
            return plans
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            try:
                ticket = int(key)
            except (TypeError, ValueError):
                continue
            plan = dict(value)
            plan["next"] = 0.0
            plans[ticket] = plan
        return plans

    @staticmethod
    def _normalize_plan_steps(raw: Any) -> list[dict]:
        """清洗前端传来的阶段：R 为正、平仓比例留空或 1–99、按 R 升序、最多 8 条。"""
        out: list[dict] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                try:
                    at_r = float(item.get("atR"))
                except (TypeError, ValueError):
                    continue
                if not (0 < at_r <= 100):
                    continue
                close = item.get("closePercent")
                try:
                    close = float(close) if close is not None else None
                except (TypeError, ValueError):
                    close = None
                if close is not None and not (0 < close < 100):
                    close = None
                out.append(
                    {
                        "atR": round(at_r, 4),
                        "closePercent": close,
                        "moveBreakeven": bool(item.get("moveBreakeven")),
                        "done": False,
                    }
                )
        out.sort(key=lambda step: step["atR"])
        return out[:8]

    @staticmethod
    def _plan_steps(plan: dict) -> list[dict]:
        """读计划里的阶段；旧版本只存了 beR，这里补成一条「移保本」阶段。"""
        steps = plan.get("steps")
        if isinstance(steps, list):
            return steps
        try:
            be_r = float(plan.get("beR") or 1) or 1.0
        except (TypeError, ValueError):
            be_r = 1.0
        steps = [{"atR": be_r, "closePercent": None, "moveBreakeven": True, "done": False}]
        plan["steps"] = steps
        return steps

    def _auto_partial_close(self, ticket: int, percent: Any) -> float | None:
        """按当前剩余仓位的百分比平仓；仓位小到拆不开时返回 None（只做止损动作）。"""
        try:
            pct = float(percent)
        except (TypeError, ValueError):
            return None
        if not (0 < pct < 100):
            return None
        found = mt5.positions_get(ticket=ticket)
        if not found:
            return None
        position = found[0]
        info = self._ensure_symbol(position.symbol)
        tick = mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise GatewayError("NO_QUOTE", "当前无报价，无法分批平仓")
        volume = float(position.volume)
        step = float(getattr(info, "volume_step", 0) or 0.01)
        min_vol = max(float(getattr(info, "volume_min", 0) or 0), step)
        target = round_volume(volume * pct / 100.0, step)
        if target < min_vol - 1e-9 or target > volume - min_vol + 1e-9:
            return None
        buy = int(position.type) == 0
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": position.symbol,
            "volume": target,
            "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
            "position": ticket,
            "price": float(tick.bid if buy else tick.ask),
            "deviation": self.cfg.deviation_points,
            "magic": self.cfg.magic,
            "comment": "tpl-partial",
            "type_filling": self._filling_mode(info),
        }
        self._result_or_raise(mt5.order_send(request), "position.template_step.partial")
        return target

    def _history_order(self, ticket: int) -> Any:
        """挂单从 orders_get 消失后，从历史里拿它的最终状态与成交持仓号。"""
        try:
            found = mt5.history_orders_get(ticket=ticket)
        except Exception:  # noqa: BLE001 - 查不到就按「已消失」处理
            return None
        return found[0] if found else None

    def _match_pending_position(self, record: dict, order: Any) -> dict | None:
        """按 comment 前缀找成交生成的持仓，再用历史里的 position_id 兜底。"""
        prefix = str(record.get("clientId") or "")[:20]
        if prefix:
            for position in self._positions:
                if str(position.get("comment") or "").startswith(prefix):
                    return position
        position_id = int(getattr(order, "position_id", 0) or 0) if order is not None else 0
        if position_id:
            for position in self._positions:
                if int(position.get("ticket") or 0) == position_id:
                    return position
                if int(position.get("identifier") or 0) == position_id:
                    return position
        return None

    def _register_pending_plan(self, ticket: int, record: dict, position: dict) -> None:
        """把挂单计划登记到实际持仓；登记失败只审计，绝不影响交易轮询。"""
        self._pending_plans.pop(ticket, None)
        try:
            entry = float(position.get("openPrice") or 0)
            sl = float(position.get("sl") or record.get("sl") or 0)
            side = str(record.get("side") or position.get("side") or "")
            risk = abs(entry - sl) if entry > 0 and sl > 0 else 0.0
            steps = self._normalize_plan_steps(record.get("steps"))
            position_ticket = int(position.get("ticket") or 0)
            if not steps or risk <= 0 or side not in ("buy", "sell") or not position_ticket:
                self.store.audit(
                    "order.template_plan.dropped",
                    {
                        "ticket": ticket,
                        "position": position_ticket or None,
                        "reason": "no-risk",
                    },
                )
                return
            existing = self._auto_be.get(position_ticket)
            self._auto_be[position_ticket] = {
                "entry": entry,
                "risk": risk,
                "side": side,
                "steps": steps,
                "next": 0.0,
                "templateId": record.get("templateId"),
                "templateName": record.get("templateName"),
            }
            self._save_auto_be()
            payload = {
                "ticket": position_ticket,
                "order": ticket,
                "entry": entry,
                "sl": sl,
                "steps": steps,
                "source": "pending",
                "templateId": record.get("templateId"),
                "templateName": record.get("templateName"),
            }
            if existing is not None:
                # netting 账户同一方向的持仓会被合并，后登记的模板生效
                payload["replaced"] = True
                self.store.audit("position.template_plan.netting", payload)
            self.store.audit("position.template_plan.set", payload)
        except Exception as exc:  # noqa: BLE001 - 登记失败不能中断轮询
            self.store.audit(
                "order.template_plan.dropped",
                {"ticket": ticket, "reason": "error", "error": f"{type(exc).__name__}: {exc}"},
            )

    def _adopt_pending_template_plans(self) -> None:
        """挂单成交后把阶段计划迁移到实际持仓；撤单 / 过期 / 已平仓则丢弃。"""
        if not self._pending_plans or not self._connected:
            return
        now = time.time()
        changed = False
        orders = {int(order["ticket"]): order for order in self._orders}
        for ticket, record in list(self._pending_plans.items()):
            try:
                placed_at = float(record.get("placedAt") or 0)
            except (TypeError, ValueError):
                placed_at = 0.0
            if now - placed_at > PENDING_PLAN_TTL:
                self._pending_plans.pop(ticket, None)
                changed = True
                self.store.audit(
                    "order.template_plan.dropped", {"ticket": ticket, "reason": "ttl"}
                )
                continue
            order = orders.get(ticket)
            if order is not None:
                record["goneAt"] = None
                position = self._match_pending_position(record, None)
                if position is None:
                    continue
            else:
                # 成交与持仓快照之间有空档，先给几秒宽限再判定「消失了」
                gone_at = record.get("goneAt")
                if not gone_at:
                    record["goneAt"] = now
                    continue
                if now - float(gone_at) < PENDING_PLAN_GRACE:
                    continue
                history = self._history_order(ticket)
                state = ""
                if history is not None:
                    raw_state = getattr(history, "state", None)
                    if isinstance(raw_state, int):
                        state = ORDER_STATES.get(raw_state, "")
                if state in ("cancelled", "expired", "rejected"):
                    self._pending_plans.pop(ticket, None)
                    changed = True
                    self.store.audit(
                        "order.template_plan.dropped",
                        {"ticket": ticket, "reason": state},
                    )
                    continue
                position = self._match_pending_position(record, history)
                if position is None:
                    self._pending_plans.pop(ticket, None)
                    changed = True
                    self.store.audit(
                        "order.template_plan.dropped",
                        {"ticket": ticket, "reason": "gone", "state": state or None},
                    )
                    continue
            self._register_pending_plan(ticket, record, position)
            changed = True
        if changed:
            self._save_pending_plans()

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
        if comment and not still_open and self.store.get_intent(comment, self._login()):
            self.store.update_intent(comment, "closed", login=self._login())
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
