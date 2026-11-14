"""worker 的非交易面：RPC 分派、健康状态、交易模式守卫与账户管理。"""

import types
from pathlib import Path

import pytest

import mt5_worker
from accounts import AccountError
from mt5_worker import GatewayError, Mt5Worker

LIMITS = {
    "max_lot": 1.0,
    "max_risk_pct": 1.0,
    "max_positions": 3,
    "daily_loss_pct": 2.0,
    "max_trades_per_day": 8,
    "max_consecutive_losses": 3,
    "cooldown_minutes": 30,
    "max_spread_points": 0,
}


class FakeStore:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.audits: list[tuple[str, object]] = []
        self.state: dict[str, object] = {}
        self.calls: list[tuple[str, tuple]] = []
        self.risks: list[dict] = []

    def audit(self, kind: str, payload: object) -> None:
        self.audits.append((kind, payload))

    def get_state(self, key: str, login: int = 0) -> object:
        return self.state.get(key)

    def set_state(self, key: str, value: object, login: int = 0) -> None:
        self.state[key] = value

    def get_intent(self, client_id: str, login: int = 0):
        return None

    def update_intent(self, client_id: str, state: str, **fields) -> None:
        self.calls.append(("update_intent", (client_id, state, fields)))

    def recent_intents(self, limit: int, login: int = 0):
        self.calls.append(("recent_intents", (limit, login)))
        return []

    def execution_stats(self, days: int, login: int = 0):
        self.calls.append(("execution_stats", (days, login)))
        return {"days": days}

    def audit_query(self, date: str, kind, text, limit: int):
        self.calls.append(("audit_query", (date, kind, text, limit)))
        return []

    def audit_tail(self, limit: int):
        self.calls.append(("audit_tail", (limit,)))
        return []

    def alerts_list(self, login: int = 0):
        self.calls.append(("alerts_list", (login,)))
        return []

    def record_position_risk(self, row: dict) -> None:
        self.risks.append(row)

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.audits]


class FakeConfig:
    def __init__(self) -> None:
        self.profiles = [
            {
                "id": "a",
                "label": "主账户",
                "login": 111,
                "server": "S1",
                "terminal_path": "C:/a.exe",
                "risk": {"max_lot": 2.0},
            },
            {
                "id": "b",
                "label": "副账户",
                "login": 222,
                "server": "S2",
                "terminal_path": "C:/b.exe",
                "risk": {},
            },
        ]
        self.active = "a"
        self.allow_live = False
        self.magic = 260511
        self.deviation_points = 20
        self.trailing_step_points = 10
        self.trade_mode = "demo"
        self.update_error: Exception | None = None
        self.save_error: Exception | None = None
        self.updates: list[dict] = []

    def active_profile(self) -> dict:
        return next((p for p in self.profiles if p["id"] == self.active), self.profiles[0])

    def account_profiles(self) -> list[dict]:
        return [dict(p) for p in self.profiles]

    def configured_accounts(self) -> list[dict]:
        return self.account_profiles()

    def _profile(self, account_id: str) -> dict | None:
        return next((p for p in self.profiles if p["id"] == account_id), None)

    def risk_limits(self, account_id: str | None = None) -> dict:
        profile = self._profile(account_id or self.active)
        limits = dict(LIMITS)
        if profile:
            limits.update(profile.get("risk") or {})
        return limits

    def account_risk(self, account_id: str) -> dict:
        profile = self._profile(account_id)
        return dict(profile.get("risk") or {}) if profile else {}

    def public(self) -> dict:
        return {
            "tradeMode": self.trade_mode,
            "allowLive": self.allow_live,
            "accounts": self.account_profiles(),
        }

    def update(self, patch: dict) -> dict:
        if self.update_error:
            raise self.update_error
        self.updates.append(dict(patch))
        return {"config": self.public(), "limits": self.risk_limits()}

    def set_active_account(self, account_id: str) -> dict:
        if self._profile(account_id) is None:
            raise ValueError(f"未知账户: {account_id}")
        if self.save_error:
            raise self.save_error
        self.active = account_id
        return self.active_profile()

    def set_account_risk(self, account_id: str, patch: dict) -> dict:
        profile = self._profile(account_id)
        if profile is None:
            raise ValueError(f"未知账户: {account_id}")
        if self.save_error:
            raise self.save_error
        risk = profile.setdefault("risk", {})
        for key, value in patch.items():
            if value is None:
                risk.pop(key, None)
            else:
                risk[key] = float(value)
        return {"accounts": self.account_profiles(), **self.public()}

    def set_allow_live(self, allow: bool) -> dict:
        if self.save_error:
            raise self.save_error
        self.allow_live = allow
        return self.public()


class FakeAccountMgr:
    def __init__(self) -> None:
        self.passwords = {"a": True, "b": False}
        self.error: Exception | None = None
        self.calls: list[tuple] = []
        self.create_result = {"id": "new", "seeded": True}
        self.update_result = {
            "id": "a",
            "connectionChanged": False,
            "passwordChanged": False,
        }
        self.delete_result = {"id": "b"}

    def _maybe_fail(self):
        if self.error:
            raise self.error

    def has_password(self, account_id: str) -> bool:
        return self.passwords.get(account_id, False)

    def create(self, payload: dict, current: dict | None = None) -> dict:
        self.calls.append(("create", payload, current))
        self._maybe_fail()
        return dict(self.create_result)

    def update(self, payload: dict) -> dict:
        self.calls.append(("update", payload))
        self._maybe_fail()
        return dict(self.update_result)

    def delete(self, account_id: str) -> dict:
        self.calls.append(("delete", account_id))
        self._maybe_fail()
        return dict(self.delete_result)


class FakeJournal:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def stats(self, days: int, login: int):
        self.calls.append(("stats", days, login))
        return {"days": days}

    def sync(self, login: int, force: bool = False) -> int:
        self.calls.append(("sync", login, force))
        return 3


def install_mt5(monkeypatch, terminal=None, trade_allowed: bool = True):
    calls = {"shutdown": 0}

    def shutdown() -> None:
        calls["shutdown"] += 1

    if terminal is None:
        terminal = types.SimpleNamespace(
            trade_allowed=trade_allowed,
            company="Broker",
            name="MetaTrader 5",
            build=4000,
            path="C:/MT5/terminal64.exe",
            connected=True,
            dlls_allowed=True,
        )
    fake = types.SimpleNamespace(
        terminal_info=lambda: terminal,
        shutdown=shutdown,
        last_error=lambda: (-1, "boom"),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    return fake, calls


@pytest.fixture()
def emitted():
    return []


@pytest.fixture()
def worker(tmp_path, monkeypatch, emitted):
    install_mt5(monkeypatch)
    w = Mt5Worker.__new__(Mt5Worker)
    w.cfg = FakeConfig()
    w.store = FakeStore(tmp_path / "base")
    w._publish = lambda *args: None
    w._emit = lambda event, data: emitted.append((event, data))
    w._loop = None
    w._account_id = "a"
    w._connected = True
    w._account = {
        "login": 111,
        "balance": 10000.0,
        "equity": 10000.0,
        "accountType": "demo",
        "tradeAllowed": True,
        "server": "S1",
    }
    w._positions = []
    w._orders = []
    w._limits = w.cfg.risk_limits("a")
    w._trade_mode = "demo"
    w._halted = None
    w._risk = None
    w._last_error = None
    w._server_offset = 0
    w._account_mgr = FakeAccountMgr()
    w._journal = FakeJournal()
    w._alerts = []
    w._alert_last = {}
    w._watch_day = {}
    w._subs = {}
    w._bar_subs = {}
    w._trailing = {}
    w._trail_next = {}
    w._auto_be = {}
    w._pending_plans = {}
    w._auto_be_pause_reason = ""
    w._risk_tracked = {}
    w._poll_risk = lambda force=False: None
    w._try_connect = lambda force_login=False: None
    w._state_loaded = True
    return w


def code_for(call) -> str:
    with pytest.raises(GatewayError) as exc:
        call()
    return exc.value.code


# ---------- 健康状态 ----------


def test_未连接时健康状态没有终端信息(worker):
    worker._connected = False
    worker._account = None

    data = worker.health()

    assert data["connected"] is False
    assert data["terminal"] is None
    assert data["account"] is None
    assert data["activeAccountId"] == "a"
    assert data["tradeMode"] == "demo"
    assert data["limits"]["max_lot"] == 2.0
    assert data["accountRisk"] == {"max_lot": 2.0}
    assert data["config"] == worker.cfg.public()
    assert data["lastError"] is None
    assert data["serverOffset"] == 0
    assert data["version"] == "0.7.2"
    assert isinstance(data["serverTime"], int)


def test_已连接时映射终端信息(worker):
    data = worker.health()

    assert data["terminal"] == {
        "company": "Broker",
        "name": "MetaTrader 5",
        "build": 4000,
        "path": "C:/MT5/terminal64.exe",
        "connected": True,
        "tradeAllowed": True,
        "dllsAllowed": True,
    }
    assert data["account"]["login"] == 111


def test_账户列表连接状态与密码标记(worker):
    rows = worker._accounts_payload()

    assert rows[0] == {
        "id": "a",
        "label": "主账户",
        "login": 111,
        "server": "S1",
        "terminalPath": "C:/a.exe",
        "active": True,
        "connected": True,
        "hasPassword": True,
        "configured": True,
    }
    assert rows[1]["active"] is False
    assert rows[1]["connected"] is False
    assert rows[1]["hasPassword"] is False


def test_账户列表使用实际连接的登录号(worker):
    worker._account = {"login": 999, "server": "Live"}

    rows = worker._accounts_payload()

    assert rows[0]["login"] == 999
    assert rows[0]["server"] == "Live"
    assert rows[1]["login"] == 222


# ---------- 方法分派 ----------


def test_未知方法被拒绝(worker):
    with pytest.raises(GatewayError) as exc:
        worker._dispatch("nope.nope", {})
    assert exc.value.code == "UNKNOWN_METHOD"
    assert "nope.nope" in exc.value.message


def test_ping返回时间戳(worker):
    result = worker._dispatch("ping", {})
    assert isinstance(result["pong"], float)


def test_分派到账户与配置处理器(worker):
    worker._set_config = lambda p: {"config": p}
    worker._set_account_risk = lambda p: {"risk": p}
    worker._set_allow_live = lambda p: {"allow": p}
    worker._set_trade_mode = lambda p: {"mode": p}
    worker._halt = lambda p: {"halt": p}
    worker._resume = lambda p: {"resume": p}
    worker._reconcile_now = lambda p: {"reconcile": p}
    worker._create_account = lambda p: {"create": p}
    worker._update_account = lambda p: {"update": p}
    worker._delete_account = lambda p: {"delete": p}
    worker._switch_account = lambda p: {"switch": p}

    cases = {
        "system.setConfig": "config",
        "system.setAccountRisk": "risk",
        "system.setAllowLive": "allow",
        "system.setTradeMode": "mode",
        "system.halt": "halt",
        "system.resume": "resume",
        "system.reconcile": "reconcile",
        "accounts.create": "create",
        "accounts.update": "update",
        "accounts.delete": "delete",
        "account.switch": "switch",
    }
    for method, key in cases.items():
        assert worker._dispatch(method, {"v": 1}) == {key: {"v": 1}}


def test_分派到交易与数据处理器(worker):
    worker._place = lambda p: {"place": p}
    worker._preview = lambda p: {"preview": p}
    worker._size = lambda p: {"size": p}
    worker._modify_order = lambda p: {"modify": p}
    worker._cancel_order = lambda p: {"cancel": p}
    worker._modify_position = lambda p: {"pmodify": p}
    worker._breakeven = lambda p: {"be": p}
    worker._set_trailing = lambda p: {"trail": p}
    worker._clear_trailing = lambda p: {"untrail": p}
    worker._close_position = lambda p: {"close": p}
    worker._close_all = lambda p: {"closeall": p}
    worker._symbols_list = lambda p: ["sym"]
    worker._symbol_info = lambda p: {"symbol": p}
    worker._history = lambda p: {"history": p}
    worker._quotes_subscribe = lambda p: {"qsub": p}
    worker._quotes_unsubscribe = lambda p: {"qunsub": p}
    worker._bars_subscribe = lambda p: {"bsub": p}
    worker._bars_unsubscribe = lambda p: {"bunsub": p}

    cases = {
        "trade.preview": {"preview": {"v": 1}},
        "trade.size": {"size": {"v": 1}},
        "order.place": {"place": {"v": 1}},
        "order.modify": {"modify": {"v": 1}},
        "order.cancel": {"cancel": {"v": 1}},
        "position.modify": {"pmodify": {"v": 1}},
        "position.breakeven": {"be": {"v": 1}},
        "position.trailing.set": {"trail": {"v": 1}},
        "position.trailing.clear": {"untrail": {"v": 1}},
        "position.close": {"close": {"v": 1}},
        "position.closeAll": {"closeall": {"v": 1}},
        "symbols.list": ["sym"],
        "symbol.info": {"symbol": {"v": 1}},
        "history.get": {"history": {"v": 1}},
        "quotes.subscribe": {"qsub": {"v": 1}},
        "quotes.unsubscribe": {"qunsub": {"v": 1}},
        "bars.subscribe": {"bsub": {"v": 1}},
        "bars.unsubscribe": {"bunsub": {"v": 1}},
    }
    for method, expected in cases.items():
        assert worker._dispatch(method, {"v": 1}) == expected


def test_分派到日志与设置处理器(worker):
    worker._journal_list = lambda p: [p]
    worker._journal_tag = lambda p: {"tag": p}
    worker._journal_shot = lambda p: {"shot": p}
    worker._data_export = lambda p: {"export": p}
    worker._data_backup = lambda p: {"backup": p}
    worker._alert_create = lambda p: {"ac": p}
    worker._alert_update = lambda p: {"au": p}
    worker._alert_delete = lambda p: {"ad": p}
    worker._alert_test = lambda p: {"at": p}
    worker._watchlist = lambda p: [p]
    worker._watchlist_set = lambda p: {"watch": p}

    cases = {
        "journal.list": [{"v": 1}],
        "journal.tag": {"tag": {"v": 1}},
        "journal.screenshot.save": {"shot": {"v": 1}},
        "data.export": {"export": {"v": 1}},
        "data.backup.create": {"backup": {"v": 1}},
        "alerts.create": {"ac": {"v": 1}},
        "alerts.update": {"au": {"v": 1}},
        "alerts.delete": {"ad": {"v": 1}},
        "alerts.test": {"at": {"v": 1}},
        "watchlist.get": [{"v": 1}],
        "watchlist.set": {"watch": {"v": 1}},
    }
    for method, expected in cases.items():
        assert worker._dispatch(method, {"v": 1}) == expected


def test_只读查询方法(worker):
    worker._positions = [{"ticket": 1}]
    worker._orders = [{"ticket": 2}]

    assert worker._dispatch("positions.get", {}) == [{"ticket": 1}]
    assert worker._dispatch("orders.get", {}) == [{"ticket": 2}]
    assert worker._dispatch("account.get", {})["login"] == 111
    assert worker._dispatch("executions.stats", {}) == {"days": 30}
    assert worker._dispatch("executions.stats", {"days": 7}) == {"days": 7}
    assert ("execution_stats", (7, 111)) in worker.store.calls

    accounts = worker._dispatch("accounts.list", {})
    assert accounts["activeId"] == "a"
    assert accounts["lastError"] is None

    assert worker._dispatch("journal.stats", {}) == {"days": 30}
    assert worker._dispatch("journal.sync", {}) == {"written": 3}
    assert ("sync", 111, True) in worker._journal.calls

    assert worker._dispatch("intents.list", {}) == []
    assert ("recent_intents", (50, 111)) in worker.store.calls
    assert worker._dispatch("audit.tail", {"limit": 5}) == []
    assert ("audit_tail", (5,)) in worker.store.calls
    assert worker._dispatch("alerts.list", {}) == []
    assert ("alerts_list", (111,)) in worker.store.calls


def test_默认审计日期用当天UTC(worker, monkeypatch):
    class FakeDateTime:
        @classmethod
        def now(cls, tz=None):
            return types.SimpleNamespace(strftime=lambda fmt: "2024-01-02")

    monkeypatch.setattr(mt5_worker, "datetime", FakeDateTime)

    worker._dispatch("audit.query", {})

    assert ("audit_query", ("2024-01-02", None, None, 300)) in worker.store.calls


def test_数据目录信息(worker):
    data = worker._dispatch("data.info", {})

    base = worker.store.base_dir
    assert data == {
        "dir": str(base),
        "exports": str(base / "exports"),
        "backups": str(base / "backups"),
    }


def test_风控状态未计算时会补算(worker):
    worker._compute_risk = lambda: {"ok": True}

    assert worker._dispatch("risk.status", {}) == {"ok": True}

    worker._risk = {"cached": True}
    assert worker._dispatch("risk.status", {}) == {"cached": True}


def test_系统配置与健康方法(worker):
    config = worker._dispatch("system.getConfig", {})
    assert config["tradeMode"] == "demo"
    assert config["config"] == worker.cfg.public()

    health = worker._dispatch("system.health", {})
    assert health["connected"] is True


def test_日历使用缓存周数据(worker, monkeypatch):
    monkeypatch.setattr(mt5_worker, "week_payload", lambda: {"events": []})
    assert worker._dispatch("calendar.week", {}) == {"events": []}


def test_未连接时账户查询被拒绝(worker):
    worker._connected = False
    assert code_for(lambda: worker._dispatch("account.get", {})) == "DISCONNECTED"

    worker._connected = True
    worker._account = None
    assert code_for(lambda: worker._require_account()) == "DISCONNECTED"


# ---------- 交易模式 ----------


def test_只读模式下禁止下单(worker):
    worker._trade_mode = "readonly"
    assert code_for(worker._guard_trade) == "READ_ONLY"


def test_未开自动交易时禁止下单(worker, monkeypatch):
    install_mt5(monkeypatch, trade_allowed=False)
    assert code_for(worker._guard_trade) == "TRADE_DISABLED"


def test_账户不允许交易时禁止下单(worker):
    worker._account["tradeAllowed"] = False
    assert code_for(worker._guard_trade) == "TRADE_DISABLED"


def test_实盘账户禁止模拟下单(worker):
    worker._trade_mode = "demo"
    worker._account["accountType"] = "real"
    assert code_for(worker._guard_trade) == "REAL_ACCOUNT"


def test_非实盘账户禁止实盘下单(worker):
    worker._trade_mode = "live"
    worker._account["accountType"] = "demo"
    assert code_for(worker._guard_trade) == "NOT_REAL"


def test_模拟模式允许下单(worker):
    assert worker._guard_trade() is worker._account

    worker._trade_mode = "live"
    worker._account["accountType"] = "real"
    assert worker._guard_trade() is worker._account


@pytest.mark.parametrize("mode", ["", "fast", "LIVE", None])
def test_未知交易模式被拒绝(worker, mode):
    assert code_for(lambda: worker._set_trade_mode({"mode": mode})) == "BAD_MODE"


def test_切换交易模式要求已连接(worker):
    worker._connected = False
    assert code_for(lambda: worker._set_trade_mode({"mode": "demo"})) == "DISCONNECTED"


def test_未开自动交易不能切到模拟或实盘(worker, monkeypatch):
    install_mt5(monkeypatch, trade_allowed=False)
    assert code_for(lambda: worker._set_trade_mode({"mode": "demo"})) == "TRADE_DISABLED"


def test_实盘开关未开启时拒绝实盘(worker):
    worker._account["accountType"] = "real"
    assert code_for(lambda: worker._set_trade_mode({"mode": "live"})) == "LIVE_DISABLED"


def test_实盘模式要求实盘账户(worker):
    worker.cfg.allow_live = True
    assert code_for(lambda: worker._set_trade_mode({"mode": "live"})) == "NOT_REAL"


def test_实盘账户不能切模拟(worker):
    worker._account["accountType"] = "real"
    assert code_for(lambda: worker._set_trade_mode({"mode": "demo"})) == "REAL_ACCOUNT"


def test_账户不允许交易时不能切换模式(worker):
    worker._account["tradeAllowed"] = False
    assert code_for(lambda: worker._set_trade_mode({"mode": "demo"})) == "TRADE_DISABLED"


def test_切换交易模式成功后审计并广播(worker, emitted):
    worker._trade_mode = "readonly"

    health = worker._set_trade_mode({"mode": "demo"})

    assert worker._trade_mode == "demo"
    assert health["tradeMode"] == "demo"
    assert ("trade.mode", {"mode": "demo", "login": 111}) in worker.store.audits
    assert emitted[-1][0] == "gateway"


def test_只读模式始终允许切换(worker):
    worker._trade_mode = "demo"

    health = worker._set_trade_mode({"mode": "readonly"})

    assert health["tradeMode"] == "readonly"


# ---------- 配置写入 ----------


def test_保存配置刷新风控并广播(worker, emitted):
    result = worker._set_config({"max_lot": 0.5})

    assert result["limits"]["max_lot"] == 2.0
    assert worker.cfg.updates == [{"max_lot": 0.5}]
    assert ("config.update", {"changes": {"max_lot": 0.5}}) in worker.store.audits
    assert emitted[-1][0] == "gateway"


def test_保存配置校验失败(worker):
    worker.cfg.update_error = ValueError("max_lot 超出范围")
    assert code_for(lambda: worker._set_config({"max_lot": 9})) == "BAD_CONFIG"


def test_保存配置写盘失败(worker):
    worker.cfg.update_error = OSError("disk full")
    assert code_for(lambda: worker._set_config({"max_lot": 1})) == "CONFIG_SAVE"


@pytest.mark.parametrize("patch", [None, {}, "x", [], 0])
def test_账户风控必须是非空对象(worker, patch):
    assert code_for(lambda: worker._set_account_risk({"risk": patch})) == "BAD_CONFIG"


def test_未知账户的风控设置被拒绝(worker):
    assert code_for(
        lambda: worker._set_account_risk({"id": "nope", "risk": {"max_lot": 1}})
    ) == "BAD_CONFIG"


def test_当前账户风控更新后立即生效(worker):
    refreshed = []
    worker._poll_risk = lambda force=False: refreshed.append(force)

    result = worker._set_account_risk({"id": "a", "risk": {"max_lot": 0.5}})

    assert worker._limits["max_lot"] == 0.5
    assert worker.cfg.account_risk("a") == {"max_lot": 0.5}
    assert result["limits"]["max_lot"] == 0.5
    assert result["accountRisk"] == {"max_lot": 0.5}
    assert refreshed == [True]
    assert (
        "config.account_risk",
        {"id": "a", "changes": {"max_lot": 0.5}},
    ) in worker.store.audits


def test_非当前账户的风控更新不刷新全局(worker):
    before = dict(worker._limits)
    refreshed = []
    worker._poll_risk = lambda force=False: refreshed.append(force)

    result = worker._set_account_risk({"id": "b", "risk": {"max_lot": 0.5}})

    assert worker._limits == before
    assert refreshed == []
    assert result["accountRisk"] == {"max_lot": 2.0}


def test_账户风控写盘失败(worker):
    worker.cfg.save_error = OSError("disk full")
    assert code_for(
        lambda: worker._set_account_risk({"id": "a", "risk": {"max_lot": 1}})
    ) == "CONFIG_SAVE"


@pytest.mark.parametrize("allow", [1, "true", None, "yes"])
def test_实盘开关必须是布尔值(worker, allow):
    assert code_for(lambda: worker._set_allow_live({"allow": allow})) == "BAD_CONFIG"


def test_打开实盘开关并写回(worker):
    result = worker._set_allow_live({"allow": True})

    assert worker.cfg.allow_live is True
    assert result["tradeMode"] == "demo"
    assert ("config.allow_live", {"allow": True}) in worker.store.audits


def test_关闭实盘时从实盘退回只读(worker):
    worker._trade_mode = "live"

    result = worker._set_allow_live({"allow": False})

    assert worker._trade_mode == "readonly"
    assert result["tradeMode"] == "readonly"


def test_实盘开关写盘失败(worker):
    worker.cfg.save_error = OSError("disk full")
    assert code_for(lambda: worker._set_allow_live({"allow": True})) == "CONFIG_SAVE"


# ---------- 账户管理 ----------


def test_新建账户成功后切换并审计(worker, emitted):
    worker.cfg.active = "new"
    worker.cfg.profiles.append(
        {"id": "new", "label": "新", "login": 3, "server": "S", "terminal_path": "C:/n.exe"}
    )

    result = worker._create_account({"login": 3})

    assert result["activeId"] == "new"
    assert (
        "account.create",
        {"id": "new", "activeId": "new", "seeded": True},
    ) in worker.store.audits
    assert worker._limits["max_lot"] == 1.0
    assert emitted[-1][0] == "gateway"


def test_新建账户校验失败(worker):
    worker._account_mgr.error = AccountError("登录号必须是正整数")
    assert code_for(lambda: worker._create_account({"login": 0})) == "BAD_ACCOUNT"


def test_新建账户写盘失败(worker):
    worker._account_mgr.error = OSError("disk full")
    assert code_for(lambda: worker._create_account({"login": 1})) == "CONFIG_SAVE"


def test_更新非当前账户不重连(worker, emitted):
    worker._account_mgr.update_result = {
        "id": "b",
        "connectionChanged": False,
        "passwordChanged": False,
    }
    reset = []
    worker._reset_for_switch = lambda: reset.append(1)

    result = worker._update_account({"id": "b"})

    assert reset == []
    assert result["activeId"] == "a"
    assert (
        "account.update",
        {"id": "b", "connectionChanged": False, "passwordChanged": False},
    ) in worker.store.audits
    assert emitted[-1][0] == "gateway"


def test_更新当前账户连接参数会重连(worker):
    worker._account_mgr.update_result = {
        "id": "a",
        "connectionChanged": True,
        "passwordChanged": False,
    }
    reset, connects = [], []
    worker._reset_for_switch = lambda: reset.append(1)
    worker._try_connect = lambda force_login=False: connects.append(force_login)

    result = worker._update_account({"id": "a"})

    assert reset == [1]
    assert connects == [True]
    assert result["activeId"] == "a"


def test_更新当前账户改密码会重连(worker):
    worker._account_mgr.update_result = {
        "id": "a",
        "connectionChanged": False,
        "passwordChanged": True,
    }
    connects = []
    worker._reset_for_switch = lambda: None
    worker._try_connect = lambda force_login=False: connects.append(force_login)

    worker._update_account({"id": "a"})

    assert connects == [True]


def test_重连失败时报账户已保存(worker):
    worker._account_mgr.update_result = {
        "id": "a",
        "connectionChanged": True,
        "passwordChanged": False,
    }
    worker._reset_for_switch = lambda: None

    def fail(force_login=False):
        worker._connected = False
        worker._last_error = {"message": "登录失败"}

    worker._try_connect = fail

    with pytest.raises(GatewayError) as exc:
        worker._update_account({"id": "a"})
    assert exc.value.code == "ACCOUNT_RECONNECT_FAILED"
    assert "登录失败" in exc.value.message


def test_更新账户错误映射(worker):
    worker._account_mgr.error = AccountError("未知账户")
    assert code_for(lambda: worker._update_account({"id": "x"})) == "BAD_ACCOUNT"

    worker._account_mgr.error = OSError("disk full")
    assert code_for(lambda: worker._update_account({"id": "a"})) == "CONFIG_SAVE"


def test_删除账户成功审计(worker):
    result = worker._delete_account({"id": "b"})

    assert result["activeId"] == "a"
    assert ("account.delete", {"id": "b"}) in worker.store.audits


def test_删除账户错误映射(worker):
    worker._account_mgr.error = AccountError("至少保留一个账户")
    assert code_for(lambda: worker._delete_account({"id": "b"})) == "BAD_ACCOUNT"

    worker._account_mgr.error = OSError("disk full")
    assert code_for(lambda: worker._delete_account({"id": "b"})) == "CONFIG_SAVE"


# ---------- 切换账户 ----------


def test_切换到未知账户被拒绝(worker):
    assert code_for(lambda: worker._switch_account({"id": "zzz"})) == "BAD_ACCOUNT"


def test_有持仓时切换需要确认(worker):
    worker._positions = [{"ticket": 1}]

    with pytest.raises(GatewayError) as exc:
        worker._switch_account({"id": "b"})
    assert exc.value.code == "HAS_POSITIONS"
    assert exc.value.detail == {"positions": 1}

    worker._reset_for_switch = lambda: None
    worker._switch_account({"id": "b", "force": True})
    assert worker._account_id == "b"


def test_切换到自己且已连接时不重连(worker):
    reset = []
    worker._reset_for_switch = lambda: reset.append(1)

    result = worker._switch_account({"id": "a"})

    assert result["activeId"] == "a"
    assert reset == []
    assert worker.store.audits == []


def test_切换账户成功(worker, emitted):
    resets = []
    worker._reset_for_switch = lambda: resets.append(1)

    result = worker._switch_account({"id": "b"})

    assert worker._account_id == "b"
    assert resets == [1]
    assert worker.cfg.active == "b"
    assert (
        "account.switch",
        {"from": "a", "to": "b", "label": "副账户", "login": 222},
    ) in worker.store.audits
    assert result["activeId"] == "b"
    assert emitted[-1][0] == "gateway"


def test_切换账户保存失败(worker):
    worker.cfg.save_error = OSError("disk full")

    with pytest.raises(GatewayError) as exc:
        worker._switch_account({"id": "b"})
    assert exc.value.code == "CONFIG_SAVE"
    assert worker._account_id == "a"


def test_切换后连接失败(worker):
    def reset():
        worker._connected = False
        worker._last_error = {"message": "终端未启动"}

    worker._reset_for_switch = reset

    with pytest.raises(GatewayError) as exc:
        worker._switch_account({"id": "b"})
    assert exc.value.code == "ACCOUNT_SWITCH_FAILED"
    assert "终端未启动" in exc.value.message


# ---------- 重置状态 ----------


def test_换账户时清空账户相关状态(worker, monkeypatch, emitted):
    _, calls = install_mt5(monkeypatch)
    worker._positions = [{"ticket": 1}]
    worker._orders = [{"ticket": 2}]
    worker._risk = {"blockReason": "x"}
    worker._halted = {"at": 1}
    worker._trailing = {1: {}}
    worker._trail_next = {1: 2.0}
    worker._auto_be = {1: {}}
    worker._pending_plans = {2: {}}
    worker._alerts = [{"id": 1}]
    worker._alert_last = {"k": 1}
    worker._watch_day = {"EURUSD": (1.0, 2.0)}
    worker._subs = {"EURUSD": 1}
    worker._bar_subs = {("EURUSD", "1m"): {}}
    worker._risk_tracked = {1: 1.0}
    worker._server_offset = 3600
    worker._trade_mode = "live"
    worker._state_loaded = True

    worker._reset_for_switch()

    assert calls["shutdown"] == 1
    assert worker._connected is False
    assert worker._connect_blocked is False
    assert worker._auth_failures == 0
    assert worker._account is None
    assert worker._positions == []
    assert worker._orders == []
    assert worker._risk is None
    assert worker._last_error is None
    assert worker._halted is None
    assert worker._trailing == {}
    assert worker._trail_next == {}
    assert worker._auto_be == {}
    assert worker._pending_plans == {}
    assert worker._alerts == []
    assert worker._alert_last == {}
    assert worker._watch_day == {}
    assert worker._subs == {}
    assert worker._bar_subs == {}
    assert worker._risk_tracked == {}
    assert worker._server_offset == 0
    assert worker._trade_mode == "readonly"
    assert worker._state_loaded is False
    assert worker._limits == worker.cfg.risk_limits("a")
    assert emitted[0] == ("positions", [])
    assert emitted[1] == ("orders", [])
    assert emitted[2][0] == "gateway"


def test_终端关闭异常不影响换账户(worker, monkeypatch):
    def boom():
        raise RuntimeError("already down")

    monkeypatch.setattr(
        mt5_worker,
        "mt5",
        types.SimpleNamespace(shutdown=boom, terminal_info=lambda: None),
    )

    worker._reset_for_switch()

    assert worker._connected is False
