"""网关访问边界：Origin / Referer 白名单。"""

from security import (
    DEFAULT_ALLOWED_ORIGINS,
    normalize_origin,
    origin_allowed,
    request_allowed,
    resolve_allowed_origins,
)


def test_默认白名单包含开发页与桌面壳():
    allowed = resolve_allowed_origins(None)
    assert "http://localhost:5173" in allowed
    assert "tauri://localhost" in allowed
    assert "http://tauri.localhost" in allowed


def test_配置来源与默认值合并并去重():
    allowed = resolve_allowed_origins(
        ["http://192.168.1.10:5173/", "http://localhost:5173"]
    )
    assert "http://192.168.1.10:5173" in allowed
    assert allowed.count("http://localhost:5173") == 1
    assert "tauri://localhost" in allowed


def test_配置不是数组时退回默认值():
    assert resolve_allowed_origins("http://evil.example") == DEFAULT_ALLOWED_ORIGINS


def test_缺少origin的本机脚本放行():
    allowed = resolve_allowed_origins(None)
    assert origin_allowed(None, allowed)


def test_浏览器来源必须精确匹配():
    allowed = resolve_allowed_origins(None)
    assert origin_allowed("http://localhost:5173", allowed)
    assert not origin_allowed("https://evil.example", allowed)
    assert not origin_allowed("http://localhost:5174", allowed)


def test_origin为null被拒绝():
    allowed = resolve_allowed_origins(None)
    assert not origin_allowed("null", allowed)
    assert not origin_allowed("", allowed)


def test_referer兜底校验():
    allowed = resolve_allowed_origins(None)
    assert request_allowed(None, "http://localhost:5173/journal", allowed)
    assert not request_allowed(None, "https://evil.example/x", allowed)
    assert request_allowed(None, None, allowed)  # 直接访问，没有来源


def test_origin优先于referer():
    allowed = resolve_allowed_origins(None)
    assert not request_allowed("https://evil.example", "http://localhost:5173/", allowed)


def test_归一化去掉路径并统一大小写():
    assert normalize_origin("HTTP://LocalHost:5173/journal?a=1") == "http://localhost:5173"
    assert normalize_origin("tauri://localhost") == "tauri://localhost"
    assert normalize_origin("null") is None
    assert normalize_origin("not a url") is None
