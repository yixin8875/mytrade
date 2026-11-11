from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

APP_DIR_NAME = "MyTrade"
GATEWAY_DIR_NAME = "gateway"
_MIGRATION_MARKER = ".migrated-from-repo-v1"

# 源码模式下的旧数据目录；打包成 sidecar 后位于临时解包目录，不会迁移。
_LEGACY_OVERRIDE = os.environ.get("MYTRADE_LEGACY_DIR")
LEGACY_DIR = (
    Path(_LEGACY_OVERRIDE).expanduser().resolve()
    if _LEGACY_OVERRIDE
    else Path(__file__).resolve().parent
)


def _argv_value(flag: str) -> str | None:
    args = sys.argv[1:]
    for index, arg in enumerate(args):
        if arg == flag and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith(f"{flag}="):
            return arg.split("=", 1)[1]
    return None


def _default_data_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / APP_DIR_NAME / GATEWAY_DIR_NAME
    return Path.home() / ".mytrade" / GATEWAY_DIR_NAME


def resolve_data_dir() -> Path:
    """数据目录：--data-dir > MYTRADE_DATA_DIR > %LOCALAPPDATA%\\MyTrade\\gateway。"""
    override = _argv_value("--data-dir") or os.environ.get("MYTRADE_DATA_DIR")
    path = Path(override).expanduser() if override else _default_data_dir()
    return path.resolve()


def _ensure_dir(path: Path) -> Path:
    try:
        path.mkdir(parents=True, exist_ok=True)
        return path
    except OSError as exc:
        fallback = Path(tempfile.gettempdir()) / APP_DIR_NAME / GATEWAY_DIR_NAME
        print(
            f"无法创建数据目录 {path}：{exc}；改用 {fallback}",
            file=sys.stderr,
        )
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _copy_sqlite(source: Path, target: Path) -> None:
    """用 SQLite 在线备份复制正在使用的数据库，避免拷到半写状态。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(target)
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _database_empty(path: Path) -> bool:
    if not path.is_file():
        return True
    try:
        with sqlite3.connect(path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM journal").fetchone()
            return not row or int(row[0]) == 0
    except sqlite3.Error:
        return True


def _copy_missing(src: Path, dst: Path) -> bool:
    """合并目录时只补缺失文件，不覆盖新数据。"""
    copied = False
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        target = dst / path.relative_to(src)
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied = True
    return copied


def _migrate(legacy: Path, target: Path) -> None:
    if legacy.resolve() == target.resolve():
        return
    if not any(
        (
            (legacy / "config.json").is_file(),
            (legacy / "data").is_dir(),
            (legacy / "audit").is_dir(),
        )
    ):
        # 打包后的 sidecar 找不到旧目录，不应该写入“已迁移”标记
        return

    marker = target / _MIGRATION_MARKER
    source_note = "migrated from " + str(legacy)
    if marker.is_file():
        try:
            if marker.read_text(encoding="utf-8").strip() == source_note:
                return
        except OSError:
            pass

    copied: list[str] = []
    config = legacy / "config.json"
    if config.is_file() and not (target / "config.json").exists():
        shutil.copy2(config, target / "config.json")
        copied.append("config.json")

    legacy_data = legacy / "data"
    target_data = target / "data"
    credentials = legacy_data / "credentials.json"
    if credentials.is_file() and not (target_data / "credentials.json").exists():
        target_data.mkdir(parents=True, exist_ok=True)
        shutil.copy2(credentials, target_data / "credentials.json")
        copied.append("data/credentials.json")

    database = legacy_data / "mytrade.db"
    target_database = target_data / "mytrade.db"
    if database.is_file() and _database_empty(target_database):
        try:
            _copy_sqlite(database, target_database)
            copied.append("data/mytrade.db")
        except sqlite3.Error as exc:
            print(f"迁移交易数据库失败：{exc}", file=sys.stderr)

    for name, source in (
        ("data/shots", legacy_data / "shots"),
        ("audit", legacy / "audit"),
    ):
        if source.is_dir() and _copy_missing(source, target / name):
            copied.append(name)

    marker.write_text(source_note + "\n", encoding="utf-8")
    if copied:
        print(
            "已将旧版网关数据迁移到 " + str(target) + "：" + ", ".join(copied),
            file=sys.stderr,
        )


BASE_DIR = _ensure_dir(resolve_data_dir())
try:
    _migrate(LEGACY_DIR, BASE_DIR)
except OSError as exc:
    # 迁移失败不应阻止网关启动；用户仍可在设置页重新配置账户
    print(f"迁移旧版网关数据失败：{exc}", file=sys.stderr)
