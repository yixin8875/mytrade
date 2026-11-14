"""AI 复盘：自带 Key、默认关闭、只发聚合数据。

边界（写死在这里，不随参数放宽）：
- Key 只经 DPAPI 加密存在本机，任何返回值只有 hasKey 布尔值。
- 没有 Key 或未开启时直接拒绝，不静默降级。
- 只发送聚合统计与用户显式勾选的笔记；不含账户号、服务器、密码、截图。
- 输出只作为建议，不写回任何交易数据。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Callable

from review import Review
from score import Score
from store import Store

DAY_FMT = "%Y-%m-%d"
TALLY_AI_VERSION = 1
SETTINGS_KEY = "ai"
KEY_ID = "__ai_review__"
MAX_TOKENS = 900
TIMEOUT_SECONDS = 60
MAX_NOTE = 500
MAX_NOTES = 20

SYSTEM_PROMPT = (
    "你是交易复盘助手。用户会给你一段聚合统计（没有账户号、没有行情、没有截图）。"
    "请用简体中文写一份复盘，固定三段：1) 做对了什么 2) 问题出在哪 3) 下次怎么做。"
    "每段 2–4 句，总字数不超过 350。"
    "只引用给定数字能支持的事实，不编造行情或消息面；不预测涨跌，不给具体买卖建议；"
    "不要逐条复述数字。"
)

PROVIDERS: dict[str, dict[str, str]] = {
    "anthropic": {
        "label": "Anthropic（Claude）",
        "baseUrl": "https://api.anthropic.com",
        "defaultModel": "claude-sonnet-5-5",
    },
    "openai": {
        "label": "OpenAI",
        "baseUrl": "https://api.openai.com/v1",
        "defaultModel": "gpt-4.1-mini",
    },
    "compatible": {
        "label": "OpenAI 兼容",
        "baseUrl": "",
        "defaultModel": "",
    },
}

DEFAULT_SETTINGS = {
    "enabled": False,
    "provider": "anthropic",
    "model": PROVIDERS["anthropic"]["defaultModel"],
    "baseUrl": "",
}

HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


class AIError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _http_post(
    url: str, headers: dict[str, str], body: dict[str, Any], timeout: float
) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"content-type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:  # noqa: BLE001 - 读错误体失败不该掩盖原始状态码
            detail = ""
        raise AIError("PROVIDER", f"服务返回 {exc.code}：{detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise AIError("PROVIDER", f"连接失败：{exc.reason}") from exc
    except OSError as exc:
        raise AIError("PROVIDER", f"连接失败：{exc}") from exc
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise AIError("PROVIDER", "服务返回的不是 JSON") from exc
    if not isinstance(parsed, dict):
        raise AIError("PROVIDER", "服务返回格式不符合预期")
    return parsed


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


class AI:
    def __init__(
        self,
        store: Store,
        review: Review,
        credentials: Any,
        score: Score | None = None,
        http: HttpPost | None = None,
    ) -> None:
        self.store = store
        self.reviewer = review
        self.credentials = credentials
        self.score = score
        self.http = http or _http_post

    # ---------- 设置与状态 ----------

    def _settings(self) -> dict[str, Any]:
        stored = self.store.review_setting_get(SETTINGS_KEY, {})
        settings = dict(DEFAULT_SETTINGS)
        if isinstance(stored, dict):
            for key in DEFAULT_SETTINGS:
                if key in stored:
                    settings[key] = stored[key]
        if settings["provider"] not in PROVIDERS:
            settings["provider"] = DEFAULT_SETTINGS["provider"]
        settings["enabled"] = bool(settings["enabled"])
        settings["model"] = _text(settings["model"], 80) or PROVIDERS[settings["provider"]][
            "defaultModel"
        ]
        settings["baseUrl"] = _text(settings["baseUrl"], 200)
        return settings

    def _has_key(self) -> bool:
        try:
            return bool(self.credentials.has(KEY_ID))
        except Exception:  # noqa: BLE001 - 凭据文件坏了等同于没有 Key
            return False

    def status(self) -> dict[str, Any]:
        settings = self._settings()
        return {
            "version": TALLY_AI_VERSION,
            "enabled": settings["enabled"],
            "hasKey": self._has_key(),
            "provider": settings["provider"],
            "model": settings["model"],
            "baseUrl": settings["baseUrl"],
            "providers": [
                {"id": key, "label": value["label"], "defaultModel": value["defaultModel"]}
                for key, value in PROVIDERS.items()
            ],
            "notice": "只在开启并保存 Key 后可用；发送内容仅为聚合统计与勾选的笔记",
        }

    def settings_save(self, params: dict[str, Any]) -> dict[str, Any]:
        current = self._settings()
        provider = _text(params.get("provider"), 20) or current["provider"]
        if provider not in PROVIDERS:
            raise AIError("BAD_PROVIDER", "不支持的模型提供方")

        model = _text(params.get("model"), 80) or PROVIDERS[provider]["defaultModel"]
        if not model:
            raise AIError("BAD_MODEL", "请填写模型名")

        base_url = _text(params.get("baseUrl"), 200).rstrip("/")
        if base_url and not base_url.startswith(("https://", "http://")):
            raise AIError("BAD_BASE_URL", "Base URL 必须以 http:// 或 https:// 开头")
        if not base_url:
            base_url = PROVIDERS[provider]["baseUrl"]
        if not base_url:
            raise AIError("BAD_BASE_URL", "OpenAI 兼容模式需要填写 Base URL")

        enabled = bool(params.get("enabled"))
        if "apiKey" in params:
            key = _text(params.get("apiKey"), 512)
            try:
                if key:
                    self.credentials.set(KEY_ID, key)
                else:
                    self.credentials.delete(KEY_ID)
            except Exception as exc:  # noqa: BLE001 - 不把底层异常文本原样抛给前端
                raise AIError("KEY_STORE", f"Key 保存失败：{exc}") from exc

        if enabled and not self._has_key():
            raise AIError("NO_KEY", "先保存 Key 再开启 AI 复盘")

        self.store.review_setting_set(
            SETTINGS_KEY,
            {"enabled": enabled, "provider": provider, "model": model, "baseUrl": base_url},
        )
        return self.status()

    # ---------- 聚合数据 ----------

    @staticmethod
    def _resolve_day(raw: Any, today: str) -> str:
        text = _text(raw, 10) or today
        try:
            datetime.strptime(text, DAY_FMT)
        except ValueError as exc:
            raise AIError("BAD_DATE", "日期格式应为 YYYY-MM-DD") from exc
        return text

    @staticmethod
    def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
        trades = len(rows)
        net = 0.0
        wins = losses = 0
        r_values: list[float] = []
        durations: list[int] = []
        for row in rows:
            profit = float(row.get("profit") or 0)
            net += profit
            if profit > 0.005:
                wins += 1
            elif profit < -0.005:
                losses += 1
            r_value = row.get("r")
            if r_value is None:
                try:
                    risk = float(row.get("risk") or 0)
                    r_value = (profit / risk) if risk > 0 else None
                except (TypeError, ValueError):
                    r_value = None
            if r_value is not None:
                r_values.append(float(r_value))
            if row.get("durationSec") is not None:
                durations.append(int(row["durationSec"]))
        return {
            "trades": trades,
            "wins": wins,
            "losses": losses,
            "winRate": round(wins / trades, 3) if trades else None,
            "net": round(net, 2),
            "totalR": round(sum(r_values), 2) if r_values else None,
            "avgR": round(sum(r_values) / len(r_values), 3) if r_values else None,
            "rTrades": len(r_values),
            "avgDurationMin": round(sum(durations) / len(durations) / 60, 1)
            if durations
            else None,
        }

    @staticmethod
    def _by_symbol(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            groups.setdefault(str(row.get("symbol") or "—"), []).append(row)
        out = []
        for symbol, items in groups.items():
            profit = sum(float(row.get("profit") or 0) for row in items)
            wins = sum(1 for row in items if float(row.get("profit") or 0) > 0.005)
            out.append(
                {
                    "symbol": symbol,
                    "trades": len(items),
                    "net": round(profit, 2),
                    "winRate": round(wins / len(items), 3),
                }
            )
        out.sort(key=lambda item: (-abs(item["net"]), item["symbol"]))
        return out[:6]

    def _mistakes(self, position_ids: list[int], login: int) -> list[dict[str, Any]]:
        if not position_ids:
            return []
        notes = self.store.trade_notes_all(login)
        counter: dict[str, int] = {}
        for position_id in position_ids:
            note = notes.get(int(position_id)) or {}
            for mistake in note.get("mistakes") or []:
                label = _text(mistake, 40)
                if label:
                    counter[label] = counter.get(label, 0) + 1
        ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
        return [{"mistake": key, "count": value} for key, value in ordered[:8]]

    def _adherence(self, login: int, server_offset: int, days: int) -> dict[str, Any] | None:
        try:
            result = self.reviewer.adherence({"days": days}, login, server_offset)
        except Exception:  # noqa: BLE001 - 遵守率缺失不影响复盘
            return None
        books = []
        total = weighted = 0.0
        for book in result.get("books", []):
            rate = book.get("rate")
            possible = float(book.get("possible") or 0)
            if rate is None or possible <= 0:
                continue
            books.append({"name": book.get("name"), "rate": round(float(rate), 3)})
            total += possible
            weighted += float(rate) * possible
        if not books:
            return None
        return {
            "overall": round(weighted / total, 3) if total else None,
            "books": books[:5],
        }

    def _score_block(self, login: int, server_offset: int, days: int) -> dict[str, Any] | None:
        if self.score is None:
            return None
        try:
            result = self.score.get({"days": days}, login, server_offset)
        except Exception:  # noqa: BLE001 - 评分缺失不影响复盘
            return None
        if result.get("score") is None:
            return None
        return {
            "score": result["score"],
            "version": result["version"],
            "weakest": [
                item["label"]
                for item in result.get("components", [])
                if item.get("included") and item.get("score") is not None and item["score"] < 50
            ][:3],
        }

    def _trade_rows(
        self, anchor: str, days: int, login: int, server_offset: int
    ) -> list[dict[str, Any]]:
        """取截至 anchor 的 days 天交易，只用 trades 返回的聚合字段。"""
        result = self.reviewer.trades({"days": days}, login, server_offset)
        return [row for row in result.get("trades", []) if str(row.get("day") or "") <= anchor]

    def _collect_notes(
        self, position_ids: list[int], day_note: str, login: int
    ) -> list[dict[str, Any]]:
        notes: list[dict[str, Any]] = []
        text = _text(day_note, 1200)
        if text:
            notes.append({"scope": "day", "text": text})
        stored = self.store.trade_notes_all(login)
        for position_id in position_ids[:MAX_NOTES]:
            trade_note = _text((stored.get(int(position_id)) or {}).get("note"), MAX_NOTE)
            if trade_note:
                notes.append({"scope": "trade", "positionId": int(position_id), "text": trade_note})
        return notes

    def build(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> tuple[str, str, dict[str, Any], list[dict[str, Any]]]:
        """返回 (kind, 锚点日期, 发送内容, 字段说明)。不读 Key，也不出网。"""
        kind = _text(params.get("kind"), 10) or "day"
        if kind not in ("day", "week"):
            raise AIError("BAD_KIND", "只支持 day / week")
        anchor = self._resolve_day(params.get("date"), self.reviewer._today())
        include_notes = bool(params.get("includeNotes"))
        anchor_date = datetime.strptime(anchor, DAY_FMT).date()

        if kind == "day":
            detail = self.reviewer.day({"date": anchor}, login, server_offset)
            rows = detail.get("records", [])
            summary = self._summarize(rows)
            profits = [float(row.get("profit") or 0) for row in rows]
            payload: dict[str, Any] = {"kind": "day", "date": anchor, "summary": summary}
            payload["best"] = round(max(profits), 2) if profits else None
            payload["worst"] = round(min(profits), 2) if profits else None
            position_ids = [int(row["position_id"]) for row in rows]
            day_note = str((detail.get("note") or {}).get("note") or "")
            span = 1
        else:
            start_date = anchor_date - timedelta(days=6)
            start = start_date.strftime(DAY_FMT)
            span = max(
                1,
                (datetime.strptime(self.reviewer._today(), DAY_FMT).date() - start_date).days + 1,
            )
            rows = self._trade_rows(anchor, span, login, server_offset)
            rows = [row for row in rows if start <= str(row.get("day") or "") <= anchor]
            payload = {
                "kind": "week",
                "start": start,
                "end": anchor,
                "summary": self._summarize(rows),
            }
            by_day: dict[str, dict[str, Any]] = {}
            for row in rows:
                key = str(row.get("day") or "")
                bucket = by_day.setdefault(key, {"date": key, "trades": 0, "net": 0.0})
                bucket["trades"] += 1
                bucket["net"] = round(bucket["net"] + float(row.get("profit") or 0), 2)
            payload["byDay"] = [by_day[key] for key in sorted(by_day)]
            position_ids = [int(row["positionId"]) for row in rows]
            day_note = ""

        payload["symbols"] = self._by_symbol(rows)
        mistakes = self._mistakes(position_ids, login)
        if mistakes:
            payload["mistakes"] = mistakes
        adherence = self._adherence(login, server_offset, span)
        if adherence:
            payload["adherence"] = adherence
        score_block = self._score_block(login, server_offset, span)
        if score_block:
            payload["score"] = score_block
        if include_notes:
            notes = self._collect_notes(position_ids, day_note, login)
            if notes:
                payload["notes"] = notes

        fields = self._fields(payload)
        return kind, anchor, payload, fields

    @staticmethod
    def _fields(payload: dict[str, Any]) -> list[dict[str, Any]]:
        summary = payload.get("summary") or {}
        fields: list[dict[str, Any]] = [
            {
                "key": "summary",
                "label": "区间汇总",
                "text": f"{summary.get('trades', 0)} 笔 · 净 {summary.get('net', 0)} · "
                f"胜率 {round((summary.get('winRate') or 0) * 100)}%",
            }
        ]
        if payload.get("symbols"):
            fields.append(
                {
                    "key": "symbols",
                    "label": "品种汇总",
                    "text": f"{len(payload['symbols'])} 个品种的笔数/净盈亏/胜率",
                }
            )
        if payload.get("mistakes"):
            fields.append({"key": "mistakes", "label": "错误标签", "text": "错误标签出现次数"})
        if payload.get("adherence"):
            fields.append({"key": "adherence", "label": "规则遵守率", "text": "各策略的规则通过比例"})
        if payload.get("score"):
            fields.append(
                {
                    "key": "score",
                    "label": "过程评分",
                    "text": f"{payload['score']['score']} 分（v{payload['score']['version']}）与短板分量",
                }
            )
        if payload.get("notes"):
            fields.append(
                {
                    "key": "notes",
                    "label": "你勾选的笔记",
                    "text": f"{len(payload['notes'])} 段，已截断到 500 字/条",
                }
            )
        else:
            fields.append({"key": "notes", "label": "笔记", "text": "未包含（需手动勾选）"})
        return fields

    def preview(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        """给前端看的「将发送哪些字段」；不需要 Key，也不出网。"""
        kind, anchor, payload, fields = self.build(params, login, server_offset)
        return {
            "kind": kind,
            "date": anchor,
            "fields": fields,
            "payload": payload,
            "bytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        }

    # ---------- 调用模型 ----------

    def _call_provider(
        self, settings: dict[str, Any], api_key: str, user_content: str
    ) -> str:
        provider = settings["provider"]
        base = (settings.get("baseUrl") or PROVIDERS[provider]["baseUrl"]).rstrip("/")
        model = settings["model"]
        if provider == "anthropic":
            url = f"{base}/v1/messages"
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
            body = {
                "model": model,
                "max_tokens": MAX_TOKENS,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_content}],
            }
        else:
            url = f"{base}/chat/completions"
            headers = {"authorization": f"Bearer {api_key}"}
            body = {
                "model": model,
                "max_tokens": MAX_TOKENS,
                "temperature": 0.4,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
            }
        try:
            data = self.http(url, headers, body, TIMEOUT_SECONDS)
        except AIError:
            raise
        except Exception as exc:  # noqa: BLE001 - 网络层异常统一转成可读错误
            raise AIError("PROVIDER", f"调用失败：{exc}") from exc

        if provider == "anthropic":
            blocks = data.get("content")
            text = ""
            if isinstance(blocks, list):
                text = "".join(
                    str(block.get("text") or "")
                    for block in blocks
                    if isinstance(block, dict) and block.get("type") == "text"
                )
        else:
            choices = data.get("choices")
            text = ""
            if isinstance(choices, list) and choices:
                message = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(message, dict):
                    text = str(message.get("content") or "")
        text = text.strip()
        if not text:
            raise AIError("PROVIDER", "模型没有返回文本")
        return text

    def review(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        settings = self._settings()
        if not settings["enabled"]:
            raise AIError("DISABLED", "AI 复盘未开启")
        try:
            api_key = self.credentials.get(KEY_ID)
        except Exception as exc:  # noqa: BLE001 - 凭据解密失败按缺 Key 处理
            raise AIError("NO_KEY", f"Key 读取失败：{exc}") from exc
        if not api_key:
            raise AIError("NO_KEY", "还没有保存 Key")

        kind, anchor, payload, fields = self.build(params, login, server_offset)
        provider = settings["provider"]
        model = settings["model"]
        refresh = bool(params.get("refresh"))

        if not refresh:
            cached = self.store.ai_review_get(login, kind, anchor, provider, model)
            if cached:
                return {
                    "kind": kind,
                    "date": anchor,
                    "provider": provider,
                    "model": model,
                    "text": cached["text"],
                    "generatedAt": cached["createdAt"],
                    "cached": True,
                    "fields": fields,
                }

        user_content = json.dumps(payload, ensure_ascii=False, indent=2)
        text = self._call_provider(settings, api_key, user_content)
        created_at = int(time.time())
        self.store.ai_review_save(login, kind, anchor, provider, model, text, created_at)
        return {
            "kind": kind,
            "date": anchor,
            "provider": provider,
            "model": model,
            "text": text,
            "generatedAt": created_at,
            "cached": False,
            "fields": fields,
        }

    def cache_clear(
        self, params: dict[str, Any], login: int, server_offset: int
    ) -> dict[str, Any]:
        kind = _text(params.get("kind"), 10) or "day"
        if kind not in ("day", "week"):
            raise AIError("BAD_KIND", "只支持 day / week")
        anchor = self._resolve_day(params.get("date"), self.reviewer._today())
        removed = self.store.ai_review_clear(login, kind, anchor)
        return {"removed": removed, "kind": kind, "date": anchor}
