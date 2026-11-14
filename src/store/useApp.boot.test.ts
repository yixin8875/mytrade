import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCENT } from '../lib/accent';

/**
 * 这个文件不静态 import useApp：store 在模块求值时就读 localStorage，
 * 要复现「启动时读到坏数据」，必须先把数据放好再动态加载一份新的模块实例。
 */
async function boot() {
  const { useApp } = await import('./useApp');
  return useApp.getState();
}

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe('useApp 启动读取 localStorage', () => {
  it('存成 null 的键不会让应用启动崩溃', async () => {
    window.localStorage.setItem('mytrade.templates', 'null');
    window.localStorage.setItem('mytrade.layoutSync', 'null');
    window.localStorage.setItem('mytrade.alertPrefs', 'null');
    window.localStorage.setItem('mytrade.risk', 'null');
    window.localStorage.setItem('mytrade.layout', 'null');
    window.localStorage.setItem('mytrade.theme', 'null');
    window.localStorage.setItem('mytrade.accent', 'null');
    window.localStorage.setItem('mytrade.watchlist', 'null');
    window.localStorage.setItem('mytrade.resolution', 'null');

    const state = await boot();

    expect(state.templates).toHaveLength(1);
    expect(state.templates[0].name).toBe('默认模板');
    expect(state.activeTemplateId).toBe(state.templates[0].id);
    expect(state.layoutSync).toEqual({
      symbol: false,
      interval: false,
      crosshair: true,
      time: false,
      dateRange: false,
    });
    expect(state.alertSound).toBe(true);
    expect(state.alertDesktop).toBe(false);
    expect(state.layout).toBe('1');
    expect(state.theme).toBe('light');
    expect(state.accentColor).toBe(DEFAULT_ACCENT);
    expect(state.watchlist).toEqual([]);
    expect(state.resolution).toBe('5');
    expect(state.risk).toEqual({ mode: 'percent', value: 1, auto: true });
  });

  it('旧版单模板会迁移成带阶段的模板', async () => {
    window.localStorage.setItem(
      'mytrade.template',
      JSON.stringify({ riskPercent: 1, rewardR: 3, breakevenR: 1.5 }),
    );

    const state = await boot();
    const template = state.templates[0];

    expect(template.id).toBe('default');
    expect(template.riskPercent).toBe(1);
    expect(template.rewardR).toBe(3);
    expect(template.steps).toEqual([{ atR: 1.5, closePercent: null, moveBreakeven: true }]);
    expect(state.activeTemplateId).toBe('default');
  });

  it('模板列表和启用项按存档恢复', async () => {
    window.localStorage.setItem(
      'mytrade.templates',
      JSON.stringify({
        activeId: 'b',
        list: [
          { id: 'a', name: 'A', riskPercent: 1, rewardR: 2, steps: [] },
          {
            id: 'b',
            name: 'B',
            riskPercent: 2,
            rewardR: 3,
            steps: [{ atR: 2, closePercent: 50, moveBreakeven: true }],
          },
        ],
      }),
    );

    const state = await boot();

    expect(state.templates.map((template) => template.name)).toEqual(['A', 'B']);
    expect(state.activeTemplateId).toBe('b');
    expect(state.templates[1].steps).toEqual([
      { atR: 2, closePercent: 50, moveBreakeven: true },
    ]);
  });

  it('启用的模板不存在时回到第一条', async () => {
    window.localStorage.setItem(
      'mytrade.templates',
      JSON.stringify({
        activeId: 'gone',
        list: [{ id: 'a', name: 'A', riskPercent: 1, rewardR: 2, steps: [] }],
      }),
    );

    const state = await boot();
    expect(state.activeTemplateId).toBe('a');
  });

  it('主题、强调色、布局与提醒偏好按存档恢复', async () => {
    window.localStorage.setItem('mytrade.theme', '"white"');
    window.localStorage.setItem('mytrade.accent', '"#ABC"');
    window.localStorage.setItem('mytrade.layout', '"quad"');
    window.localStorage.setItem('mytrade.resolution', '"15"');
    window.localStorage.setItem(
      'mytrade.layoutSync',
      JSON.stringify({ crosshair: false, symbol: true }),
    );
    window.localStorage.setItem(
      'mytrade.alertPrefs',
      JSON.stringify({ sound: false, desktop: true }),
    );
    window.localStorage.setItem('mytrade.watchlist', JSON.stringify(['XAUUSD', 'EURUSD', 42]));

    const state = await boot();

    expect(state.theme).toBe('white');
    expect(state.accentColor).toBe('#aabbcc');
    expect(state.layout).toBe('4');
    expect(state.resolution).toBe('15');
    expect(state.layoutSync.symbol).toBe(true);
    expect(state.layoutSync.crosshair).toBe(false);
    expect(state.alertSound).toBe(false);
    expect(state.alertDesktop).toBe(true);
    expect(state.watchlist).toEqual(['XAUUSD', 'EURUSD']);
  });
});
