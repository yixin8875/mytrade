"""告警通道的 schema、密钥投影、合并与校验。"""

import json

import pytest

import alert_channels
from notify import CHANNELS

URL_TYPES = ("webhook", "discord", "wecom", "feishu", "dingtalk", "bark", "ntfy")


def channel(**over) -> dict:
    base = {
        "id": "a1b2c3d4",
        "type": "feishu",
        "name": "飞书",
        "url": "https://open.feishu.cn/hook/secret",
        "secret": "sign-secret",
    }
    base.update(over)
    return base


def test_schema_covers_every_sender():
    assert set(alert_channels.schema()) == set(CHANNELS)


def test_url_fields_are_secret_and_required():
    for ctype in URL_TYPES:
        fields = {item["key"]: item for item in alert_channels.schema()[ctype]["fields"]}
        assert fields["url"]["secret"] is True
        assert fields["url"]["required"] is True


def test_public_list_never_returns_secret_values():
    public = alert_channels.public_list([channel()])[0]

    assert public["id"] == "a1b2c3d4"
    assert public["typeLabel"] == "飞书 / Lark"
    assert public["secretKeys"] == ["url", "secret"]
    assert public["fields"] == {}
    assert "open.feishu.cn" not in json.dumps(public, ensure_ascii=False)
    assert "sign-secret" not in json.dumps(public, ensure_ascii=False)


def test_public_list_keeps_non_secret_fields():
    public = alert_channels.public_list(
        [
            {
                "id": "e1",
                "type": "email",
                "name": "邮箱",
                "host": "smtp.example.com",
                "port": 465,
                "user": "bot@example.com",
                "password": "pw",
                "to": ["a@example.com"],
                "ssl": True,
            }
        ]
    )[0]

    assert public["fields"] == {
        "host": "smtp.example.com",
        "port": 465,
        "user": "bot@example.com",
        "to": ["a@example.com"],
        "ssl": True,
    }
    assert public["secretKeys"] == ["password"]
    assert "pw" not in json.dumps(public, ensure_ascii=False)


def test_public_list_skips_bad_entries():
    assert alert_channels.public_list(["bad", {"type": "sms"}, None]) == []


def test_assign_ids_fills_and_dedupes():
    original = [
        {"type": "discord", "url": "https://x"},
        {"type": "ntfy", "url": "https://y", "id": "same"},
        {"type": "bark", "url": "https://z", "id": "same"},
        "bad",
    ]
    channels, changed = alert_channels.assign_ids(original)

    assert changed is True
    assert len(channels) == 3
    ids = [item["id"] for item in channels]
    assert ids[0] and len(ids[0]) == 8
    assert len(set(ids)) == 3


def test_assign_ids_is_noop_when_complete():
    channels, changed = alert_channels.assign_ids([channel()])
    assert changed is False
    assert channels[0]["id"] == "a1b2c3d4"


def test_merge_keeps_blank_secrets_and_updates_name():
    merged = alert_channels.merge(
        channel(), {"id": "a1b2c3d4", "type": "feishu", "name": "改名", "url": "", "secret": ""}
    )

    assert merged["name"] == "改名"
    assert merged["url"] == "https://open.feishu.cn/hook/secret"
    assert merged["secret"] == "sign-secret"


def test_merge_replaces_secret_when_provided():
    merged = alert_channels.merge(
        channel(), {"id": "a1b2c3d4", "type": "feishu", "url": "https://new.example/hook"}
    )
    assert merged["url"] == "https://new.example/hook"


def test_merge_clear_removes_optional_secret():
    merged = alert_channels.merge(
        channel(), {"id": "a1b2c3d4", "type": "feishu", "clear": ["secret"]}
    )
    assert "secret" not in merged
    alert_channels.validate(merged)


def test_merge_clear_required_secret_fails_validation():
    merged = alert_channels.merge(
        channel(), {"id": "a1b2c3d4", "type": "feishu", "clear": ["url"]}
    )
    with pytest.raises(ValueError, match="Webhook 地址不能为空"):
        alert_channels.validate(merged)


def test_merge_rejects_type_change():
    with pytest.raises(ValueError, match="类型不能修改"):
        alert_channels.merge(
            channel(), {"id": "a1b2c3d4", "type": "discord", "url": "https://x"}
        )


def test_merge_ignores_unknown_incoming_keys():
    merged = alert_channels.merge(channel(), {"id": "a1b2c3d4", "type": "feishu", "evil": "x"})
    assert "evil" not in merged


def test_merge_new_channel_applies_defaults_and_name():
    merged = alert_channels.merge(
        None,
        {"type": "email", "host": "smtp.example.com", "user": "bot@example.com"},
    )

    assert merged["id"] and len(merged["id"]) == 8
    assert merged["name"] == "邮件 SMTP"
    assert merged["port"] == 465
    assert merged["ssl"] is True
    assert merged["starttls"] is False


def test_merge_non_secret_blank_removes_key():
    merged = alert_channels.merge(
        channel(type="bark", url="https://api.day.app/k", group="交易"),
        {"id": "a1b2c3d4", "type": "bark", "group": ""},
    )
    assert "group" not in merged


def test_merge_parses_headers_and_lists():
    merged = alert_channels.merge(
        None,
        {
            "type": "webhook",
            "url": "https://example.com/hook",
            "headers": "X-Key: v\nAuthorization: Bearer t",
        },
    )
    assert merged["headers"] == {"X-Key": "v", "Authorization": "Bearer t"}

    mail = alert_channels.merge(
        None,
        {
            "type": "email",
            "host": "smtp.example.com",
            "user": "u@e.com",
            "to": "a@e.com, b@e.com",
        },
    )
    assert mail["to"] == ["a@e.com", "b@e.com"]


def test_headers_reject_bad_lines_and_limits():
    with pytest.raises(ValueError, match="Key: Value"):
        alert_channels.merge(None, {"type": "webhook", "url": "https://x", "headers": "oops"})
    with pytest.raises(ValueError, match="最多 20 行"):
        alert_channels.merge(
            None,
            {
                "type": "webhook",
                "url": "https://x",
                "headers": {f"K{i}": "v" for i in range(21)},
            },
        )


def test_validate_rejects_missing_url_and_bad_scheme():
    with pytest.raises(ValueError, match="不能为空"):
        alert_channels.validate(alert_channels.merge(None, {"type": "discord"}))
    with pytest.raises(ValueError, match="http"):
        alert_channels.validate(
            alert_channels.merge(None, {"type": "discord", "url": "ftp://example.com"})
        )


def test_validate_rejects_port_and_priority():
    with pytest.raises(ValueError, match="端口必须在"):
        alert_channels.validate(
            alert_channels.merge(
                None,
                {"type": "email", "host": "smtp.example.com", "user": "u", "port": 70000},
            )
        )
    with pytest.raises(ValueError, match="优先级取值无效"):
        alert_channels.validate(
            alert_channels.merge(
                None, {"type": "ntfy", "url": "https://ntfy.sh/t", "priority": "9"}
            )
        )


def test_validate_email_needs_sender():
    with pytest.raises(ValueError, match="发件人或用户名"):
        alert_channels.validate(
            alert_channels.merge(None, {"type": "email", "host": "smtp.example.com"})
        )


def test_validate_rejects_long_name():
    with pytest.raises(ValueError, match="名称不能超过"):
        alert_channels.validate(channel(name="名" * 41))


def test_redact_error_hides_secrets():
    entry = channel(
        type="webhook",
        url="https://hooks.example.com/secret-key",
        headers={"X-Token": "hdr-secret"},
    )
    error = RuntimeError("failed https://hooks.example.com/secret-key header hdr-secret")

    text = alert_channels.redact_error(error, entry)

    assert "secret-key" not in text
    assert "hdr-secret" not in text
    assert "***" in text
    assert text.startswith("RuntimeError:")
