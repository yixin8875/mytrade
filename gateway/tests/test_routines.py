"""例行清单：星期过滤、补勾窗口、热力图与默认清单。"""

from datetime import timedelta

import pytest

from routines import RoutineError, Routines
from store import Store


@pytest.fixture()
def store(tmp_path):
    instance = Store(tmp_path)
    instance.review_setting_set("timezone_offset_min", 0)
    return instance


def test_seed_is_idempotent(store: Store):
    review = Routines(store)
    first = review.seed({}, 1)
    assert first["created"] == 7
    assert len(first["routines"]) == 7
    second = review.seed({}, 1)
    assert second["created"] == 0
    assert len(second["routines"]) == 7


def test_day_filters_by_weekday(store: Store):
    review = Routines(store)
    today = review._today()
    weekday = today.isoweekday()
    other = weekday % 7 + 1
    review.save({"title": "今天要做", "phase": "pre", "weekdays": [weekday]}, 1)
    review.save({"title": "别的天做", "phase": "pre", "weekdays": [other]}, 1)

    payload = review.day({"date": today.strftime("%Y-%m-%d")}, 1)
    assert [item["title"] for item in payload["items"]] == ["今天要做"]
    assert payload["summary"]["total"] == 1
    assert payload["summary"]["done"] == 0


def test_day_has_no_items_when_no_routine_matches(store: Store):
    review = Routines(store)
    today = review._today()
    review.save(
        {"title": "只在别的天", "phase": "pre", "weekdays": [today.isoweekday() % 7 + 1]}, 1
    )
    payload = review.day({"date": today.strftime("%Y-%m-%d")}, 1)
    assert payload["items"] == []
    assert payload["summary"]["rate"] is None


def test_toggle_marks_done_and_updates_rate(store: Store):
    review = Routines(store)
    today = review._today().strftime("%Y-%m-%d")
    book = review.save(
        {"title": "检查点差", "phase": "pre", "weekdays": [1, 2, 3, 4, 5, 6, 7]}, 1
    )["routine"]
    review.save({"title": "写计划", "phase": "pre", "weekdays": [1, 2, 3, 4, 5, 6, 7]}, 1)

    payload = review.toggle({"id": book["id"], "date": today, "done": True}, 1)
    assert payload["summary"]["total"] == 2
    assert payload["summary"]["done"] == 1
    assert payload["summary"]["rate"] == pytest.approx(0.5)

    undone = review.toggle({"id": book["id"], "date": today, "done": False}, 1)
    assert undone["summary"]["done"] == 0


def test_toggle_rejects_older_than_backfill_window(store: Store):
    review = Routines(store)
    book = review.save({"title": "检查点差", "phase": "pre"}, 1)["routine"]
    old = (review._today() - timedelta(days=8)).strftime("%Y-%m-%d")
    with pytest.raises(RoutineError) as exc:
        review.toggle({"id": book["id"], "date": old, "done": True}, 1)
    assert exc.value.code == "LOCKED"


def test_toggle_allows_backfill_within_window(store: Store):
    review = Routines(store)
    book = review.save({"title": "检查点差", "phase": "pre"}, 1)["routine"]
    today = review._today()
    yesterday = (today - timedelta(days=1)).strftime("%Y-%m-%d")
    payload = review.toggle({"id": book["id"], "date": yesterday, "done": True}, 1)
    assert payload["date"] == yesterday
    assert payload["editable"] is True
    # 昨天创建的例行昨天仍算应做（归档/创建按天比较）
    marked = store.routine_done_range(1, yesterday, yesterday)
    assert (book["id"], yesterday) in marked


def test_heatmap_counts_due_and_skips_archived(store: Store):
    review = Routines(store)
    book = review.save(
        {"title": "每天一次", "phase": "during", "weekdays": [1, 2, 3, 4, 5, 6, 7]}, 1
    )["routine"]
    today = review._today()
    payload = review.heatmap({"weeks": 1}, 1)
    key = today.strftime("%Y-%m-%d")
    cell = next(item for item in payload["cells"] if item["date"] == key)
    assert cell["due"] == 1
    assert cell["done"] == 0

    review.toggle({"id": book["id"], "date": key, "done": True}, 1)
    payload = review.heatmap({"weeks": 1}, 1)
    cell = next(item for item in payload["cells"] if item["date"] == key)
    assert cell["rate"] == 1
    assert payload["summary"]["streak"] == 1

    review.delete({"id": book["id"]}, 1)
    after = review.heatmap({"weeks": 1}, 1)
    archived = next(item for item in after["cells"] if item["date"] == key)
    # 归档当天仍然算应做，次日起不再计入
    assert archived["due"] == 1
    tomorrow = (today + timedelta(days=1)).strftime("%Y-%m-%d")
    future = next(item for item in after["cells"] if item["date"] == tomorrow)
    assert future["due"] == 0
    assert future["future"] is True


def test_save_validates_phase_and_trims_weekdays(store: Store):
    review = Routines(store)
    with pytest.raises(RoutineError):
        review.save({"title": "x", "phase": "noon"}, 1)
    book = review.save(
        {"title": "  只做计划内  ", "phase": "during", "weekdays": [5, 1, 1, 9]}, 1
    )["routine"]
    assert book["title"] == "只做计划内"
    assert book["weekdays"] == [1, 5]
