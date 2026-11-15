from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import math
import queue
import sys
import threading
import time as _time_module
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Any, Awaitable, Callable

import MetaTrader5 as _mt5_module

import exporter
from accounts import AccountError, AccountManager
from ai import AI, AIError
from calendar_feed import week_payload
from config import BASE_DIR, Config
from journal import TradeJournal
from missed import Missed, MissedError
from score import Score
from notify import Notifier
from review import Review, ReviewError
from routines import RoutineError, Routines
from secure_store import CredentialStore
from store import Store


class _WorkerModuleProxy:
    """惰性转发到 mt5_worker 模块里的同名依赖。

    测试会直接替换 mt5_worker.mt5 / mt5_worker.time；方法必须看到替换后的对象，
    而不是导入时绑定的副本。
    """

    def __init__(self, attribute: str, fallback: Any) -> None:
        self._attribute = attribute
        self._fallback = fallback

    def __getattr__(self, name: str) -> Any:
        module = sys.modules.get("mt5_worker")
        target = getattr(module, self._attribute, None) if module else None
        if target is None or target is self:
            target = self._fallback
        return getattr(target, name)


mt5 = _WorkerModuleProxy("mt5", _mt5_module)
time = _WorkerModuleProxy("time", _time_module)

TIMEFRAMES = {
    "1": mt5.TIMEFRAME_M1,
    "5": mt5.TIMEFRAME_M5,
    "15": mt5.TIMEFRAME_M15,
    "30": mt5.TIMEFRAME_M30,
    "60": mt5.TIMEFRAME_H1,
    "240": mt5.TIMEFRAME_H4,
    "1D": mt5.TIMEFRAME_D1,
    "1W": mt5.TIMEFRAME_W1,
    "1M": mt5.TIMEFRAME_MN1,
}

RES_SECONDS = {
    "1": 60,
    "5": 300,
    "15": 900,
    "30": 1800,
    "60": 3600,
    "240": 14400,
    "1D": 86400,
    "1W": 604800,
    "1M": 2592000,
}

RETCODE_TEXT = {
    10004: "价格变动，请重试",
    10006: "请求被拒绝",
    10007: "请求被交易者取消",
    10008: "挂单已放置",
    10009: "成交完成",
    10010: "部分成交",
    10011: "请求处理中",
    10012: "请求超时",
    10013: "请求参数无效",
    10014: "手数无效",
    10015: "价格无效",
    10016: "止损/止盈无效（距离过近或方向错误）",
    10017: "交易被禁用",
    10018: "市场已关闭",
    10019: "保证金不足",
    10020: "价格已变化",
    10021: "当前无报价",
    10022: "挂单有效期无效",
    10023: "订单状态已变化",
    10024: "请求过于频繁",
    10025: "没有变化",
    10026: "服务器禁止自动交易",
    10027: "客户端禁止自动交易",
    10028: "交易被锁定",
    10029: "订单/持仓已冻结",
    10030: "填充模式无效",
    10031: "与交易服务器无连接",
    10032: "仅允许实盘账户操作",
    10033: "挂单数量已达上限",
    10034: "交易量已达上限",
    10035: "订单类型无效",
    10036: "持仓已关闭",
}

OK_RETCODES = {10008, 10009, 10010}

log = logging.getLogger("mytrade.gateway.worker")

# 服务端命令超时：必须略小于 src/gateway/client.ts 里同名方法的前端超时，
# 前端才能收到明确错误码，而不是笼统的“请求超时”。
COMMAND_TIMEOUT_DEFAULT = 7.0
COMMAND_TIMEOUTS = {
    "history.get": 18.0,
    "ai.payload": 18.0,
    "ai.review": 85.0,
    "data.export": 50.0,
    "data.backup.create": 50.0,
    "data.backup.list": 18.0,
    "journal.stats": 18.0,
    "journal.sync": 20.0,
    "review.trades": 18.0,
    "missed.simulate": 25.0,
    "order.place": 12.0,
    "order.modify": 12.0,
    "order.cancel": 12.0,
    "position.modify": 12.0,
    "position.breakeven": 12.0,
    "position.close": 12.0,
    "position.closeAll": 18.0,
    "account.switch": 25.0,
    "system.reconcile": 25.0,
    "diagnostics.get": 20.0,
}

# 可能已经改变券商侧状态的命令：超时不能简单报“失败”，只能报结果未知并自动对账。
MUTATING_METHODS = frozenset(
    {
        "order.place",
        "order.modify",
        "order.cancel",
        "position.modify",
        "position.breakeven",
        "position.close",
        "position.closeAll",
    }
)


def command_timeout(method: str) -> float:
    return COMMAND_TIMEOUTS.get(method, COMMAND_TIMEOUT_DEFAULT)


# 挂单计划：成交后登记的宽限（成交与持仓快照之间有几百毫秒空档）与最长存活时间
PENDING_PLAN_GRACE = 3.0
PENDING_PLAN_TTL = 30 * 24 * 3600

# 单轮最多执行多少条命令，避免命令洪峰饿死行情/持仓轮询
MAX_COMMANDS_PER_TICK = 32

# 自动备份：每小时检查一次，24 小时内已有自动备份就跳过，只保留最近 7 份
AUTO_BACKUP_INTERVAL = 3600
AUTO_BACKUP_MIN_AGE = 24 * 3600
AUTO_BACKUP_KEEP = 7

ORDER_STATES = {
    0: "started",
    1: "working",
    2: "cancelled",
    3: "partial",
    4: "filled",
    5: "rejected",
    6: "expired",
    7: "request_add",
    8: "request_modify",
    9: "request_cancel",
}


class GatewayError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def round_volume(volume: float, step: float) -> float:
    if step <= 0:
        return volume
    d = Decimal(str(step))
    q = (Decimal(str(volume)) / d).to_integral_value(rounding=ROUND_DOWN)
    return float(q * d)


def align_price(price: float, info: Any) -> float:
    tick = float(getattr(info, "trade_tick_size", 0) or getattr(info, "point", 0) or 0)
    digits = int(info.digits)
    if tick <= 0:
        return round(price, digits)
    return round(round(price / tick) * tick, digits)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


