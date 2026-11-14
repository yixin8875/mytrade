import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Gauge, RefreshCw } from 'lucide-react';
import { gateway } from '../gateway/client';
import {
  componentBarWidth,
  componentValue,
  effectiveWeight,
  scoreTone,
  scoreWords,
} from '../lib/score';
import { useApp } from '../store/useApp';
import type { ProcessScore } from '../gateway/types';

const RANGES = [30, 90, 365];

/** 过程评分：7 个分量的透明加权分，没有样本就不给分 */
export function ScoreView() {
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [days, setDays] = useState(90);
  const [data, setData] = useState<ProcessScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await gateway.call<ProcessScore>('score.get', { days });
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load, activeLogin]);

  const weight = data ? effectiveWeight(data.components) : 0;

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">过程评分</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              只评价做得好不好，不预测收益
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 公式与权重写在页面底部
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {RANGES.map((value) => (
                <button
                  key={value}
                  onClick={() => setDays(value)}
                  className={clsx('console-chip', days === value && 'console-chip-active')}
                >
                  {value} 天
                </button>
              ))}
            </div>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="console-btn console-btn-secondary"
            >
              <RefreshCw size={14} strokeWidth={1.5} className={clsx(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
            读取失败：{error}
          </div>
        )}

        <section className="console-card mt-6 flex flex-wrap items-center gap-8 px-6 py-6">
          <ScoreRing score={data?.score ?? null} />
          <div className="min-w-[220px] flex-1">
            <div className={clsx('text-[16px] font-medium', scoreTone(data?.score ?? null))}>
              {scoreWords(data?.score ?? null)}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-console-muted">
              {data?.note ??
                `区间 ${data?.windowStart ?? '—'} 至 ${data?.windowEnd ?? '—'} · ${data?.sample.trades ?? 0} 笔，其中 ${
                  data?.sample.rTrades ?? 0
                } 笔可折算 R`}
            </p>
            <p className="mt-2 text-[11px] text-console-faint">
              样本门槛 20 笔；当前参与权重 {(weight * 100).toFixed(0)}%
              {data ? ` · 公式版本 v${data.version}` : ''}
            </p>
          </div>
          <div className="grid min-w-[200px] grid-cols-2 gap-x-6 gap-y-2 text-[11px] text-console-faint">
            <div>
              <div>交易笔数</div>
              <div className="num mt-0.5 font-mono text-[14px] text-console-ink">
                {data?.sample.trades ?? '—'}
              </div>
            </div>
            <div>
              <div>可折算 R</div>
              <div className="num mt-0.5 font-mono text-[14px] text-console-ink">
                {data?.sample.rTrades ?? '—'}
              </div>
            </div>
            <div>
              <div>统计窗口</div>
              <div className="num mt-0.5 font-mono text-[14px] text-console-ink">
                {data?.sample.days ?? '—'} 天
              </div>
            </div>
            <div>
              <div>公式版本</div>
              <div className="num mt-0.5 font-mono text-[14px] text-console-ink">
                v{data?.version ?? '—'}
              </div>
            </div>
          </div>
        </section>

        <section className="console-card mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-console-line px-5 py-3">
            <h2 className="text-[13px] font-medium">分量明细</h2>
            <span className="text-[11px] text-console-faint">权重按参与分量重新归一化</span>
          </div>
          <div className="divide-y divide-console-line/60">
            {(data?.components ?? []).map((component) => (
              <div key={component.key} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    className={clsx(
                      'w-[80px] shrink-0 text-[13px]',
                      component.included ? 'text-console-ink' : 'text-console-faint',
                    )}
                  >
                    {component.label}
                  </span>
                  <span className="num font-mono text-[12px] text-console-muted">
                    {componentValue(component)}
                  </span>
                  <span className="num ml-auto font-mono text-[12px] text-console-faint">
                    权重 {(component.weight * 100).toFixed(0)}%
                  </span>
                  <span
                    className={clsx(
                      'num w-[46px] text-right font-mono text-[13px]',
                      component.score == null ? 'text-console-faint' : scoreTone(component.score),
                    )}
                  >
                    {component.score == null ? '—' : Math.round(component.score)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-console-line/50">
                    <div
                      className={clsx(
                        'h-full rounded-full',
                        component.score == null
                          ? 'bg-transparent'
                          : component.score >= 75
                            ? 'bg-console-gain'
                            : component.score >= 50
                              ? 'bg-console-accent'
                              : 'bg-console-warn',
                      )}
                      style={{ width: componentBarWidth(component.score) }}
                    />
                  </div>
                  <span className="min-w-[180px] text-[10px] text-console-faint">
                    {component.included ? component.rule : component.reason}
                  </span>
                </div>
              </div>
            ))}
            {!data && (
              <div className="flex h-[160px] items-center justify-center text-[12px] text-console-faint">
                {loading ? '读取中…' : '暂无数据'}
              </div>
            )}
          </div>
        </section>

        <section className="console-card mt-4 px-5 py-4">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <Gauge size={14} strokeWidth={1.6} />
            公式说明
          </div>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-console-muted">
            {(data?.components ?? []).map((component) => (
              <li key={component.key}>
                <span className="text-console-ink">{component.label}</span>：{component.rule}
                （权重 {(component.weight * 100).toFixed(0)}%）
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-console-faint">
            总分 = 各分量得分 × 权重之和 ÷ 参与权重合计；样本不足的分量会被剔除，不用 0 分冒充。
            区间交易少于 20 笔时不给总分。评分只用于检查流程，不写回交易数据，也不影响下单。
          </p>
        </section>
      </div>
    </div>
  );
}

function ScoreRing({ score }: { score: number | null }) {
  const size = 132;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const ratio = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color =
    score == null
      ? 'var(--color-console-line-2)'
      : score >= 75
        ? 'var(--color-console-gain)'
        : score >= 50
          ? 'var(--color-console-accent)'
          : 'var(--color-console-warn)';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-console-line)"
          strokeWidth="8"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx('num font-mono text-[30px] leading-none', scoreTone(score))}>
          {score == null ? '—' : Math.round(score)}
        </span>
        <span className="mt-1 text-[10px] text-console-faint">/ 100</span>
      </div>
    </div>
  );
}
