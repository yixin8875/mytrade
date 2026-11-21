import { clsx } from 'clsx';
import { PageTabs, useVisited } from '../components/PageTabs';
import { useApp } from '../store/useApp';
import { ReportsTab } from './Reports';
import { ReviewView } from './ReviewView';

const TABS = [
  { key: 'reports', label: '报表', hint: '统计报表与执行质量' },
  { key: 'review', label: '复盘', hint: '绩效趋势与深度分析' },
] as const;

/** 分析：报表（钱 / 成本）与复盘（过程）两个页签 */
export function InsightsView() {
  const tab = useApp((s) => s.insightsTab);
  const setTab = useApp((s) => s.setInsightsTab);
  const seen = useVisited(tab);

  return (
    <div className="console-scope flex h-full min-h-0 flex-col bg-console-canvas">
      <PageTabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="relative min-h-0 flex-1">
        {seen.includes('reports') && (
          <div className={clsx('absolute inset-0', tab !== 'reports' && 'hidden')}>
            <ReportsTab />
          </div>
        )}
        {seen.includes('review') && (
          <div className={clsx('absolute inset-0', tab !== 'review' && 'hidden')}>
            <ReviewView />
          </div>
        )}
      </div>
    </div>
  );
}
