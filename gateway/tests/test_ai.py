"""AI 复盘：默认关闭、Key 不外泄、只发聚合数据、缓存不重复计费。"""

from datetime import datetime, timezone

import pytest

from ai import AI, AIError, KEY_ID, PROVIDERS, TALLY_AI_VERSION
from review import Review
from score import Score
from store import Store


class FakeCredentials:
    """内存里的 Key 存储，形状与 CredentialStore 一致（不落盘）。"""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def has(self, key: str) -> bool:
        return bool(self.data.get(key))

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def set(self, key: str, value: str) -> None:
        self.data[key] = value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)


class FakeHttp:
    def __init__(self, reply=None, error: Exception | None = None) -> None:
        self.reply = reply
        self.error = error
        self.calls: list[dict] = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.reply


def epoch_noon() -> int:
    noon = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    return int(noon.timestamp())


def add_trade(store: Store, position_id: int, profit: float, symbol: str = "EURUSD") -> None:
    close_time = epoch_noon() - position_id * 60
    store.upsert_journal(
        {
            "login": 1,
            "position_id": position_id,
            "symbol": symbol,
            "side": "buy",
            "volume": 1.0,
            "entry_price": 1.1,
            "exit_price": 1.1,
            "profit": profit,
            "swap": 0,
            "commission": 0,
            "open_time": close_time - 600,
            "close_time": close_time,
            "duration_sec": 600,
            "mfe": max(profit, 0),
            "mae": min(profit, 0),
            "tag": None,
            "closed_by": "manual",
            "risk": 10.0,
            "risk_source": "order",
        }
    )


@pytest.fixture()
def store(tmp_path):
    instance = Store(tmp_path)
    instance.review_setting_set("timezone_offset_min", 0)
    return instance


def make_ai(store: Store, http=None, credentials=None) -> AI:
    review = Review(store)
    return AI(store, review, credentials or FakeCredentials(), Score(store, review), http)


def anthropic_reply(text: str = "第一段。第二段。第三段。"):
    return {"content": [{"type": "text", "text": text}]}


def test_status_defaults_to_off_without_key(store: Store):
    status = make_ai(store).status()
    assert status["enabled"] is False
    assert status["hasKey"] is False
    assert status["version"] == TALLY_AI_VERSION
    assert {item["id"] for item in status["providers"]} == set(PROVIDERS)


def test_enabling_without_key_is_rejected(store: Store):
    ai = make_ai(store)
    with pytest.raises(AIError) as error:
        ai.settings_save({"enabled": True})
    assert error.value.code == "NO_KEY"
    assert ai.status()["enabled"] is False


def test_key_is_saved_but_never_returned(store: Store):
    ai = make_ai(store)
    status = ai.settings_save({"enabled": True, "apiKey": "sk-test-123456"})
    assert status["hasKey"] is True
    assert status["enabled"] is True
    assert "sk-test-123456" not in str(status)

    cleared = ai.settings_save({"enabled": False, "apiKey": ""})
    assert cleared["hasKey"] is False


def test_settings_validate_provider_model_and_base_url(store: Store):
    ai = make_ai(store)
    with pytest.raises(AIError) as provider_error:
        ai.settings_save({"provider": "unknown"})
    assert provider_error.value.code == "BAD_PROVIDER"

    with pytest.raises(AIError) as url_error:
        ai.settings_save({"baseUrl": "ftp://example.test"})
    assert url_error.value.code == "BAD_BASE_URL"

    with pytest.raises(AIError) as compatible_error:
        ai.settings_save({"provider": "compatible", "model": "m"})
    assert compatible_error.value.code == "BAD_BASE_URL"

    saved = ai.settings_save(
        {"provider": "compatible", "model": "m", "baseUrl": "https://example.test/v1/"}
    )
    assert saved["baseUrl"] == "https://example.test/v1"


def test_review_requires_enabled_and_key(store: Store):
    add_trade(store, 1, 10.0)
    ai = make_ai(store)
    with pytest.raises(AIError) as disabled:
        ai.review({"kind": "day"}, 1, 0)
    assert disabled.value.code == "DISABLED"

    ai.settings_save({"enabled": True, "apiKey": "sk-x"})
    ai.credentials.delete(KEY_ID)
    with pytest.raises(AIError) as no_key:
        ai.review({"kind": "day"}, 1, 0)
    assert no_key.value.code == "NO_KEY"


def test_anthropic_request_shape_and_cache(store: Store):
    add_trade(store, 1, 10.0)
    add_trade(store, 2, -4.0)
    http = FakeHttp(anthropic_reply("做对了。问题在仓位。下次分批。"))
    ai = make_ai(store, http)
    ai.settings_save({"enabled": True, "apiKey": "sk-secret", "provider": "anthropic"})

    first = ai.review({"kind": "day"}, 1, 0)
    assert first["text"].startswith("做对了")
    assert first["cached"] is False
    assert len(http.calls) == 1
    call = http.calls[0]
    assert call["url"] == "https://api.anthropic.com/v1/messages"
    assert call["headers"]["x-api-key"] == "sk-secret"
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["body"]["system"]
    user_content = call["body"]["messages"][0]["content"]
    assert '"trades": 2' in user_content
    assert "sk-secret" not in user_content

    again = ai.review({"kind": "day"}, 1, 0)
    assert again["cached"] is True
    assert len(http.calls) == 1

    refreshed = ai.review({"kind": "day", "refresh": True}, 1, 0)
    assert refreshed["cached"] is False
    assert len(http.calls) == 2


def test_compatible_provider_uses_bearer_and_chat_completions(store: Store):
    add_trade(store, 1, 5.0)
    http = FakeHttp({"choices": [{"message": {"content": "复盘正文"}}]})
    ai = make_ai(store, http)
    ai.settings_save(
        {
            "enabled": True,
            "apiKey": "sk-local",
            "provider": "compatible",
            "model": "qwen-max",
            "baseUrl": "https://example.test/v1",
        }
    )
    result = ai.review({"kind": "day"}, 1, 0)
    assert result["text"] == "复盘正文"
    call = http.calls[0]
    assert call["url"] == "https://example.test/v1/chat/completions"
    assert call["headers"]["authorization"] == "Bearer sk-local"
    assert call["body"]["model"] == "qwen-max"
    assert [item["role"] for item in call["body"]["messages"]] == ["system", "user"]


def test_preview_sends_notes_only_when_asked(store: Store):
    add_trade(store, 1, 10.0)
    ai = make_ai(store)
    review = Review(store)
    review.note_save({"date": review._today(), "note": "今天情绪稳。"}, 1)
    review.trade_note_save({"positionId": 1, "note": "长" * 900}, 1)

    plain = ai.preview({"kind": "day"}, 1, 0)
    assert "notes" not in plain["payload"]
    assert any(item["key"] == "notes" and "未包含" in item["text"] for item in plain["fields"])

    with_notes = ai.preview({"kind": "day", "includeNotes": True}, 1, 0)
    notes = with_notes["payload"]["notes"]
    assert notes[0] == {"scope": "day", "text": "今天情绪稳。"}
    assert len(notes[1]["text"]) == 500
    assert with_notes["bytes"] > plain["bytes"]


def test_payload_has_no_account_or_secret(store: Store):
    add_trade(store, 1, 10.0)
    add_trade(store, 2, -3.0)
    preview = make_ai(store).preview({"kind": "day"}, 1, 0)
    payload = preview["payload"]
    assert payload["summary"]["trades"] == 2
    assert payload["symbols"][0]["symbol"] == "EURUSD"
    dumped = str(preview)
    assert '"login"' not in dumped
    assert "password" not in dumped.lower()
    assert "api_key" not in dumped.lower()


def test_week_preview_has_by_day(store: Store):
    add_trade(store, 1, 10.0)
    add_trade(store, 2, -3.0)
    preview = make_ai(store).preview({"kind": "week"}, 1, 0)
    payload = preview["payload"]
    assert payload["kind"] == "week"
    assert payload["start"] < payload["end"]
    assert len(payload["byDay"]) == 1
    assert payload["byDay"][0]["trades"] == 2


def test_provider_failures_become_ai_errors(store: Store):
    add_trade(store, 1, 1.0)
    ai = make_ai(store, FakeHttp(error=RuntimeError("boom")))
    ai.settings_save({"enabled": True, "apiKey": "sk-x"})
    with pytest.raises(AIError) as failed:
        ai.review({"kind": "day"}, 1, 0)
    assert failed.value.code == "PROVIDER"

    empty = make_ai(store, FakeHttp({"content": []}))
    empty.settings_save({"enabled": True, "apiKey": "sk-y"})
    with pytest.raises(AIError) as no_text:
        empty.review({"kind": "day"}, 1, 0)
    assert no_text.value.code == "PROVIDER"


def test_cache_clear_removes_rows(store: Store):
    add_trade(store, 1, 1.0)
    http = FakeHttp(anthropic_reply())
    ai = make_ai(store, http)
    ai.settings_save({"enabled": True, "apiKey": "sk-x"})
    ai.review({"kind": "day"}, 1, 0)
    removed = ai.cache_clear({"kind": "day"}, 1, 0)
    assert removed["removed"] == 1
    ai.review({"kind": "day"}, 1, 0)
    assert len(http.calls) == 2
