import { describe, expect, it } from 'vitest';
import { GATEWAY_RESOLUTIONS, resolutionLabel, SUPPORTED_RESOLUTIONS } from './resolutions';

describe('SUPPORTED_RESOLUTIONS', () => {
  it('包含原生菜单里的分 / 小时 / 天 / 周 / 月常用周期', () => {
    for (const value of ['1', '2', '3', '5', '10', '15', '30', '45', '60', '120', '240', '1D', '1W', '1M', '12M']) {
      expect(SUPPORTED_RESOLUTIONS).toContain(value);
    }
  });

  it('依次递增，且覆盖网关能直接提供的全部周期', () => {
    const weight = (value: string) => {
      const unit = value.slice(-1);
      const amount = Number(value.slice(0, -1));
      if (unit === 'D') return amount * 1440;
      if (unit === 'W') return amount * 10080;
      if (unit === 'M') return amount * 43200;
      return Number(value);
    };
    const weights = SUPPORTED_RESOLUTIONS.map(weight);
    expect([...weights].sort((a, b) => a - b)).toEqual(weights);
    for (const value of GATEWAY_RESOLUTIONS) expect(SUPPORTED_RESOLUTIONS).toContain(value);
  });
});

describe('resolutionLabel', () => {
  it('分钟、小时、天 / 周 / 月分别显示短标签', () => {
    expect(resolutionLabel('1')).toBe('1m');
    expect(resolutionLabel('45')).toBe('45m');
    expect(resolutionLabel('60')).toBe('1h');
    expect(resolutionLabel('120')).toBe('2h');
    expect(resolutionLabel('240')).toBe('4h');
    expect(resolutionLabel('1D')).toBe('1D');
    expect(resolutionLabel('2W')).toBe('2W');
    expect(resolutionLabel('12M')).toBe('12M');
  });

  it('自定义周期和空值不会抛错', () => {
    expect(resolutionLabel('7')).toBe('7m');
    expect(resolutionLabel('205')).toBe('205m');
    expect(resolutionLabel('15S')).toBe('15秒');
    expect(resolutionLabel('')).toBe('');
  });
});
