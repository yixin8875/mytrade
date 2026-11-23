import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import type { PriceAlert } from '../gateway/types';
import { AlertsPanel } from './AlertsPanel';

function makeAlert(id: number, overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id,
    login: 12345,
    symbol: 'XAUUSD',
    kind: 'above',
    price: 4100,
    note: '前高',
    enabled: 1,
    repeat: 0,
    cooldown_sec: 60,
    created_at: 1763200000,
    triggered_at: null,
    trigger_count: 0,
    ...overrides,
  };
}

const ALERT = makeAlert(1);
const SECOND_ALERT = makeAlert(2, { symbol: 'EURUSD', price: 1.1 });

function mockGateway(list: PriceAlert[] = []) {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'alerts.list') return list;
    if (
      method === 'alerts.create' ||
      method === 'alerts.update' ||
      method === 'alerts.delete' ||
      method === 'alerts.test'
    ) {
      return {};
    }
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

let notify: ReturnType<typeof vi.fn>;
type Notify = (kind: 'info' | 'error' | 'success', text: string) => void;

function resetStore(alerts: PriceAlert[] = []) {
  notify = vi.fn();
  useApp.setState({
    page: 'trade',
    alerts,
    alertPrefill: null,
    symbol: 'XAUUSD',
    symbols: [GOLD_INFO],
    quote: null,
    crosshairPrice: null,
    health: null,
    alertSound: true,
    alertDesktop: false,
    notify: notify as unknown as Notify,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

describe('AlertsPanel', () => {
  it('新建告警调用 alerts.create，字段来自表单', async () => {
    const call = mockGateway([]);
    render(<AlertsPanel />);

    const [priceInput] = screen.getAllByRole('spinbutton');
    await userEvent.type(priceInput, '4000');
    await userEvent.type(screen.getByPlaceholderText('前高 / 日线阻力'), '前高');
    await userEvent.click(screen.getByRole('button', { name: '添加告警' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'alerts.create',
        expect.objectContaining({
          symbol: 'XAUUSD',
          kind: 'above',
          price: 4000,
          note: '前高',
          repeat: false,
          cooldownSec: 60,
        }),
      );
    });
    expect(notify).toHaveBeenCalledWith('success', '已添加 XAUUSD 上穿 4000');
  });

  it('编辑已有告警后提交调用 alerts.update', async () => {
    const call = mockGateway([ALERT]);
    resetStore([ALERT]);
    render(<AlertsPanel />);

    await screen.findByText(/4100\.00/);
    await userEvent.click(screen.getByLabelText('编辑告警'));

    const [priceInput] = screen.getAllByRole('spinbutton');
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '4200');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'alerts.update',
        expect.objectContaining({
          id: 1,
          kind: 'above',
          price: 4200,
          note: '前高',
          repeat: false,
          cooldownSec: 0,
        }),
      );
    });
  });

  it('删除告警需要二次确认，确认后调用 alerts.delete', async () => {
    const call = mockGateway([ALERT]);
    resetStore([ALERT]);
    render(<AlertsPanel />);

    await screen.findByText(/4100\.00/);
    const del = screen.getByLabelText('删除告警');
    await userEvent.click(del);

    expect(screen.getByText('确认')).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('alerts.delete', expect.anything());

    await userEvent.click(del);

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('alerts.delete', { id: 1 });
    });
  });

  it('点「测试」调用 alerts.test 并带上当前品种', async () => {
    const call = mockGateway([]);
    render(<AlertsPanel />);

    await userEvent.click(screen.getByRole('button', { name: '测试' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('alerts.test', { symbol: 'XAUUSD' });
    });
  });

  it('价格为空时不发请求并提示错误', async () => {
    const call = mockGateway([]);
    render(<AlertsPanel />);

    await userEvent.click(screen.getByRole('button', { name: '添加告警' }));

    expect(notify).toHaveBeenCalledWith('error', '请输入有效的告警价格');
    expect(call).not.toHaveBeenCalledWith('alerts.create', expect.anything());
  });

  it('价格为 0 时不发请求并提示错误', async () => {
    const call = mockGateway([]);
    render(<AlertsPanel />);

    const [priceInput] = screen.getAllByRole('spinbutton');
    await userEvent.type(priceInput, '0');
    await userEvent.click(screen.getByRole('button', { name: '添加告警' }));

    expect(notify).toHaveBeenCalledWith('error', '请输入有效的告警价格');
    expect(call).not.toHaveBeenCalledWith('alerts.create', expect.anything());
  });

  it('同一时间只有一个告警处于编辑态', async () => {
    const call = mockGateway([ALERT, SECOND_ALERT]);
    resetStore([ALERT, SECOND_ALERT]);
    render(<AlertsPanel />);

    await screen.findByText(/1\.10000/);
    const editButtons = screen.getAllByLabelText('编辑告警');

    await userEvent.click(editButtons[0]);
    let [priceInput] = screen.getAllByRole('spinbutton');
    expect((priceInput as HTMLInputElement).value).toBe('4100');
    expect(screen.getAllByText('编辑中')).toHaveLength(1);

    await userEvent.click(screen.getAllByLabelText('编辑告警')[1]);
    [priceInput] = screen.getAllByRole('spinbutton');
    expect((priceInput as HTMLInputElement).value).toBe('1.1');
    expect(screen.getAllByText('编辑中')).toHaveLength(1);

    // 只读取告警列表，没有提交任何修改
    expect(call).not.toHaveBeenCalledWith('alerts.update', expect.anything());
  });

  it('图表快捷操作送来的预填只套用一次', async () => {
    const call = mockGateway([]);
    useApp.setState({
      alertPrefill: { symbol: 'XAUUSD', price: 3990.5, kind: 'below', nonce: 1 },
    });
    const { unmount } = render(<AlertsPanel />);

    const [priceInput] = screen.getAllByRole('spinbutton');
    expect((priceInput as HTMLInputElement).value).toBe('3990.50');
    expect(screen.getByRole('button', { name: '下穿' })).toHaveAttribute('aria-pressed', 'true');
    expect(useApp.getState().alertPrefill).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '添加告警' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'alerts.create',
        expect.objectContaining({ symbol: 'XAUUSD', kind: 'below', price: 3990.5 }),
      );
    });

    // 清空后重新挂载不应再套用旧价
    unmount();
    render(<AlertsPanel />);
    const [again] = screen.getAllByRole('spinbutton');
    expect((again as HTMLInputElement).value).toBe('');
  });
});
