import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

export interface PageTab<T extends string> {
  key: T;
  label: string;
  hint?: string;
}

/** 容器页顶部页签条：记录 / 分析 / 纪律三页共用 */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly PageTab<T>[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex h-12 shrink-0 items-center gap-1 border-b border-console-line bg-console-canvas px-6"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          title={tab.hint}
          className={clsx('console-chip', value === tab.key && 'console-chip-active')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 页签懒挂载：第一次打开才渲染，之后保持挂载（hidden），
 * 这样切换页签不会把筛选、选中日期和滚动位置重置掉。
 */
export function useVisited<T extends string>(key: T): T[] {
  const [seen, setSeen] = useState<T[]>([key]);
  useEffect(() => {
    setSeen((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, [key]);
  return seen;
}
