import { beforeEach, describe, expect, it } from 'vitest';
import { clearReplayBack, getReplayBack, setReplayBack } from './back';

describe('回放返回路径', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('记住来源页与持仓号，刷新后还能读到', () => {
    setReplayBack({ page: 'journal', positionId: 42, label: '交易日志' });

    expect(getReplayBack()).toEqual({ page: 'journal', positionId: 42, label: '交易日志' });
  });

  it('没有持仓号时也能返回页面级入口', () => {
    setReplayBack({ page: 'missed', label: '错过的机会' });

    const back = getReplayBack();
    expect(back?.page).toBe('missed');
    expect(back?.label).toBe('错过的机会');
    expect(back?.positionId).toBeUndefined();
  });

  it('数据不完整时当作没有返回入口', () => {
    window.sessionStorage.setItem('mytrade.replay.back', '{"page":"journal"}');
    expect(getReplayBack()).toBeNull();

    window.sessionStorage.setItem('mytrade.replay.back', '不是 JSON');
    expect(getReplayBack()).toBeNull();
  });

  it('清除后不再返回旧入口', () => {
    setReplayBack({ page: 'overview', label: '概览' });
    clearReplayBack();
    expect(getReplayBack()).toBeNull();
  });
});
