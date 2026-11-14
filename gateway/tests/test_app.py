"""网关入口：健康检查、截图白名单、WebSocket 协议与广播。

app.py 在导入时就创建 Config/Store/Worker，测试里先替换这三个依赖，
再按文件路径单独加载一份模块，避免碰到真实数据目录。
"""

import asyncio
import concurrent.futures
import importlib.util
import json
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mt5_worker import GatewayError

APP_PATH = Path(__file__).resolve().parents[1] / "app.py"


class FakeWorker:
    def __init__(self) -> None:
        self.health_value = {"ok": True, "mode": "demo", "login": 1}
        self.started_loop = None
        self.stopped = 0
        self.commands: list[tuple[str, dict]] = []
        self.results: dict[str, object] = {}

    def health(self) -> dict:
        return self.health_value

    def start(self, loop) -> None:
        self.started_loop = loop

    def stop(self) -> None:
        self.stopped += 1

    def submit(self, method: str, params: dict):
        self.commands.append((method, params))
        future: concurrent.futures.Future = concurrent.futures.Future()
        value = self.results.get(method)
        if isinstance(value, BaseException):
            future.set_exception(value)
        else:
            future.set_result(value)
        return future


class FakeSocket:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.sent: list[dict] = []

    async def send_json(self, message: dict) -> None:
        if self.fail:
            raise RuntimeError("client gone")
        self.sent.append(message)


def load_app():
    """按路径加载一份干净的 app 模块，不写 sys.modules。"""
    spec = importlib.util.spec_from_file_location("gateway_app_under_test", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def gateway(tmp_path, monkeypatch):
    import config
    import store as store_mod
    import mt5_worker

    worker = FakeWorker()
    cfg = types.SimpleNamespace(host="127.0.0.1", port=8765)
    monkeypatch.setattr(config.Config, "load", classmethod(lambda cls: cfg))
    monkeypatch.setattr(store_mod, "Store", lambda base_dir: object())
    monkeypatch.setattr(mt5_worker, "Mt5Worker", lambda c, s, publish: worker)

    module = load_app()
    module.BASE_DIR = tmp_path
    return module, worker


@pytest.fixture()
def client(gateway):
    module, _ = gateway
    with TestClient(module.app) as test_client:
        yield test_client


def write_shot(root: Path, name: str, body: bytes = b"jpg") -> Path:
    path = root / "data" / "shots" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


# ---------- 生命周期与健康检查 ----------


def test_健康检查返回worker状态(gateway):
    module, worker = gateway

    with TestClient(module.app) as test_client:
        response = test_client.get("/health")

        assert response.status_code == 200
        assert response.json() == worker.health_value
        assert worker.started_loop is not None

    assert worker.stopped == 1


# ---------- 截图 ----------


def test_未分账户的截图从根目录读取(gateway):
    module, _ = gateway
    write_shot(module.BASE_DIR, "12.jpg", b"image")

    with TestClient(module.app) as test_client:
        response = test_client.get("/shots/12.jpg")
        write_shot(module.BASE_DIR, "12.json", b'{"x": 1}')
        meta_response = test_client.get("/shots/12.json")

    assert response.status_code == 200
    assert response.content == b"image"
    assert response.headers["content-type"] == "image/jpeg"
    assert meta_response.headers["content-type"] == "application/json"


def test_分账户截图优先账户目录(gateway):
    module, _ = gateway
    write_shot(module.BASE_DIR, "7.jpg", b"root")
    write_shot(module.BASE_DIR, "888/7.jpg", b"account")

    with TestClient(module.app) as test_client:
        response = test_client.get("/shots/888/7.jpg")

    assert response.status_code == 200
    assert response.content == b"account"


def test_账户目录缺失时回退根目录(gateway):
    module, _ = gateway
    write_shot(module.BASE_DIR, "7.jpg", b"root")

    with TestClient(module.app) as test_client:
        response = test_client.get("/shots/888/7.jpg")

    assert response.status_code == 200
    assert response.content == b"root"


@pytest.mark.parametrize(
    "url",
    [
        "/shots/abc.jpg",
        "/shots/12.34.jpg",
        "/shots/12.png",
        "/shots/12",
        "/shots/12.exe",
        "/shots/888/abc.jpg",
        "/shots/abc/12.jpg",
    ],
)
def test_非法截图名一律404(client, url):
    assert client.get(url).status_code == 404


def test_截图不存在时404(client):
    assert client.get("/shots/404.jpg").status_code == 404
    assert client.get("/shots/888/404.jpg").status_code == 404


# ---------- WebSocket RPC ----------


def open_ws(client):
    manager = client.websocket_connect("/ws")
    ws = manager.__enter__()
    hello = ws.receive_json()
    return manager, ws, hello


def test_连接后先推送网关状态(client, gateway):
    _, worker = gateway
    manager, _, hello = open_ws(client)

    try:
        assert hello == {"event": "gateway", "data": worker.health_value}
    finally:
        manager.__exit__(None, None, None)


def test_命令结果按id返回(client, gateway):
    _, worker = gateway
    worker.results["account.info"] = {"login": 1, "balance": 1000}
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text(json.dumps({"id": 7, "method": "account.info", "params": {"a": 1}}))
        reply = ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert reply == {"id": 7, "result": {"login": 1, "balance": 1000}}
    assert worker.commands == [("account.info", {"a": 1})]


def test_缺少params时传空对象(client, gateway):
    _, worker = gateway
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text(json.dumps({"id": 1, "method": "symbols.list"}))
        ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert worker.commands == [("symbols.list", {})]


def test_业务错误返回错误码与详情(client, gateway):
    _, worker = gateway
    worker.results["trade.place"] = GatewayError("READ_ONLY", "只读模式", {"limit": 1})
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text(json.dumps({"id": 2, "method": "trade.place"}))
        reply = ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert reply == {
        "id": 2,
        "error": {"code": "READ_ONLY", "message": "只读模式", "detail": {"limit": 1}},
    }


def test_未知异常返回INTERNAL(client, gateway):
    _, worker = gateway
    worker.results["bad.method"] = RuntimeError("boom")
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text(json.dumps({"id": 3, "method": "bad.method"}))
        reply = ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert reply == {"id": 3, "error": {"code": "INTERNAL", "message": "boom"}}


def test_无效JSON返回BAD_JSON(client):
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text("{not json")
        reply = ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert reply == {"id": None, "error": {"code": "BAD_JSON", "message": "无效 JSON"}}


@pytest.mark.parametrize("params", [[1, 2], "x", 5, True])
def test_params必须是对象(client, gateway, params):
    _, worker = gateway
    manager, ws, _ = open_ws(client)

    try:
        ws.send_text(json.dumps({"id": 4, "method": "x", "params": params}))
        reply = ws.receive_json()
    finally:
        manager.__exit__(None, None, None)

    assert reply == {
        "id": 4,
        "error": {"code": "BAD_PARAMS", "message": "params 必须是对象"},
    }
    assert worker.commands == []


def test_断开后移除客户端(client, gateway):
    module, _ = gateway
    manager, _, _ = open_ws(client)
    assert len(module.clients) == 1

    manager.__exit__(None, None, None)

    # 服务端收到断开后才会执行 finally，给它一点时间清理
    for _ in range(100):
        if not module.clients:
            break
        time.sleep(0.01)
    assert module.clients == {}


# ---------- 广播 ----------


def test_publish广播到所有客户端(gateway):
    module, _ = gateway
    first, second = FakeSocket(), FakeSocket()
    module.clients = {first: asyncio.Lock(), second: asyncio.Lock()}

    asyncio.run(module.publish("tick", {"symbol": "EURUSD"}))

    expected = [{"event": "tick", "data": {"symbol": "EURUSD"}}]
    assert first.sent == expected
    assert second.sent == expected


def test_publish移除发送失败的客户端(gateway):
    module, _ = gateway
    good, bad = FakeSocket(), FakeSocket(fail=True)
    module.clients = {good: asyncio.Lock(), bad: asyncio.Lock()}

    asyncio.run(module.publish("tick", {}))

    assert list(module.clients) == [good]
    assert len(good.sent) == 1


def test_send忽略未登记的客户端(gateway):
    module, _ = gateway
    socket = FakeSocket()
    module.clients = {}

    asyncio.run(module.send(socket, {"id": 1}))

    assert socket.sent == []
