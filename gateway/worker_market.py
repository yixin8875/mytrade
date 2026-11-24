from __future__ import annotations

from worker_base import *  # noqa: F401,F403
from worker_base import _num  # noqa: F401
from resolutions import aggregate_month_bars, month_multiple


class WorkerMarket:
    def _missed_bars(self, symbol: str, start: int, end: int) -> list[dict[str, Any]]:
        """模拟错过机会用的 M1；时间口径与 _history 一致（服务器时间当 UTC 喂库）。"""
        self._ensure_symbol(symbol)
        try:
            rates = mt5.copy_rates_range(
                symbol,
                mt5.TIMEFRAME_M1,
                datetime.fromtimestamp(start),
                datetime.fromtimestamp(end),
            )
        except Exception:  # noqa: BLE001 - 历史缺失按没有数据处理
            rates = None
        if rates is None:
            return []
        return [
            {
                "time": int(rate["time"]),
                "open": float(rate["open"]),
                "high": float(rate["high"]),
                "low": float(rate["low"]),
                "close": float(rate["close"]),
                "volume": float(rate["tick_volume"]),
            }
            for rate in rates
        ]

    def _watchlist(self, p: dict) -> list[dict]:
        names = [str(item).upper() for item in (p.get("symbols") or []) if str(item).strip()]
        if not names:
            names = [
                str(item)
                for item in (self.store.get_state("watchlist", self._login()) or [])
            ]
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
        self.store.set_state("watchlist", names, self._login())
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

    def _history(self, p: dict) -> dict:
        symbol = str(p.get("symbol") or "")
        resolution = str(p.get("resolution") or "1")
        count = max(10, min(int(p.get("count") or 1000), 5000))
        # 3M/6M/12M 不是 MT5 原生周期：先取 1M 月线，再按日历聚合成每 n 个月一根
        months = month_multiple(resolution)
        fetch_resolution = "1M" if months else resolution
        tf = TIMEFRAMES.get(fetch_resolution)
        if tf is None:
            raise GatewayError("BAD_RESOLUTION", f"不支持的周期: {resolution}")
        info = self._ensure_symbol(symbol)
        # 一根 n 月线需要 n 根月线；上限 2 万根避免一次请求太久
        fetch_count = min(20000, count * months) if months else count

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
                start_ts = end_ts - RES_SECONDS.get(fetch_resolution, 60) * fetch_count * 1.2
            try:
                # MetaTrader5 会把 datetime 当成本地墙钟时间换算成时间戳；
                # 而 K 线 time 我们按「服务器时间当作 UTC」处理，所以这里也要用
                # 本地墙钟构造，才能查到对应的服务器时间区间。
                date_to = datetime.fromtimestamp(end_ts)
                date_from = datetime.fromtimestamp(max(0.0, start_ts))
                rates = mt5.copy_rates_range(symbol, tf, date_from, date_to)
            except Exception:
                rates = None
            if rates is not None and len(rates) > fetch_count:
                rates = rates[-fetch_count:]
            # 请求的窗口可能正好落在周末/休市，直接返回空会让图表以为左侧
            # 再没有数据而停止翻页。这里往前找最近一段有数据的区间返回，
            # 图表跨过休市继续加载更早的 K 线。
            if (rates is None or len(rates) == 0) and from_ts:
                probe_end = float(from_ts)
                probe_span = RES_SECONDS.get(fetch_resolution, 60) * max(60, fetch_count) * 1.2
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
                        rates = got[-fetch_count:]
                        break
                    probe_end = probe_start
                else:
                    rates = []
            if rates is None:
                rates = []
        else:
            rates = mt5.copy_rates_from_pos(symbol, tf, 0, fetch_count)
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
        if months:
            bars = aggregate_month_bars(bars, months)[-count:]
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
            if month_multiple(resolution):
                # 图表库自己合成 3M/12M，不需要网关推送；Pine 只读历史
                raise GatewayError(
                    "BAD_RESOLUTION",
                    f"{resolution} 仅支持历史 K 线，暂不支持实时订阅",
                )
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
