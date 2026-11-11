from __future__ import annotations

import os
from pathlib import Path

from config import Config
from secure_store import CredentialError, CredentialStore

_KEEP = object()


class AccountError(ValueError):
    """账户配置校验或保存失败。错误消息不包含密码。"""


class AccountManager:
    """账户的增删改查；密码单独经 DPAPI 加密保存。"""

    def __init__(self, cfg: Config, credentials: CredentialStore) -> None:
        self.cfg = cfg
        self.credentials = credentials

    def has_password(self, account_id: str) -> bool:
        try:
            return self.credentials.has(account_id)
        except CredentialError:
            # 凭据文件损坏时仍允许账户列表加载，连接阶段会给出明确错误
            return False

    def password(self, account_id: str) -> str | None:
        try:
            return self.credentials.get(account_id)
        except CredentialError as exc:
            raise AccountError(str(exc)) from exc

    def create(self, payload: dict, current: dict | None = None) -> dict:
        data, password = self._clean(payload)
        raw = self.cfg.configured_accounts()
        previous_active = self.cfg.active_profile()["id"]
        active = previous_active
        fallback: dict | None = None

        if not raw:
            current_login = int((current or {}).get("login") or 0)
            current_path = str((current or {}).get("terminalPath") or self.cfg.terminal_path or "")
            same = (
                current_login == data["login"]
                and bool(current_path)
                and self._same_path(current_path, data["terminal_path"])
            )
            if same:
                # 首次添加的账户就是当前终端：直接接管当前连接
                active = ""
            else:
                fallback = self._current_profile(current)
                if fallback:
                    raw = [fallback]
                    active = fallback["id"]

        self._ensure_unique_login(raw, data["login"])
        account_id = self._unique_id(data["label"], data["login"], {item["id"] for item in raw})
        entry = {"id": account_id, **data}
        profiles = raw + [entry]
        active = active or account_id

        if password is not _KEEP and password:
            try:
                self.credentials.set(account_id, str(password))
            except CredentialError as exc:
                raise AccountError(f"保存密码失败：{exc}") from exc
        try:
            saved = self.cfg.save_accounts(profiles, active)
        except (OSError, ValueError) as exc:
            if password is not _KEEP and password:
                try:
                    self.credentials.delete(account_id)
                except CredentialError:
                    pass
            raise AccountError(f"保存账户失败：{exc}") from exc

        return {
            "id": account_id,
            "activeId": self.cfg.active_profile()["id"],
            "accounts": saved,
            "seeded": bool(fallback),
        }

    def update(self, payload: dict) -> dict:
        account_id = str(payload.get("id") or "").strip()
        if not account_id:
            raise AccountError("缺少账户 id")

        raw = self.cfg.configured_accounts()
        if not raw and account_id == "default":
            # 单终端模式：第一次编辑默认终端时把它固化成显式账户
            raw = [self.cfg.account_profiles()[0]]
        existing = next((item for item in raw if item["id"] == account_id), None)
        if existing is None:
            raise AccountError(f"未知账户：{account_id}")

        data, password = self._clean(payload, existing)
        self._ensure_unique_login(raw, data["login"], exclude=account_id)
        connection_changed = (
            data["login"] != existing["login"]
            or data["server"] != existing["server"]
            or not self._same_path(data["terminal_path"], existing["terminal_path"])
        )
        clear_password = bool(payload.get("clearPassword"))
        password_changed = password is not _KEEP or clear_password
        old_password: str | None = None
        if password is not _KEEP and password is not None:
            try:
                old_password = self.credentials.get(account_id)
            except CredentialError:
                # 旧密文损坏时允许直接写入新密码修复
                old_password = None

        if password is not _KEEP and password is not None:
            try:
                self.credentials.set(account_id, str(password))
            except CredentialError as exc:
                raise AccountError(f"保存密码失败：{exc}") from exc

        # 保留账户级风控覆盖（risk），只更新连接相关字段
        profiles = [
            {**item, **data} if item["id"] == account_id else item for item in raw
        ]
        try:
            saved = self.cfg.save_accounts(profiles, self.cfg.active_profile()["id"])
        except (OSError, ValueError) as exc:
            # 回滚刚写入的密码，避免配置与凭据不一致
            if password is not _KEEP:
                try:
                    if old_password:
                        self.credentials.set(account_id, old_password)
                    else:
                        self.credentials.delete(account_id)
                except CredentialError:
                    pass
            raise AccountError(f"保存账户失败：{exc}") from exc

        if clear_password:
            try:
                self.credentials.delete(account_id)
            except CredentialError as exc:
                raise AccountError(f"账户已保存，但清除密码失败：{exc}") from exc

        return {
            "id": account_id,
            "activeId": self.cfg.active_profile()["id"],
            "accounts": saved,
            "connectionChanged": connection_changed,
            "passwordChanged": password_changed,
        }

    def delete(self, account_id: str) -> dict:
        account_id = str(account_id or "").strip()
        raw = self.cfg.configured_accounts()
        if not raw:
            raise AccountError("当前是单终端模式，没有可删除的账户")
        if len(raw) <= 1:
            raise AccountError("至少保留一个账户")
        if account_id == self.cfg.active_profile()["id"]:
            raise AccountError("不能删除当前账户，请先切换到其他账户")

        remaining = [item for item in raw if item["id"] != account_id]
        if len(remaining) == len(raw):
            raise AccountError(f"未知账户：{account_id}")

        try:
            saved = self.cfg.save_accounts(remaining, self.cfg.active_profile()["id"])
        except (OSError, ValueError) as exc:
            raise AccountError(f"删除账户失败：{exc}") from exc
        try:
            self.credentials.delete(account_id)
        except CredentialError as exc:
            raise AccountError(f"账户已删除，但清除密码失败：{exc}") from exc
        return {"id": account_id, "activeId": self.cfg.active_profile()["id"], "accounts": saved}

    def _clean(
        self, payload: dict, existing: dict | None = None
    ) -> tuple[dict, object | str | None]:
        existing = existing or {}

        label = str(payload.get("label", existing.get("label", "")) or "").strip()
        if not label:
            raise AccountError("账户名称不能为空")
        if len(label) > 40:
            raise AccountError("账户名称不能超过 40 个字符")

        raw_login = payload.get("login", existing.get("login", 0))
        if isinstance(raw_login, bool):
            raise AccountError("登录号必须是正整数")
        try:
            login = int(raw_login)
        except (TypeError, ValueError) as exc:
            raise AccountError("登录号必须是正整数") from exc
        if login <= 0:
            raise AccountError("登录号必须是正整数")

        server = str(payload.get("server", existing.get("server", "")) or "").strip()
        if not server:
            raise AccountError("服务器不能为空，自动登录需要服务器名")
        if len(server) > 80:
            raise AccountError("服务器名不能超过 80 个字符")

        raw_path = payload.get(
            "terminalPath", payload.get("terminal_path", existing.get("terminal_path", ""))
        )
        raw_path = str(raw_path or "").strip().strip('"')
        if not raw_path:
            raise AccountError("终端路径不能为空")
        if len(raw_path) > 1024:
            raise AccountError("终端路径过长")
        resolved = self._terminal_file(raw_path)
        if resolved is None:
            raise AccountError(f"终端路径不存在或不是文件：{raw_path}")
        terminal_path = os.path.normpath(str(resolved))

        if "password" in payload:
            raw_password = payload.get("password")
            if raw_password is None:
                password: object | str | None = _KEEP
            else:
                password = str(raw_password)
                if len(password) > 256:
                    raise AccountError("密码过长")
        else:
            password = _KEEP

        return (
            {
                "label": label,
                "login": login,
                "server": server,
                "terminal_path": terminal_path,
            },
            password,
        )

    def _current_profile(self, current: dict | None) -> dict | None:
        raw_path = str(
            (current or {}).get("terminalPath") or self.cfg.terminal_path or ""
        ).strip()
        path = self._terminal_file(raw_path)
        if path is None:
            return None
        login = int((current or {}).get("login") or self.cfg.expected_login or 0)
        if login <= 0:
            return None
        server = str((current or {}).get("server") or "").strip()
        return {
            "id": "default",
            "label": "当前终端",
            "login": login,
            "server": server,
            "terminal_path": os.path.normpath(str(path)),
        }

    @staticmethod
    def _terminal_file(value: str) -> Path | None:
        """接受 terminal64.exe 路径，也接受 MT5 安装目录；返回有效的可执行文件。"""
        raw = os.path.expandvars(os.path.expanduser(str(value or "").strip().strip('"')))
        if not raw:
            return None
        try:
            path = Path(raw)
            if path.is_dir():
                candidate = path / "terminal64.exe"
                return candidate if candidate.is_file() else None
            return path if path.is_file() else None
        except OSError:
            return None

    @staticmethod
    def _ensure_unique_login(raw: list[dict], login: int, exclude: str | None = None) -> None:
        for item in raw:
            if item["id"] == exclude:
                continue
            if int(item.get("login") or 0) == login:
                raise AccountError(
                    f"登录号 {login} 已被账户「{item['label']}」使用；"
                    "交易日志按登录号隔离，请勿重复添加"
                )

    @staticmethod
    def _same_path(left: str, right: str) -> bool:
        try:
            left_path = AccountManager._terminal_file(left) or Path(str(left))
            right_path = AccountManager._terminal_file(right) or Path(str(right))
            return os.path.normcase(os.path.abspath(str(left_path))) == os.path.normcase(
                os.path.abspath(str(right_path))
            )
        except (OSError, ValueError):
            return left == right

    @staticmethod
    def _unique_id(label: str, login: int, used: set[str]) -> str:
        base = Config._slug(label, f"acc{login}")
        if base not in used:
            return base
        suffix = 2
        while f"{base}-{suffix}" in used:
            suffix += 1
        return f"{base}-{suffix}"
