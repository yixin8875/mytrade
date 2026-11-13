from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
from pathlib import Path

# DPAPI 的附加熵：同一台机器上的其他程序即使拿到文件也不能直接解密
_ENTROPY = b"mytrade.mt5.credentials.v1"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1
_DESCRIPTION = "Tally MT5 账户凭据"


class CredentialError(RuntimeError):
    """凭据存储读写失败。错误消息不包含密码本身。"""


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p

    def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
        buf = ctypes.create_string_buffer(data, len(data)) if data else ctypes.create_string_buffer(0)
        return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf

    def _windows_error(prefix: str) -> CredentialError:
        code = ctypes.get_last_error()
        detail = ctypes.FormatError(code).strip() if code else "未知错误"
        return CredentialError(f"{prefix}（Windows {code}: {detail}）")

    def _protect(plain: str) -> bytes:
        data, data_buf = _blob(plain.encode("utf-8"))
        entropy, entropy_buf = _blob(_ENTROPY)
        out = _DataBlob()
        ok = _crypt32.CryptProtectData(
            ctypes.byref(data),
            _DESCRIPTION,
            ctypes.byref(entropy),
            None,
            None,
            0,
            ctypes.byref(out),
        )
        # 让 ctypes 明确知道输入缓冲区在调用期间存活
        _ = (data_buf, entropy_buf)
        if not ok:
            raise _windows_error("密码加密失败")
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))

    def _unprotect(encrypted: bytes) -> str:
        data, data_buf = _blob(encrypted)
        entropy, entropy_buf = _blob(_ENTROPY)
        out = _DataBlob()
        ok = _crypt32.CryptUnprotectData(
            ctypes.byref(data),
            None,
            ctypes.byref(entropy),
            None,
            None,
            _CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(out),
        )
        _ = (data_buf, entropy_buf)
        if not ok:
            raise _windows_error("密码解密失败，可能不是当前 Windows 用户保存的凭据")
        try:
            return ctypes.string_at(out.pbData, out.cbData).decode("utf-8")
        finally:
            _kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))

else:

    def _protect(_: str) -> bytes:
        raise CredentialError("当前系统不支持 Windows DPAPI，无法保存 MT5 密码")

    def _unprotect(_: bytes) -> str:
        raise CredentialError("当前系统不支持 Windows DPAPI，无法读取 MT5 密码")


class CredentialStore:
    """按账户 id 保存 DPAPI 加密的密码；只在本机当前 Windows 用户下可解密。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        # 缓存的是密文条目，不在内存里长期保留所有账户的明文密码
        self._cache: dict[str, dict] | None = None

    def _load(self) -> dict[str, dict]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise CredentialError(f"凭据文件读取失败：{exc}") from exc
        if not isinstance(raw, dict) or raw.get("version") != 1:
            raise CredentialError("凭据文件格式不受支持")
        accounts = raw.get("accounts")
        if not isinstance(accounts, dict):
            raise CredentialError("凭据文件缺少 accounts")
        result: dict[str, dict] = {}
        for account_id, item in accounts.items():
            if not isinstance(account_id, str) or not isinstance(item, dict):
                continue
            blob = item.get("blob")
            if not isinstance(blob, str) or not blob:
                continue
            try:
                updated = int(item.get("updatedAt") or 0)
            except (TypeError, ValueError):
                updated = 0
            result[account_id] = {"blob": blob, "updatedAt": updated}
        return result

    def _values(self) -> dict[str, dict]:
        with self._lock:
            if self._cache is None:
                self._cache = self._load()
            return self._cache

    def _flush(self, values: dict[str, dict]) -> None:
        payload = {"version": 1, "accounts": values}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(f"{self.path.name}.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as exc:
            raise CredentialError(f"凭据文件写入失败：{exc}") from exc

    def has(self, account_id: str) -> bool:
        return bool(self._values().get(account_id, {}).get("blob"))

    def get(self, account_id: str) -> str | None:
        item = self._values().get(account_id)
        blob = item.get("blob") if item else None
        if not blob:
            return None
        try:
            return _unprotect(base64.b64decode(blob, validate=True))
        except (ValueError, CredentialError) as exc:
            raise CredentialError(f"账户 {account_id} 的密码解密失败：{exc}") from exc

    def set(self, account_id: str, password: str) -> None:
        if not password:
            self.delete(account_id)
            return
        try:
            encrypted = base64.b64encode(_protect(password)).decode("ascii")
        except CredentialError:
            raise
        with self._lock:
            values = dict(self._values())
            values[account_id] = {"blob": encrypted, "updatedAt": int(time.time())}
            # 先写盘成功，再更新内存缓存
            self._flush(values)
            self._cache = values

    def delete(self, account_id: str) -> None:
        with self._lock:
            values = self._values()
            if account_id not in values:
                return
            next_values = {key: value for key, value in values.items() if key != account_id}
            self._flush(next_values)
            self._cache = next_values
