"""回放会话持久化：训练数据进 SQLite，浏览器只做缓存。

会话体是前端 ReplaySession 的完整快照（K 线不存，需要时从网关重新拉取）；
图表视图与画线分列存放，单独保存时不推进 updated_at。
"""

from __future__ import annotations

import json

from worker_base import *  # noqa: F401,F403
from worker_base import GatewayError

# 单文件保护：超过上限拒绝写库，前端保留本地副本并提示
PAYLOAD_LIMIT = 4 * 1024 * 1024
BLOB_LIMIT = 2 * 1024 * 1024
LIST_LIMIT = 500
STATUSES = {
    "preparing",
    "ready",
    "running",
    "paused",
    "finished",
    "archived",
    "error",
}


class WorkerReplay:
    def _replay_view(self, p: dict) -> tuple[str | None, str | None]:
        out: list[str | None] = []
        for label, value in (("图表视图", p.get("chart")), ("画线", p.get("drawings"))):
            if value is None:
                out.append(None)
                continue
            if not isinstance(value, str):
                raise GatewayError("BAD_VIEW", f"{label}需要是字符串")
            if len(value.encode("utf-8")) > BLOB_LIMIT:
                raise GatewayError("REPLAY_TOO_LARGE", f"{label}超过 2 MB，已保存在本机")
            out.append(value)
        return out[0], out[1]

    def _replay_payload(self, session: dict) -> tuple[dict, str]:
        replay_id = str(session.get("id") or "").strip()
        if not replay_id or len(replay_id) > 64:
            raise GatewayError("BAD_SESSION", "会话 id 无效")
        symbol = str(session.get("symbol") or "").strip()
        if not symbol:
            raise GatewayError("BAD_SESSION", "会话缺少品种")
        status = str(session.get("status") or "")
        if status not in STATUSES:
            raise GatewayError("BAD_SESSION", f"未知会话状态: {status}")
        for key in ("startTs", "endTs"):
            value = session.get(key)
            if not isinstance(value, (int, float)) or not value:
                raise GatewayError("BAD_SESSION", f"会话缺少 {key}")
        now = int(time.time() * 1000)
        fixed = dict(session)
        fixed["id"] = replay_id
        fixed["createdAt"] = int(fixed.get("createdAt") or now)
        # updated_at 用毫秒，只做顺序比较；缺失时按服务器时间补齐
        fixed["updatedAt"] = int(fixed.get("updatedAt") or now)
        try:
            payload = json.dumps(fixed, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise GatewayError("BAD_SESSION", f"会话无法序列化: {exc}") from exc
        if len(payload.encode("utf-8")) > PAYLOAD_LIMIT:
            raise GatewayError("REPLAY_TOO_LARGE", "会话超过 4 MB，已保存在本机")
        return fixed, payload

    def _replay_list(self, p: dict) -> dict:
        limit = int(p.get("limit") or LIST_LIMIT)
        limit = min(LIST_LIMIT, max(1, limit))
        return {"sessions": self.store.replay_list(self._login(), limit)}

    def _replay_save(self, p: dict) -> dict:
        login = self._login()
        chart, drawings = self._replay_view(p)
        session = p.get("session")
        if session is None:
            # 只保存图表视图 / 画线；行不存在（本地模式或旧会话）时静默返回
            replay_id = str(p.get("id") or "").strip()
            if not replay_id:
                raise GatewayError("BAD_SESSION", "缺少会话 id")
            saved = self.store.replay_save_view(login, replay_id, chart, drawings)
            return {"id": replay_id, "saved": saved}
        if not isinstance(session, dict):
            raise GatewayError("BAD_SESSION", "缺少会话数据")
        fixed, payload = self._replay_payload(session)
        saved = self.store.replay_save(login, fixed, payload, chart, drawings)
        if not saved:
            raise GatewayError("REPLAY_CONFLICT", "这个复盘会话在别处有更新的进度，请刷新后再试")
        return {"id": fixed["id"], "updatedAt": fixed["updatedAt"], "saved": True}

    def _replay_delete(self, p: dict) -> dict:
        replay_id = str(p.get("id") or "").strip()
        if not replay_id:
            raise GatewayError("BAD_ID", "缺少会话 id")
        return {"id": replay_id, "deleted": self.store.replay_delete(replay_id, self._login())}
