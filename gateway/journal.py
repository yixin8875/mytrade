from __future__ import annotations

import base64
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import MetaTrader5 as mt5

from store import Store


def _weighted(pairs: list[tuple[float, float]]) -> float:
    total = sum(volume for volume, _ in pairs)
    return sum(volume * price for volume, price in pairs) / total if total else 0.0


def _close_kind(comment: str) -> str:
    text = comment.strip().lower()
    # 模板分批止盈的成交注释是 "tpl-partial"，开头的 tp 不是止盈单
    if text.startswith("tpl"):
        return "manual"
    if text.startswith("tp"):
        return "tp"
    if text.startswith("sl"):
        return "sl"
    if text.startswith("so"):
        return "stop_out"
    return "manual"


def _clean_shot_meta(meta: Any) -> dict[str, Any] | None:
    """只保留前端标注需要的价格锚点，避免把任意 JSON 写进截图目录。"""
    if not isinstance(meta, dict):
        return None
    anchors: list[dict[str, float]] = []
    for item in meta.get("anchors") or []:
        if not isinstance(item, dict):
            continue
        try:
            price = float(item.get("price"))
            y = float(item.get("y"))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(price) and math.isfinite(y)):
            continue
        anchors.append({"price": round(price, 10), "y": round(max(0.0, min(1.0, y)), 6)})
        if len(anchors) >= 8:
            break
    if len(anchors) < 2:
        return None
    try:
        digits = int(meta.get("digits") or 5)
    except (TypeError, ValueError):
        digits = 5
    return {
        "version": 1,
        "digits": max(0, min(8, digits)),
        "symbol": str(meta.get("symbol") or "")[:40],
        "interval": str(meta.get("interval") or "")[:12],
        "anchors": anchors,
    }


def _r_multiple(profit: float, risk: float | None) -> float | None:
    """盈亏折算成初始风险倍数；没有记录风险的交易不参与 R 统计。"""
    if risk is None or risk <= 0:
        return None
    return profit / risk


def _duration_bucket(seconds: int) -> str:
    if seconds < 15 * 60:
        return "15 分内"
    if seconds < 60 * 60:
        return "15 分–1 时"
    if seconds < 4 * 60 * 60:
        return "1–4 时"
    if seconds < 24 * 60 * 60:
        return "4–24 时"
    return "1 天以上"


def _r_summary(curve: list[dict], hit1r: int, total_trades: int) -> dict:
    """R 曲线的汇总：平均 / 累计 R、R 口径回撤和 1R 到达率。"""
    values = [float(point["r"]) for point in curve]
    total = float(curve[-1]["cum"]) if curve else 0.0
    peak = 0.0
    drawdown = 0.0
    for point in curve:
        peak = max(peak, float(point["cum"]))
        drawdown = max(drawdown, peak - float(point["cum"]))
    return {
        "trades": len(values),
        "coverage": round(len(values) / total_trades * 100, 1) if total_trades else None,
        "avgR": round(total / len(values), 2) if values else None,
        "totalR": round(total, 2),
        "bestR": round(max(values), 2) if values else None,
        "worstR": round(min(values), 2) if values else None,
        "maxDrawdownR": round(drawdown, 2),
        "hit1R": round(hit1r / len(values) * 100, 1) if values else None,
    }


def _plan_fidelity(
    rows: list[dict],
    risks: dict[int, float],
    plans: dict[int, dict],
    steps: dict[int, list[dict]],
) -> dict:
    """模板计划执行情况：有多少真的走到 1R、移了保本、并且守住了不亏。"""
    planned = 0
    reached = 0
    breakeven = 0
    held = 0
    r_values: list[float] = []
    for row in rows:
        ticket = int(row["position_id"])
        if ticket not in plans:
            continue
        planned += 1
        risk = risks.get(ticket)
        r = _r_multiple(float(row["profit"]), risk)
        if r is not None:
            r_values.append(r)
        mfe = row.get("mfe")
        if risk is None or mfe is None or float(mfe) + 1e-9 < risk:
            continue
        reached += 1
        moved = any(
            float(step.get("atR") or 0) >= 1 and step.get("breakeven") is not None
            for step in steps.get(ticket, [])
        )
        if not moved:
            continue
        breakeven += 1
        if float(row["profit"]) >= 0:
            held += 1
    return {
        "planned": planned,
        "reached1R": reached,
        "breakeven": breakeven,
        "held": held,
        "breakevenRate": round(breakeven / reached * 100, 1) if reached else None,
        "heldRate": round(held / breakeven * 100, 1) if breakeven else None,
        "avgR": round(sum(r_values) / len(r_values), 2) if r_values else None,
    }


def _execution_cross(rows: list[dict], entries: dict[int, dict]) -> dict:
    """把每笔交易的入场点差/滑点按输赢分组，看执行成本和结果的关系。"""
    buckets: dict[str, list[dict]] = {"win": [], "loss": []}
    for row in rows:
        entry = entries.get(int(row["position_id"]))
        if entry is None:
            continue
        buckets["win" if float(row["profit"]) > 0 else "loss"].append(entry)

    def summarize(items: list[dict]) -> dict:
        slips = [float(item["slippage"]) for item in items if item.get("slippage") is not None]
        spreads = [float(item["spread"]) for item in items if item.get("spread") is not None]
        return {
            "trades": len(items),
            "avgSlippage": round(sum(slips) / len(slips), 2) if slips else None,
            "avgSpread": round(sum(spreads) / len(spreads), 1) if spreads else None,
        }

    return {
        "matched": len(buckets["win"]) + len(buckets["loss"]),
        "wins": summarize(buckets["win"]),
        "losses": summarize(buckets["loss"]),
    }


class TradeJournal:
    """把历史成交配对成「一笔交易」，补 MFE/MAE、持有时长，并按维度出统计。

    只允许 MT5 工作线程调用（内部直接用 mt5 模块）。
    """

    def __init__(self, store: Store) -> None:
        self.store = store
        self._last_sync = 0.0
        self._risk_cache: dict[tuple, float | None] = {}
        self._plan_cache: tuple[int, float, dict, dict] | None = None
        self.shots_dir = store.base_dir / "data" / "shots"
        self.shots_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 同步 ----------

    def sync(self, login: int, force: bool = False) -> int:
        now = time.monotonic()
        if not force and now - self._last_sync < 4.0:
            return 0
        self._last_sync = now
        try:
            raw = mt5.history_deals_get(
                datetime.now() - timedelta(days=30), datetime.now() + timedelta(days=1)
            )
        except Exception:  # noqa: BLE001 - 历史读不到就等下一轮
            return 0
        if not raw:
            return 0

        groups: dict[int, list[Any]] = {}
        for deal in raw:
            position_id = int(getattr(deal, "position_id", 0) or 0)
            if position_id <= 0 or int(getattr(deal, "type", 0)) >= 2:
                continue
            groups.setdefault(position_id, []).append(deal)

        written = 0
        for position_id, deals in groups.items():
            existing = self.store.journal_get(position_id, login)
            if existing:
                # 已经完整记录过；如果之后补上了截图，把 has_shot 补回来
                if not int(existing.get("has_shot") or 0) and self.shot_path(
                    login, position_id
                ).is_file():
                    self.store.journal_set_shot(position_id, login)
                continue
            entries = [d for d in deals if int(getattr(d, "entry", 0) or 0) == 0]
            exits = [d for d in deals if int(getattr(d, "entry", 0) or 0) in (1, 3)]
            if not entries or not exits:
                continue
            in_volume = sum(float(d.volume) for d in entries)
            out_volume = sum(float(d.volume) for d in exits)
            if out_volume + 1e-9 < in_volume:
                continue  # 还有仓位没平完

            entry_price = _weighted([(float(d.volume), float(d.price)) for d in entries])
            exit_price = _weighted([(float(d.volume), float(d.price)) for d in exits])
            open_time = min(int(d.time) for d in entries)
            close_time = max(int(d.time) for d in exits)
            profit = sum(
                float(d.profit)
                + float(d.swap)
                + float(d.commission)
                + float(getattr(d, "fee", 0) or 0)
                for d in deals
            )
            last_exit = max(exits, key=lambda d: int(d.time))
            symbol = str(entries[0].symbol)
            side = "buy" if int(entries[0].type) == 0 else "sell"
            mfe, mae = self._excursion(
                symbol, side, in_volume, entry_price, open_time, close_time
            )
            self.store.upsert_journal(
                {
                    "login": int(login),
                    "position_id": position_id,
                    "symbol": symbol,
                    "side": side,
                    "volume": in_volume,
                    "entry_price": entry_price,
                    "exit_price": exit_price,
                    "profit": profit,
                    "swap": sum(float(d.swap) for d in deals),
                    "commission": sum(float(d.commission) for d in deals),
                    "open_time": open_time,
                    "close_time": close_time,
                    "duration_sec": max(0, close_time - open_time),
                    "mfe": mfe,
                    "mae": mae,
                    "tag": self.store.journal_tag_for_position(position_id, login),
                    "closed_by": _close_kind(str(getattr(last_exit, "comment", "") or "")),
                }
            )
            # 截图可能在日志记录之前就上传了（成交后立刻截图，收盘后才配对完成），
            # 这里按文件补一次标记，前端才知道有图可看
            if self.shot_path(login, position_id).is_file():
                self.store.journal_set_shot(position_id, login)
            written += 1
        return written

    def _excursion(
        self,
        symbol: str,
        side: str,
        volume: float,
        entry: float,
        open_time: int,
        close_time: int,
    ) -> tuple[float | None, float | None]:
        """用持仓期间的 M1 高低点折算最大浮盈/浮亏（账户货币）。"""
        try:
            bars = mt5.copy_rates_range(
                symbol,
                mt5.TIMEFRAME_M1,
                datetime.fromtimestamp(open_time - 60),
                datetime.fromtimestamp(close_time + 60),
            )
        except Exception:  # noqa: BLE001
            bars = None
        if bars is None or len(bars) == 0:
            return None, None
        highs = [float(bar["high"]) for bar in bars]
        lows = [float(bar["low"]) for bar in bars]
        base = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        best = max(highs) if side == "buy" else min(lows)
        worst = min(lows) if side == "buy" else max(highs)

        def pnl(price: float) -> float | None:
            try:
                value = mt5.order_calc_profit(base, symbol, volume, entry, price)
            except Exception:  # noqa: BLE001
                return None
            return float(value) if value is not None else None

        return pnl(best), pnl(worst)

    # ---------- 统计 ----------

    def stats(self, days: int = 30, login: int = 0) -> dict:
        since = int(time.time()) - max(1, days) * 86400
        rows = self.store.journal_list(limit=5000, since=since, login=login)
        rows.sort(key=lambda r: int(r["close_time"]))
        if not rows:
            return self._empty_stats(days)

        # 初始风险来自下单时带的止损；没有记录的旧交易不参与 R 统计
        risks = self._risks(rows, login)

        profits = [float(r["profit"]) for r in rows]
        wins = [p for p in profits if p > 0]
        losses = [p for p in profits if p < 0]
        gross_profit = sum(wins)
        gross_loss = sum(losses)
        net = sum(profits)

        cumulative = 0.0
        peak = 0.0
        max_dd = 0.0
        full_curve: list[dict] = []
        for row in rows:
            cumulative += float(row["profit"])
            peak = max(peak, cumulative)
            max_dd = max(max_dd, peak - cumulative)
            full_curve.append(
                {
                    "t": int(row["close_time"]),
                    "pnl": round(float(row["profit"]), 2),
                    "cum": round(cumulative, 2),
                }
            )
        curve = self._downsample(full_curve)
        r_curve, hit1r = self._r_curve(rows, risks)
        plans, steps = self._template_events(days)

        summary = {
            "trades": len(rows),
            "wins": len(wins),
            "losses": len(losses),
            "winRate": round(len(wins) / len(rows) * 100, 1),
            "netPnl": round(net, 2),
            "grossProfit": round(gross_profit, 2),
            "grossLoss": round(gross_loss, 2),
            "profitFactor": round(gross_profit / abs(gross_loss), 2) if gross_loss else None,
            "expectancy": round(net / len(rows), 2),
            "avgWin": round(gross_profit / len(wins), 2) if wins else None,
            "avgLoss": round(gross_loss / len(losses), 2) if losses else None,
            "avgDurationSec": int(sum(int(r["duration_sec"]) for r in rows) / len(rows)),
            "maxDrawdown": round(max_dd, 2),
            "bestTrade": round(max(profits), 2),
            "worstTrade": round(min(profits), 2),
        }
        return {
            "days": days,
            "summary": summary,
            "r": _r_summary(r_curve, hit1r, len(rows)),
            "template": _plan_fidelity(rows, risks, plans, steps),
            "execution": _execution_cross(
                rows, self.store.execution_entry_map(login, since)
            ),
            "bySymbol": self._breakdown(rows, lambda r: r["symbol"], risks),
            "byHour": self._breakdown(
                rows,
                lambda r: f"{datetime.fromtimestamp(int(r['open_time'])).hour:02d}:00",
                risks,
            ),
            "byTag": self._breakdown(rows, lambda r: (r.get("tag") or "未标记"), risks),
            "byDuration": self._breakdown(
                rows, lambda r: _duration_bucket(int(r["duration_sec"])), risks
            ),
            "curve": curve,
            "rCurve": self._downsample(r_curve),
        }

    @staticmethod
    def _empty_stats(days: int) -> dict:
        return {
            "days": days,
            "summary": {
                "trades": 0,
                "wins": 0,
                "losses": 0,
                "winRate": None,
                "netPnl": 0.0,
                "grossProfit": 0.0,
                "grossLoss": 0.0,
                "profitFactor": None,
                "expectancy": None,
                "avgWin": None,
                "avgLoss": None,
                "avgDurationSec": 0,
                "maxDrawdown": 0.0,
                "bestTrade": None,
                "worstTrade": None,
            },
            "r": {
                "trades": 0,
                "coverage": None,
                "avgR": None,
                "totalR": 0.0,
                "bestR": None,
                "worstR": None,
                "maxDrawdownR": 0.0,
                "hit1R": None,
            },
            "template": {
                "planned": 0,
                "reached1R": 0,
                "breakeven": 0,
                "held": 0,
                "breakevenRate": None,
                "heldRate": None,
                "avgR": None,
            },
            "execution": {
                "matched": 0,
                "wins": {"trades": 0, "avgSlippage": None, "avgSpread": None},
                "losses": {"trades": 0, "avgSlippage": None, "avgSpread": None},
            },
            "bySymbol": [],
            "byHour": [],
            "byTag": [],
            "byDuration": [],
            "curve": [],
            "rCurve": [],
        }

    @staticmethod
    def _downsample(curve: list[dict], limit: int = 300) -> list[dict]:
        if len(curve) <= limit:
            return curve
        step = len(curve) / limit
        return [curve[int(index * step)] for index in range(limit)]

    @staticmethod
    def _r_curve(rows: list[dict], risks: dict[int, float]) -> tuple[list[dict], int]:
        cumulative = 0.0
        hit1r = 0
        curve: list[dict] = []
        for row in rows:
            risk = risks.get(int(row["position_id"]))
            r = _r_multiple(float(row["profit"]), risk)
            if r is None:
                continue
            mfe = row.get("mfe")
            if mfe is not None and float(mfe) + 1e-9 >= float(risk):
                hit1r += 1
            cumulative += r
            curve.append(
                {
                    "t": int(row["close_time"]),
                    "r": round(r, 2),
                    "cum": round(cumulative, 2),
                }
            )
        return curve, hit1r

    def _risks(self, rows: list[dict], login: int) -> dict[int, float]:
        """每笔交易的初始风险（账户货币）：成交价到下单止损的距离。"""
        sls = self.store.intent_sl_map(login, [int(row["position_id"]) for row in rows])
        out: dict[int, float] = {}
        for row in rows:
            ticket = int(row["position_id"])
            sl = sls.get(ticket)
            if sl is None:
                continue
            risk = self._risk_money(
                str(row["symbol"]),
                str(row["side"]),
                float(row["volume"]),
                float(row["entry_price"]),
                float(sl),
            )
            if risk is not None and risk > 0:
                out[ticket] = risk
        return out

    def _risk_money(
        self, symbol: str, side: str, volume: float, entry: float, sl: float
    ) -> float | None:
        if entry <= 0 or sl <= 0 or volume <= 0:
            return None
        key = (symbol, side, round(abs(entry - sl), 10), round(volume, 4))
        if key in self._risk_cache:
            return self._risk_cache[key]
        base = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        try:
            value = mt5.order_calc_profit(base, symbol, volume, entry, sl)
        except Exception:  # noqa: BLE001 - 终端不可用时按没有风险处理
            value = None
        risk = None
        if value is not None and math.isfinite(float(value)):
            risk = abs(float(value))
        if len(self._risk_cache) > 4000:
            self._risk_cache.clear()
        self._risk_cache[key] = risk
        return risk

    def _template_events(
        self, days: int
    ) -> tuple[dict[int, dict], dict[int, list[dict]]]:
        """从审计 JSONL 里取模板设计划 / 执行阶段的事件，按 ticket 归并。"""
        now = time.monotonic()
        if (
            self._plan_cache is not None
            and self._plan_cache[0] == days
            and now - self._plan_cache[1] < 30
        ):
            return self._plan_cache[2], self._plan_cache[3]
        plans: dict[int, dict] = {}
        steps: dict[int, list[dict]] = {}
        audit_dir = self.store.base_dir / "audit"
        today = datetime.now(timezone.utc).date()
        for offset in range(max(1, days) + 1):
            path = audit_dir / f"{today - timedelta(days=offset)}.jsonl"
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for line in lines:
                if "position.template_" not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue
                try:
                    ticket = int(payload.get("ticket") or 0)
                except (TypeError, ValueError):
                    continue
                if ticket <= 0:
                    continue
                kind = str(record.get("kind") or "")
                if kind == "position.template_plan.set":
                    plans[ticket] = payload
                elif kind == "position.template_step":
                    steps.setdefault(ticket, []).append(payload)
        self._plan_cache = (days, now, plans, steps)
        return plans, steps

    @staticmethod
    def _breakdown(
        rows: list[dict], key, risks: dict[int, float] | None = None
    ) -> list[dict]:
        buckets: dict[str, dict] = {}
        for row in rows:
            label = str(key(row))
            profit = float(row["profit"])
            item = buckets.setdefault(
                label,
                {"key": label, "trades": 0, "wins": 0, "pnl": 0.0, "rSum": 0.0, "rN": 0},
            )
            item["trades"] += 1
            item["pnl"] += profit
            if profit > 0:
                item["wins"] += 1
            if risks:
                r = _r_multiple(profit, risks.get(int(row["position_id"])))
                if r is not None:
                    item["rSum"] += r
                    item["rN"] += 1
        out = []
        for item in buckets.values():
            trades = item["trades"]
            out.append(
                {
                    "key": item["key"],
                    "trades": trades,
                    "wins": item["wins"],
                    "pnl": round(item["pnl"], 2),
                    "winRate": round(item["wins"] / trades * 100, 1),
                    "expectancy": round(item["pnl"] / trades, 2),
                    "avgR": round(item["rSum"] / item["rN"], 2) if item["rN"] else None,
                }
            )
        out.sort(key=lambda item: item["pnl"], reverse=True)
        return out

    # ---------- 截图 ----------

    def save_shot(
        self, login: int, position_id: int, data: str, meta: Any = None
    ) -> dict:
        raw = data.split(",", 1)[-1]
        try:
            blob = base64.b64decode(raw, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"截图解码失败: {exc}") from exc
        if len(blob) > 3 * 1024 * 1024:
            raise ValueError("截图超过 3MB")
        if not blob.startswith(b"\xff\xd8"):
            raise ValueError("只接受 JPEG 截图")
        folder = self.shots_dir / str(int(login or 0))
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{int(position_id)}.jpg"
        path.write_bytes(blob)

        cleaned = _clean_shot_meta(meta)
        sidecar = path.with_suffix(".json")
        try:
            if cleaned:
                sidecar.write_text(json.dumps(cleaned, ensure_ascii=False), encoding="utf-8")
            elif sidecar.is_file():
                # 新截图没有坐标时别留下上一张的旧锚点
                sidecar.unlink()
        except OSError:
            cleaned = None

        self.store.journal_set_shot(int(position_id), login)
        return {
            "positionId": int(position_id),
            "login": int(login or 0),
            "bytes": len(blob),
            "url": f"/shots/{int(login or 0)}/{path.name}",
            "annotated": bool(cleaned),
        }

    def shot_path(self, login: int, position_id: int) -> Path:
        return self.shots_dir / str(int(login or 0)) / f"{int(position_id)}.jpg"
