"""下单计划的清洗与旧格式迁移：分批止盈的入口，出错会直接下错单。"""

from mt5_worker import Mt5Worker


def test_normalize_keeps_valid_steps_sorted_by_r():
    raw = [
        {"atR": 2, "closePercent": 50, "moveBreakeven": True},
        {"atR": 1, "closePercent": None, "moveBreakeven": True},
        {"atR": 1.5, "closePercent": 25, "moveBreakeven": False},
    ]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert [step["atR"] for step in steps] == [1.0, 1.5, 2.0]
    assert steps[0] == {"atR": 1.0, "closePercent": None, "moveBreakeven": True, "done": False}
    assert steps[2]["closePercent"] == 50.0


def test_normalize_rejects_junk_entries():
    raw = [
        "nope",
        None,
        {"atR": "abc"},
        {"atR": 0},
        {"atR": -1},
        {"atR": 101},
        {"closePercent": 50},
    ]
    assert Mt5Worker._normalize_plan_steps(raw) == []


def test_normalize_treats_non_list_as_empty():
    assert Mt5Worker._normalize_plan_steps(None) == []
    assert Mt5Worker._normalize_plan_steps({"atR": 1}) == []


def test_normalize_clamps_close_percent():
    raw = [
        {"atR": 1, "closePercent": 0},
        {"atR": 2, "closePercent": 100},
        {"atR": 3, "closePercent": -5},
        {"atR": 4, "closePercent": "abc"},
        {"atR": 5, "closePercent": "50"},
        {"atR": 6, "closePercent": 99.9},
    ]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert [step["closePercent"] for step in steps] == [None, None, None, None, 50.0, 99.9]


def test_normalize_rounds_r_and_caps_at_eight_steps():
    raw = [{"atR": index + 1 + 0.123456, "closePercent": 10} for index in range(12)]
    steps = Mt5Worker._normalize_plan_steps(raw)
    assert len(steps) == 8
    assert steps[0]["atR"] == 1.1235
    assert steps[-1]["atR"] == 8.1235


def test_normalize_coerces_move_breakeven_to_bool():
    steps = Mt5Worker._normalize_plan_steps(
        [
            {"atR": 1, "closePercent": 50, "moveBreakeven": 1},
            {"atR": 2, "closePercent": 50},
            {"atR": 3, "closePercent": 50, "moveBreakeven": "yes"},
        ]
    )
    assert [step["moveBreakeven"] for step in steps] == [True, False, True]


def test_plan_steps_returns_existing_list_untouched():
    plan = {"steps": [{"atR": 1, "closePercent": None, "moveBreakeven": True, "done": True}]}
    steps = Mt5Worker._plan_steps(plan)
    assert steps is plan["steps"]
    assert steps[0]["done"] is True


def test_plan_steps_migrates_legacy_be_r():
    plan = {"beR": 2.5}
    steps = Mt5Worker._plan_steps(plan)
    assert steps == [{"atR": 2.5, "closePercent": None, "moveBreakeven": True, "done": False}]
    assert plan["steps"] is steps


def test_plan_steps_defaults_legacy_be_r():
    assert Mt5Worker._plan_steps({})[0]["atR"] == 1.0
    assert Mt5Worker._plan_steps({"beR": 0})[0]["atR"] == 1.0
    assert Mt5Worker._plan_steps({"beR": "abc"})[0]["atR"] == 1.0
