"""告警通道的字段定义、合并校验与密钥脱敏。

与 notify.py 分开：这里只处理配置结构，不发送消息，避免 config.py 依赖网络代码。
"""

from __future__ import annotations

import re
import secrets
import urllib.parse
from dataclasses import dataclass
from typing import Any

MAX_CHANNELS = 20
MAX_NAME = 40
MAX_URL = 500
MAX_ITEMS = 20
MAX_ERROR = 300


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    kind: str = "text"
    required: bool = False
    secret: bool = False
    placeholder: str = ""
    hint: str = ""
    min: float | None = None
    max: float | None = None
    max_length: int = 0
    default: Any = None
    options: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class TypeSpec:
    label: str
    fields: tuple[FieldSpec, ...]


def _url(
    label: str = "Webhook 地址",
    placeholder: str = "https://example.com/hook",
) -> FieldSpec:
    # URL 里通常带 key/token，按密钥处理：只上行，不回显
    return FieldSpec(
        "url",
        label,
        "text",
        required=True,
        secret=True,
        placeholder=placeholder,
        max_length=MAX_URL,
    )


SPECS: dict[str, TypeSpec] = {
    "webhook": TypeSpec(
        "通用 Webhook",
        (
            _url(),
            FieldSpec(
                "headers",
                "自定义请求头",
                "headers",
                secret=True,
                hint="每行一个 Key: Value；填写会整体替换",
            ),
        ),
    ),
    "discord": TypeSpec(
        "Discord",
        (_url("Webhook 地址", "https://discord.com/api/webhooks/..."),),
    ),
    "telegram": TypeSpec(
        "Telegram",
        (
            FieldSpec(
                "token",
                "Bot Token",
                "password",
                required=True,
                secret=True,
                placeholder="123456:ABC...",
            ),
            FieldSpec("chatId", "Chat ID", required=True, hint="频道或群的 chat id"),
        ),
    ),
    "wecom": TypeSpec(
        "企业微信",
        (
            _url(
                "机器人 Webhook 地址",
                "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
            ),
        ),
    ),
    "feishu": TypeSpec(
        "飞书 / Lark",
        (
            _url("Webhook 地址", "https://open.feishu.cn/open-apis/bot/v2/hook/..."),
            FieldSpec(
                "secret",
                "签名密钥",
                "password",
                secret=True,
                hint="机器人开启签名校验时填写",
            ),
        ),
    ),
    "dingtalk": TypeSpec(
        "钉钉",
        (
            _url(
                "Webhook 地址",
                "https://oapi.dingtalk.com/robot/send?access_token=...",
            ),
            FieldSpec(
                "secret",
                "加签密钥",
                "password",
                secret=True,
                hint="机器人开启加签时填写",
            ),
        ),
    ),
    "bark": TypeSpec(
        "Bark（iOS）",
        (
            _url("设备地址", "https://api.day.app/<device-key>"),
            FieldSpec("group", "分组"),
            FieldSpec("sound", "铃声"),
            FieldSpec(
                "level",
                "通知级别",
                "select",
                options=(
                    ("active", "active"),
                    ("timeSensitive", "timeSensitive"),
                    ("passive", "passive"),
                    ("critical", "critical"),
                ),
            ),
        ),
    ),
    "ntfy": TypeSpec(
        "ntfy",
        (
            _url("主题地址", "https://ntfy.sh/mytrade"),
            FieldSpec("title", "标题", default="Tally"),
            FieldSpec(
                "priority",
                "优先级",
                "select",
                options=(
                    ("1", "1 · 最低"),
                    ("2", "2"),
                    ("3", "3 · 默认"),
                    ("4", "4 · 高"),
                    ("5", "5 · 最高"),
                ),
            ),
            FieldSpec(
                "headers",
                "自定义请求头",
                "headers",
                secret=True,
                hint="每行一个 Key: Value，例如 Authorization: Bearer ...",
            ),
        ),
    ),
    "email": TypeSpec(
        "邮件 SMTP",
        (
            FieldSpec("host", "SMTP 服务器", required=True, placeholder="smtp.qq.com"),
            FieldSpec("port", "端口", "number", min=1, max=65535, default=465),
            FieldSpec("user", "用户名", placeholder="you@example.com"),
            FieldSpec("password", "密码 / 授权码", "password", secret=True),
            FieldSpec("from", "发件人", hint="缺省使用用户名"),
            FieldSpec("to", "收件人", "list", hint="多个地址用逗号分隔；缺省发给发件人"),
            FieldSpec("ssl", "SSL", "bool", default=True),
            FieldSpec(
                "starttls",
                "STARTTLS",
                "bool",
                default=False,
                hint="端口 587 等非 SSL 连接时开启",
            ),
        ),
    ),
}


def _field_dict(field: FieldSpec) -> dict:
    data: dict[str, Any] = {
        "key": field.key,
        "label": field.label,
        "kind": field.kind,
        "required": field.required,
        "secret": field.secret,
    }
    if field.placeholder:
        data["placeholder"] = field.placeholder
    if field.hint:
        data["hint"] = field.hint
    if field.min is not None:
        data["min"] = field.min
    if field.max is not None:
        data["max"] = field.max
    if field.max_length:
        data["maxLength"] = field.max_length
    if field.default is not None:
        data["default"] = field.default
    if field.options:
        data["options"] = [{"value": value, "label": label} for value, label in field.options]
    return data


def schema() -> dict[str, dict]:
    """给前端的表单定义；服务端保存时仍会重新校验。"""
    return {
        key: {"label": spec.label, "fields": [_field_dict(field) for field in spec.fields]}
        for key, spec in SPECS.items()
    }


def new_channel_id() -> str:
    return secrets.token_hex(4)


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return not value
    return False


def assign_ids(channels: list | None) -> tuple[list[dict], bool]:
    """过滤坏条目并补齐稳定 id；返回 (通道列表, 是否有改动)。"""
    out: list[dict] = []
    used: set[str] = set()
    changed = False
    for entry in channels or []:
        if not isinstance(entry, dict):
            changed = True
            continue
        item = dict(entry)
        channel_id = str(item.get("id") or "").strip()
        if not channel_id or channel_id in used:
            channel_id = new_channel_id()
            while channel_id in used:
                channel_id = new_channel_id()
            item["id"] = channel_id
            changed = True
        used.add(channel_id)
        out.append(item)
    return out, changed


def public_list(channels: list | None) -> list[dict]:
    """前端可见结构：不含任何密钥值，只标记哪些密钥已经配置。"""
    public: list[dict] = []
    for entry in channels or []:
        if not isinstance(entry, dict):
            continue
        ctype = str(entry.get("type") or "")
        spec = SPECS.get(ctype)
        if spec is None:
            continue
        fields: dict[str, Any] = {}
        secret_keys: list[str] = []
        for field in spec.fields:
            value = entry.get(field.key)
            if field.secret:
                if not _blank(value):
                    secret_keys.append(field.key)
            elif value is not None:
                fields[field.key] = value
        public.append(
            {
                "id": str(entry.get("id") or ""),
                "type": ctype,
                "typeLabel": spec.label,
                "name": str(entry.get("name") or spec.label),
                "fields": fields,
                "secretKeys": secret_keys,
            }
        )
    return public


def merge(existing: dict | None, incoming: dict) -> dict:
    """把界面提交的值合并到已有通道：密钥留空保持原值，clear 才删除。"""
    base = dict(existing or {})
    ctype = str(incoming.get("type") or base.get("type") or "").strip()
    spec = SPECS.get(ctype)
    if spec is None:
        raise ValueError(f"未知通道类型: {ctype or '(空)'}")
    if existing is not None and str(base.get("type") or "") != ctype:
        raise ValueError("通道类型不能修改，请删除后重新添加")

    merged = dict(base) if existing is not None else {}
    merged["type"] = ctype
    if existing is None:
        merged["id"] = new_channel_id()

    raw_name = incoming.get("name", base.get("name"))
    name = str(raw_name or "").strip()
    merged["name"] = name or spec.label

    clear = incoming.get("clear")
    cleared = {str(key) for key in clear} if isinstance(clear, list) else set()

    for field in spec.fields:
        if field.secret:
            if field.key in cleared:
                merged.pop(field.key, None)
                continue
            if field.key in incoming and not _blank(incoming[field.key]):
                merged[field.key] = _coerce(field, incoming[field.key])
            continue
        if field.key in incoming:
            if _blank(incoming[field.key]):
                merged.pop(field.key, None)
            else:
                merged[field.key] = _coerce(field, incoming[field.key])
        elif existing is None and field.default is not None:
            merged[field.key] = field.default
    return merged


def _coerce(field: FieldSpec, value: Any) -> Any:
    if field.kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{field.label}必须是布尔值")
        return value
    if field.kind == "number":
        if isinstance(value, bool):
            raise ValueError(f"{field.label}必须是整数")
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field.label}必须是整数") from exc
    if field.kind == "list":
        return _parse_list(field, value)
    if field.kind == "headers":
        return _parse_headers(field, value)
    text = str(value).strip()
    if field.max_length and len(text) > field.max_length:
        raise ValueError(f"{field.label}不能超过 {field.max_length} 个字符")
    return text


def _parse_list(field: FieldSpec, value: Any) -> list[str]:
    if isinstance(value, list):
        items = [str(item).strip() for item in value]
    elif isinstance(value, str):
        items = [part.strip() for part in re.split(r"[,\n]", value)]
    else:
        raise ValueError(f"{field.label}格式不正确")
    items = [item for item in items if item]
    if len(items) > MAX_ITEMS:
        raise ValueError(f"{field.label}最多 {MAX_ITEMS} 项")
    return items


def _parse_headers(field: FieldSpec, value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        pairs = [(str(key).strip(), str(item).strip()) for key, item in value.items()]
    elif isinstance(value, str):
        pairs = []
        for line in value.splitlines():
            line = line.strip()
            if not line:
                continue
            if ":" not in line:
                raise ValueError(f"{field.label}每行需要 Key: Value")
            key, item = line.split(":", 1)
            pairs.append((key.strip(), item.strip()))
    else:
        raise ValueError(f"{field.label}格式不正确")
    pairs = [(key, item) for key, item in pairs if key]
    if len(pairs) > MAX_ITEMS:
        raise ValueError(f"{field.label}最多 {MAX_ITEMS} 行")
    return dict(pairs)


def validate(channel: dict) -> None:
    """校验合并后的完整通道；错误信息直接展示给用户。"""
    ctype = str(channel.get("type") or "")
    spec = SPECS.get(ctype)
    if spec is None:
        raise ValueError(f"未知通道类型: {ctype or '(空)'}")
    name = str(channel.get("name") or "")
    if len(name) > MAX_NAME:
        raise ValueError(f"名称不能超过 {MAX_NAME} 个字符")

    for field in spec.fields:
        value = channel.get(field.key)
        if _blank(value):
            if field.required:
                raise ValueError(f"{field.label}不能为空")
            continue
        if field.kind == "bool":
            if not isinstance(value, bool):
                raise ValueError(f"{field.label}必须是布尔值")
            continue
        if field.kind == "number":
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{field.label}必须是整数")
            low = field.min if field.min is not None else 0
            high = field.max if field.max is not None else 0
            if value < low or (field.max is not None and value > high):
                raise ValueError(f"{field.label}必须在 {int(low)} 到 {int(high)} 之间")
            continue
        if field.kind == "select":
            allowed = {item for item, _ in field.options}
            if str(value) not in allowed:
                raise ValueError(f"{field.label}取值无效")
            continue
        if field.kind == "headers":
            if not isinstance(value, dict):
                raise ValueError(f"{field.label}格式不正确")
            continue
        if field.kind == "list":
            if not isinstance(value, list):
                raise ValueError(f"{field.label}格式不正确")
            continue
        text = str(value)
        if field.max_length and len(text) > field.max_length:
            raise ValueError(f"{field.label}不能超过 {field.max_length} 个字符")
        if field.key == "url":
            parts = urllib.parse.urlsplit(text)
            if parts.scheme not in ("http", "https") or not parts.netloc:
                raise ValueError(f"{field.label}必须是 http(s) 地址")

    if ctype == "email" and not channel.get("from") and not channel.get("user"):
        raise ValueError("请填写发件人或用户名")


def _secret_values(channel: dict) -> list[str]:
    values: list[str] = []
    spec = SPECS.get(str(channel.get("type") or ""))
    if spec is None:
        return values
    for field in spec.fields:
        if not field.secret:
            continue
        value = channel.get(field.key)
        if isinstance(value, str):
            if value:
                values.append(value)
        elif isinstance(value, dict):
            values.extend(str(item) for item in value.values() if item)
    return values


def redact_error(exc: Exception, channel: dict) -> str:
    """第三方返回的错误常带完整 URL/Token，展示前替换掉。"""
    text = f"{type(exc).__name__}: {exc}"
    for value in sorted(_secret_values(channel), key=len, reverse=True):
        text = text.replace(value, "***")
    return text[:MAX_ERROR]
