"""本地网关的访问边界：只接受 Tally 自己的界面。

网关只监听 127.0.0.1，但浏览器里的任意网页都能向本机 WebSocket 发起连接
（WebSocket 不受 CORS 约束）。所以真正的门禁是握手时的 Origin 白名单：
浏览器一定会带 Origin，别的网站带的是它自己的域名，直接拒绝。

没有 Origin 的请求来自本机脚本/工具（scripts/verify_trade.py 等）。它们和
当前用户同权限，本来就能直接读数据目录，因此放行。注意绝不能放行
``Origin: null``——沙箱 iframe、file:// 页面会用它绕过同源限制。
"""

from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import urlsplit

# 开发页（Vite）与桌面壳（Tauri 2，Windows 用 http(s)://tauri.localhost，
# macOS/Linux 用 tauri://localhost）；两者都在这里，源码启动和桌面版共用一套。
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)


def normalize_origin(value: str | None) -> str | None:
    """把 ``scheme://host[:port]`` 归一化；``null``/空值/坏值返回 None。"""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


def resolve_allowed_origins(configured: Iterable[str] | None) -> tuple[str, ...]:
    """默认白名单 + config.json 里的额外来源；去重后返回。

    采用合并而不是覆盖，避免在配置里漏写 Tauri 来源后桌面版整个连不上。
    """
    origins: list[str] = list(DEFAULT_ALLOWED_ORIGINS)
    if not isinstance(configured, (list, tuple, set)):
        configured = ()
    for value in configured:
        origin = normalize_origin(value)
        if origin and origin not in origins:
            origins.append(origin)
    return tuple(origins)


def origin_allowed(origin: str | None, allowed: Iterable[str]) -> bool:
    """WebSocket 握手 / 跨域请求的来源校验。

    ``origin is None`` 表示非浏览器客户端（本机脚本），按设计放行。
    ``Origin: null`` 归一化失败，会被拒绝。
    """
    if origin is None:
        return True
    normalized = normalize_origin(origin)
    return normalized is not None and normalized in allowed


def request_allowed(
    origin: str | None, referer: str | None, allowed: Iterable[str]
) -> bool:
    """HTTP 资源校验：优先看 Origin，没有就退回 Referer。

    ``<img src>`` 不会带 Origin，只可能带 Referer；两者都没有时按本机请求放行。
    """
    if origin is not None:
        return origin_allowed(origin, allowed)
    if not referer:
        return True
    return origin_allowed(normalize_origin(referer), allowed)
