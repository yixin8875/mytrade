import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Bar as TvBar,
  HistoryMetadata,
  LibrarySymbolInfo,
  PeriodParams,
  ResolutionString,
  Timezone,
} from '../../public/charting_library/charting_library';
import {
  aggregateBars,
  aggregateLast,
  bucketStart,
  REPLAY_RESOLUTIONS,
  ReplayDatafeed,
} from './datafeed';
import { setReplayBars } from './source';
import { useReplay } from './store';
import { makeBar, makeSession } from './testUtils';

const T0 = Date.UTC(2024, 0, 1) / 1000; // 周一 00:00 UTC

const BARS = [
  makeBar(T0, 100, 105, 95, 102, 100),
  makeBar(T0 + 60, 102, 110, 100, 108, 100),
  makeBar(T0 + 120, 108, 112, 104, 106, 100),
  makeBar(T0 + 180, 106, 109, 101, 103, 100),
  makeBar(T0 + 240, 103, 107, 99, 105, 100),
  makeBar(T0 + 300, 105, 115, 103, 112, 100),
];

function resolve(feed: ReplayDatafeed): Promise<LibrarySymbolInfo> {
  return new Promise((done, fail) => feed.resolveSymbol('XAUUSD', done, fail));
}

function history(
  feed: ReplayDatafeed,
  info: LibrarySymbolInfo,
  resolution: string,
  params: Partial<PeriodParams> = {},
): Promise<{ bars: TvBar[]; meta: HistoryMetadata }> {
  return new Promise((done, fail) => {
    feed.getBars(
      info,
      resolution as ResolutionString,
      { from: 0, to: (T0 + 400) * 1000, countBack: 1000, firstDataRequest: true, ...params },
      (bars, meta) => done({ bars, meta: meta ?? { noData: false } }),
      fail,
    );
  });
}

describe('bucketStart', () => {
  it('分钟周期按 UTC 起点取整', () => {
    expect(bucketStart(T0 + 61, '1')).toBe(T0 + 60);
    expect(bucketStart(T0 + 61, '5')).toBe(T0);
    expect(bucketStart(T0 + 899, '15')).toBe(T0);
    expect(bucketStart(T0 + 3600, '60')).toBe(T0 + 3600);
  });

  it('日、周、月按 UTC 日历边界取整', () => {
    expect(bucketStart(T0 + 5 * 3600, '1D')).toBe(T0);
    // 2024-01-03 是周三，周起点回到周一 2024-01-01
    expect(bucketStart(Date.UTC(2024, 0, 3, 12) / 1000, '1W')).toBe(T0);
    expect(bucketStart(Date.UTC(2024, 2, 20, 8) / 1000, '1M')).toBe(
      Date.UTC(2024, 2, 1) / 1000,
    );
  });

  it('未列出的周期按月份处理', () => {
    expect(bucketStart(Date.UTC(2024, 4, 20) / 1000, 'unknown')).toBe(
      Date.UTC(2024, 4, 1) / 1000,
    );
  });
});

describe('aggregateBars', () => {
  it('把 M1 聚合成目标周期的 OHLCV', () => {
    const series = aggregateBars(BARS, '5', BARS.length);
    expect(series).toHaveLength(2);
    expect(series[0]).toEqual({
      time: T0,
      open: 100,
      high: 112,
      low: 95,
      close: 105,
      volume: 500,
    });
    expect(series[1]).toEqual({
      time: T0 + 300,
      open: 105,
      high: 115,
      low: 103,
      close: 112,
      volume: 100,
    });
  });

  it('只聚合游标之前的数据，不泄漏未来', () => {
    const series = aggregateBars(BARS, '5', 3);
    expect(series).toHaveLength(1);
    expect(series[0].close).toBe(106);
    expect(series[0].volume).toBe(300);
  });

  it('游标为 0 或越界时安全返回', () => {
    expect(aggregateBars(BARS, '5', 0)).toEqual([]);
    expect(aggregateBars(BARS, '5', -5)).toEqual([]);
    expect(aggregateBars(BARS, '5', 999)).toHaveLength(2);
  });
});

describe('aggregateLast', () => {
  it('只算最后一根所在周期', () => {
    expect(aggregateLast(BARS, '5', BARS.length)).toEqual({
      time: T0 + 300,
      open: 105,
      high: 115,
      low: 103,
      close: 112,
      volume: 100,
    });
    expect(aggregateLast(BARS, '5', 3)?.close).toBe(106);
  });

  it('没有数据时返回 null', () => {
    expect(aggregateLast(BARS, '5', 0)).toBeNull();
    expect(aggregateLast([], '5', 1)).toBeNull();
  });
});

describe('ReplayDatafeed', () => {
  beforeEach(() => {
    const session = makeSession({
      cursorIndex: 3,
      totalBars: 6,
      startTs: T0,
      endTs: T0 + 300,
      fetchStartTs: T0 - 600,
      cursorTs: T0 + 120,
    });
    setReplayBars(session.id, BARS);
    useReplay.setState({ sessions: [session], activeId: session.id });
  });

  it('解析出图表需要的品种信息', async () => {
    const feed = new ReplayDatafeed(useReplay.getState().activeId!);
    const info = await resolve(feed);

    expect(info.name).toBe('XAUUSD');
    expect(info.pricescale).toBe(100);
    expect(info.timezone).toBe<Timezone>('Etc/UTC');
    expect(info.supported_resolutions).toEqual(REPLAY_RESOLUTIONS);
    expect(info.has_weekly_and_monthly).toBe(true);
  });

  it('getBars 只返回游标之前已经揭示的 K 线', async () => {
    const feed = new ReplayDatafeed(useReplay.getState().activeId!);
    const info = await resolve(feed);
    const { bars, meta } = await history(feed, info, '1');

    expect(meta.noData).toBe(false);
    expect(bars.map((bar) => bar.time)).toEqual([
      T0 * 1000,
      (T0 + 60) * 1000,
      (T0 + 120) * 1000,
    ]);
  });

  it('请求的 to 早于游标时按 to 截断', async () => {
    const feed = new ReplayDatafeed(useReplay.getState().activeId!);
    const info = await resolve(feed);
    const { bars } = await history(feed, info, '1', { to: (T0 + 60) * 1000 });

    expect(bars.map((bar) => bar.time)).toEqual([T0 * 1000, (T0 + 60) * 1000]);
  });

  it('countBack 只取尾部一小段，给左侧留出翻页空间', async () => {
    const session = useReplay.getState().sessions[0];
    session.cursorIndex = 6;
    setReplayBars(session.id, BARS);
    useReplay.setState({ sessions: [{ ...session }] });

    const feed = new ReplayDatafeed(session.id);
    const info = await resolve(feed);
    const { bars } = await history(feed, info, '1', { countBack: 2 });

    expect(bars).toHaveLength(4);
    expect(bars.at(-1)?.time).toBe((T0 + 300) * 1000);
  });

  it('游标在第 0 根时没有数据', async () => {
    const session = useReplay.getState().sessions[0];
    session.cursorIndex = 0;
    useReplay.setState({ sessions: [{ ...session }] });

    const feed = new ReplayDatafeed(session.id);
    const info = await resolve(feed);
    const { bars, meta } = await history(feed, info, '1');

    expect(bars).toEqual([]);
    expect(meta.noData).toBe(true);
  });

  it('会话不存在时回调错误', async () => {
    const feed = new ReplayDatafeed('missing');
    await expect(
      new Promise((done, fail) => feed.resolveSymbol('XAUUSD', done, fail)),
    ).rejects.toBe('回放会话不存在');
  });
});
