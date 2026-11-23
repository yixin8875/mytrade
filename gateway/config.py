from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field

import alert_channels
from paths import BASE_DIR


@dataclass
class Config:
    # 设置页允许修改的风控字段：字段 -> (类型, 最小值, 最大值)
    EDITABLE_FIELDS = {
        "max_lot": (float, 0.01, 1000.0),
        "max_risk_pct": (float, 0.01, 100.0),
        "max_positions": (int, 1, 100),
        "daily_loss_pct": (float, 0.0, 100.0),
        "max_trades_per_day": (int, 0, 10_000),
        "max_consecutive_losses": (int, 0, 1_000),
        "cooldown_minutes": (int, 0, 10_080),
        "max_spread_points": (int, 0, 1_000_000),
    }

    host: str = "127.0.0.1"
    port: int = 8765

    # 固定连接哪个 MT5 终端（terminal64.exe 路径）；为空时由 MetaTrader5 自行选择，
    # 同时开着多个终端时可能连到别的账户，建议显式指定。
    terminal_path: str = ""
    # 期望登录的账户号，0 = 不校验；非 0 时连错账户会报错并断开。
    expected_login: int = 0
    # 多账户配置：每个账户对应一个已登录的 MT5 终端实例。
    # [{"id": "a", "label": "主账户", "terminal_path": "C:/.../terminal64.exe",
    #   "login": 123456, "server": "Broker-Demo"}]
    # 切换时网关会 shutdown 后重新 initialize 到目标 terminal_path，并用 login 校验。
    accounts: list[dict] = field(default_factory=list)
    # 上次选中的账户 id；空 = 使用 accounts 里的第一个。
    active_account: str = ""

    # 交易模式：readonly 只读 / demo 允许模拟账户交易 / live 允许实盘
    trade_mode: str = "readonly"
    allow_live: bool = False

    max_lot: float = 0.50
    max_risk_pct: float = 1.0
    max_spread_points: int = 0  # 0 = 不限制
    max_positions: int = 3
    # 当日亏损（已实现 + 浮动）达到起始余额的该比例后禁止开新仓
    daily_loss_pct: float = 2.0
    # 当日最多开仓次数，0 = 不限制
    max_trades_per_day: int = 8
    # 连续亏损达到该次数后进入冷却，0 = 不启用
    max_consecutive_losses: int = 3
    cooldown_minutes: int = 30
    deviation_points: int = 20
    # 移动止损每次至少改进的点数
    trailing_step_points: int = 5
    magic: int = 260511
    # 告警的第三方推送通道（含密钥，绝不下发给前端）
    # [{"type": "webhook", "url": "...", "headers": {...}},
    #  {"type": "telegram", "token": "...", "chatId": "..."},
    #  {"type": "discord", "url": "..."}, {"type": "wecom", "url": "..."}]
    alert_channels: list[dict] = field(default_factory=list)
    # 在默认白名单（Vite 开发页 + Tauri 桌面壳）之外，额外允许的页面来源。
    # 一般不用改；需要从别的地址打开界面时再加，如 "http://192.168.1.10:5173"。
    allowed_origins: list[str] = field(default_factory=list)

    # 开仓纪律门禁：只作用于 order.place，不拦平仓/改单/保本等保护性操作
    # off = 关闭；confirm = 未完成清单时二次确认；block = 未完成则拒绝下单
    discipline_mode: str = "off"
    # 默认清单（playbook id）；票面可临时改选
    discipline_playbook: str = ""
    # 强行跳过清单时是否必须填写理由
    discipline_require_reason: bool = False

    @classmethod
    def load(cls) -> "Config":
        path = BASE_DIR / "config.json"
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in raw.items() if k in known})

    @staticmethod
    def _slug(value: str, fallback: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
        return cleaned or fallback

    @classmethod
    def _clean_risk(cls, value: object) -> dict:
        """账户级风控覆盖：只保留已知字段，并做与全局一致的取值范围校验。"""
        if not isinstance(value, dict):
            return {}
        clean: dict[str, float | int] = {}
        for key, number in value.items():
            spec = cls.EDITABLE_FIELDS.get(key)
            if spec is None or isinstance(number, bool) or not isinstance(number, (int, float)):
                continue
            kind, low, high = spec
            if kind is int and not isinstance(number, int):
                continue
            parsed = kind(number)
            if low <= parsed <= high:
                clean[key] = parsed
        return clean

    @classmethod
    def _clean_account_discipline(cls, value: object) -> dict:
        """账户级纪律覆盖：只保留已知键，非法值静默丢弃（与 _clean_risk 一致）。"""
        if not isinstance(value, dict):
            return {}
        clean: dict[str, object] = {}
        mode = str(value.get("mode") or "").strip().lower()
        if mode in ("off", "confirm", "block"):
            clean["mode"] = mode
        playbook = value.get("playbook")
        if isinstance(playbook, str):
            clean["playbook"] = playbook.strip()[:40]
        require_reason = value.get("require_reason")
        if isinstance(require_reason, bool):
            clean["require_reason"] = require_reason
        return clean

    @staticmethod
    def _read_raw() -> dict:
        path = BASE_DIR / "config.json"
        if not path.exists():
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}

    @staticmethod
    def _write_raw(raw: dict) -> None:
        path = BASE_DIR / "config.json"
        tmp = path.with_name(f"{path.name}.tmp")
        tmp.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, path)

    def _normalize_accounts(self, raw: list) -> list[dict]:
        profiles: list[dict] = []
        used: set[str] = set()
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                continue
            try:
                login = int(item.get("login") or 0)
            except (TypeError, ValueError):
                login = 0
            base = str(item.get("id") or item.get("name") or (login or f"acc{index + 1}"))
            account_id = self._slug(base, f"acc{index + 1}")
            if account_id in used:
                suffix = 2
                while f"{account_id}-{suffix}" in used:
                    suffix += 1
                account_id = f"{account_id}-{suffix}"
            used.add(account_id)
            label = str(
                item.get("label")
                or item.get("name")
                or (f"账户 {login}" if login else f"账户 {index + 1}")
            )
            profiles.append(
                {
                    "id": account_id,
                    "label": label[:40],
                    "login": login,
                    "server": str(item.get("server") or "")[:80],
                    "terminal_path": str(
                        item.get("terminal_path")
                        or item.get("terminalPath")
                        or self.terminal_path
                        or ""
                    ),
                    "risk": self._clean_risk(item.get("risk")),
                    "discipline": self._clean_account_discipline(item.get("discipline")),
                }
            )
        return profiles

    def configured_accounts(self) -> list[dict]:
        """只返回 config.json 里显式配置的账户，不合成默认终端。"""
        raw = self.accounts if isinstance(self.accounts, list) else []
        return self._normalize_accounts(raw)

    def account_profiles(self) -> list[dict]:
        """规范化 accounts 配置；没有配置时退化成单终端（terminal_path / expected_login）。"""
        profiles = self.configured_accounts()
        if not profiles:
            profiles.append(
                {
                    "id": "default",
                    "label": "默认终端",
                    "login": int(self.expected_login or 0),
                    "server": "",
                    "terminal_path": self.terminal_path,
                    "risk": {},
                    "discipline": {},
                }
            )
        return profiles

    def active_profile(self) -> dict:
        profiles = self.account_profiles()
        for profile in profiles:
            if profile["id"] == self.active_account:
                return profile
        return profiles[0]

    def save_accounts(self, accounts: list[dict], active_account: str | None = None) -> list[dict]:
        """保存账户列表与当前选择；密码由独立的 DPAPI 凭据文件保存。"""
        profiles = self._normalize_accounts(accounts)
        if not profiles:
            raise ValueError("至少保留一个账户")
        ids = {profile["id"] for profile in profiles}
        active = active_account if active_account in ids else profiles[0]["id"]
        raw = self._read_raw()
        serialized = []
        for profile in profiles:
            entry = {
                "id": profile["id"],
                "label": profile["label"],
                "login": profile["login"],
                "server": profile["server"],
                "terminal_path": profile["terminal_path"],
            }
            if profile.get("risk"):
                entry["risk"] = dict(profile["risk"])
            if profile.get("discipline"):
                entry["discipline"] = dict(profile["discipline"])
            serialized.append(entry)
        raw["accounts"] = serialized
        raw["active_account"] = active
        self._write_raw(raw)
        self.accounts = raw["accounts"]
        self.active_account = active
        return profiles

    def set_active_account(self, account_id: str) -> dict:
        """校验并持久化当前账户选择，保留 config.json 里的其他字段。"""
        profiles = self.account_profiles()
        profile = next((item for item in profiles if item["id"] == account_id), None)
        if profile is None:
            raise ValueError(f"未知账户: {account_id}")

        raw = self._read_raw()
        raw["active_account"] = profile["id"]
        self._write_raw(raw)
        self.active_account = profile["id"]
        return profile

    def update(self, patch: dict) -> dict:
        """校验并保存设置页可改的风控与纪律字段，保留 config.json 里的其他字段。"""
        clean: dict[str, object] = {}
        for key, value in patch.items():
            if key in ("discipline_mode", "discipline_playbook", "discipline_require_reason"):
                clean[key] = self._clean_discipline(key, value)
                continue
            spec = self.EDITABLE_FIELDS.get(key)
            if spec is None:
                raise ValueError(f"字段 {key} 不允许在设置页修改")
            kind, low, high = spec
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} 必须是数字")
            if kind is int and not isinstance(value, int):
                raise ValueError(f"{key} 必须是整数")
            number = kind(value)
            if not low <= number <= high:
                raise ValueError(f"{key} 必须在 {low} 到 {high} 之间")
            clean[key] = number

        if not clean:
            raise ValueError("没有需要保存的字段")

        raw = self._read_raw() or asdict(self)
        raw.update(clean)
        self._write_raw(raw)
        for key, value in clean.items():
            setattr(self, key, value)
        return self.public()

    @staticmethod
    def _clean_discipline(key: str, value: object) -> object:
        """纪律门禁字段：mode 三档、playbook id 限长、require_reason 必须是布尔。"""
        if key == "discipline_mode":
            mode = str(value or "").strip().lower()
            if mode not in ("off", "confirm", "block"):
                raise ValueError("discipline_mode 只能是 off / confirm / block")
            return mode
        if key == "discipline_playbook":
            if not isinstance(value, str):
                raise ValueError("discipline_playbook 必须是字符串")
            return value.strip()[:40]
        if not isinstance(value, bool):
            raise ValueError("discipline_require_reason 必须是布尔值")
        return value

    def account_risk(self, account_id: str) -> dict:
        """账户自己的风控覆盖；没有配置时返回空 dict（全部继承全局）。"""
        profile = next(
            (item for item in self.account_profiles() if item["id"] == account_id), None
        )
        return dict(profile.get("risk") or {}) if profile else {}

    def risk_limits(self, account_id: str | None = None) -> dict:
        """当前账户真正生效的风控：全局默认被账户覆盖改写。"""
        limits: dict[str, float | int] = {
            key: getattr(self, key) for key in self.EDITABLE_FIELDS
        }
        limits.update(self.account_risk(account_id or self.active_profile()["id"]))
        return limits

    def set_account_risk(self, account_id: str, patch: dict) -> dict:
        """保存账户级风控覆盖；值为 None 表示删掉该覆盖、恢复跟随全局。"""
        profiles = self.account_profiles()
        if not any(item["id"] == account_id for item in profiles):
            raise ValueError(f"未知账户: {account_id}")

        current = self.account_risk(account_id)
        for key, value in patch.items():
            if key not in self.EDITABLE_FIELDS:
                raise ValueError(f"字段 {key} 不支持按账户设置")
            if value is None:
                current.pop(key, None)
                continue
            kind, low, high = self.EDITABLE_FIELDS[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} 必须是数字")
            if kind is int and not isinstance(value, int):
                raise ValueError(f"{key} 必须是整数")
            number = kind(value)
            if not low <= number <= high:
                raise ValueError(f"{key} 必须在 {low} 到 {high} 之间")
            current[key] = number

        accounts = []
        for profile in profiles:
            entry = {
                "id": profile["id"],
                "label": profile["label"],
                "login": profile["login"],
                "server": profile["server"],
                "terminal_path": profile["terminal_path"],
            }
            risk = current if profile["id"] == account_id else profile.get("risk") or {}
            if risk:
                entry["risk"] = dict(risk)
            discipline = profile.get("discipline") or {}
            if discipline:
                entry["discipline"] = dict(discipline)
            accounts.append(entry)

        raw = self._read_raw()
        raw["accounts"] = accounts
        raw.setdefault("active_account", self.active_profile()["id"])
        self._write_raw(raw)
        self.accounts = accounts
        return self.public()

    def account_discipline(self, account_id: str) -> dict:
        """账户自己的纪律覆盖；没有配置时返回空 dict（全部继承全局）。"""
        profile = next(
            (item for item in self.account_profiles() if item["id"] == account_id), None
        )
        return dict(profile.get("discipline") or {}) if profile else {}

    def discipline_settings(self, account_id: str | None = None) -> dict:
        """当前账户真正生效的门禁设置：全局默认被账户覆盖改写。"""
        settings: dict[str, object] = {
            "mode": self.discipline_mode,
            "playbook": self.discipline_playbook,
            "require_reason": bool(self.discipline_require_reason),
        }
        settings.update(self.account_discipline(account_id or self.active_profile()["id"]))
        return settings

    _DISCIPLINE_OVERRIDE_KEYS = {
        "mode": "discipline_mode",
        "playbook": "discipline_playbook",
        "require_reason": "discipline_require_reason",
    }

    def set_account_discipline(self, account_id: str, patch: dict) -> dict:
        """保存账户级门禁覆盖；值为 None 表示删掉该覆盖、恢复跟随全局。"""
        profiles = self.account_profiles()
        if not any(item["id"] == account_id for item in profiles):
            raise ValueError(f"未知账户: {account_id}")

        current = self.account_discipline(account_id)
        for key, value in patch.items():
            field = self._DISCIPLINE_OVERRIDE_KEYS.get(key)
            if field is None:
                raise ValueError(f"字段 {key} 不支持按账户设置")
            if value is None:
                current.pop(key, None)
                continue
            current[key] = self._clean_discipline(field, value)

        accounts = []
        for profile in profiles:
            entry = {
                "id": profile["id"],
                "label": profile["label"],
                "login": profile["login"],
                "server": profile["server"],
                "terminal_path": profile["terminal_path"],
            }
            risk = profile.get("risk") or {}
            if risk:
                entry["risk"] = dict(risk)
            discipline = current if profile["id"] == account_id else profile.get("discipline") or {}
            if discipline:
                entry["discipline"] = dict(discipline)
            accounts.append(entry)

        raw = self._read_raw()
        raw["accounts"] = accounts
        raw.setdefault("active_account", self.active_profile()["id"])
        self._write_raw(raw)
        self.accounts = accounts
        return self.public()

    def set_allow_live(self, allow: bool) -> dict:
        """运行时打开/关闭实盘开关：写回 config.json，立即生效。"""
        raw = self._read_raw() or asdict(self)
        raw["allow_live"] = bool(allow)
        self._write_raw(raw)
        self.allow_live = bool(allow)
        return self.public()

    def ensure_channel_ids(self) -> list[dict]:
        """读取磁盘上的告警通道，补齐缺失的稳定 id；只有真的补了才写回。"""
        raw = self._read_raw() or asdict(self)
        stored = raw.get("alert_channels")
        if stored is None:
            stored = self.alert_channels
        channels, changed = alert_channels.assign_ids(stored)
        if changed:
            raw["alert_channels"] = channels
            self._write_raw(raw)
        self.alert_channels = channels
        return channels

    def channels_public(self) -> list[dict]:
        """设置页可见的通道列表（不含任何密钥值）。"""
        return alert_channels.public_list(self.ensure_channel_ids())

    def save_channel(self, incoming: dict) -> dict:
        """新增或更新一个告警通道；密钥字段留空表示保持原值。"""
        if not isinstance(incoming, dict):
            raise ValueError("channel 必须是对象")
        raw = self._read_raw() or asdict(self)
        stored = raw.get("alert_channels")
        if stored is None:
            stored = self.alert_channels
        channels, _ = alert_channels.assign_ids(stored)

        channel_id = str(incoming.get("id") or "").strip()
        existing = None
        if channel_id:
            existing = next(
                (item for item in channels if item.get("id") == channel_id), None
            )
            if existing is None:
                raise ValueError("通道不存在，可能已被删除")
        elif len(channels) >= alert_channels.MAX_CHANNELS:
            raise ValueError(f"最多只能配置 {alert_channels.MAX_CHANNELS} 个通道")

        merged = alert_channels.merge(existing, incoming)
        alert_channels.validate(merged)

        if existing is None:
            channels.append(merged)
        else:
            for index, item in enumerate(channels):
                if item.get("id") == channel_id:
                    channels[index] = merged
                    break

        raw["alert_channels"] = channels
        self._write_raw(raw)
        self.alert_channels = channels
        public = alert_channels.public_list(channels)
        saved = next((item for item in public if item["id"] == merged["id"]), None)
        return {"channel": saved, "channels": public}

    def delete_channel(self, channel_id: str) -> dict:
        """删除一个告警通道；id 不存在时报错而不是静默成功。"""
        raw = self._read_raw() or asdict(self)
        stored = raw.get("alert_channels")
        if stored is None:
            stored = self.alert_channels
        channels, _ = alert_channels.assign_ids(stored)
        target = next((item for item in channels if item.get("id") == channel_id), None)
        if target is None:
            raise ValueError("通道不存在，可能已被删除")

        channels = [item for item in channels if item.get("id") != channel_id]
        raw["alert_channels"] = channels
        self._write_raw(raw)
        self.alert_channels = channels
        deleted = alert_channels.public_list([target])
        return {
            "deleted": deleted[0] if deleted else {"id": channel_id},
            "channels": alert_channels.public_list(channels),
        }

    def public(self) -> dict:
        data = asdict(self)
        data.pop("host", None)
        data.pop("port", None)
        # 账户列表用规范化后的结构，路径和登录号都是本机信息，前端需要展示
        data["accounts"] = [
            {
                "id": profile["id"],
                "label": profile["label"],
                "login": profile["login"],
                "server": profile["server"],
                "terminal_path": profile["terminal_path"],
                "risk": profile.get("risk") or {},
                "discipline": profile.get("discipline") or {},
            }
            for profile in self.account_profiles()
        ]
        data["active_account"] = self.active_profile()["id"]
        # 通道配置里有 token/webhook 密钥，只下发通道名称
        channels = data.pop("alert_channels", []) or []
        data["alert_channel_names"] = [
            str(item.get("name") or item.get("type"))
            for item in channels
            if isinstance(item, dict)
        ]
        return data
