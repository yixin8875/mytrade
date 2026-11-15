import { clsx } from 'clsx';
import { PageTabs, useVisited } from '../components/PageTabs';
import { useApp } from '../store/useApp';
import { MissedView } from './Missed';
import { RoutinesView } from './Routines';
import { StrategyView } from './Strategy';

const TABS = [
  { key: 'strategy', label: '策略手册', hint: '交易规则与清单' },
  { key: 'routines', label: '例行清单', hint: '盘前 / 盘中 / 盘后流程' },
  { key: 'missed', label: '错过机会', hint: '看得到但没做的行情' },
] as const;

/** 纪律：策略、例行与错过机会共用一个页面；例行仍是每日流程，不参与开仓门禁判定 */
export function DisciplineView() {
  const tab = useApp((s) => s.disciplineTab);
  const setTab = useApp((s) => s.setDisciplineTab);
  const seen = useVisited(tab);

  return (
    <div className="console-scope flex h-full min-h-0 flex-col bg-console-canvas">
      <PageTabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="relative min-h-0 flex-1">
        {seen.includes('strategy') && (
          <div className={clsx('absolute inset-0', tab !== 'strategy' && 'hidden')}>
            <StrategyView />
          </div>
        )}
        {seen.includes('routines') && (
          <div className={clsx('absolute inset-0', tab !== 'routines' && 'hidden')}>
            <RoutinesView />
          </div>
        )}
        {seen.includes('missed') && (
          <div className={clsx('absolute inset-0', tab !== 'missed' && 'hidden')}>
            <MissedView />
          </div>
        )}
      </div>
    </div>
  );
}
