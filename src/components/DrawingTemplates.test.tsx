import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';
import { useApp } from '../store/useApp';
import { DrawingTemplates, type DrawTemplate } from './DrawingTemplates';

const MAIN_KEY = 'mytrade.drawTemplates:main';
const LEGACY_KEY = 'mytrade.drawTemplates';

type StoredTemplates = Record<string, Record<string, DrawTemplate>>;

function makeChart(options: { selected?: boolean } = {}) {
  const selected = options.selected ?? true;
  const setProperties = vi.fn();
  const removeEntity = vi.fn();
  const createMultipointShape = vi.fn(() => Promise.resolve('tmp'));
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const shape = {
    getProperties: () => ({ color: '#f00', linewidth: 2, text: 'hi' }),
    getPoints: () => [
      { time: 1, price: 2 },
      { time: 3, price: 4 },
    ],
    setProperties,
  };
  const defaultShape = {
    getProperties: () => ({ color: '#0f0', linewidth: 1, text: 'default' }),
  };
  const chart = {
    getAllShapes: () => (selected ? [{ id: 's1', name: 'trend_line' }] : []),
    getShapeById: (id: string) => (id === 's1' ? shape : id === 'tmp' ? defaultShape : null),
    createMultipointShape,
    removeEntity,
    selection: () => ({
      allItems: () => (selected ? ['s1'] : []),
      onChanged: () => ({ subscribe, unsubscribe }),
    }),
  } as unknown as IChartWidgetApi;
  return {
    chart,
    setProperties,
    removeEntity,
    createMultipointShape,
    subscribe,
    unsubscribe,
  };
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

/** 面板入口在图表工具栏里，测试直接以展开状态渲染 */
function renderPanel(chart: IChartWidgetApi, slot?: string) {
  return render(
    <DrawingTemplates chart={chart} slot={slot} open onClose={() => {}} />,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('DrawingTemplates', () => {
  it('从「保存模板为…」进入命名视图，保存时去掉 text 并写入主图槽位', async () => {
    const { chart } = makeChart();
    renderPanel(chart);

    await userEvent.click(screen.getByRole('menuitem', { name: '保存模板为…' }));
    await userEvent.type(screen.getByPlaceholderText('模板名称'), '红色');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    const map = readMap(MAIN_KEY);
    expect(map.trend_line['红色']).toMatchObject({
      name: '红色',
      type: 'trend_line',
      savedAt: expect.any(Number),
    });
    expect(map.trend_line['红色'].props).toEqual({ color: '#f00', linewidth: 2 });
    expect(map.trend_line['红色'].props).not.toHaveProperty('text');
    expect(screen.getByRole('menuitem', { name: '红色' })).toBeInTheDocument();
  });

  it('套用模板把属性写回选中画线，第二参跟随默认样式开关', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored()));

    const { chart, setProperties } = makeChart();
    renderPanel(chart);

    await userEvent.click(screen.getByTitle('应用到当前选中的画线'));
    expect(setProperties).toHaveBeenLastCalledWith({ color: '#f00', linewidth: 2 }, true);

    await userEvent.click(
      screen.getByRole('checkbox', { name: '应用时也设为该类型画线的默认样式' }),
    );
    await userEvent.click(screen.getByTitle('应用到当前选中的画线'));
    expect(setProperties).toHaveBeenLastCalledWith({ color: '#f00', linewidth: 2 }, false);
  });

  it('应用默认模板：临时建一条同类画线读出默认属性后删除，再套到选中画线', async () => {
    const { chart, setProperties, createMultipointShape, removeEntity } = makeChart();
    const notify = vi.spyOn(useApp.getState(), 'notify');
    renderPanel(chart);

    await userEvent.click(screen.getByRole('menuitem', { name: '应用默认模板' }));

    await waitFor(() => {
      expect(setProperties).toHaveBeenCalledWith({ color: '#0f0', linewidth: 1 }, true);
    });
    expect(createMultipointShape).toHaveBeenCalledWith(
      [
        { time: 1, price: 2 },
        { time: 3, price: 4 },
      ],
      expect.objectContaining({ shape: 'trend_line', disableSave: true, disableUndo: true }),
    );
    expect(removeEntity).toHaveBeenCalledWith('tmp', { disableUndo: true });
    expect(notify).toHaveBeenCalledWith('success', '已恢复 1 条画线的默认样式，并设为默认样式');
  });

  it('没有选中画线时，保存与恢复默认都不可点', () => {
    const { chart } = makeChart({ selected: false });
    renderPanel(chart);

    expect(screen.getByRole('menuitem', { name: '保存模板为…' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '应用默认模板' })).toBeDisabled();
    expect(screen.getByText('在图上选择一条画线后，可保存或恢复默认样式')).toBeInTheDocument();
  });

  it('删除需要两次点击：第一次不删，第二次才移除并提示', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored()));

    const { chart } = makeChart();
    const notify = vi.spyOn(useApp.getState(), 'notify');
    renderPanel(chart);

    await userEvent.click(screen.getByTitle('删除模板（需再点一次确认）'));
    expect(screen.getByRole('menuitem', { name: '红色' })).toBeInTheDocument();
    expect(readMap(MAIN_KEY).trend_line['红色']).toBeDefined();
    expect(screen.getByTitle('再点一次删除')).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('再点一次删除'));
    expect(screen.queryByRole('menuitem', { name: '红色' })).not.toBeInTheDocument();
    expect(readMap(MAIN_KEY).trend_line).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('success', '已删除模板「红色」');
  });

  it('子槽位没有数据时回退读取主图模板', () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(stored('主图模板')));

    const { chart } = makeChart();
    renderPanel(chart, 'c1');

    expect(screen.getByRole('menuitem', { name: '主图模板' })).toBeInTheDocument();
  });

  it('Esc 关闭菜单；保存视图里的 Esc 先退回模板列表', async () => {
    const { chart } = makeChart();
    const onClose = vi.fn();
    render(<DrawingTemplates chart={chart} open onClose={onClose} />);

    await userEvent.click(screen.getByRole('menuitem', { name: '保存模板为…' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: '应用默认模板' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
