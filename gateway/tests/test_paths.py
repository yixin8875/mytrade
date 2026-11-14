"""数据目录解析与旧数据迁移：只补缺、不覆盖、失败不阻塞启动。"""

import json
import sqlite3

import paths


# ---------- 命令行参数 ----------


def test_解析命令行参数(monkeypatch):
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py", "--data-dir", "C:/data"])

    assert paths._argv_value("--data-dir") == "C:/data"


def test_解析等号形式的参数(monkeypatch):
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py", "--data-dir=C:/data"])

    assert paths._argv_value("--data-dir") == "C:/data"


def test_参数在末尾没有值时返回空(monkeypatch):
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py", "--data-dir"])

    assert paths._argv_value("--data-dir") is None
    assert paths._argv_value("--other") is None


# ---------- 数据目录 ----------


def test_命令行参数优先于环境变量(monkeypatch, tmp_path):
    arg_dir = tmp_path / "arg"
    env_dir = tmp_path / "env"
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py", "--data-dir", str(arg_dir)])
    monkeypatch.setenv("MYTRADE_DATA_DIR", str(env_dir))

    assert paths.resolve_data_dir() == arg_dir.resolve()


def test_环境变量作为数据目录(monkeypatch, tmp_path):
    env_dir = tmp_path / "env"
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py"])
    monkeypatch.setenv("MYTRADE_DATA_DIR", str(env_dir))

    assert paths.resolve_data_dir() == env_dir.resolve()


def test_默认使用本地应用数据目录(monkeypatch, tmp_path):
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py"])
    monkeypatch.delenv("MYTRADE_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))

    assert paths.resolve_data_dir() == (tmp_path / "local" / "MyTrade" / "gateway").resolve()


def test_没有本地应用数据目录时退回用户目录(monkeypatch):
    monkeypatch.setattr(paths.sys, "argv", ["gateway.py"])
    monkeypatch.delenv("MYTRADE_DATA_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)

    assert paths.resolve_data_dir() == (
        paths.Path.home() / ".mytrade" / "gateway"
    ).resolve()


def test_创建目录成功(tmp_path):
    target = tmp_path / "new"

    assert paths._ensure_dir(target) == target
    assert target.is_dir()


def test_创建目录失败时退回临时目录(monkeypatch, tmp_path, capsys):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    fallback_root = tmp_path / "temp"
    monkeypatch.setattr(paths.tempfile, "gettempdir", lambda: str(fallback_root))

    result = paths._ensure_dir(blocker)

    assert result == fallback_root / "MyTrade" / "gateway"
    assert result.is_dir()
    assert "无法创建数据目录" in capsys.readouterr().err


# ---------- SQLite 与数据库判断 ----------


def make_db(path, rows=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE journal (id INTEGER PRIMARY KEY)")
        for index in range(rows):
            conn.execute("INSERT INTO journal (id) VALUES (?)", (index + 1,))


def test_数据库不存在或没有记录视为空(tmp_path):
    assert paths._database_empty(tmp_path / "missing.db") is True

    empty = tmp_path / "empty.db"
    make_db(empty, rows=0)
    assert paths._database_empty(empty) is True

    filled = tmp_path / "filled.db"
    make_db(filled, rows=2)
    assert paths._database_empty(filled) is False


def test_数据库损坏视为空(tmp_path):
    broken = tmp_path / "broken.db"
    broken.write_text("not a database", encoding="utf-8")
    assert paths._database_empty(broken) is True

    other = tmp_path / "other.db"
    with sqlite3.connect(other) as conn:
        conn.execute("CREATE TABLE unrelated (id INTEGER)")
    assert paths._database_empty(other) is True


def test_在线备份复制数据库(tmp_path):
    source = tmp_path / "source.db"
    make_db(source, rows=2)
    target = tmp_path / "nested" / "target.db"

    paths._copy_sqlite(source, target)

    with sqlite3.connect(target) as conn:
        assert conn.execute("SELECT COUNT(*) FROM journal").fetchone()[0] == 2
    with sqlite3.connect(source) as conn:
        assert conn.execute("SELECT COUNT(*) FROM journal").fetchone()[0] == 2


def test_只补缺失文件不覆盖(tmp_path):
    source = tmp_path / "source"
    (source / "a").mkdir(parents=True)
    (source / "a" / "1.txt").write_text("new", encoding="utf-8")
    (source / "a" / "2.txt").write_text("two", encoding="utf-8")
    (source / "top.txt").write_text("top", encoding="utf-8")
    target = tmp_path / "target"
    (target / "a").mkdir(parents=True)
    (target / "a" / "1.txt").write_text("keep", encoding="utf-8")

    assert paths._copy_missing(source, target) is True
    assert (target / "a" / "1.txt").read_text(encoding="utf-8") == "keep"
    assert (target / "a" / "2.txt").read_text(encoding="utf-8") == "two"
    assert (target / "top.txt").read_text(encoding="utf-8") == "top"

    assert paths._copy_missing(source, target) is False


def test_空目录不复制任何东西(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    target = tmp_path / "target"
    target.mkdir()

    assert paths._copy_missing(source, target) is False


# ---------- 迁移 ----------


def make_legacy(root):
    root.mkdir(parents=True)
    (root / "config.json").write_text(json.dumps({"magic": 1}), encoding="utf-8")
    (root / "data").mkdir()
    (root / "data" / "credentials.json").write_text("{}", encoding="utf-8")
    make_db(root / "data" / "mytrade.db", rows=1)
    (root / "data" / "shots").mkdir()
    (root / "data" / "shots" / "shot.jpg").write_bytes(b"jpg")
    (root / "audit").mkdir()
    (root / "audit" / "audit.log").write_text("log", encoding="utf-8")
    return root


def test_完整迁移旧目录(tmp_path):
    legacy = make_legacy(tmp_path / "legacy")
    target = tmp_path / "target"
    target.mkdir()

    paths._migrate(legacy, target)

    assert json.loads((target / "config.json").read_text(encoding="utf-8")) == {"magic": 1}
    assert (target / "data" / "credentials.json").read_text(encoding="utf-8") == "{}"
    with sqlite3.connect(target / "data" / "mytrade.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM journal").fetchone()[0] == 1
    assert (target / "data" / "shots" / "shot.jpg").read_bytes() == b"jpg"
    assert (target / "audit" / "audit.log").read_text(encoding="utf-8") == "log"
    assert (
        target / ".migrated-from-repo-v1"
    ).read_text(encoding="utf-8") == f"migrated from {legacy}\n"


def test_迁移过一次后不重复覆盖(tmp_path):
    legacy = make_legacy(tmp_path / "legacy")
    target = tmp_path / "target"
    target.mkdir()
    paths._migrate(legacy, target)
    (target / "config.json").write_text('{"changed": true}', encoding="utf-8")

    paths._migrate(legacy, target)

    assert json.loads((target / "config.json").read_text(encoding="utf-8")) == {"changed": True}


def test_来源不同的标记会重新合并但保留新数据(tmp_path):
    legacy = make_legacy(tmp_path / "legacy")
    target = tmp_path / "target"
    target.mkdir()
    paths._migrate(legacy, target)
    (target / ".migrated-from-repo-v1").write_text("migrated from elsewhere\n", encoding="utf-8")
    (target / "config.json").write_text('{"changed": true}', encoding="utf-8")

    paths._migrate(legacy, target)

    assert json.loads((target / "config.json").read_text(encoding="utf-8")) == {"changed": True}
    assert (
        target / ".migrated-from-repo-v1"
    ).read_text(encoding="utf-8") == f"migrated from {legacy}\n"


def test_目标已有配置和交易库时不覆盖(tmp_path):
    legacy = make_legacy(tmp_path / "legacy")
    target = tmp_path / "target"
    (target / "data").mkdir(parents=True)
    (target / "config.json").write_text('{"mine": true}', encoding="utf-8")
    make_db(target / "data" / "mytrade.db", rows=3)

    paths._migrate(legacy, target)

    assert json.loads((target / "config.json").read_text(encoding="utf-8")) == {"mine": True}
    with sqlite3.connect(target / "data" / "mytrade.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM journal").fetchone()[0] == 3


def test_旧目录没有数据时不写迁移标记(tmp_path):
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    target = tmp_path / "target"
    target.mkdir()

    paths._migrate(legacy, target)

    assert not (target / ".migrated-from-repo-v1").exists()


def test_同目录不做迁移(tmp_path):
    legacy = tmp_path / "same"
    legacy.mkdir()
    (legacy / "config.json").write_text("{}", encoding="utf-8")

    paths._migrate(legacy, legacy)

    assert not (legacy / ".migrated-from-repo-v1").exists()


def test_旧目录只有空数据目录也写标记(tmp_path):
    legacy = tmp_path / "legacy"
    (legacy / "data").mkdir(parents=True)
    target = tmp_path / "target"
    target.mkdir()

    paths._migrate(legacy, target)

    assert (target / ".migrated-from-repo-v1").is_file()


def test_交易库复制失败不阻塞其余迁移(tmp_path, capsys):
    legacy = make_legacy(tmp_path / "legacy")
    (legacy / "data" / "mytrade.db").write_text("broken", encoding="utf-8")
    target = tmp_path / "target"
    target.mkdir()

    paths._migrate(legacy, target)

    assert (target / "config.json").is_file()
    assert (target / "data" / "shots" / "shot.jpg").is_file()
    assert (target / ".migrated-from-repo-v1").is_file()
    assert "迁移交易数据库失败" in capsys.readouterr().err
