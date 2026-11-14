import { describe, expect, it } from 'vitest';
import { parseReplayRoute, routeSessionId } from './route';

describe('parseReplayRoute', () => {
  it('空 hash 与回放根路径都落到列表', () => {
    expect(parseReplayRoute('')).toEqual({ kind: 'list' });
    expect(parseReplayRoute('#/replay')).toEqual({ kind: 'list' });
    expect(parseReplayRoute('#/replay/')).toEqual({ kind: 'list' });
  });

  it('其他页面不归回放路由管', () => {
    expect(parseReplayRoute('#/trade')).toEqual({ kind: 'list' });
  });

  it('解析会话与报告', () => {
    expect(parseReplayRoute('#/replay/abc')).toEqual({ kind: 'session', id: 'abc' });
    expect(parseReplayRoute('#/replay/abc/report')).toEqual({ kind: 'report', id: 'abc' });
  });

  it('路径多一段时仍按会话处理', () => {
    expect(parseReplayRoute('#/replay/abc/extra')).toEqual({ kind: 'session', id: 'abc' });
  });
});

describe('routeSessionId', () => {
  it('只在该会话路由里返回 id', () => {
    expect(routeSessionId({ kind: 'list' })).toBeNull();
    expect(routeSessionId({ kind: 'session', id: 'abc' })).toBe('abc');
    expect(routeSessionId({ kind: 'report', id: 'abc' })).toBe('abc');
  });
});
