from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


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

    @classmethod
    def load(cls) -> "Config":
        path = BASE_DIR / "config.json"
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in raw.items() if k in known})

    def update(self, patch: dict) -> dict:
        """校验并保存设置页可改的风控字段，保留 config.json 里的其他字段。"""
        clean: dict[str, float | int] = {}
        for key, value in patch.items():
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

        path = BASE_DIR / "config.json"
        raw: dict = asdict(self)
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
        raw.update(clean)
        path.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        for key, value in clean.items():
            setattr(self, key, value)
        return self.public()

    def public(self) -> dict:
        data = asdict(self)
        data.pop("host", None)
        data.pop("port", None)
        # 通道配置里有 token/webhook 密钥，只下发通道名称
        channels = data.pop("alert_channels", []) or []
        data["alert_channel_names"] = [
            str(item.get("name") or item.get("type"))
            for item in channels
            if isinstance(item, dict)
        ]
        return data
