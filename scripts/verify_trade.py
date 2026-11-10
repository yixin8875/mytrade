"""MyTrade 下单链路冒烟测试（仅允许模拟账户）。

用法：
    python scripts/verify_trade.py [SYMBOL] [WAIT_ALGO_SECONDS]

流程：
    1. 等待 MT5 打开 Algo Trading（最多 WAIT_ALGO_SECONDS 秒）
    2. 切到 demo 交易模式
    3. 挂一张远离市价的限价单 → 改价 → 撤单
    4. 市价买入最小手数 → 改 SL/TP → 平仓
    5. 打印逐步结果；异常时清理本脚本创建的挂单和持仓
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid

import websockets

WS_URL = "ws://127.0.0.1:8765/ws"
SYMBOL = sys.argv[1] if len(sys.argv) > 1 else "AUDCAD"
WAIT_ALGO = float(sys.argv[2]) if len(sys.argv) > 2 else 600.0

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def out(step: str, text: str = "") -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {step} {text}".rstrip(), flush=True)


class Client:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.seq = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.ticks: dict[str, dict] = {}
        self.reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                req_id = msg.get("id")
                if req_id is not None and req_id in self.pending:
                    fut = self.pending.pop(req_id)
                    if fut.done():
                        continue
                    err = msg.get("error")
                    if err:
                        fut.set_exception(
                            RuntimeError(f"{err.get('code')}: {err.get('message')}")
                        )
                    else:
                        fut.set_result(msg.get("result"))
                elif msg.get("event") == "tick":
                    data = msg.get("data") or {}
                    if data.get("symbol"):
                        self.ticks[data["symbol"]] = data
        except Exception as exc:  # noqa: BLE001
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(exc)

    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        self.seq += 1
        req_id = self.seq
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        await self.ws.send(json.dumps({"id": req_id, "method": method, "params": params or {}}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(req_id, None)

    async def tick(self, symbol: str, timeout: float = 10.0) -> dict:
        await self.call("quotes.subscribe", {"symbols": [symbol]})
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            found = self.ticks.get(symbol)
            if found:
                return found
            await asyncio.sleep(0.2)
        raise RuntimeError(f"{symbol} 10 秒内没有收到报价")

    async def close(self) -> None:
        self.reader.cancel()


async def wait_for_algo(client: Client) -> dict:
    out("0/6", f"等待 MT5 Algo Trading 开启（最多 {int(WAIT_ALGO)} 秒）…")
    end = time.monotonic() + WAIT_ALGO
    last_note = 0.0
    while time.monotonic() < end:
        health = await client.call("system.health")
        terminal = health.get("terminal") or {}
        if terminal.get("tradeAllowed"):
            out("0/6", "Algo Trading 已开启")
            return health
        now = time.monotonic()
        if now - last_note > 20:
            out("0/6", "仍在等待：请在 MT5 工具栏点击「算法交易 / Algo Trading」按钮")
            last_note = now
        await asyncio.sleep(2)
    raise SystemExit("TIMEOUT: MT5 Algo Trading 未开启，测试取消（没有发出任何订单）")


def find_by_comment(items: list[dict], client_id: str) -> dict | None:
    for item in items:
        if str(item.get("comment") or "").startswith(client_id[:20]):
            return item
    return None


async def wait_until(client: Client, method: str, predicate, timeout: float = 5.0):
    """券商回报有延迟，轮询到条件成立为止。"""
    end = time.monotonic() + timeout
    data = await client.call(method)
    while time.monotonic() < end:
        if predicate(data):
            return data
        await asyncio.sleep(0.2)
        data = await client.call(method)
    return data


async def main() -> int:
    async with websockets.connect(WS_URL, max_size=8 * 1024 * 1024) as ws:
        client = Client(ws)
        created_order: int | None = None
        created_position: int | None = None
        report: dict = {"symbol": SYMBOL, "steps": []}

        try:
            health = await wait_for_algo(client)
            account = health.get("account") or {}
            if account.get("accountType") != "demo":
                raise SystemExit(
                    f"拒绝执行：当前账户类型是 {account.get('accountType')}，只允许模拟账户"
                )
            out(
                "1/6",
                f"账户 {account.get('login')} @ {account.get('server')} "
                f"余额 {account.get('balance')} {account.get('currency')}",
            )
            report["account"] = {
                "login": account.get("login"),
                "server": account.get("server"),
                "balance": account.get("balance"),
                "equity": account.get("equity"),
            }

            info = await client.call("symbol.info", {"symbol": SYMBOL})
            digits = int(info["digits"])
            point = float(info["point"])
            volume = max(float(info["minVolume"]), 0.01)
            out(
                "2/6",
                f"{SYMBOL} digits={digits} point={point} 最小手数={info['minVolume']} "
                f"stopsLevel={info['stopsLevelPoints']}点 测试手数={volume}",
            )
            report["symbolInfo"] = {
                "digits": digits,
                "point": point,
                "volume": volume,
                "stopsLevelPoints": info["stopsLevelPoints"],
            }

            await client.call("system.setTradeMode", {"mode": "demo"})
            out("3/6", "已切换到 demo 交易模式")

            tick = await client.tick(SYMBOL)
            bid, ask = float(tick["bid"]), float(tick["ask"])
            out("3/6", f"当前报价 bid={bid} ask={ask} 点差={(ask - bid) / point:.0f} 点")

            # --- 挂单 / 改单 / 撤单 ---
            limit_price = round(bid - 300 * point, digits)
            cid = f"vt{int(time.time())}{uuid.uuid4().hex[:6]}"
            placed = await client.call(
                "order.place",
                {
                    "clientOrderId": cid,
                    "symbol": SYMBOL,
                    "side": "buy",
                    "type": "limit",
                    "volume": volume,
                    "price": limit_price,
                },
            )
            created_order = int(placed["order"])
            out("4/6", f"限价买单已提交 ticket={created_order} price={limit_price}")

            orders = await client.call("orders.get")
            order = next((o for o in orders if int(o["ticket"]) == created_order), None)
            if order is None:
                raise RuntimeError("下单返回成功，但挂单列表里找不到该 ticket")
            out("4/6", f"挂单列表已出现：{order['type']} {order['side']} @ {order['price']}")

            moved_price = round(bid - 340 * point, digits)
            await client.call("order.modify", {"ticket": created_order, "price": moved_price})
            orders = await client.call("orders.get")
            order = next((o for o in orders if int(o["ticket"]) == created_order), None)
            if order is None or abs(float(order["price"]) - moved_price) > point / 2:
                raise RuntimeError(f"改价未生效：期望 {moved_price}，实际 {order and order['price']}")
            out("4/6", f"改价成功：{limit_price} → {moved_price}")

            await client.call("order.cancel", {"ticket": created_order})
            ticket_placed = int(placed["order"])
            created_order = None
            orders = await wait_until(
                client,
                "orders.get",
                lambda rows: all(int(o["ticket"]) != ticket_placed for o in rows),
            )
            if any(int(o["ticket"]) == ticket_placed for o in orders):
                raise RuntimeError("撤单后挂单仍然存在")
            out("4/6", "撤单成功，挂单列表已清空")
            report["steps"].append({"step": "pending_order", "status": "ok"})

            # --- 市价单 / 改 SLTP / 平仓 ---
            tick = await client.tick(SYMBOL)
            out("5/6", f"市价买入 {volume} 手 {SYMBOL}（ask={tick['ask']}）")
            cid2 = f"vt{int(time.time())}{uuid.uuid4().hex[:6]}"
            filled = await client.call(
                "order.place",
                {
                    "clientOrderId": cid2,
                    "symbol": SYMBOL,
                    "side": "buy",
                    "type": "market",
                    "volume": volume,
                },
            )
            out(
                "5/6",
                f"成交回报 retcode={filled['retcode']} deal={filled['deal']} "
                f"成交价={filled['price']} 手数={filled['volume']}",
            )

            positions = await client.call("positions.get")
            pos = find_by_comment(positions, cid2)
            if pos is None:
                raise RuntimeError("成交回报成功，但持仓列表里找不到该订单")
            created_position = int(pos["ticket"])
            out(
                "5/6",
                f"持仓已出现 ticket={created_position} {pos['side']} {pos['volume']} 手 "
                f"@ {pos['openPrice']}",
            )

            min_stops = max(float(info["stopsLevelPoints"]) * point, 100 * point)
            entry = float(pos["openPrice"])
            sl = round(entry - max(150 * point, min_stops + 50 * point), digits)
            tp = round(entry + max(300 * point, min_stops + 50 * point), digits)
            await client.call(
                "position.modify", {"ticket": created_position, "sl": sl, "tp": tp}
            )
            positions = await client.call("positions.get")
            pos = next((p for p in positions if int(p["ticket"]) == created_position), None)
            if pos is None or pos["sl"] is None or pos["tp"] is None:
                raise RuntimeError("修改 SL/TP 后持仓未带回止损止盈")
            out("5/6", f"SL/TP 修改成功：SL={pos['sl']} TP={pos['tp']}")
            report["steps"].append({"step": "market_position", "status": "ok"})

            close_ticket = created_position
            await client.call("position.close", {"ticket": close_ticket})
            created_position = None
            positions = await wait_until(
                client,
                "positions.get",
                lambda rows: all(int(p["ticket"]) != close_ticket for p in rows),
            )
            if any(int(p["ticket"]) == close_ticket for p in positions):
                raise RuntimeError("平仓后持仓仍然存在")
            out("6/6", "平仓成功，持仓已清空")

            account_after = await client.call("account.get")
            out(
                "6/6",
                f"账户余额 {account_after['balance']} 净值 {account_after['equity']} "
                f"保证金 {account_after['margin']}",
            )
            report["accountAfter"] = {
                "balance": account_after["balance"],
                "equity": account_after["equity"],
                "margin": account_after["margin"],
            }
            report["steps"].append({"step": "close_position", "status": "ok"})

            # 恢复只读，避免测试结束后界面停留在可交易状态
            await client.call("system.setTradeMode", {"mode": "readonly"})
            out("6/6", "已恢复只读模式")

            report["status"] = "PASS"
            print("RESULT " + json.dumps(report, ensure_ascii=False), flush=True)
            return 0
        except BaseException as exc:  # noqa: BLE001
            out("ERR", f"{type(exc).__name__}: {exc}")
            report["status"] = "FAIL"
            report["error"] = f"{type(exc).__name__}: {exc}"
            for cleanup in (
                ("order.cancel", {"ticket": created_order}) if created_order else None,
                ("position.close", {"ticket": created_position}) if created_position else None,
            ):
                if not cleanup:
                    continue
                try:
                    await client.call(cleanup[0], cleanup[1])
                    out("CLN", f"已清理 {cleanup[0]} {cleanup[1]}")
                except Exception as clean_exc:  # noqa: BLE001
                    out("CLN", f"清理失败 {cleanup[0]}: {clean_exc}")
            print("RESULT " + json.dumps(report, ensure_ascii=False), flush=True)
            return 1
        finally:
            await client.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
