"""错过机会：记录「看到了但没做」的 setup，并用观察后的 M1 走一遍计划。

模拟只是理论值：不含点差、滑点、手续费，也不进入任何交易绩效统计。
同一根 M1 同时触及止损和目标时按「先到止损」处理，保持保守。
"""

from __future__ import annotations

import time
from typing import Any, Callable

from store import Store

MAX_BARS = 5000
WINDOW_SECONDS = 3 * 86400
SIDES = ("buy", "sell")
MAX_SYMBOL = 32
MAX_NOTE = 2000

FEE_NOTE = "理论值，不含点差/滑点/手续费"


class MissedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        number = float(value)
        return number if number == number else None
    except (TypeError, ValueError):
        return None


def simulate(
    bars: list[dict[str, Any]],
    side: str,
    observed_at: int,
    entry: float | None,
    sl: float | None,
    tp: float | None,
    *,
    market: bool = False,
    now: int | None = None,
) -> dict[str, Any]:
    """用观察时间之后的 M1 走一遍计划，返回触发 / 止损 / 目标 / 未结束。

    bars 需按时间升序，字段 time/open/high/low/close。
    """
    if side not in SIDES:
        raise MissedError("BAD_SIDE", "方向只能是 buy / sell")
    ordered = [bar for bar in bars if int(bar.get("time") or 0) >= int(observed_at)]
    ordered = ordered[:MAX_BARS]
    if not ordered:
        return {
            "status": "no_data",
            "note": "观察时间之后没有 M1 数据",
            "bars": 0,
            "windowEnd": int(observed_at) + WINDOW_SECONDS,
        }

    last_time = int(ordered[-1]["time"])
    window_end = int(observed_at) + WINDOW_SECONDS
    complete = (now is not None and int(now) >= window_end) or last_time >= window_end

    planned = _float_or_none(entry)
    stop = _float_or_none(sl)
    target = _float_or_none(tp)
    is_buy = side == "buy"

    entry_index: int | None = None
    entry_price: float | None = None
    if market or planned is None:
        entry_index = 0
        entry_price = float(ordered[0]["open"])
    else:
        for index, bar in enumerate(ordered):
            low = float(bar["low"])
            high = float(bar["high"])
            if (is_buy and low <= planned) or (not is_buy and high >= planned):
                entry_index = index
                entry_price = planned
                break
    if entry_index is None or entry_price is None:
        return {
            "status": "no_entry",
            "note": "窗口内没有触及计划入场价",
            "bars": len(ordered),
            "windowEnd": window_end,
            "lastPrice": float(ordered[-1]["close"]),
        }

    risk = abs(entry_price - stop) if stop is not None else 0.0
    direction = 1.0 if is_buy else -1.0

    # 市价入场时价格可能已经跑过目标/止损，这种计划已经无效，不能记成「到目标」
    if target is not None and (
        (is_buy and entry_price >= target) or (not is_buy and entry_price <= target)
    ):
        return {
            "status": "invalid",
            "note": "入场价已经在目标之外，检查计划方向与价位",
            "entryAt": int(ordered[entry_index]["time"]),
            "entryPrice": entry_price,
            "bars": len(ordered),
            "windowEnd": window_end,
        }
    if stop is not None and (
        (is_buy and entry_price <= stop) or (not is_buy and entry_price >= stop)
    ):
        return {
            "status": "invalid",
            "note": "入场价已经越过止损，检查计划方向与价位",
            "entryAt": int(ordered[entry_index]["time"]),
            "entryPrice": entry_price,
            "bars": len(ordered),
            "windowEnd": window_end,
        }

    mfe_price = entry_price
    mae_price = entry_price
    exit_price: float | None = None
    exit_time: int | None = None
    status = "open"
    bars_held = 0

    for bar in ordered[entry_index:]:
        high = float(bar["high"])
        low = float(bar["low"])
        if is_buy:
            mfe_price = max(mfe_price, high)
            mae_price = min(mae_price, low)
            sl_hit = stop is not None and low <= stop
            tp_hit = target is not None and high >= target
        else:
            mfe_price = min(mfe_price, low)
            mae_price = max(mae_price, high)
            sl_hit = stop is not None and high >= stop
            tp_hit = target is not None and low <= target
        bars_held += 1
        if sl_hit:
            # 同根 K 线同时触及两边时按先到止损处理
            exit_price, exit_time, status = stop, int(bar["time"]), "sl"
            break
        if tp_hit:
            exit_price, exit_time, status = target, int(bar["time"]), "tp"
            break

    if exit_price is None:
        exit_price = float(ordered[-1]["close"])
        exit_time = last_time
        status = "timeout" if complete else "open"

    def in_r(price: float) -> float | None:
        return round((price - entry_price) / risk * direction, 4) if risk > 0 else None

    return {
        "status": status,
        "note": FEE_NOTE,
        "entryAt": int(ordered[entry_index]["time"]),
        "entryPrice": entry_price,
        "exitAt": exit_time,
        "exitPrice": exit_price,
        "r": in_r(exit_price),
        "mfeR": in_r(mfe_price),
        "maeR": in_r(mae_price),
        "barsHeld": bars_held,
        "bars": len(ordered),
        "windowEnd": window_end,
        "complete": complete,
    }


class Missed:
    def __init__(self, store: Store) -> None:
        self.store = store

    def _payload(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "symbol": row["symbol"],
            "side": row["side"],
            "observedAt": int(row["observed_at"]),
            "entryPrice": row.get("entry_price"),
            "sl": row.get("sl"),
            "tp": row.get("tp"),
            "playbookId": row.get("playbook_id"),
            "note": row.get("note") or "",
            "sim": row.get("sim"),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def list(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        limit = max(1, min(500, int(params.get("limit") or 200)))
        rows = self.store.missed_list(login, limit)
        items = [self._payload(row) for row in rows]
        simulated = [
            item["sim"]
            for item in items
            if item.get("sim") and item["sim"].get("status") in ("tp", "sl", "timeout")
        ]
        total_r = sum(float(sim.get("r") or 0) for sim in simulated if sim.get("r") is not None)
        return {
            "missed": items,
            "summary": {
                "total": len(items),
                "simulated": len(simulated),
                "hits": sum(1 for sim in simulated if sim.get("status") == "tp"),
                "stops": sum(1 for sim in simulated if sim.get("status") == "sl"),
                "totalR": round(total_r, 2) if simulated else None,
            },
        }

    def _require(self, missed_id: int, login: int) -> dict[str, Any]:
        row = self.store.missed_get(missed_id, login)
        if row is None:
            raise MissedError("NOT_FOUND", "错过机会不存在")
        return row

    def save(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        symbol = str(params.get("symbol") or "").strip().upper()[:MAX_SYMBOL]
        if not symbol:
            raise MissedError("BAD_SYMBOL", "品种不能为空")
        side = str(params.get("side") or "")
        if side not in SIDES:
            raise MissedError("BAD_SIDE", "方向只能是 buy / sell")
        try:
            observed_at = int(params.get("observedAt") or 0)
        except (TypeError, ValueError) as exc:
            raise MissedError("BAD_TIME", "观察时间无效") from exc
        if observed_at < 946684800 or observed_at > int(time.time()) + 86400:
            raise MissedError("BAD_TIME", "观察时间不在合理范围内")
        entry = _float_or_none(params.get("entryPrice"))
        sl = _float_or_none(params.get("sl"))
        tp = _float_or_none(params.get("tp"))
        if entry is not None:
            if side == "buy":
                if sl is not None and sl >= entry:
                    raise MissedError("BAD_PLAN", "做多时止损必须低于入场价")
                if tp is not None and tp <= entry:
                    raise MissedError("BAD_PLAN", "做多时目标必须高于入场价")
            else:
                if sl is not None and sl <= entry:
                    raise MissedError("BAD_PLAN", "做空时止损必须高于入场价")
                if tp is not None and tp >= entry:
                    raise MissedError("BAD_PLAN", "做空时目标必须低于入场价")
        playbook_id = str(params.get("playbookId") or "").strip()[:40] or None
        if playbook_id and self.store.playbook_get(playbook_id, login) is None:
            raise MissedError("NOT_FOUND", "策略不存在")
        note = str(params.get("note") or "")[:MAX_NOTE]
        missed_id = int(params.get("id") or 0) or None
        saved = self.store.missed_save(
            symbol, side, observed_at, entry, sl, tp, playbook_id, note, login, missed_id
        )
        if saved is None:
            raise MissedError("NOT_FOUND", "错过机会不存在")
        return {"missed": self._payload(saved)}

    def delete(self, params: dict[str, Any], login: int) -> dict[str, Any]:
        missed_id = int(params.get("id") or 0)
        if not missed_id or not self.store.missed_delete(missed_id, login):
            raise MissedError("NOT_FOUND", "错过机会不存在")
        return {"deleted": True}

    def simulate(
        self,
        params: dict[str, Any],
        login: int,
        fetch_bars: Callable[[str, int, int], list[dict[str, Any]]],
    ) -> dict[str, Any]:
        missed_id = int(params.get("id") or 0)
        if not missed_id:
            raise MissedError("BAD_ID", "缺少 id")
        row = self._require(missed_id, login)
        observed_at = int(row["observed_at"])
        end = observed_at + WINDOW_SECONDS
        bars = fetch_bars(str(row["symbol"]), observed_at - 60, end)
        sim = simulate(
            bars,
            str(row["side"]),
            observed_at,
            row.get("entry_price"),
            row.get("sl"),
            row.get("tp"),
            now=int(time.time()),
        )
        self.store.missed_update_sim(missed_id, sim, login)
        return {"missed": self._payload(self._require(missed_id, login))}
