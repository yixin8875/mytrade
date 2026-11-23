import { cn } from '@/lib/utils';
import { SegmentedControl, SegmentedControlItem } from './ui/segmented-control';

/** 区间天数的统一选项；0 = 全部历史，与 journal.stats 的 days<=0 语义一致 */
export const RANGE_OPTIONS = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 365, label: '1 年' },
  { value: 0, label: '全部' },
] as const;

export type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

/** 日志 / 报表 / 趋势共用的区间切换，避免每个页面维护一套按钮样式 */
export function RangeChips({
  value,
  onChange,
  options = RANGE_OPTIONS,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  options?: readonly { value: number; label: string }[];
  className?: string;
}) {
  return (
    <SegmentedControl size="sm" className={cn('w-fit', className)}>
      {options.map((item) => (
        <SegmentedControlItem
          key={item.value}
          onClick={() => onChange(item.value)}
          aria-pressed={value === item.value}
          className="text-[12px]"
        >
          {item.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
