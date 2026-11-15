import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RANGE_OPTIONS, RangeChips } from './RangeChips';

describe('RangeChips', () => {
  it('按顺序渲染常用时间区间', () => {
    render(<RangeChips value={30} onChange={() => {}} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '7 天',
      '30 天',
      '90 天',
      '1 年',
      '全部',
    ]);
    expect(RANGE_OPTIONS.map((option) => option.value)).toEqual([7, 30, 90, 365, 0]);
  });

  it('点击区间把数值交给回调', async () => {
    const onChange = vi.fn();
    render(<RangeChips value={30} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: '90 天' }));
    expect(onChange).toHaveBeenCalledWith(90);

    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('当前值用高亮类标出，其他按钮不激活', () => {
    render(<RangeChips value={90} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: '90 天' })).toHaveClass('console-chip-active');
    for (const label of ['7 天', '30 天', '1 年', '全部']) {
      expect(screen.getByRole('button', { name: label })).not.toHaveClass('console-chip-active');
    }
  });

  it('支持自定义选项和容器 className', async () => {
    const onChange = vi.fn();
    render(
      <RangeChips
        value={15}
        onChange={onChange}
        options={[
          { value: 15, label: '15 天' },
          { value: 0, label: '全部' },
        ]}
        className="extra-class"
      />,
    );

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '15 天',
      '全部',
    ]);
    expect(screen.getByRole('button', { name: '15 天' })).toHaveClass('console-chip-active');
    expect(screen.getByRole('button', { name: '15 天' }).parentElement).toHaveClass(
      'extra-class',
    );

    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
