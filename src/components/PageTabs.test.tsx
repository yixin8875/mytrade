import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PageTabs, useVisited, type PageTab } from './PageTabs';

type Key = 'list' | 'calendar';

const TABS: PageTab<Key>[] = [
  { key: 'list', label: '交易列表', hint: '按平仓时间倒序' },
  { key: 'calendar', label: '盈亏日历' },
];

describe('PageTabs', () => {
  it('列出所有页签，并用 aria-selected 标出当前页', () => {
    render(<PageTabs tabs={TABS} value="calendar" onChange={() => {}} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['交易列表', '盈亏日历']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('title', '按平仓时间倒序');
  });

  it('点击页签把 key 交给容器页', async () => {
    const onChange = vi.fn();
    render(<PageTabs tabs={TABS} value="list" onChange={onChange} />);

    await userEvent.click(screen.getByRole('tab', { name: '盈亏日历' }));

    expect(onChange).toHaveBeenCalledWith('calendar');
  });
});

describe('useVisited', () => {
  it('第一次见到的页签才挂载，之后保持记忆且不重复', () => {
    const { result, rerender } = renderHook(({ key }: { key: Key }) => useVisited(key), {
      initialProps: { key: 'list' },
    });
    expect(result.current).toEqual(['list']);

    rerender({ key: 'calendar' });
    expect(result.current).toEqual(['list', 'calendar']);

    // 切回已访问过的页签不会再追加，旧页签继续保留挂载
    rerender({ key: 'list' });
    expect(result.current).toEqual(['list', 'calendar']);
  });
});
