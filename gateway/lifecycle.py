from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Callable


def _argv_value(flag: str) -> str | None:
    args = sys.argv[1:]
    for index, arg in enumerate(args):
        if arg == flag and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith(f"{flag}="):
            return arg.split("=", 1)[1]
    return None


def parent_pid() -> int:
    raw = _argv_value("--parent-pid")
    try:
        pid = int(raw or 0)
    except (TypeError, ValueError):
        return 0
    return pid if pid > 0 and pid != os.getpid() else 0


def _watch_windows(pid: int, on_exit: Callable[[], None]) -> threading.Thread | None:
    import ctypes
    from ctypes import wintypes

    synchronize = 0x00100000
    infinite = 0xFFFFFFFF

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        # 父进程在启动前已退出
        on_exit()
        return None

    def run() -> None:
        try:
            kernel32.WaitForSingleObject(handle, infinite)
        finally:
            kernel32.CloseHandle(handle)
            on_exit()

    thread = threading.Thread(target=run, name="parent-watchdog", daemon=True)
    thread.start()
    return thread


def _watch_posix(pid: int, on_exit: Callable[[], None]) -> threading.Thread:
    def run() -> None:
        while True:
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(1)
        on_exit()

    thread = threading.Thread(target=run, name="parent-watchdog", daemon=True)
    thread.start()
    return thread


def watch_parent(pid: int, on_exit: Callable[[], None]) -> threading.Thread | None:
    """父进程（桌面应用）退出后回调 on_exit，防止 sidecar 变成孤儿进程。"""
    if pid <= 0:
        return None
    if sys.platform == "win32":
        return _watch_windows(pid, on_exit)
    return _watch_posix(pid, on_exit)
