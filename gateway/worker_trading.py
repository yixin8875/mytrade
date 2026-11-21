from __future__ import annotations

import uuid

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401

# 服务端最多存 8 档；UI 只放 4 档，多余档位留给脚本/旧模板
MAX_PLAN_STEPS = 8


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
        """按目标风险（固定金额或净值百分比）反推手数。

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
        # 百分比模式必须和开仓闸门同口径：闸门按净值算风险占比，
        # 这里若按余额算，浮亏时算出的手数会被闸门以“超过上限”拒掉。
        basis = equity if equity > 0 else balance
        target = basis * risk_value / 100.0 if mode == "percent" else risk_value
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
                        "breakevenOffsetPoints": self._plan_offset_points(
                            plan.get("breakevenOffsetPoints")
                        ),
                        "source": "template",
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
        """把止损移到开仓价（可加偏移点数）。

        只有开仓价已经站在现价有利一侧、且留得出券商最小止损距离时才下单；
        亏损或利润太薄时保持原止损不动，避免把它压到现价旁边被瞬间扫掉。
        """
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
        desired = float(position.price_open) + offset if buy else float(position.price_open) - offset
        desired = align_price(desired, info)
        stops = max(
            int(getattr(info, "trade_stops_level", 0) or 0),
            int(getattr(info, "trade_freeze_level", 0) or 0),
        )
        # 止损必须和现价拉开一点距离，券商 stops_level 为 0 时也至少 1 个点。
        # 再加 5 个点缓冲：贴着实盘 stops 边界发单，报价一跳动就会 Invalid stops。
        min_dist = (max(stops, 1) + 5) * point
        current_price = float(tick.bid if buy else tick.ask)
        # 开仓价还没进到有利一侧、或离现价太近：保本放不下，保持原止损。
        if buy and desired > current_price - min_dist:
            reason = "not_in_profit" if desired >= current_price else "too_close"
            return {
                "ticket": ticket,
                "sl": float(position.sl or 0),
                "changed": False,
                "reason": reason,
                "price": current_price,
            }
        if not buy and desired < current_price + min_dist:
            reason = "not_in_profit" if desired <= current_price else "too_close"
            return {
                "ticket": ticket,
                "sl": float(position.sl or 0),
                "changed": False,
                "reason": reason,
                "price": current_price,
            }
        current_sl = float(position.sl or 0)
        if current_sl:
            if buy and desired <= current_sl + point / 2:
                return {"ticket": ticket, "sl": current_sl, "changed": False}
            if not buy and desired >= current_sl - point / 2:
                return {"ticket": ticket, "sl": current_sl, "changed": False}
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": position.symbol,
            "position": ticket,
            "sl": desired,
            "tp": float(position.tp or 0),
            "magic": self.cfg.magic,
        }
        result = mt5.order_send(request)
        out = self._result_or_raise(result, "position.breakeven")
        self._poll_trade_state()
        return {"ticket": ticket, "sl": desired, "changed": True, **out}

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
            "breakevenOffsetPoints": self._plan_offset_points(
                plan.get("breakevenOffsetPoints")
            ),
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
            # 旧版 autoBreakeven 都来自模板；手动计划一定会带 source 落盘
            plan.setdefault("source", "template")
            plan.setdefault("breakevenOffsetPoints", 0.0)
            steps = plan.get("steps")
            if isinstance(steps, list):
                for index, step in enumerate(steps):
                    if not isinstance(step, dict):
                        continue
                    step.setdefault("id", f"legacy-{index + 1}")
                    step.setdefault("price", None)
                    step.setdefault("done", False)
                    step.setdefault("skipped", False)
                    step.setdefault("moveBreakeven", False)
                plan["steps"] = steps
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
                price = None
                try:
                    if item.get("price") is not None:
                        price = float(item["price"])
                        if not math.isfinite(price) or price <= 0:
                            price = None
                except (TypeError, ValueError):
                    price = None
                out.append(
                    {
                        "id": WorkerTrading._clean_step_id(item.get("id")),
                        "price": price,
                        "atR": round(at_r, 4),
                        "closePercent": close,
                        "moveBreakeven": bool(item.get("moveBreakeven")),
                        "done": False,
                        "skipped": False,
                    }
                )
        out.sort(key=lambda step: step["atR"])
        return out[:MAX_PLAN_STEPS]

    @staticmethod
    def _clean_step_id(raw: Any) -> str:
        text = str(raw or "").strip()[:16]
        return text or uuid.uuid4().hex[:8]

    @staticmethod
    def _plan_steps(plan: dict) -> list[dict]:
        """读计划里的阶段；旧版本只存了 beR，这里补成一条「移保本」阶段。"""
        steps = plan.get("steps")
        if isinstance(steps, list):
            for index, step in enumerate(steps):
                if not isinstance(step, dict):
                    continue
                step.setdefault("id", f"legacy-{index + 1}")
                step.setdefault("price", None)
                step.setdefault("skipped", False)
                step.setdefault("done", False)
            return steps
        try:
            be_r = float(plan.get("beR") or 1) or 1.0
        except (TypeError, ValueError):
            be_r = 1.0
        steps = [
            {
                "id": "legacy-1",
                "price": None,
                "atR": be_r,
                "closePercent": None,
                "moveBreakeven": True,
                "done": False,
                "skipped": False,
            }
        ]
        plan["steps"] = steps
        return steps

    @staticmethod
    def _step_trigger(step: dict, plan: dict) -> float | None:
        """一档的触发价：优先存下来的价格，否则按 entry ± risk × atR 折算。"""
        try:
            price = float(step.get("price"))
            if math.isfinite(price) and price > 0:
                return price
        except (TypeError, ValueError):
            pass
        try:
            at_r = float(step.get("atR") or 0)
        except (TypeError, ValueError):
            return None
        risk = float(plan.get("risk") or 0)
        entry = float(plan.get("entry") or 0)
        if at_r <= 0 or risk <= 0 or entry <= 0:
            return None
        return entry + risk * at_r if str(plan.get("side")) == "buy" else entry - risk * at_r

    @staticmethod
    def _step_at_r(trigger: float | None, plan: dict) -> float | None:
        risk = float(plan.get("risk") or 0)
        entry = float(plan.get("entry") or 0)
        if trigger is None or risk <= 0 or entry <= 0:
            return None
        return round(abs(trigger - entry) / risk, 4)

    @classmethod
    def _sort_plan_steps(cls, steps: list[dict], plan: dict) -> list[dict]:
        """多单按触发价升序、空单降序；算不出触发价的放最后。"""
        buy = str(plan.get("side")) != "sell"

        def key(step: dict) -> tuple[int, float]:
            trigger = cls._step_trigger(step, plan)
            return (1, 0.0) if trigger is None else (0, trigger if buy else -trigger)

        return sorted(steps, key=key)

    def _auto_partial_close(
        self, ticket: int, percent: Any, comment: str = "tpl-partial"
    ) -> float | None:
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
            # MT5 备注最长 31 字节；plan-<8位id> 足够区分每一档，也用于查重
            "comment": str(comment or "tpl-partial")[:31],
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
                "breakevenOffsetPoints": self._plan_offset_points(
                    record.get("breakevenOffsetPoints")
                ),
                "source": "template",
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

    def _cancel_all_orders(self, p: dict) -> dict:
        """批量撤单：逐笔走单笔撤单逻辑，单笔失败不影响其它单。"""
        self._guard_trade()
        symbol = p.get("symbol")
        targets = [o for o in (mt5.orders_get() or []) if not symbol or o.symbol == symbol]
        results = []
        for order in targets:
            ticket = int(order.ticket)
            try:
                self._cancel_order({"ticket": ticket})
                results.append({"ticket": ticket})
            except GatewayError as exc:
                results.append({"ticket": ticket, "error": exc.message})
        self._poll_trade_state()
        remaining = [o for o in (mt5.orders_get() or []) if not symbol or o.symbol == symbol]
        out = {"results": results, "remaining": len(remaining)}
        self.store.audit(
            "order.cancelAll",
            {
                "symbol": symbol,
                "cancelled": sum(1 for item in results if not item.get("error")),
                "failed": [item for item in results if item.get("error")],
                "remaining": len(remaining),
            },
        )
        return out

    def _flatten(self, p: dict) -> dict:
        """全部清仓：先撤挂单，再平持仓。

        顺序不能反：先平仓的话，撤单期间挂单仍可能成交，清完又冒出新仓位。
        """
        self._guard_trade()
        symbol = p.get("symbol")
        cancelled = self._cancel_all_orders({"symbol": symbol}).get("results", [])
        closed = self._close_all({"symbol": symbol}).get("results", [])
        self._poll_trade_state()
        # 用券商最新快照统计剩余，避免相信操作前的缓存
        orders = [o for o in (mt5.orders_get() or []) if not symbol or o.symbol == symbol]
        positions = [
            x for x in (mt5.positions_get() or []) if not symbol or x.symbol == symbol
        ]
        remaining = {"positions": len(positions), "orders": len(orders)}
        self.store.audit(
            "trade.flatten",
            {
                "symbol": symbol,
                "cancelled": sum(1 for item in cancelled if not item.get("error")),
                "closed": sum(1 for item in closed if not item.get("error")),
                "failed": [
                    item for item in [*cancelled, *closed] if item.get("error")
                ],
                "remaining": remaining,
            },
        )
        return {"cancelled": cancelled, "closed": closed, "remaining": remaining}

    # ---------- 分批止盈计划（只改本地 state，不发券商请求） ----------

    def _plan_position(self, ticket: int) -> Any:
        try:
            found = mt5.positions_get(ticket=ticket)
        except Exception as exc:  # noqa: BLE001 - 终端异常统一报「找不到持仓」
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}") from exc
        if not found:
            raise GatewayError("NO_POSITION", f"找不到持仓 {ticket}")
        return found[0]

    def _plan_base(self, position: Any, ticket: int) -> dict:
        """新计划的入场价与 1R：优先持仓当前 SL，其次历史落库的初始入场/止损。

        注意落库的 `risk` 是账户货币金额，不是价格距离；这里只能用 entry/sl 折算。
        """
        entry = float(getattr(position, "price_open", 0) or 0)
        sl = float(getattr(position, "sl", 0) or 0)
        risk = abs(entry - sl) if entry > 0 and sl > 0 else 0.0
        login = self._login()
        if risk <= 0 and login > 0:
            try:
                recorded = self.store.position_risk_map(login, [ticket]).get(ticket) or {}
            except Exception:  # noqa: BLE001 - 读不到就按无 R 处理
                recorded = {}
            if entry <= 0:
                entry = float(recorded.get("entry") or 0)
            recorded_sl = float(recorded.get("sl") or 0)
            if entry > 0 and recorded_sl > 0:
                risk = abs(entry - recorded_sl)
        return {
            "entry": entry,
            "risk": risk,
            "side": "buy" if int(getattr(position, "type", 0)) == 0 else "sell",
            "steps": [],
            "next": 0.0,
            "breakevenOffsetPoints": 0.0,
            "source": "manual",
            "templateId": None,
            "templateName": None,
        }

    @staticmethod
    def _plan_offset_points(raw: Any) -> float:
        """保本偏移（点）：补偿手续费/隔夜利息/滑点；非法值按 0，最多 500 点。"""
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return 0.0
        if not math.isfinite(value) or value <= 0:
            return 0.0
        return min(value, 500.0)

    @staticmethod
    def _plan_tick(info: Any) -> float:
        try:
            tick = float(getattr(info, "trade_tick_size", 0) or 0)
        except (TypeError, ValueError):
            tick = 0.0
        if tick <= 0:
            try:
                tick = float(getattr(info, "point", 0) or 0)
            except (TypeError, ValueError):
                tick = 0.0
        return tick if math.isfinite(tick) and tick > 0 else 0.0

    def _validate_plan_price(
        self, plan: dict, position: Any, info: Any, raw: Any, *, step_id: str | None = None
    ) -> float:
        try:
            price = float(raw)
        except (TypeError, ValueError):
            raise GatewayError("BAD_PRICE", "触发价无效") from None
        if not math.isfinite(price) or price <= 0:
            raise GatewayError("BAD_PRICE", "触发价无效")
        price = align_price(price, info)
        half = self._plan_tick(info) / 2 or 1e-9
        entry = float(plan.get("entry") or 0)
        buy = str(plan.get("side")) == "buy"
        if entry > 0:
            if buy and price < entry + half:
                raise GatewayError("PLAN_WRONG_SIDE", "多单的分批价必须高于开仓价")
            if not buy and price > entry - half:
                raise GatewayError("PLAN_WRONG_SIDE", "空单的分批价必须低于开仓价")
        tp = float(getattr(position, "tp", 0) or 0)
        if tp > 0:
            beyond = price >= tp - half if buy else price <= tp + half
            if beyond:
                raise GatewayError("PLAN_BEYOND_TP", "该档在最终止盈之后，不会触发")
        for step in self._plan_steps(plan):
            if step_id and str(step.get("id")) == step_id:
                continue
            if step.get("done") or step.get("skipped"):
                continue
            other = self._step_trigger(step, plan)
            if other is not None and abs(other - price) < half:
                raise GatewayError("PLAN_DUPLICATE", "已有一档在这个价位")
        return price

    @staticmethod
    def _validate_plan_percent(raw: Any) -> float:
        try:
            percent = float(raw)
        except (TypeError, ValueError):
            raise GatewayError("BAD_PERCENT", "平仓比例需在 1–99% 之间") from None
        if not math.isfinite(percent) or not (1 <= percent <= 99):
            raise GatewayError("BAD_PERCENT", "平仓比例需在 1–99% 之间")
        return round(percent, 2)

    def _plan_for_edit(self, ticket: int, *, require: bool = False) -> tuple[Any, dict]:
        position = self._plan_position(ticket)
        plan = self._auto_be.get(ticket)
        if plan is None:
            if require:
                raise GatewayError("NO_PLAN", "该持仓还没有分批止盈")
            plan = self._plan_base(position, ticket)
            self._auto_be[ticket] = plan
        return position, plan

    def _plan_payload(self, plan: dict) -> dict:
        steps = self._sort_plan_steps(self._plan_steps(plan), plan)
        out = []
        for step in steps:
            trigger = self._step_trigger(step, plan)
            if trigger is None:
                continue
            out.append(
                {
                    "id": str(step.get("id") or ""),
                    "price": round(float(trigger), 8),
                    "closePercent": step.get("closePercent"),
                    "moveBreakeven": bool(step.get("moveBreakeven")),
                    "done": bool(step.get("done")),
                    "skipped": bool(step.get("skipped")),
                    "atR": self._step_at_r(trigger, plan),
                }
            )
        return {
            "entry": float(plan.get("entry") or 0),
            "risk": float(plan.get("risk") or 0),
            "side": str(plan.get("side") or "buy"),
            "steps": out,
            "breakevenOffsetPoints": self._plan_offset_points(
                plan.get("breakevenOffsetPoints")
            ),
            "templateId": plan.get("templateId"),
            "templateName": plan.get("templateName"),
            "source": str(plan.get("source") or "manual"),
        }

    def _position_plan(self, ticket: int) -> dict | None:
        """下发给前端的派生计划；没有计划时返回 None。"""
        plan = getattr(self, "_auto_be", {}).get(int(ticket))
        if not plan:
            return None
        return self._plan_payload(plan)

    def _plan_add(self, p: dict) -> dict:
        ticket = int(p.get("ticket") or 0)
        if ticket <= 0:
            raise GatewayError("BAD_TICKET", "缺少持仓号")
        # 先不写进 _auto_be：校验失败时不应该留下一个空计划
        position = self._plan_position(ticket)
        plan = self._auto_be.get(ticket) or self._plan_base(position, ticket)
        steps = self._plan_steps(plan)
        if len(steps) >= MAX_PLAN_STEPS:
            raise GatewayError("PLAN_LIMIT", f"分批止盈最多 {MAX_PLAN_STEPS} 档")
        info = self._ensure_symbol(position.symbol)
        price = self._validate_plan_price(plan, position, info, p.get("price"))
        percent = self._validate_plan_percent(p.get("closePercent"))
        step = {
            "id": uuid.uuid4().hex[:8],
            "price": price,
            "atR": None,
            "closePercent": percent,
            "moveBreakeven": bool(p.get("moveBreakeven")),
            "done": False,
            "skipped": False,
        }
        if "breakevenOffsetPoints" in p:
            plan["breakevenOffsetPoints"] = self._plan_offset_points(
                p.get("breakevenOffsetPoints")
            )
        plan["steps"] = self._sort_plan_steps([*steps, step], plan)
        self._auto_be[ticket] = plan
        self._save_auto_be()
        self._poll_trade_state()
        payload = self._plan_payload(plan)
        self.store.audit(
            "position.plan.add",
            {
                "ticket": ticket,
                "stepId": step["id"],
                "price": price,
                "closePercent": percent,
                "source": payload["source"],
                "steps": payload["steps"],
            },
        )
        return {"plan": payload}

    def _plan_update(self, p: dict) -> dict:
        ticket = int(p.get("ticket") or 0)
        step_id = str(p.get("stepId") or "")
        position, plan = self._plan_for_edit(ticket, require=True)
        info = self._ensure_symbol(position.symbol)
        steps = self._plan_steps(plan)
        step = next((item for item in steps if str(item.get("id")) == step_id), None)
        if step is None:
            raise GatewayError("NO_STEP", "找不到该档")
        if p.get("price") is not None:
            step["price"] = self._validate_plan_price(
                plan, position, info, p.get("price"), step_id=step_id
            )
        if "closePercent" in p and p.get("closePercent") is not None:
            step["closePercent"] = self._validate_plan_percent(p.get("closePercent"))
        if "moveBreakeven" in p:
            step["moveBreakeven"] = bool(p.get("moveBreakeven"))
        plan["steps"] = self._sort_plan_steps(steps, plan)
        self._save_auto_be()
        self._poll_trade_state()
        payload = self._plan_payload(plan)
        self.store.audit(
            "position.plan.update",
            {
                "ticket": ticket,
                "stepId": step_id,
                "price": step.get("price"),
                "closePercent": step.get("closePercent"),
                "steps": payload["steps"],
            },
        )
        return {"plan": payload}

    def _plan_remove(self, p: dict) -> dict:
        ticket = int(p.get("ticket") or 0)
        step_id = str(p.get("stepId") or "")
        _, plan = self._plan_for_edit(ticket, require=True)
        steps = self._plan_steps(plan)
        left = [item for item in steps if str(item.get("id")) != step_id]
        if len(left) == len(steps):
            raise GatewayError("NO_STEP", "找不到该档")
        plan["steps"] = self._sort_plan_steps(left, plan)
        self._save_auto_be()
        self._poll_trade_state()
        payload = self._plan_payload(plan)
        self.store.audit(
            "position.plan.remove",
            {"ticket": ticket, "stepId": step_id, "steps": payload["steps"]},
        )
        return {"plan": payload}

    def _plan_clear(self, p: dict) -> dict:
        ticket = int(p.get("ticket") or 0)
        self._plan_position(ticket)
        existed = self._auto_be.pop(ticket, None) is not None
        if existed:
            self._save_auto_be()
            self._poll_trade_state()
        self.store.audit("position.plan.clear", {"ticket": ticket, "existed": existed})
        return {"plan": None}

    def _step_filled(self, ticket: int, comment: str) -> bool:
        """这一档是否已经成交过：响应丢失时避免下一轮再平一次。

        查历史失败按「没成交」处理（保持旧行为），只是可能多平一次。
        """
        try:
            deals = mt5.history_deals_get(position=ticket)
        except Exception:  # noqa: BLE001 - 历史读不到不能阻挡执行
            return False
        for deal in deals or []:
            if str(getattr(deal, "comment", "") or "").strip() == comment:
                return True
        return False

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
