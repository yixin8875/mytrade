"""开仓纪律门禁：清单状态、order.place 判定与成交后的复盘关联。

门禁只拦「新开仓」，平仓 / 改单 / 保本 / 移动止损永远不经过这里。
网关永远以 pre_trade_checks 的落库结果为准，前端传的 confirmed 只表示
「用户接受风险」，不表示清单已经完成。
"""

from __future__ import annotations

from worker_base import GatewayError, time  # noqa: F401

MAX_RULE_LEN = 200
MAX_REASON_LEN = 500


def _clean(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


class WorkerDiscipline:
    # ---------- 接口 ----------

    def _discipline_mode(self) -> str:
        mode = str(getattr(self.cfg, "discipline_mode", "off") or "off").strip().lower()
        return mode if mode in ("off", "confirm", "block") else "off"

    def _discipline_payload(self, login: int, gate: dict) -> dict:
        checks = self.store.pre_trade_checks_get(login, gate["client_id"])
        rules = list(gate.get("rules") or [])
        return {
            "clientId": gate["client_id"],
            "playbookId": gate.get("playbook_id"),
            "mode": gate.get("mode"),
            "state": gate.get("state"),
            "reason": gate.get("reason"),
            "positionId": gate.get("position_id"),
            "createdAt": gate.get("created_at"),
            "updatedAt": gate.get("updated_at"),
            "rules": [
                {
                    "rule": rule,
                    "followed": checks.get(rule),
                    "evaluated": rule in checks,
                }
                for rule in rules
            ],
            "missing": [rule for rule in rules if rule not in checks],
            "violated": [rule for rule in rules if checks.get(rule) is False],
        }

    def _discipline_start(self, p: dict) -> dict:
        client_id = _clean(p.get("clientOrderId"), 31)
        if not client_id:
            raise GatewayError("BAD_ID", "缺少 clientOrderId")
        login = self._login()
        gate = self.store.pre_trade_gate_get(login, client_id)
        if gate is not None:
            # 同一个 clientOrderId 重开清单：返回已保存的勾选，不重写快照
            return {"gate": self._discipline_payload(login, gate)}

        playbook_id = _clean(p.get("playbookId"), 40) or _clean(
            getattr(self.cfg, "discipline_playbook", ""), 40
        )
        book = None
        if playbook_id:
            book = self.store.playbook_get(playbook_id, login)
            if book is None:
                raise GatewayError("NOT_FOUND", "策略清单不存在")
        rules = list(book["rules"]) if book else []
        gate = self.store.pre_trade_gate_start(
            login, client_id, playbook_id or None, self._discipline_mode(), rules
        )
        self.store.audit(
            "discipline.start",
            {
                "clientId": client_id,
                "playbookId": playbook_id or None,
                "rules": len(rules),
            },
        )
        return {"gate": self._discipline_payload(login, gate)}

    def _discipline_check(self, p: dict) -> dict:
        client_id = _clean(p.get("clientOrderId"), 31)
        if not client_id:
            raise GatewayError("BAD_ID", "缺少 clientOrderId")
        login = self._login()
        gate = self.store.pre_trade_gate_get(login, client_id)
        if gate is None:
            raise GatewayError("NOT_FOUND", "先打开开仓清单")
        if gate.get("state") != "pending":
            raise GatewayError("CONFLICT", "清单已提交，不能再修改")

        playbook_id = _clean(p.get("playbookId"), 40) or str(gate.get("playbook_id") or "")
        if gate.get("playbook_id") and playbook_id != gate["playbook_id"]:
            raise GatewayError("BAD_RULE", "这条规则不属于当前清单")
        rule = str(p.get("rule") or "")[:MAX_RULE_LEN]
        if rule not in (gate.get("rules") or []):
            raise GatewayError("BAD_RULE", "这条规则不属于当前清单")
        followed = p.get("followed")
        if followed is not None and not isinstance(followed, bool):
            raise GatewayError("BAD_VALUE", "followed 只能是 true / false / null")

        self.store.pre_trade_check_set(login, client_id, playbook_id, rule, followed)
        self.store.audit(
            "discipline.check",
            {
                "clientId": client_id,
                "rule": rule[:40],
                "followed": followed,
            },
        )
        gate = self.store.pre_trade_gate_get(login, client_id) or gate
        return {"gate": self._discipline_payload(login, gate)}

    def _discipline_state(self, p: dict) -> dict:
        client_id = _clean(p.get("clientOrderId"), 31)
        if not client_id:
            raise GatewayError("BAD_ID", "缺少 clientOrderId")
        login = self._login()
        gate = self.store.pre_trade_gate_get(login, client_id)
        return {"gate": self._discipline_payload(login, gate) if gate else None}

    def _discipline_reset(self, p: dict) -> dict:
        client_id = _clean(p.get("clientOrderId"), 31)
        if not client_id:
            raise GatewayError("BAD_ID", "缺少 clientOrderId")
        login = self._login()
        gate = self.store.pre_trade_gate_reset(login, client_id)
        if gate is None:
            return {"gate": None}
        self.store.audit("discipline.reset", {"clientId": client_id})
        return {"gate": self._discipline_payload(login, gate)}

    # ---------- order.place 判定 ----------

    def _discipline_gate(self, login: int, client_id: str, payload: object) -> None:
        """在下单前判定清单；通过则更新 gate 状态，不通过抛 GatewayError。

        调用位置在 _analyze 与原有风控之后、写 intent 之前：
        只读 / 风控 / 重复单被拒绝时不应该先弹清单。
        """
        mode = self._discipline_mode()
        if mode == "off":
            return
        info = payload if isinstance(payload, dict) else {}
        try:
            playbook_id = _clean(info.get("playbookId"), 40) or _clean(
                getattr(self.cfg, "discipline_playbook", ""), 40
            )
            confirmed = bool(info.get("confirmed"))
            reason = _clean(info.get("reason"), MAX_REASON_LEN)
            require_reason = bool(
                getattr(self.cfg, "discipline_require_reason", False)
            )

            gate = self.store.pre_trade_gate_get(login, client_id)
            if gate is not None and gate.get("state") in ("passed", "overridden"):
                # 同一 clientOrderId 的重试：门禁已经放行过，不再重复要求清单
                return
            if gate is None:
                book = (
                    self.store.playbook_get(playbook_id, login)
                    if playbook_id
                    else None
                )
                rules = list(book["rules"]) if book else []
                gate = self.store.pre_trade_gate_start(
                    login, client_id, playbook_id or None, mode, rules
                )

            rules = list(gate.get("rules") or [])
            if not rules:
                why = "no-rules" if gate.get("playbook_id") else "no-playbook"
                self.store.pre_trade_gate_update(login, client_id, "skipped")
                self.store.audit(
                    "discipline.skipped", {"clientId": client_id, "reason": why}
                )
                if mode == "block":
                    raise GatewayError(
                        "DISCIPLINE_BLOCKED",
                        "开仓清单没有规则：请先在策略页创建清单",
                        {"missing": [], "violated": []},
                    )
                return

            checks = self.store.pre_trade_checks_get(login, client_id)
            missing = [rule for rule in rules if rule not in checks]
            violated = [rule for rule in rules if checks.get(rule) is False]

            if mode == "block":
                if missing:
                    self._discipline_blocked(client_id, gate, missing, violated)
                if violated:
                    if not confirmed or not reason:
                        self._discipline_blocked(client_id, gate, missing, violated)
                    self.store.pre_trade_gate_update(
                        login, client_id, "overridden", reason=reason
                    )
                    self.store.audit(
                        "discipline.override",
                        {
                            "clientId": client_id,
                            "playbookId": gate.get("playbook_id"),
                            "missing": missing,
                            "violated": violated,
                            "reason": reason,
                        },
                    )
                    return
            elif missing or violated:
                if not confirmed or (require_reason and not reason):
                    self.store.audit(
                        "discipline.incomplete",
                        {
                            "clientId": client_id,
                            "playbookId": gate.get("playbook_id"),
                            "missing": missing,
                            "violated": violated,
                            "requireReason": require_reason,
                        },
                    )
                    raise GatewayError(
                        "DISCIPLINE_INCOMPLETE",
                        f"还有 {len(missing)} 条规则未评估，请先复核清单"
                        if missing
                        else "存在违反的规则，需要复核后才能下单",
                        {"missing": missing, "violated": violated},
                    )
                self.store.pre_trade_gate_update(
                    login, client_id, "overridden", reason=reason or None
                )
                self.store.audit(
                    "discipline.override",
                    {
                        "clientId": client_id,
                        "playbookId": gate.get("playbook_id"),
                        "missing": missing,
                        "violated": violated,
                        "reason": reason or None,
                    },
                )
                return

            self.store.pre_trade_gate_update(login, client_id, "passed")
            self.store.audit(
                "discipline.pass",
                {
                    "clientId": client_id,
                    "playbookId": gate.get("playbook_id"),
                    "rules": len(rules),
                },
            )
        except GatewayError:
            raise
        except Exception as exc:  # noqa: BLE001
            summary = f"{type(exc).__name__}: {exc}"
            try:
                self.store.audit(
                    "discipline.error", {"clientId": client_id, "error": summary}
                )
            except Exception:  # noqa: BLE001 - 审计也失败时不再掩盖原错误
                pass
            # 严格模式 fail-closed；确认模式 fail-open，但留下审计
            if mode == "block":
                raise GatewayError("INTERNAL", f"纪律门禁不可用: {exc}") from exc

    def _discipline_blocked(
        self,
        client_id: str,
        gate: dict,
        missing: list[str],
        violated: list[str],
    ) -> None:
        self.store.audit(
            "discipline.blocked",
            {
                "clientId": client_id,
                "playbookId": gate.get("playbook_id"),
                "missing": missing,
                "violated": violated,
            },
        )
        if violated:
            message = "存在违反的规则：填写理由并二次确认后才能下单"
        else:
            message = f"还有 {len(missing)} 条规则未评估，不能下单"
        raise GatewayError(
            "DISCIPLINE_BLOCKED",
            message,
            {"missing": missing, "violated": violated},
        )

    # ---------- 成交关联 ----------

    def _discipline_link(self, login: int, client_id: str, position_id: int) -> None:
        """成交后回填持仓号；关联失败只影响复盘展示，绝不影响交易。"""
        try:
            gate = self.store.pre_trade_gate_get(login, client_id)
            if gate is not None and position_id:
                self.store.pre_trade_gate_link(login, client_id, int(position_id))
        except Exception:  # noqa: BLE001
            pass
