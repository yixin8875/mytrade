"""日志侧的纯函数：加权成交价、平仓分类、截图标注清洗。"""

from journal import _clean_shot_meta, _close_kind, _weighted


def test_weighted_price_uses_volume():
    assert _weighted([(1.0, 100.0), (3.0, 200.0)]) == 175.0
    assert _weighted([]) == 0.0


def test_close_kind_reads_comment_prefix():
    assert _close_kind("tp 106.0") == "tp"
    assert _close_kind(" SL ") == "sl"
    assert _close_kind("so margin") == "stop_out"
    assert _close_kind("tpl-partial") == "manual"
    assert _close_kind("") == "manual"


def test_clean_shot_meta_needs_two_anchors():
    assert _clean_shot_meta(None) is None
    assert _clean_shot_meta({"anchors": [{"price": 1, "y": 0.5}]}) is None
    assert _clean_shot_meta({"anchors": [{"price": "x", "y": 0.5}]}) is None


def test_clean_shot_meta_clamps_and_truncates():
    meta = {
        "digits": 99,
        "symbol": "X" * 60,
        "interval": "1".ljust(20, "0"),
        "anchors": [
            {"price": 1.23456789012345, "y": 2},
            {"price": 2.0, "y": -1},
            *[{"price": index, "y": 0.5} for index in range(20)],
        ],
    }
    clean = _clean_shot_meta(meta)
    assert clean is not None
    assert clean["digits"] == 8
    assert len(clean["symbol"]) == 40
    assert len(clean["interval"]) == 12
    assert len(clean["anchors"]) == 8
    assert clean["anchors"][0]["price"] == 1.2345678901
    assert clean["anchors"][0]["y"] == 1.0
    assert clean["anchors"][1]["y"] == 0.0
