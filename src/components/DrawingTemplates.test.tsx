import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';
import { useApp } from '../store/useApp';
import { DrawingTemplates, type DrawTemplate } from './DrawingTemplates';

const MAIN_KEY = 'mytrade.drawTemplates:main';
const LEGACY_KEY = 'mytrade.drawTemplates';

type StoredTemplates = Record<string, Record<string, DrawTemplate>>;

function makeChart() {
  const setProperties = vi.fn();
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const shape = {
    getProperties: () => ({ color: '#f00', linewidth: 2, text: 'hi' }),
    setProperties,
  };
  const chart = {
    getAllShapes: () => [{ id: 's1', name: 'trend_line' }],
    getShapeById: (id: string) => (id === 's1' ? shape : null),
    selection: () => ({
      allItems: () => ['s1'],
      onChanged: () => ({ subscribe, unsubscribe }),
    }),
  } as unknown as IChartWidgetApi;
  return { chart, setProperties, subscribe, unsubscribe };
}

function drawTemplate(name: string, savedAt = 1): DrawTemplate {
  return { name, type: 'trend_line', props: { color: '#f00', linewidth: 2 }, savedAt };
}

function stored(name = '红色'): StoredTemplates {
  return { trend_line: { [name]: drawTemplate(name) } };
}

function readMap(key: string): StoredTemplates {
  return JSON.parse(window.localStorage.getItem(key) ?? '{}') as StoredTemplates;
}

async function openPanel() {
  await userEvent.click(screen.getByTitle(/拖动/));
}

// jsdom 没有实现 Pointer Capture：userEvent 点击可拖动按钮会先触发 pointerdown，
// 这里补上两个空实现，避免拖拽入口在测试里抛异常。
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
});

afterEach(() => {
  window.localStorage.clear();
});

describe('DrawingTemplates', () => {
  it('选中画线后保存模板，去掉 text 并写入主图槽位', async () => {
    const { chart } = makeChart();
    render(<DrawingTemplates chart={chart} />);
    await openPanel();

    expect(screen.getByText('已选中：趋势线')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('模板名，如「红色粗线」'), '红色');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    const map = readMap(MAIN_KEY);
    expect(map.trend_line['红色']).toMatchObject({
      name: '红色',
      type: 'trend_line',
      savedAt: expect.any(Number),
    });
    expect(map.trend_line['红色'].props).toEqual({ color: '#f00', linewidth: 2 });
    expect(map.trend_line['红色'].props).not.toHaveProperty('text');
    expect(screen.getByText('红色')).toBeInTheDocument();
  });

  it('套用模板把属性写回选中画线，第二参跟随默认样式开关', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored()));

    const { chart, setProperties } = makeChart();
    render(<DrawingTemplates chart={chart} />);
    await openPanel();

    await userEvent.click(screen.getByTitle('应用到当前选中的画线'));
    expect(setProperties).toHaveBeenLastCalledWith({ color: '#f00', linewidth: 2 }, true);

    await userEvent.click(
      screen.getByRole('checkbox', { name: '应用时也设为该类型画线的默认样式' }),
    );
    await userEvent.click(screen.getByTitle('应用到当前选中的画线'));
    expect(setProperties).toHaveBeenLastCalledWith({ color: '#f00', linewidth: 2 }, false);
  });

  it('删除需要两次点击：第一次不删，第二次才移除并提示', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored()));

    const { chart } = makeChart();
    const notify = vi.spyOn(useApp.getState(), 'notify');
    render(<DrawingTemplates chart={chart} />);
    await openPanel();

    await userEvent.click(screen.getByTitle('删除模板（需再点一次确认）'));
    expect(screen.getByText('红色')).toBeInTheDocument();
    expect(readMap(MAIN_KEY).trend_line['红色']).toBeDefined();
    expect(screen.getByTitle('再点一次删除')).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('再点一次删除'));
    expect(screen.queryByText('红色')).not.toBeInTheDocument();
    expect(readMap(MAIN_KEY).trend_line).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('success', '已删除模板「红色」');
  });

  it('子槽位没有数据时回退读取主图模板', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored('主图模板')));

    const { chart } = makeChart();
    render(<DrawingTemplates chart={chart} slot="c1" />);
    await openPanel();

    expect(screen.getByText('主图模板')).toBeInTheDocument();
  });

  it('提供可拖动按钮，点击可开合模板面板', async () => {
    const { chart } = makeChart();
    render(<DrawingTemplates chart={chart} />);

    const trigger = screen.getByTitle(/拖动/);
    expect(trigger.getAttribute('title')).toContain('拖动');

    await userEvent.click(trigger);
    expect(screen.getByTitle('关闭')).toBeInTheDocument();
  });
});
