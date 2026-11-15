import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';
import { useApp } from '../store/useApp';
import { StudyTemplates, type StudyTemplate } from './StudyTemplates';

const MAIN_KEY = 'mytrade.studyTemplates:main';
const SLOT_KEY = 'mytrade.studyTemplates:c1';
const LEGACY_KEY = 'mytrade.studyTemplates';

function makeChart() {
  const createStudyTemplate = vi.fn(() => ({
    studies: [{ name: 'MA' }, { name: 'Volume' }],
  }));
  const applyStudyTemplate = vi.fn();
  const chart = {
    getAllStudies: () => [{ name: 'MA' }, { name: 'Volume' }],
    createStudyTemplate,
    applyStudyTemplate,
  } as unknown as IChartWidgetApi;
  return { chart, createStudyTemplate, applyStudyTemplate };
}

function template(name: string, savedAt = 1): StudyTemplate {
  return { name, content: { studies: [name] }, savedAt };
}

function readMap(key: string): Record<string, StudyTemplate> {
  return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, StudyTemplate>;
}

async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: '指标模板' }));
}

afterEach(() => {
  window.localStorage.clear();
});

describe('StudyTemplates', () => {
  it('保存模板写入主图槽位并在列表中出现', async () => {
    const { chart, createStudyTemplate } = makeChart();
    render(<StudyTemplates chart={chart} />);
    await openPanel();

    await userEvent.type(screen.getByPlaceholderText('模板名，如「趋势组合」'), '趋势');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(createStudyTemplate).toHaveBeenCalledWith({ saveSymbol: false, saveInterval: false });
    const map = readMap(MAIN_KEY);
    expect(Object.keys(map)).toEqual(['趋势']);
    expect(map['趋势']).toMatchObject({ name: '趋势', savedAt: expect.any(Number) });
    expect(map['趋势'].content).toEqual({ studies: [{ name: 'MA' }, { name: 'Volume' }] });
    expect(screen.getByText('趋势')).toBeInTheDocument();
  });

  it('旧版全局键迁移到主图槽位，旧键保留', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify({ 旧组合: template('旧组合') }));

    const { chart } = makeChart();
    render(<StudyTemplates chart={chart} />);
    await openPanel();

    expect(screen.getByText('旧组合')).toBeInTheDocument();
    expect(readMap(MAIN_KEY)['旧组合']).toMatchObject({ name: '旧组合' });
    expect(window.localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('子槽位没有自己的数据时读取主图模板，保存后写入自己的键', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify({ 主图: template('主图') }));

    const { chart } = makeChart();
    render(<StudyTemplates chart={chart} slot="c1" />);
    await openPanel();

    expect(screen.getByText('主图')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('模板名，如「趋势组合」'), '备用');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(Object.keys(readMap(SLOT_KEY)).sort()).toEqual(['主图', '备用']);
    expect(Object.keys(readMap(MAIN_KEY))).toEqual(['主图']);
  });

  it('删除需要两次点击：第一次不删，第二次才移除并提示', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify({ 旧模板: template('旧模板') }));

    const { chart } = makeChart();
    const notify = vi.spyOn(useApp.getState(), 'notify');
    render(<StudyTemplates chart={chart} />);
    await openPanel();

    await userEvent.click(screen.getByTitle('删除模板（需再点一次确认）'));
    expect(screen.getByText('旧模板')).toBeInTheDocument();
    expect(readMap(MAIN_KEY)['旧模板']).toBeDefined();
    expect(screen.getByTitle('再点一次删除')).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('再点一次删除'));
    expect(screen.queryByText('旧模板')).not.toBeInTheDocument();
    expect(readMap(MAIN_KEY)['旧模板']).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('success', '已删除模板「旧模板」');
  });

  it('点击模板条目套用并提示成功', async () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify({ 趋势: template('趋势') }));

    const { chart, applyStudyTemplate } = makeChart();
    const notify = vi.spyOn(useApp.getState(), 'notify');
    render(<StudyTemplates chart={chart} />);
    await openPanel();

    await userEvent.click(screen.getByTitle('把这个指标组合套到当前图表'));

    expect(applyStudyTemplate).toHaveBeenCalledWith({ studies: ['趋势'] });
    expect(notify).toHaveBeenCalledWith('success', '已套用指标模板「趋势」');
  });
});
