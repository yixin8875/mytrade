import { useCallback, useEffect, useRef, useState } from 'react';
import { gateway } from '../../gateway/client';
import type {
  DisciplineGate,
  Playbook,
  Toast,
  ToastAction,
} from '../../gateway/types';

type Notify = (kind: Toast['kind'], text: string, action?: ToastAction) => void;

/**
 * 开仓纪律门禁：清单状态、规则评估与二次确认。
 * 弹窗打开时拉一份快照，关闭或下单成功后丢弃在途请求。
 */
export function useDisciplineGate({
  confirm,
  enabled,
  mode,
  requireReason,
  defaultPlaybook,
  notify,
}: {
  confirm: boolean;
  enabled: boolean;
  mode: string;
  requireReason: boolean;
  defaultPlaybook: string;
  notify: Notify;
}) {
  const [gate, setGate] = useState<DisciplineGate | null>(null);
  const [gatePlaybooks, setGatePlaybooks] = useState<Playbook[]>([]);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateConfirmed, setGateConfirmed] = useState(false);
  const [gateReason, setGateReason] = useState('');
  const [gateClientId, setGateClientId] = useState<string | null>(null);
  /** 连续切换清单时只接受最后一次请求的结果 */
  const gateRequestRef = useRef(0);
  /**
   * openDisciplineGate 只依赖 settings，不依赖已加载的清单列表；
   * 用 ref 读取列表，避免加载完清单后重跑「打开弹窗」的 effect。
   */
  const booksRef = useRef<Playbook[]>([]);
  useEffect(() => {
    booksRef.current = gatePlaybooks;
  }, [gatePlaybooks]);

  const reset = useCallback(() => {
    gateRequestRef.current += 1;
    setGate(null);
    setGateError(null);
    setGateLoading(false);
    setGateConfirmed(false);
    setGateReason('');
    setGateClientId(null);
  }, []);

  /** 打开/切换开仓清单；每次生成新的 clientOrderId，避免沿用旧快照 */
  const openDisciplineGate = useCallback(
    async (playbookId?: string) => {
      if (!enabled) return;
      const request = gateRequestRef.current + 1;
      gateRequestRef.current = request;
      setGateLoading(true);
      setGateError(null);
      setGateConfirmed(false);
      setGateReason('');
      setGate(null);
      const clientOrderId = crypto.randomUUID();
      setGateClientId(clientOrderId);
      try {
        let books = booksRef.current;
        if (!books.length) {
          const res = await gateway.call<{ playbooks: Playbook[] }>('strategy.list', {});
          books = res.playbooks ?? [];
          if (gateRequestRef.current !== request) return;
          setGatePlaybooks(books);
        }
        const fallback = defaultPlaybook || books[0]?.id || '';
        const chosen = playbookId === undefined ? fallback : playbookId;
        const res = await gateway.call<{ gate: DisciplineGate }>('discipline.start', {
          clientOrderId,
          playbookId: chosen || undefined,
        });
        if (gateRequestRef.current !== request) return;
        setGate(res.gate);
      } catch (error) {
        if (gateRequestRef.current !== request) return;
        setGateError((error as Error).message);
      } finally {
        if (gateRequestRef.current === request) setGateLoading(false);
      }
    },
    [enabled, defaultPlaybook],
  );

  const checkRule = useCallback(
    async (rule: string, followed: boolean | null) => {
      if (!gate || gateLoading) return;
      setGateLoading(true);
      try {
        const res = await gateway.call<{ gate: DisciplineGate }>('discipline.check', {
          clientOrderId: gate.clientId,
          playbookId: gate.playbookId ?? undefined,
          rule,
          followed,
        });
        setGate(res.gate);
      } catch (error) {
        notify('error', (error as Error).message);
      } finally {
        setGateLoading(false);
      }
    },
    [gate, gateLoading, notify],
  );

  useEffect(() => {
    if (!confirm) {
      // 关闭弹窗：丢弃在途请求，下次打开重新生成 clientOrderId
      reset();
      return;
    }
    if (!enabled) return;
    void openDisciplineGate();
    // 只在弹窗打开时初始化；切换清单由用户操作显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);

  // 门禁状态：全部规则都有评估结果才算完成；「不适用」视为已评估
  const gateRules = gate?.rules ?? [];
  const gateMissing = gate?.missing ?? [];
  const gateViolated = gate?.violated ?? [];
  const gateHasRules = !!gate?.playbookId && gateRules.length > 0;
  const gateShowConfirm =
    enabled &&
    gateHasRules &&
    (mode === 'confirm'
      ? gateMissing.length > 0 || gateViolated.length > 0
      : gateMissing.length === 0 && gateViolated.length > 0);
  const gateShowReason = gateShowConfirm && (mode === 'block' || requireReason);
  let gateProblem: string | null = null;
  if (enabled) {
    if (gateLoading) {
      gateProblem = '正在读取开仓清单…';
    } else if (gateError) {
      gateProblem = gateError;
    } else if (!gate) {
      gateProblem = '开仓清单不可用，请稍后重试';
    } else if (!gateHasRules) {
      // confirm 允许跳过并写审计；block 必须先在设置里配置清单
      if (mode === 'block') gateProblem = '先在设置里配置开仓清单';
    } else if (mode === 'block') {
      if (gateMissing.length) {
        gateProblem = `还有 ${gateMissing.length} 条规则未评估`;
      } else if (gateViolated.length) {
        if (!gateConfirmed) gateProblem = '存在违反的规则，请先勾选复核';
        else if (!gateReason.trim()) gateProblem = '请填写强行下单的理由';
      }
    } else if (gateMissing.length || gateViolated.length) {
      if (!gateConfirmed) {
        gateProblem =
          gateMissing.length > 0
            ? `还有 ${gateMissing.length} 条规则未评估，请先勾选「我已复核」`
            : '存在违反的规则，请先勾选「我已复核」';
      } else if (requireReason && !gateReason.trim()) {
        gateProblem = '请填写强行下单的理由';
      }
    }
  }

  return {
    gate,
    gatePlaybooks,
    gateLoading,
    gateError,
    gateConfirmed,
    setGateConfirmed,
    gateReason,
    setGateReason,
    gateClientId,
    gateRules,
    gateMissing,
    gateViolated,
    gateShowConfirm,
    gateShowReason,
    gateProblem,
    openDisciplineGate,
    checkRule,
    resetGate: reset,
  };
}
