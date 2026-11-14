import type { Bar } from '../gateway/types';

/**
 * 回放行情缓存：只存 M1 K 线，按品种一条记录，存在 IndexedDB。
 * 不进入实盘日志、不写网关数据库。
 */

const DB_NAME = 'mytrade-replay';
const STORE = 'bars';
const MAX_BARS = 500_000;

interface CachedBars {
  symbol: string;
  bars: Bar[];
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'symbol' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开回放缓存'));
  });
}

async function readRecord(db: IDBDatabase, symbol: string): Promise<Bar[]> {
  return new Promise<Bar[]>((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(symbol);
    request.onsuccess = () => {
      const record = request.result as CachedBars | undefined;
      resolve(Array.isArray(record?.bars) ? record.bars : []);
    };
    request.onerror = () => resolve([]);
  });
}

export async function readCachedBars(symbol: string): Promise<Bar[]> {
  try {
    const db = await openDb();
    const bars = await readRecord(db, symbol);
    db.close();
    return bars;
  } catch {
    return [];
  }
}

/** 合并新旧 K 线，按时间排序去重，只保留最近 MAX_BARS 根 */
export function mergeBars(existing: Bar[], incoming: Bar[]): Bar[] {
  if (!incoming.length) return existing;
  const map = new Map<number, Bar>();
  for (const bar of existing) map.set(bar.time, bar);
  for (const bar of incoming) map.set(bar.time, bar);
  const merged = [...map.values()].sort((a, b) => a.time - b.time);
  return merged.length > MAX_BARS ? merged.slice(merged.length - MAX_BARS) : merged;
}

export async function writeCachedBars(symbol: string, bars: Bar[]): Promise<void> {
  if (!bars.length) return;
  try {
    const db = await openDb();
    const existing = await readRecord(db, symbol);
    const merged = mergeBars(existing, bars);
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ symbol, bars: merged, savedAt: Date.now() } satisfies CachedBars);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* 缓存失败不影响回放，下一次重新向网关取 */
  }
}

export async function cacheSummary(): Promise<{ symbol: string; bars: number; bytes: number }[]> {
  try {
    const db = await openDb();
    const rows = await new Promise<CachedBars[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as CachedBars[] | undefined) ?? []);
      request.onerror = () => resolve([]);
    });
    db.close();
    return rows
      .map((row) => ({
        symbol: row.symbol,
        bars: row.bars.length,
        // 每根 K 线 6 个数字，按 JSON 体积粗估
        bytes: row.bars.length * 48,
      }))
      .sort((a, b) => b.bars - a.bars);
  } catch {
    return [];
  }
}

export async function clearCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}
