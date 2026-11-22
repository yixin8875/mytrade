from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from config import BASE_DIR, Config
from lifecycle import parent_pid, watch_parent
from mt5_worker import MUTATING_METHODS, GatewayError, Mt5Worker, command_timeout
from security import origin_allowed, request_allowed, resolve_allowed_origins
from store import Store

LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        # 落盘日志供诊断包读取；2MB × 4 个文件足够定位最近的崩溃
        RotatingFileHandler(
            LOG_DIR / "gateway.log",
            maxBytes=2_000_000,
            backupCount=3,
            encoding="utf-8",
        ),
    ],
)
log = logging.getLogger("mytrade.gateway")

cfg = Config.load()
# 只接受 Tally 自己的页面连接；白名单见 security.py（默认 + config.allowed_origins）
ALLOWED_ORIGINS = resolve_allowed_origins(getattr(cfg, "allowed_origins", None))
store = Store(BASE_DIR)
clients: dict[WebSocket, asyncio.Lock] = {}


async def publish(event: str, data: Any) -> None:
    message = {"event": event, "data": data}
    for ws in list(clients.keys()):
        lock = clients.get(ws)
        if lock is None:
            continue
        try:
            async with lock:
                await ws.send_json(message)
        except Exception:  # noqa: BLE001
            clients.pop(ws, None)


worker = Mt5Worker(cfg, store, publish)


async def send(ws: WebSocket, payload: dict) -> None:
    lock = clients.get(ws)
    if lock is None:
        return
    async with lock:
        await ws.send_json(payload)


def _retrieve_exception(fut: asyncio.Future) -> None:
    """超时后工作线程仍会完成任务；提前取走异常，避免 asyncio 打“异常未读取”日志。"""
    if not fut.cancelled():
        fut.exception()


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker.start(asyncio.get_running_loop())
    log.info("MT5 worker started; ws://%s:%s/ws", cfg.host, cfg.port)
    log.info("allowed origins: %s", ", ".join(ALLOWED_ORIGINS))
    yield
    worker.stop()
    log.info("MT5 worker stopped")


app = FastAPI(title="Tally Gateway", version="0.7.17", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_methods=["GET"],
    allow_headers=[],
    allow_credentials=False,
)


@app.get("/health")
async def health() -> dict:
    return worker.health()


def _require_own_page(request: Request) -> None:
    """截图只给 Tally 自己的页面读：别的网站知道文件名也拿不到。"""
    if not request_allowed(
        request.headers.get("origin"),
        request.headers.get("referer"),
        ALLOWED_ORIGINS,
    ):
        raise HTTPException(status_code=403, detail="forbidden")


def _shot_file(name: str, login: str | None = None) -> FileResponse:
    stem, _, ext = name.rpartition(".")
    if ext not in ("jpg", "json") or not stem.isdigit():
        raise HTTPException(status_code=404, detail="not found")
    if login is not None and not login.isdigit():
        raise HTTPException(status_code=404, detail="not found")
    root = BASE_DIR / "data" / "shots"
    path = root / login / name if login is not None else root / name
    if not path.is_file():
        # 旧版截图平铺在 shots 根目录，按账户找不到时回退
        path = root / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    media = "image/jpeg" if ext == "jpg" else "application/json"
    return FileResponse(path, media_type=media)


@app.get("/shots/{name}")
async def shot(name: str, request: Request) -> FileResponse:
    """交易日志里的图表截图/坐标元数据，只允许 <positionId>.jpg 或 .json。"""
    _require_own_page(request)
    return _shot_file(name)


@app.get("/shots/{login}/{name}")
async def account_shot(login: str, name: str, request: Request) -> FileResponse:
    """多账户截图：data/shots/<login>/<positionId>.jpg|.json。"""
    _require_own_page(request)
    return _shot_file(name, login)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if not origin_allowed(origin, ALLOWED_ORIGINS):
        # 浏览器一定会带 Origin；不是 Tally 的页面就直接拒绝握手
        log.warning("rejected websocket from origin %r", origin)
        await ws.close(code=1008)
        return
    await ws.accept()
    clients[ws] = asyncio.Lock()
    log.info("client connected (%d total)", len(clients))
    try:
        await send(ws, {"event": "gateway", "data": worker.health()})
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await send(ws, {"id": None, "error": {"code": "BAD_JSON", "message": "无效 JSON"}})
                continue

            req_id = msg.get("id")
            method = str(msg.get("method") or "")
            params = msg.get("params") or {}
            if not isinstance(params, dict):
                await send(
                    ws,
                    {"id": req_id, "error": {"code": "BAD_PARAMS", "message": "params 必须是对象"}},
                )
                continue

            timeout = command_timeout(method)
            try:
                future = worker.submit(method, params)
                pending = asyncio.wrap_future(future)
                pending.add_done_callback(_retrieve_exception)
                result = await asyncio.wait_for(asyncio.shield(pending), timeout)
                await send(ws, {"id": req_id, "result": result})
            except asyncio.TimeoutError:
                if method in MUTATING_METHODS:
                    # 下单类命令可能已经在券商侧生效：不能报失败，只能报结果未知
                    worker.request_reconcile(method)
                    log.warning("command %s timed out after %.1fs; result unknown", method, timeout)
                    await send(
                        ws,
                        {
                            "id": req_id,
                            "error": {
                                "code": "RESULT_UNKNOWN",
                                "message": (
                                    f"{method} 超过 {timeout:.0f} 秒未返回，结果未知；"
                                    "网关恢复后会自动对账，请稍后核对持仓与挂单。"
                                ),
                                "detail": {"method": method, "timeout": timeout},
                            },
                        },
                    )
                else:
                    log.warning("command %s timed out after %.1fs", method, timeout)
                    await send(
                        ws,
                        {
                            "id": req_id,
                            "error": {
                                "code": "TIMEOUT",
                                "message": f"命令超时：{method}（{timeout:.0f} 秒）",
                                "detail": {"method": method, "timeout": timeout},
                            },
                        },
                    )
                continue
            except GatewayError as exc:
                await send(
                    ws,
                    {
                        "id": req_id,
                        "error": {
                            "code": exc.code,
                            "message": exc.message,
                            "detail": exc.detail,
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001
                log.exception("command failed: %s", method)
                await send(ws, {"id": req_id, "error": {"code": "INTERNAL", "message": str(exc)}})
    except WebSocketDisconnect:
        pass
    finally:
        clients.pop(ws, None)
        log.info("client disconnected (%d total)", len(clients))


if __name__ == "__main__":
    log.info(
        "starting Tally gateway on %s:%s (mode=%s, data=%s)",
        cfg.host,
        cfg.port,
        cfg.trade_mode,
        BASE_DIR,
    )
    server = uvicorn.Server(
        uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning")
    )
    owner = parent_pid()
    if owner:
        log.info("watching parent process %s", owner)
        watch_parent(owner, lambda: setattr(server, "should_exit", True))
    server.run()
