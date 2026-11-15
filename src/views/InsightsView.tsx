import { clsx } from 'clsx';
import { PageTabs, useVisited } from '../components/PageTabs';
import { useApp } from '../store/useApp';
import { AnalysisView } from './Analysis';
import { ExecutionsView } from './Executions';
import { ReportsView } from './Reports';
import { TrendsView } from './Trends';

const TABS = [
  { key: 'reports', label: '统计报表', hint: '区间汇总、曲线与分组表现' },
  { key: 'trends', label: '绩效趋势', hint: '按日、按周看稳定性' },
  { key: 'deep', label: '深度分析', hint: '多维筛选与交叉矩阵' },
  { key: 'executions', label: '执行质量', hint: '点差、滑点与延迟' },
] as const;

/** 分析：报表、趋势、深度分析与执行质量共用一个页面 */
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
            <ReportsView />
          </div>
        )}
        {seen.includes('trends') && (
          <div className={clsx('absolute inset-0', tab !== 'trends' && 'hidden')}>
            <TrendsView />
          </div>
        )}
        {seen.includes('deep') && (
          <div className={clsx('absolute inset-0', tab !== 'deep' && 'hidden')}>
            <AnalysisView />
          </div>
        )}
        {seen.includes('executions') && (
          <div className={clsx('absolute inset-0', tab !== 'executions' && 'hidden')}>
            <ExecutionsView />
          </div>
        )}
      </div>
    </div>
  );
}
