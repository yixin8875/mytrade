/**
 * MT5 的时间戳是券商服务器时钟，不是 UTC。
 * 展示给用户时统一先减去 `serverOffset`（服务器时间 - UTC，秒），再按本机时区格式化。
 */

export function toUtcSeconds(raw: number, serverOffset: number): number {
  if (!Number.isFinite(raw)) return 0;
  return raw - (Number.isFinite(serverOffset) ? serverOffset : 0);
}

/**
 * 单笔记录同步时落下的偏移优先；老记录没有这个字段，回退到账户当前偏移。
 */
export function rowOffset(
  record: { server_offset?: number | null } | null | undefined,
  fallback = 0,
): number {
  const own = record?.server_offset;
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  return Number.isFinite(fallback) ? fallback : 0;
}

/** 列表里的成交时间：MM/DD HH:MM（本机时区） */
export function fmtLocalTime(raw: number, serverOffset = 0): string {
  if (!raw) return '—';
  return new Date(toUtcSeconds(raw, serverOffset) * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 曲线轴等只需要日期的场景：MM/DD（本机时区） */
export function fmtLocalDay(raw: number, serverOffset = 0): string {
  if (!raw) return '—';
  return new Date(toUtcSeconds(raw, serverOffset) * 1000).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
}
