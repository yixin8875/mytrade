"""凭据文件：加密存取、格式校验、只更新内存缓存前先落盘。"""

import base64
import json

import pytest

import secure_store
from secure_store import CredentialError, CredentialStore


@pytest.fixture(autouse=True)
def fake_dpapi(monkeypatch):
    monkeypatch.setattr(
        secure_store, "_protect", lambda plain: b"enc:" + plain.encode("utf-8")
    )

    def unprotect(blob: bytes) -> str:
        if blob == b"bad":
            raise CredentialError("cannot decrypt")
        if not blob.startswith(b"enc:"):
            raise CredentialError("bad blob")
        return blob[4:].decode("utf-8")

    monkeypatch.setattr(secure_store, "_unprotect", unprotect)


def make_store(tmp_path) -> CredentialStore:
    return CredentialStore(tmp_path / "credentials.json")


def write_file(path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


# ---------- 基本存取 ----------


def test_保存读取与删除密码(tmp_path):
    store = make_store(tmp_path)

    store.set("acc1", "secret")

    assert store.has("acc1") is True
    assert store.get("acc1") == "secret"

    store.delete("acc1")

    assert store.has("acc1") is False
    assert store.get("acc1") is None
    assert json.loads(store.path.read_text(encoding="utf-8")) == {
        "version": 1,
        "accounts": {},
    }


def test_文件只保存密文与更新时间(tmp_path):
    store = make_store(tmp_path)

    store.set("acc1", "secret")

    raw = json.loads(store.path.read_text(encoding="utf-8"))
    item = raw["accounts"]["acc1"]
    assert raw["version"] == 1
    assert list(item) == ["blob", "updatedAt"]
    assert isinstance(item["updatedAt"], int)
    assert item["updatedAt"] > 0
    assert base64.b64decode(item["blob"]) == b"enc:secret"
    assert "secret" not in json.dumps(raw)
    assert not store.path.with_name(store.path.name + ".tmp").exists()


def test_空密码等于删除(tmp_path):
    store = make_store(tmp_path)
    store.set("acc1", "secret")

    store.set("acc1", "")

    assert store.has("acc1") is False
    assert json.loads(store.path.read_text(encoding="utf-8"))["accounts"] == {}


def test_删除不存在的账户不创建文件(tmp_path):
    store = make_store(tmp_path)

    store.delete("nope")

    assert not store.path.exists()


def test_覆盖密码(tmp_path):
    store = make_store(tmp_path)
    store.set("acc1", "old")

    store.set("acc1", "new")

    assert store.get("acc1") == "new"


def test_新实例从磁盘解密(tmp_path):
    make_store(tmp_path).set("acc1", "secret")

    fresh = CredentialStore(tmp_path / "credentials.json")

    assert fresh.get("acc1") == "secret"


def test_读取后缓存不会感知外部改动(tmp_path):
    store = make_store(tmp_path)
    store.set("acc1", "secret")
    store.get("acc1")

    write_file(store.path, {"version": 1, "accounts": {}})

    assert store.has("acc1") is True


# ---------- 错误处理 ----------


def test_没有账户时返回空(tmp_path):
    store = make_store(tmp_path)
    assert store.get("missing") is None


def test_base64_损坏时报解密失败(tmp_path):
    store = make_store(tmp_path)
    write_file(
        store.path,
        {"version": 1, "accounts": {"acc1": {"blob": "!!!", "updatedAt": 1}}},
    )

    with pytest.raises(CredentialError) as exc:
        store.get("acc1")

    assert "账户 acc1 的密码解密失败" in str(exc.value)


def test_解密函数失败时报解密失败(tmp_path):
    store = make_store(tmp_path)
    write_file(
        store.path,
        {
            "version": 1,
            "accounts": {"acc1": {"blob": base64.b64encode(b"bad").decode(), "updatedAt": 1}},
        },
    )

    with pytest.raises(CredentialError) as exc:
        store.get("acc1")

    assert "cannot decrypt" in str(exc.value)


def test_加密失败直接抛出(tmp_path, monkeypatch):
    def boom(value):
        raise CredentialError("DPAPI 不可用")

    monkeypatch.setattr(secure_store, "_protect", boom)
    store = make_store(tmp_path)

    with pytest.raises(CredentialError) as exc:
        store.set("acc1", "secret")

    assert str(exc.value) == "DPAPI 不可用"
    assert not store.path.exists()


def test_文件格式损坏时报错(tmp_path):
    store = make_store(tmp_path)

    store.path.write_text("{not json", encoding="utf-8")
    with pytest.raises(CredentialError) as exc:
        store.has("acc1")
    assert "凭据文件读取失败" in str(exc.value)

    write_file(store.path, {"version": 2, "accounts": {}})
    with pytest.raises(CredentialError) as exc:
        store.has("acc1")
    assert str(exc.value) == "凭据文件格式不受支持"

    write_file(store.path, {"version": 1})
    with pytest.raises(CredentialError) as exc:
        store.has("acc1")
    assert str(exc.value) == "凭据文件缺少 accounts"

    write_file(store.path, {"version": 1, "accounts": []})
    with pytest.raises(CredentialError) as exc:
        store.has("acc1")
    assert str(exc.value) == "凭据文件缺少 accounts"


def test_格式不对的条目被跳过(tmp_path):
    store = make_store(tmp_path)
    write_file(
        store.path,
        {
            "version": 1,
            "accounts": {
                "empty": {"blob": "", "updatedAt": 1},
                "not-dict": "x",
                "zero": {"blob": "eA==", "updatedAt": "bad"},
            },
        },
    )

    assert store._load() == {"zero": {"blob": "eA==", "updatedAt": 0}}


def test_写入失败时不更新缓存(tmp_path, monkeypatch):
    store = make_store(tmp_path)

    def boom(source, target):
        raise OSError("locked")

    monkeypatch.setattr(secure_store.os, "replace", boom)

    with pytest.raises(CredentialError) as exc:
        store.set("acc1", "secret")

    assert "凭据文件写入失败：locked" in str(exc.value)
    assert store._cache == {}
    assert store.has("acc1") is False


def test_删除写入失败时保留缓存(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    store.set("acc1", "secret")

    def boom(source, target):
        raise OSError("locked")

    monkeypatch.setattr(secure_store.os, "replace", boom)

    with pytest.raises(CredentialError):
        store.delete("acc1")

    assert store.get("acc1") == "secret"
