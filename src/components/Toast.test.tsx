import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../store/useApp';
import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    useApp.setState({ toast: null });
  });

  it('普通提示点击关闭', async () => {
    useApp.setState({ toast: { id: 1, kind: 'info', text: '已同步交易日志', action: null } });
    render(<Toast />);

    await userEvent.click(screen.getByText('已同步交易日志'));

    expect(useApp.getState().toast).toBeNull();
  });

  it('带撤销动作的提示先清掉提示再执行动作', async () => {
    const run = vi.fn();
    useApp.setState({
      toast: {
        id: 2,
        kind: 'info',
        text: '已撤 XAUUSD #123',
        action: { label: '撤销', run },
      },
    });
    render(<Toast />);

    await userEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(useApp.getState().toast).toBeNull();
  });

  it('没有提示时不渲染', () => {
    const { container } = render(<Toast />);
    expect(container).toBeEmptyDOMElement();
  });
});
