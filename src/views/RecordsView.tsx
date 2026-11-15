import { clsx } from 'clsx';
import { PageTabs, useVisited } from '../components/PageTabs';
import { useApp } from '../store/useApp';
import { DiaryView } from './Diary';
import { JournalView } from './Journal';

const TABS = [
  { key: 'list', label: '交易列表', hint: '已平仓记录、筛选与复盘入口' },
  { key: 'calendar', label: '盈亏日历', hint: '按天看盈亏、写笔记与导出卡片' },
] as const;

/** 记录：交易日志与盈亏日历合并成一个页面的两个页签 */
export function RecordsView() {
  const tab = useApp((s) => s.recordsTab);
  const setTab = useApp((s) => s.setRecordsTab);
  const seen = useVisited(tab);

  return (
    <div className="console-scope flex h-full min-h-0 flex-col bg-console-canvas">
      <PageTabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="relative min-h-0 flex-1">
        {seen.includes('list') && (
          <div className={clsx('absolute inset-0', tab !== 'list' && 'hidden')}>
            <JournalView />
          </div>
        )}
        {seen.includes('calendar') && (
          <div className={clsx('absolute inset-0', tab !== 'calendar' && 'hidden')}>
            <DiaryView />
          </div>
        )}
      </div>
    </div>
  );
}
