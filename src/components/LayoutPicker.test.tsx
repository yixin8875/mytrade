import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LayoutGallery } from './LayoutPicker';

const COMMON_LABELS = [
  '1 图 单图',
  '2 图 上下两图',
  '2 图 左右两图',
  '4 图 2×2',
  '6 图 3×2',
  '6 图 六列',
];

describe('LayoutGallery', () => {
  it('默认只列出 6 个常用布局', () => {
    render(<LayoutGallery value="1" onChange={() => {}} />);

    for (const label of COMMON_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 6 个常用布局 +「更多布局」
    expect(screen.getAllByRole('button')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: '3 图 三列' })).not.toBeInTheDocument();
  });

  it('展开更多布局后显示其余布局，按钮文案切换，再点可收起', async () => {
    render(<LayoutGallery value="1" onChange={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: '更多布局' }));
    expect(screen.getByRole('button', { name: '3 图 三列' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '6 图 六行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起更多布局' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起更多布局' }));
    expect(screen.queryByRole('button', { name: '3 图 三列' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多布局' })).toBeInTheDocument();
  });

  it('点击布局把 id 交给 onChange', async () => {
    const onChange = vi.fn();
    render(<LayoutGallery value="1" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: '2 图 上下两图' }));

    expect(onChange).toHaveBeenCalledWith('2v');
  });

  it('当前布局的按钮 aria-pressed 为 true，其他为 false', () => {
    render(<LayoutGallery value="2h" onChange={() => {}} />);

    expect(screen.getByRole('button', { name: '2 图 左右两图' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '1 图 单图' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
