from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from config import BASE_DIR, Config
from mt5_worker import GatewayError, Mt5Worker
from store import Store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mytrade.gateway")

cfg = Config.load()
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker.start(asyncio.get_running_loop())
    log.info("MT5 worker started; ws://%s:%s/ws", cfg.host, cfg.port)
    yield
    worker.stop()
    log.info("MT5 worker stopped")


app = FastAPI(title="MyTrade Gateway", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return worker.health()


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
async def shot(name: str) -> FileResponse:
    """交易日志里的图表截图/坐标元数据，只允许 <positionId>.jpg 或 .json。"""
    return _shot_file(name)


@app.get("/shots/{login}/{name}")
async def account_shot(login: str, name: str) -> FileResponse:
    """多账户截图：data/shots/<login>/<positionId>.jpg|.json。"""
    return _shot_file(name, login)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
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

            try:
                future = worker.submit(method, params)
                result = await asyncio.wrap_future(future)
                await send(ws, {"id": req_id, "result": result})
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
    log.info("starting MyTrade gateway on %s:%s (mode=%s)", cfg.host, cfg.port, cfg.trade_mode)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="warning")
