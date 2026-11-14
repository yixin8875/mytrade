"""账户增删改查：登录号唯一、密码与配置分开保存、失败时回滚。"""

import os

import pytest

from accounts import AccountError, AccountManager
from secure_store import CredentialError


class FakeCredentials:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.fail: str | None = None
        self.fail_get = False
        self.fail_delete = False

    def _check(self) -> None:
        if self.fail:
            raise CredentialError(self.fail)

    def has(self, account_id: str) -> bool:
        self._check()
        return account_id in self.data

    def get(self, account_id: str) -> str | None:
        self._check()
        if self.fail_get:
            raise CredentialError("旧密文损坏")
        return self.data.get(account_id)

    def set(self, account_id: str, password: str) -> None:
        self._check()
        self.data[account_id] = password

    def delete(self, account_id: str) -> None:
        self._check()
        if self.fail_delete:
            raise CredentialError("删除失败")
        self.data.pop(account_id, None)


class FakeConfig:
    def __init__(self, accounts=None, active="", terminal_path="", expected_login=0) -> None:
        self.accounts = [dict(item) for item in (accounts or [])]
        self.active_account = active
        self.terminal_path = terminal_path
        self.expected_login = expected_login
        self.saved: list[list[dict]] = []
        self.fail_save: Exception | None = None

    def configured_accounts(self) -> list[dict]:
        return [dict(item) for item in self.accounts]

    def account_profiles(self) -> list[dict]:
        profiles = self.configured_accounts()
        if profiles:
            return profiles
        return [
            {
                "id": "default",
                "label": "默认终端",
                "login": int(self.expected_login or 0),
                "server": "",
                "terminal_path": self.terminal_path,
                "risk": {},
            }
        ]

    def active_profile(self) -> dict:
        profiles = self.account_profiles()
        return next(
            (item for item in profiles if item["id"] == self.active_account), profiles[0]
        )

    def save_accounts(self, accounts: list[dict], active_account=None) -> list[dict]:
        if self.fail_save is not None:
            raise self.fail_save
        self.accounts = [dict(item) for item in accounts]
        ids = [item["id"] for item in self.accounts]
        self.active_account = active_account if active_account in ids else ids[0]
        self.saved.append([dict(item) for item in accounts])
        return self.accounts


def term_file(tmp_path, name: str = "terminal64.exe"):
    path = tmp_path / name
    path.write_text("", encoding="utf-8")
    return path


def make_manager(tmp_path, **cfg_kwargs):
    cfg = FakeConfig(**cfg_kwargs)
    creds = FakeCredentials()
    return AccountManager(cfg, creds), cfg, creds


def payload(term, **over) -> dict:
    data = {
        "label": "主账户",
        "login": 111,
        "server": "Broker-Demo",
        "terminalPath": str(term),
    }
    data.update(over)
    return data


def account(term, **over) -> dict:
    base = {
        "id": "acc1",
        "label": "主账户",
        "login": 111,
        "server": "Broker-Demo",
        "terminal_path": os.path.normpath(str(term)),
        "risk": {},
    }
    base.update(over)
    return base


# ---------- 创建 ----------


def test_首次添加账户并切换为当前账户(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(tmp_path)

    result = manager.create(payload(term, password="secret"))

    assert result["id"] == "acc111"
    assert result["activeId"] == "acc111"
    assert result["seeded"] is False
    assert result["accounts"] == [
        {
            "id": "acc111",
            "label": "主账户",
            "login": 111,
            "server": "Broker-Demo",
            "terminal_path": os.path.normpath(str(term)),
        }
    ]
    assert creds.data == {"acc111": "secret"}
    assert cfg.active_account == "acc111"


def test_新增账户时保持当前账户不变(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")

    result = manager.create(payload(term, label="Scalper", login=222))

    assert result["id"] == "scalper"
    assert result["activeId"] == "acc1"
    assert [item["id"] for item in result["accounts"]] == ["acc1", "scalper"]
    assert creds.data == {}


def test_首次添加的正是当前终端时直接接管(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)
    current = {"login": 111, "server": "Broker", "terminalPath": str(term)}

    result = manager.create(payload(term), current=current)

    assert result["id"] == "acc111"
    assert result["activeId"] == "acc111"
    assert result["seeded"] is False
    assert len(result["accounts"]) == 1


def test_首次添加其他终端时把当前终端固化成默认账户(tmp_path):
    term = term_file(tmp_path, "new.exe")
    current_term = term_file(tmp_path, "current.exe")
    manager, _, _ = make_manager(tmp_path)
    current = {"login": 111, "server": "Broker", "terminalPath": str(current_term)}

    result = manager.create(payload(term, label="副账户", login=222), current=current)

    assert result["seeded"] is True
    assert [item["id"] for item in result["accounts"]] == ["default", "acc222"]
    assert result["accounts"][0]["label"] == "当前终端"
    assert result["accounts"][0]["login"] == 111
    assert result["activeId"] == "default"


def test_没有当前终端时只添加新账户(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path, terminal_path=str(tmp_path / "missing.exe"))

    result = manager.create(payload(term))

    assert result["seeded"] is False
    assert len(result["accounts"]) == 1


def test_登录号重复会被拒绝且提示占用的账户(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path, accounts=[account(term)], active="acc1")

    with pytest.raises(AccountError) as exc:
        manager.create(payload(term, label="另一个", login=111))

    assert "已被账户「主账户」使用" in str(exc.value)


def test_同名账户的id自动加后缀(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(
        tmp_path,
        accounts=[account(term, id="main", label="Main"), account(term, id="main-2", label="Main")],
        active="main",
    )

    result = manager.create(payload(term, label="Main", login=222))

    assert result["id"] == "main-3"


def test_密码为空或未提供时不写入凭据(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path)

    manager.create(payload(term, login=111, password=""))
    manager.create(payload(term, login=222, password=None))

    assert creds.data == {}


def test_密码会被转成字符串保存(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path)

    manager.create(payload(term, password=1234))

    assert creds.data["acc111"] == "1234"


def test_保存配置失败会回滚刚写入的密码(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(tmp_path)
    cfg.fail_save = OSError("disk full")

    with pytest.raises(AccountError) as exc:
        manager.create(payload(term, password="secret"))

    assert "保存账户失败：disk full" in str(exc.value)
    assert creds.data == {}


def test_保存密码失败时直接拒绝创建(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(tmp_path)
    creds.fail = "DPAPI 不可用"

    with pytest.raises(AccountError) as exc:
        manager.create(payload(term, password="secret"))

    assert "保存密码失败：DPAPI 不可用" in str(exc.value)
    assert cfg.saved == []


# ---------- 修改 ----------


def test_修改账户保留风控覆盖与未填字段(tmp_path):
    term = term_file(tmp_path)
    existing = account(term, risk={"max_lot": 1.5})
    manager, _, _ = make_manager(tmp_path, accounts=[existing], active="acc1")

    result = manager.update({"id": "acc1", "label": "改名"})

    assert result["accounts"][0]["label"] == "改名"
    assert result["accounts"][0]["login"] == 111
    assert result["accounts"][0]["risk"] == {"max_lot": 1.5}
    assert result["connectionChanged"] is False
    assert result["passwordChanged"] is False


def test_修改连接信息会标记需要重连(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path, accounts=[account(term)], active="acc1")

    result = manager.update({"id": "acc1", "server": "Broker-Live"})

    assert result["connectionChanged"] is True
    assert result["accounts"][0]["server"] == "Broker-Live"


def test_单终端模式下第一次修改会固化成默认账户(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, _ = make_manager(
        tmp_path,
        terminal_path=str(term),
        expected_login=111,
    )

    result = manager.update(
        {
            "id": "default",
            "label": "我的终端",
            "login": 111,
            "server": "Broker",
            "terminalPath": str(term),
        }
    )

    assert result["id"] == "default"
    assert cfg.accounts[0]["id"] == "default"
    assert cfg.accounts[0]["label"] == "我的终端"


def test_修改时登录号不能与其他账户重复(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )

    with pytest.raises(AccountError):
        manager.update({"id": "acc2", "login": 111})


def test_缺少或未知账户id会被拒绝(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path, accounts=[account(term)], active="acc1")

    with pytest.raises(AccountError) as exc:
        manager.update({"label": "x"})
    assert str(exc.value) == "缺少账户 id"

    with pytest.raises(AccountError) as exc:
        manager.update({"id": "nope"})
    assert str(exc.value) == "未知账户：nope"


def test_修改密码会覆盖旧密码(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.data["acc1"] = "old"

    result = manager.update({"id": "acc1", "password": "new"})

    assert result["passwordChanged"] is True
    assert creds.data["acc1"] == "new"


def test_未填密码时保持原密码(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.data["acc1"] = "old"

    result = manager.update({"id": "acc1"})

    assert result["passwordChanged"] is False
    assert creds.data["acc1"] == "old"


def test_清除密码(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.data["acc1"] = "old"

    result = manager.update({"id": "acc1", "clearPassword": True})

    assert result["passwordChanged"] is True
    assert creds.data == {}


def test_保存配置失败会恢复旧密码(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.data["acc1"] = "old"
    cfg.fail_save = OSError("disk full")

    with pytest.raises(AccountError):
        manager.update({"id": "acc1", "password": "new"})

    assert creds.data["acc1"] == "old"


def test_旧密文损坏时仍可写入新密码(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.fail_get = True

    manager.update({"id": "acc1", "password": "new"})

    assert creds.data["acc1"] == "new"


def test_旧密文损坏且保存失败时删掉新密码(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.fail_get = True
    cfg.fail_save = OSError("disk full")

    with pytest.raises(AccountError):
        manager.update({"id": "acc1", "password": "new"})

    assert creds.data == {}


def test_账户已保存但清除密码失败会明确报错(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    creds.fail_delete = True

    with pytest.raises(AccountError) as exc:
        manager.update({"id": "acc1", "clearPassword": True})

    assert "账户已保存，但清除密码失败" in str(exc.value)


# ---------- 删除 ----------


def test_删除非当前账户并清除密码(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )
    creds.data["acc2"] = "secret"

    result = manager.delete("acc2")

    assert result["id"] == "acc2"
    assert [item["id"] for item in cfg.accounts] == ["acc1"]
    assert creds.data == {}


def test_单终端模式没有可删除账户(tmp_path):
    manager, _, _ = make_manager(tmp_path)
    with pytest.raises(AccountError) as exc:
        manager.delete("default")
    assert str(exc.value) == "当前是单终端模式，没有可删除的账户"


def test_至少保留一个账户(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path, accounts=[account(term)], active="acc1")
    with pytest.raises(AccountError) as exc:
        manager.delete("acc1")
    assert str(exc.value) == "至少保留一个账户"


def test_不能删除当前账户(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )
    with pytest.raises(AccountError) as exc:
        manager.delete("acc1")
    assert str(exc.value) == "不能删除当前账户，请先切换到其他账户"


def test_删除未知账户(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )
    with pytest.raises(AccountError) as exc:
        manager.delete("nope")
    assert str(exc.value) == "未知账户：nope"


def test_删除时保存失败不会动密码(tmp_path):
    term = term_file(tmp_path)
    manager, cfg, creds = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )
    creds.data["acc2"] = "secret"
    cfg.fail_save = ValueError("bad")

    with pytest.raises(AccountError) as exc:
        manager.delete("acc2")

    assert "删除账户失败：bad" in str(exc.value)
    assert creds.data["acc2"] == "secret"


def test_账户已删除但清除密码失败会明确报错(tmp_path):
    term = term_file(tmp_path)
    manager, _, creds = make_manager(
        tmp_path,
        accounts=[account(term), account(term, id="acc2", label="副账户", login=222)],
        active="acc1",
    )
    creds.fail_delete = True

    with pytest.raises(AccountError) as exc:
        manager.delete("acc2")

    assert "账户已删除，但清除密码失败" in str(exc.value)


# ---------- 密码读取 ----------


def test_凭据损坏时账户列表仍可加载(tmp_path):
    manager, _, creds = make_manager(tmp_path)
    creds.fail = "损坏"

    assert manager.has_password("acc1") is False
    with pytest.raises(AccountError) as exc:
        manager.password("acc1")
    assert "损坏" in str(exc.value)


def test_正常读取密码(tmp_path):
    manager, _, creds = make_manager(tmp_path)
    creds.data["acc1"] = "secret"

    assert manager.has_password("acc1") is True
    assert manager.password("acc1") == "secret"


# ---------- 字段清洗 ----------


def test_账户名称与服务器校验(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)

    with pytest.raises(AccountError):
        manager._clean(payload(term, label="  "))
    with pytest.raises(AccountError):
        manager._clean(payload(term, label="x" * 41))
    with pytest.raises(AccountError):
        manager._clean(payload(term, server=""))
    with pytest.raises(AccountError):
        manager._clean(payload(term, server="x" * 81))

    data, _ = manager._clean(payload(term, label=" 主账户 ", server=" Broker "))
    assert data["label"] == "主账户"
    assert data["server"] == "Broker"


def test_登录号必须是正整数(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)

    for value in (True, False, "abc", 0, -1, 1.5):
        with pytest.raises(AccountError):
            manager._clean(payload(term, login=value))

    data, _ = manager._clean(payload(term, login="123"))
    assert data["login"] == 123


def test_终端路径必须是存在的文件或安装目录(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)

    with pytest.raises(AccountError):
        manager._clean(payload(term, terminalPath=""))
    with pytest.raises(AccountError):
        manager._clean(payload(term, terminalPath=str(tmp_path / "missing.exe")))
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(AccountError):
        manager._clean(payload(term, terminalPath=str(empty)))
    with pytest.raises(AccountError):
        manager._clean(payload(term, terminalPath="x" * 1025))

    install = tmp_path / "MT5"
    install.mkdir()
    (install / "terminal64.exe").write_text("", encoding="utf-8")
    data, _ = manager._clean(payload(term, terminalPath=str(install)))
    assert data["terminal_path"] == os.path.normpath(str(install / "terminal64.exe"))

    data, _ = manager._clean(payload(term, terminalPath=f'"{term}"'))
    assert data["terminal_path"] == os.path.normpath(str(term))


def test_密码字段缺省表示保持原密码(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)
    from accounts import _KEEP

    _, password = manager._clean(payload(term))
    assert password is _KEEP

    _, password = manager._clean(payload(term, password=None))
    assert password is _KEEP

    _, password = manager._clean(payload(term, password="pw"))
    assert password == "pw"

    with pytest.raises(AccountError):
        manager._clean(payload(term, password="x" * 257))


def test_修改时用现有值补齐未填字段(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)
    existing = account(term)

    data, password = manager._clean({}, existing)

    assert data["label"] == "主账户"
    assert data["login"] == 111
    assert data["server"] == "Broker-Demo"
    assert data["terminal_path"] == os.path.normpath(str(term))
    assert password is not None


def test_兼容下划线形式的终端路径字段(tmp_path):
    term = term_file(tmp_path)
    manager, _, _ = make_manager(tmp_path)

    data, _ = manager._clean(
        {"label": "L", "login": 1, "server": "S", "terminal_path": str(term)}
    )

    assert data["terminal_path"] == os.path.normpath(str(term))


# ---------- 路径与 id 工具 ----------


def test_目录与可执行文件视为同一路径(tmp_path):
    term = term_file(tmp_path)

    assert AccountManager._terminal_file(str(tmp_path)) == term
    assert AccountManager._terminal_file(str(term)) == term
    assert AccountManager._terminal_file(str(tmp_path / "missing")) is None
    assert AccountManager._same_path(str(tmp_path), str(term)) is True
    assert AccountManager._same_path(str(term), str(term)) is True
    assert AccountManager._same_path(str(term), str(tmp_path / "other.exe")) is False


def test_生成唯一账户id():
    used = {"main", "main-2"}
    assert AccountManager._unique_id("main", 1, used) == "main-3"
    assert AccountManager._unique_id("fresh", 1, used) == "fresh"
    assert AccountManager._unique_id("中文", 123, used) == "acc123"
