import { beforeEach, describe, expect, it } from 'vitest';
import { customIndicators } from './studies';

interface StudyMetainfo {
  name: string;
  plots: { id: string }[];
  styles?: Record<string, { title?: string }>;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('customIndicators', () => {
  it('declares a styles title for every plot so settings can open', async () => {
    // 构造函数不会执行，PineJS 传空对象即可
    const indicators = await customIndicators({} as never, 'ctx');
    expect(indicators.length).toBeGreaterThan(0);

    for (const indicator of indicators) {
      const metainfo = indicator.metainfo as unknown as StudyMetainfo;
      // 图表库样式页读 metaInfo.styles[plotId].title，缺失会抛 Value is undefined
      expect(metainfo.styles, metainfo.name).toBeTruthy();
      for (const plot of metainfo.plots) {
        expect(metainfo.styles?.[plot.id]?.title, `${metainfo.name}/${plot.id}`).toBeTruthy();
      }
    }
  });
});
