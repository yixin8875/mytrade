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
