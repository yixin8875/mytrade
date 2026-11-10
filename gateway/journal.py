from __future__ import annotations

import base64
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import MetaTrader5 as mt5

from store import Store


def _weighted(pairs: list[tuple[float, float]]) -> float:
    total = sum(volume for volume, _ in pairs)
    return sum(volume * price for volume, price in pairs) / total if total else 0.0


def _close_kind(comment: str) -> str:
    text = comment.strip().lower()
    if text.startswith("tp"):
        return "tp"
    if text.startswith("sl"):
        return "sl"
    if text.startswith("so"):
        return "stop_out"
    return "manual"


class TradeJournal:
    """把历史成交配对成「一笔交易」，补 MFE/MAE、持有时长，并按维度出统计。

    只允许 MT5 工作线程调用（内部直接用 mt5 模块）。
    """

    def __init__(self, store: Store) -> None:
        self.store = store
        self._last_sync = 0.0
        self.shots_dir = store.base_dir / "data" / "shots"
        self.shots_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 同步 ----------

    def sync(self, force: bool = False) -> int:
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
            existing = self.store.journal_get(position_id)
            if existing:
                # 已经完整记录过；如果之后补上了截图，把 has_shot 补回来
                if not int(existing.get("has_shot") or 0) and self.shot_path(position_id).is_file():
                    self.store.journal_set_shot(position_id)
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
                    "tag": self.store.journal_tag_for_position(position_id),
                    "closed_by": _close_kind(str(getattr(last_exit, "comment", "") or "")),
                }
            )
            # 截图可能在日志记录之前就上传了（成交后立刻截图，收盘后才配对完成），
            # 这里按文件补一次标记，前端才知道有图可看
            if self.shot_path(position_id).is_file():
                self.store.journal_set_shot(position_id)
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

    def stats(self, days: int = 30) -> dict:
        since = int(time.time()) - max(1, days) * 86400
        rows = self.store.journal_list(limit=5000, since=since)
        rows.sort(key=lambda r: int(r["close_time"]))
        if not rows:
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
                "bySymbol": [],
                "byHour": [],
                "byTag": [],
                "curve": [],
            }

        profits = [float(r["profit"]) for r in rows]
        wins = [p for p in profits if p > 0]
        losses = [p for p in profits if p < 0]
        gross_profit = sum(wins)
        gross_loss = sum(losses)
        net = sum(profits)

        cumulative = 0.0
        peak = 0.0
        max_dd = 0.0
        curve: list[dict] = []
        for row in rows:
            cumulative += float(row["profit"])
            peak = max(peak, cumulative)
            max_dd = max(max_dd, peak - cumulative)
            curve.append(
                {
                    "t": int(row["close_time"]),
                    "pnl": round(float(row["profit"]), 2),
                    "cum": round(cumulative, 2),
                }
            )
        if len(curve) > 300:
            step = len(curve) / 300
            curve = [curve[int(index * step)] for index in range(300)]

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
            "bySymbol": self._breakdown(rows, lambda r: r["symbol"]),
            "byHour": self._breakdown(
                rows,
                lambda r: f"{datetime.fromtimestamp(int(r['open_time'])).hour:02d}:00",
            ),
            "byTag": self._breakdown(rows, lambda r: (r.get("tag") or "未标记")),
            "curve": curve,
        }

    @staticmethod
    def _breakdown(rows: list[dict], key) -> list[dict]:
        buckets: dict[str, dict] = {}
        for row in rows:
            label = str(key(row))
            item = buckets.setdefault(label, {"key": label, "trades": 0, "wins": 0, "pnl": 0.0})
            item["trades"] += 1
            item["pnl"] += float(row["profit"])
            if float(row["profit"]) > 0:
                item["wins"] += 1
        out = []
        for item in buckets.values():
            item["pnl"] = round(item["pnl"], 2)
            item["winRate"] = round(item["wins"] / item["trades"] * 100, 1)
            out.append(item)
        out.sort(key=lambda item: item["pnl"], reverse=True)
        return out

    # ---------- 截图 ----------

    def save_shot(self, position_id: int, data: str) -> dict:
        raw = data.split(",", 1)[-1]
        try:
            blob = base64.b64decode(raw, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"截图解码失败: {exc}") from exc
        if len(blob) > 3 * 1024 * 1024:
            raise ValueError("截图超过 3MB")
        if not blob.startswith(b"\xff\xd8"):
            raise ValueError("只接受 JPEG 截图")
        path = self.shots_dir / f"{int(position_id)}.jpg"
        path.write_bytes(blob)
        self.store.journal_set_shot(int(position_id))
        return {"positionId": int(position_id), "bytes": len(blob), "url": f"/shots/{path.name}"}

    def shot_path(self, position_id: int) -> Path:
        return self.shots_dir / f"{int(position_id)}.jpg"
