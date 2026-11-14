"""设置页的风控字段校验：范围、类型、账户级覆盖都不能越过 EDITABLE_FIELDS。"""

import pytest

from config import Config


def test_clean_risk_keeps_known_numbers_only():
    raw = {
        "max_lot": 2.5,
        "max_positions": 3,
        "max_risk_pct": 0.5,
        "magic": 260511,
        "unknown": 1,
    }
    clean = Config._clean_risk(raw)
    assert clean == {"max_lot": 2.5, "max_positions": 3, "max_risk_pct": 0.5}


def test_clean_risk_drops_bools_and_wrong_types():
    raw = {"max_lot": True, "max_positions": 2.5, "max_risk_pct": "1"}
    assert Config._clean_risk(raw) == {}


def test_clean_risk_drops_out_of_range_values():
    raw = {"max_lot": 0.001, "max_positions": 0, "daily_loss_pct": 150, "max_trades_per_day": 5}
    assert Config._clean_risk(raw) == {"max_trades_per_day": 5}


def test_clean_risk_ignores_non_dict():
    assert Config._clean_risk(None) == {}
    assert Config._clean_risk([("max_lot", 1)]) == {}


def test_slug_normalizes_and_falls_back():
    assert Config._slug(" My Account ", "acc") == "my-account"
    assert Config._slug("***", "acc") == "acc"
    assert Config._slug("", "default") == "default"


@pytest.fixture()
def isolated_config(monkeypatch):
    """Config.update 会写 gateway/config.json；测试里换成内存实现。"""
    monkeypatch.setattr(Config, "_read_raw", staticmethod(lambda: {}))
    monkeypatch.setattr(Config, "_write_raw", staticmethod(lambda raw: None))
    return Config()


def test_update_applies_valid_fields(isolated_config):
    isolated_config.update({"max_lot": 1.5, "max_positions": 4})
    assert isolated_config.max_lot == 1.5
    assert isolated_config.max_positions == 4


@pytest.mark.parametrize(
    "patch",
    [
        {"magic": 1},
        {"max_lot": True},
        {"max_positions": 3.5},
        {"max_lot": 0},
        {"daily_loss_pct": 101},
        {},
    ],
)
def test_update_rejects_invalid_patches(isolated_config, patch):
    with pytest.raises(ValueError):
        isolated_config.update(patch)


@pytest.fixture()
def memory_config(monkeypatch):
    """账户相关方法会读写 config.json，这里换成内存字典并保留其他字段。"""
    disk: dict = {}
    monkeypatch.setattr(Config, "_read_raw", staticmethod(lambda: dict(disk)))
    monkeypatch.setattr(
        Config, "_write_raw", staticmethod(lambda raw: (disk.clear(), disk.update(raw)))
    )
    return Config(), disk


def test_normalize_accounts_fills_defaults_and_ids():
    cfg = Config(terminal_path="C:/MT5/terminal64.exe")
    profiles = cfg._normalize_accounts(
        [
            {"login": 111, "server": "A" * 100},
            {"name": "Main Account", "login": "222"},
            {"id": "main-account", "label": "重复", "login": 333},
            "bad",
            {"login": "abc"},
            {"label": "L" * 60, "login": 444, "risk": {"max_lot": 1}},
        ]
    )

    assert [item["id"] for item in profiles] == [
        "111",
        "main-account",
        "main-account-2",
        "acc5",
        "444",
    ]
    assert profiles[0]["label"] == "账户 111"
    assert profiles[0]["terminal_path"] == "C:/MT5/terminal64.exe"
    assert len(profiles[0]["server"]) == 80
    assert profiles[1]["label"] == "Main Account"
    assert profiles[3]["label"] == "账户 5"
    assert profiles[3]["login"] == 0
    assert profiles[4]["label"] == "L" * 40
    assert profiles[4]["risk"] == {"max_lot": 1.0}


def test_normalize_accounts_accepts_terminal_path_variants():
    cfg = Config(terminal_path="C:/fallback.exe")

    profiles = cfg._normalize_accounts(
        [
            {"login": 1, "terminalPath": "C:/camel.exe"},
            {"login": 2, "terminal_path": "C:/snake.exe"},
            {"login": 3},
        ]
    )

    assert [item["terminal_path"] for item in profiles] == [
        "C:/camel.exe",
        "C:/snake.exe",
        "C:/fallback.exe",
    ]


def test_configured_accounts_ignores_non_list():
    cfg = Config()
    cfg.accounts = {"not": "a list"}
    assert cfg.configured_accounts() == []


def test_account_profiles_falls_back_to_single_terminal():
    cfg = Config(terminal_path="C:/MT5/terminal64.exe", expected_login=999)

    profiles = cfg.account_profiles()

    assert profiles == [
        {
            "id": "default",
            "label": "默认终端",
            "login": 999,
            "server": "",
            "terminal_path": "C:/MT5/terminal64.exe",
            "risk": {},
        }
    ]


def test_active_profile_falls_back_to_first():
    cfg = Config(
        accounts=[
            {"id": "a", "label": "A", "login": 1},
            {"id": "b", "label": "B", "login": 2},
        ]
    )
    cfg.active_account = "b"
    assert cfg.active_profile()["id"] == "b"

    cfg.active_account = "missing"
    assert cfg.active_profile()["id"] == "a"


def test_save_accounts_requires_at_least_one(memory_config):
    cfg, _ = memory_config
    with pytest.raises(ValueError) as exc:
        cfg.save_accounts([])
    assert str(exc.value) == "至少保留一个账户"


def test_save_accounts_writes_profiles_and_preserves_other_fields(memory_config):
    cfg, disk = memory_config
    disk.update({"magic": 9, "custom": "keep"})

    saved = cfg.save_accounts(
        [
            {"id": "a", "label": "A", "login": 1, "server": "S", "terminal_path": "C:/a.exe"},
            {
                "id": "b",
                "label": "B",
                "login": 2,
                "server": "S",
                "terminal_path": "C:/b.exe",
                "risk": {"max_lot": 2},
            },
        ],
        active_account="missing",
    )

    assert [item["id"] for item in saved] == ["a", "b"]
    assert disk["magic"] == 9
    assert disk["custom"] == "keep"
    assert disk["active_account"] == "a"
    assert disk["accounts"][0] == {
        "id": "a",
        "label": "A",
        "login": 1,
        "server": "S",
        "terminal_path": "C:/a.exe",
    }
    assert disk["accounts"][1]["risk"] == {"max_lot": 2.0}
    assert cfg.active_account == "a"


def test_set_active_account_persists_choice(memory_config):
    cfg, disk = memory_config
    cfg.accounts = [
        {"id": "a", "label": "A", "login": 1},
        {"id": "b", "label": "B", "login": 2},
    ]
    disk.update({"magic": 7})

    profile = cfg.set_active_account("b")

    assert profile["id"] == "b"
    assert cfg.active_account == "b"
    assert disk["active_account"] == "b"
    assert disk["magic"] == 7


def test_set_active_account_rejects_unknown(memory_config):
    cfg, _ = memory_config
    cfg.accounts = [{"id": "a", "label": "A", "login": 1}]

    with pytest.raises(ValueError) as exc:
        cfg.set_active_account("nope")
    assert str(exc.value) == "未知账户: nope"


def test_account_risk_and_risk_limits_merge_overrides():
    cfg = Config(
        accounts=[
            {"id": "a", "label": "A", "login": 1, "risk": {"max_lot": 2, "max_positions": 5}},
            {"id": "b", "label": "B", "login": 2},
        ],
        max_lot=0.5,
        max_positions=3,
        max_risk_pct=1.0,
    )

    assert cfg.account_risk("a") == {"max_lot": 2.0, "max_positions": 5}
    assert cfg.account_risk("b") == {}
    assert cfg.account_risk("missing") == {}

    limits = cfg.risk_limits("a")
    assert limits["max_lot"] == 2
    assert limits["max_positions"] == 5
    assert limits["max_risk_pct"] == 1.0


def test_risk_limits_default_to_active_account():
    cfg = Config(
        accounts=[
            {"id": "a", "label": "A", "login": 1},
            {"id": "b", "label": "B", "login": 2, "risk": {"max_lot": 4}},
        ],
        active_account="b",
        max_lot=0.5,
    )

    assert cfg.risk_limits()["max_lot"] == 4


def test_set_account_risk_updates_one_account(memory_config):
    cfg, disk = memory_config
    cfg.accounts = [
        {"id": "a", "label": "A", "login": 1, "risk": {"max_lot": 1}},
        {"id": "b", "label": "B", "login": 2},
    ]

    result = cfg.set_account_risk("b", {"max_lot": 3, "daily_loss_pct": 5})

    assert result["accounts"][0]["risk"] == {"max_lot": 1.0}
    assert result["accounts"][1]["risk"] == {"max_lot": 3.0, "daily_loss_pct": 5.0}
    assert disk["accounts"][1]["risk"] == {"max_lot": 3.0, "daily_loss_pct": 5.0}
    assert disk["active_account"] == "a"


def test_set_account_risk_removes_override_with_none(memory_config):
    cfg, _ = memory_config
    cfg.accounts = [
        {"id": "a", "label": "A", "login": 1, "risk": {"max_lot": 1, "max_positions": 4}}
    ]

    result = cfg.set_account_risk("a", {"max_lot": None})

    assert result["accounts"][0]["risk"] == {"max_positions": 4}


def test_set_account_risk_rejects_bad_fields(memory_config):
    cfg, _ = memory_config
    cfg.accounts = [{"id": "a", "label": "A", "login": 1}]

    with pytest.raises(ValueError) as exc:
        cfg.set_account_risk("missing", {"max_lot": 1})
    assert str(exc.value) == "未知账户: missing"

    with pytest.raises(ValueError) as exc:
        cfg.set_account_risk("a", {"magic": 1})
    assert str(exc.value) == "字段 magic 不支持按账户设置"

    for patch in ({"max_lot": True}, {"max_positions": 2.5}, {"max_lot": 0}):
        with pytest.raises(ValueError):
            cfg.set_account_risk("a", patch)


def test_set_allow_live_writes_back(memory_config):
    cfg, disk = memory_config
    disk["magic"] = 3

    result = cfg.set_allow_live(True)

    assert cfg.allow_live is True
    assert disk["allow_live"] is True
    assert disk["magic"] == 3
    assert result["allow_live"] is True


def test_public_hides_endpoint_and_channel_secrets():
    cfg = Config(
        host="0.0.0.0",
        port=9999,
        accounts=[{"id": "a", "label": "A", "login": 1, "risk": {"max_lot": 1}}],
        alert_channels=[
            {"type": "webhook", "name": "飞书", "url": "https://secret.example"},
            {"type": "telegram", "token": "secret-token"},
            "bad",
        ],
    )

    data = cfg.public()

    assert "host" not in data
    assert "port" not in data
    assert "alert_channels" not in data
    assert data["alert_channel_names"] == ["飞书", "telegram"]
    assert data["accounts"][0]["risk"] == {"max_lot": 1.0}
    assert data["active_account"] == "a"
    assert "secret-token" not in str(data)
