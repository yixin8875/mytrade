"""父进程看门狗：参数解析、平台分派与退出回调。"""

import pytest

import lifecycle


def set_argv(monkeypatch, *args):
    monkeypatch.setattr(lifecycle.sys, "argv", ["gateway.py", *args])


class ImmediateThread:
    instances: list["ImmediateThread"] = []

    def __init__(self, target=None, name=None, daemon=None):
        self.target = target
        self.name = name
        self.daemon = daemon
        self.started = False
        ImmediateThread.instances.append(self)

    def start(self):
        self.started = True
        self.target()


@pytest.fixture
def immediate_threads(monkeypatch):
    ImmediateThread.instances = []
    monkeypatch.setattr(lifecycle.threading, "Thread", ImmediateThread)
    return ImmediateThread


# ---------- 参数解析 ----------


def test_解析父进程号(monkeypatch):
    set_argv(monkeypatch, "--parent-pid", "123")
    assert lifecycle.parent_pid() == 123

    set_argv(monkeypatch, "--parent-pid=456")
    assert lifecycle.parent_pid() == 456


def test_没有父进程号或格式非法时返回零(monkeypatch):
    set_argv(monkeypatch)
    assert lifecycle.parent_pid() == 0

    set_argv(monkeypatch, "--parent-pid")
    assert lifecycle.parent_pid() == 0

    set_argv(monkeypatch, "--parent-pid", "abc")
    assert lifecycle.parent_pid() == 0

    set_argv(monkeypatch, "--parent-pid", "0")
    assert lifecycle.parent_pid() == 0

    set_argv(monkeypatch, "--parent-pid", "-5")
    assert lifecycle.parent_pid() == 0


def test_父进程号不能是自己(monkeypatch):
    monkeypatch.setattr(lifecycle.os, "getpid", lambda: 999)
    set_argv(monkeypatch, "--parent-pid", "999")

    assert lifecycle.parent_pid() == 0


# ---------- 平台分派 ----------


def test_没有父进程号时不启动看门狗(monkeypatch):
    called = []
    monkeypatch.setattr(lifecycle, "_watch_windows", lambda pid, cb: called.append("win"))
    monkeypatch.setattr(lifecycle, "_watch_posix", lambda pid, cb: called.append("posix"))

    assert lifecycle.watch_parent(0, lambda: None) is None
    assert called == []


def test_按平台选择实现(monkeypatch):
    called = []
    monkeypatch.setattr(
        lifecycle, "_watch_windows", lambda pid, cb: called.append("win") or "win"
    )
    monkeypatch.setattr(
        lifecycle, "_watch_posix", lambda pid, cb: called.append("posix") or "posix"
    )

    monkeypatch.setattr(lifecycle.sys, "platform", "win32")
    assert lifecycle.watch_parent(1, lambda: None) == "win"
    monkeypatch.setattr(lifecycle.sys, "platform", "linux")
    assert lifecycle.watch_parent(1, lambda: None) == "posix"

    assert called == ["win", "posix"]


# ---------- POSIX 看门狗 ----------


def test_posix_在进程消失后回调(monkeypatch, immediate_threads):
    calls = {"kill": 0}

    def kill(pid, signal):
        calls["kill"] += 1
        if calls["kill"] >= 2:
            raise OSError("gone")

    exits = []
    monkeypatch.setattr(lifecycle.os, "kill", kill)
    monkeypatch.setattr(lifecycle.time, "sleep", lambda seconds: None)

    thread = lifecycle._watch_posix(321, lambda: exits.append(1))

    assert calls["kill"] == 2
    assert exits == [1]
    assert thread.name == "parent-watchdog"
    assert thread.daemon is True


# ---------- Windows 看门狗 ----------


class FakeWinFunc:
    def __init__(self, function):
        self.function = function
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.function(*args)


class FakeKernel32:
    def __init__(self, open_handle=77, wait_result=0):
        self.closed: list[int] = []
        self.OpenProcess = FakeWinFunc(lambda access, inherit, pid: open_handle)
        self.WaitForSingleObject = FakeWinFunc(lambda handle, timeout: wait_result)
        self.CloseHandle = FakeWinFunc(self.closed.append)


def install_kernel32(monkeypatch, kernel):
    import ctypes

    monkeypatch.setattr(ctypes, "WinDLL", lambda name, use_last_error=True: kernel)


def test_windows_父进程已退出时立即回调(monkeypatch, immediate_threads):
    kernel = FakeKernel32(open_handle=0)
    install_kernel32(monkeypatch, kernel)
    exits = []

    thread = lifecycle._watch_windows(123, lambda: exits.append(1))

    assert thread is None
    assert exits == [1]
    assert immediate_threads.instances == []


def test_windows_等待父进程退出后回调(monkeypatch, immediate_threads):
    kernel = FakeKernel32(open_handle=77, wait_result=0)
    install_kernel32(monkeypatch, kernel)
    exits = []

    thread = lifecycle._watch_windows(123, lambda: exits.append(1))

    assert thread is not None
    assert thread.started is True
    assert thread.name == "parent-watchdog"
    assert thread.daemon is True
    assert exits == [1]
    assert kernel.closed == [77]


def test_windows_打开句柄失败不启动线程(monkeypatch, immediate_threads):
    kernel = FakeKernel32(open_handle=0)
    install_kernel32(monkeypatch, kernel)

    lifecycle._watch_windows(123, lambda: None)

    assert immediate_threads.instances == []
