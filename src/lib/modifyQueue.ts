/**
 * 拖动止盈/止损/挂单价时的改单节流。
 *
 * 以前拖动过程中每 90–200ms 就向网关发一次 order.modify / position.modify，
 * 而网关所有 MT5 请求都排在一个线程里串行执行，请求一多，行情轮询被饿死，
 * 图表和标签就会卡。拖动本身只需要改本地显示，所以这里做三件事：
 *
 *  1. 连续拖动时只记下最新价格，停手 DELAY_MS 后才真正发一次；
 *  2. 同一张单同一字段同时只允许一个请求在飞，飞行期间只保留最新目标价；
 *  3. 目标价和上一次成功发送的相同（tick 容差内）就不再发。
 *
 * 每个通道用 key 区分，例如 position:123:sl、order:456。
 */

/** 停手多久后发送：既不会拖一下就发一串，也不会松手后等太久 */
const DELAY_MS = 320;
/** 上一个请求回来、还有新目标价时，隔一小会儿再发，避免挤在一起 */
const GAP_MS = 60;

interface Job {
  timer: number;
  pending: number | null;
  inFlight: boolean;
  lastSent: number | null;
  send: ((price: number) => Promise<unknown>) | null;
  onError: ((error: Error) => void) | null;
}

const jobs = new Map<string, Job>();

function jobFor(key: string): Job {
  let job = jobs.get(key);
  if (!job) {
    job = {
      timer: 0,
      pending: null,
      inFlight: false,
      lastSent: null,
      send: null,
      onError: null,
    };
    jobs.set(key, job);
  }
  return job;
}

/**
 * 请求把某个价格字段改到 price。
 *
 * @param key       通道，如 position:<ticket>:sl
 * @param price     目标价格（已按 tick 对齐）
 * @param send      真正发请求的函数
 * @param onError   失败回调（默认只丢弃，下次拖动会重试）
 * @param tolerance 与上次发送价的比较容差，通常半个 tick
 */
export function requestModify(
  key: string,
  price: number,
  send: (price: number) => Promise<unknown>,
  onError?: (error: Error) => void,
  tolerance = 0,
): void {
  if (!Number.isFinite(price)) return;
  const job = jobFor(key);
  job.send = send;
  job.onError = onError ?? null;

  // 已经发过同一个价格（拖动又拖回原处）就不用再发
  if (job.lastSent != null && Math.abs(price - job.lastSent) <= tolerance) {
    job.pending = null;
    if (job.timer) {
      window.clearTimeout(job.timer);
      job.timer = 0;
    }
    return;
  }

  job.pending = price;
  if (job.timer) window.clearTimeout(job.timer);
  job.timer = window.setTimeout(() => {
    job.timer = 0;
    drain(job);
  }, DELAY_MS);
}

function drain(job: Job): void {
  if (job.inFlight || job.pending == null || !job.send) return;
  const price = job.pending;
  const send = job.send;
  const onError = job.onError;
  job.pending = null;
  job.inFlight = true;

  send(price)
    .then(() => {
      job.lastSent = price;
    })
    .catch((error: Error) => {
      // 失败不更新 lastSent，下一轮还会重试
      onError?.(error);
    })
    .finally(() => {
      job.inFlight = false;
      if (job.pending == null) return;
      window.setTimeout(() => {
        if (!job.inFlight) drain(job);
      }, GAP_MS);
    });
}
