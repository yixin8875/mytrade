import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { AuditPanel } from './Audit';

type CallImpl = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function resetApp() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    conn: 'closed',
    toast: null,
  });
}

function mockGateway(values: Record<string, unknown>) {
  const impl: CallImpl = (method) =>
    Promise.resolve(method in values ? values[method] : []);
  return vi.spyOn(gateway, 'call').mockImplementation(impl as unknown as typeof gateway.call);
}

describe('AuditPanel', () => {
  beforeEach(resetApp);

  it('立即对账调用 system.reconcile 并显示结果提示', async () => {
    const user = userEvent.setup();
    const spy = mockGateway({
      'system.reconcile': { checked: 3, found: 2, notFound: 1 },
      'audit.query': [],
    });
    render(<AuditPanel />);

    await user.click(screen.getByRole('button', { name: '立即对账' }));

    expect(spy).toHaveBeenCalledWith('system.reconcile', {});
    await waitFor(() =>
      expect(useApp.getState().toast?.text).toBe('对账完成：检查 3，找到 2，未找到 1'),
    );
    expect(useApp.getState().toast?.kind).toBe('error');
  });

  it('按日期、类型和关键词查询并渲染审计行', async () => {
    const user = userEvent.setup();
    const spy = mockGateway({
      'audit.query': [
        {
          ts: '2026-11-15T09:30:00Z',
          kind: 'order.place',
          payload: { clientId: 'c1' },
        },
      ],
    });
    render(<AuditPanel />);

    fireEvent.change(screen.getByLabelText('日期（UTC）'), {
      target: { value: '2026-11-15' },
    });
    fireEvent.change(screen.getByLabelText('类型'), {
      target: { value: 'order.' },
    });
    fireEvent.change(screen.getByLabelText('含文本'), {
      target: { value: 'EURUSD' },
    });

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('audit.query', {
        date: '2026-11-15',
        kind: 'order.',
        text: 'EURUSD',
        limit: 300,
      }),
    );
    expect(screen.getByText('order.place')).toBeInTheDocument();
    expect(screen.getByText('{"clientId":"c1"}')).toBeInTheDocument();
    expect(screen.getByText('1 条')).toBeInTheDocument();
  });

  it('没有记录时显示空态文案', async () => {
    const user = userEvent.setup();
    mockGateway({ 'audit.query': [] });
    render(<AuditPanel />);

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() =>
      expect(screen.getByText('这个日期没有匹配的审计记录')).toBeInTheDocument(),
    );
  });
});
