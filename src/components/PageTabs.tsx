import { useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTab } from './ui/tabs';

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
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next as T);
      }}
      className="shrink-0 gap-0 border-b border-border bg-sidebar px-6"
    >
      <TabsList variant="underline" className="h-12 gap-1">
        {tabs.map((tab) => (
          <TabsTab key={tab.key} value={tab.key} title={tab.hint} className="h-10 px-3">
            {tab.label}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
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
