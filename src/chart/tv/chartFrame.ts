/**
 * 跟踪 TradingView 图表 iframe：库会先建一个 about:blank 的 iframe，再导航到
 * 图表页面，文档对象整个换掉；之后页内 DOM 还会不断重绘。
 * 这里统一处理「iframe 出现 / 导航 / 文档变化」，调用方只需要按文档同步自己的元素。
 */
export function watchChartFrame(
  host: HTMLElement | null | undefined,
  onChange: (doc: Document | null) => void,
): () => void {
  if (!host) return () => {};
  const root: HTMLElement = host;
  let frame: HTMLIFrameElement | null = null;
  let frameDoc: Document | null = null;
  let frameObserver: MutationObserver | null = null;
  let frameLoad: (() => void) | null = null;
  let disposed = false;

  const detach = () => {
    frameObserver?.disconnect();
    frameObserver = null;
    if (frame && frameLoad) frame.removeEventListener('load', frameLoad);
    frameLoad = null;
    frameDoc = null;
  };

  const attach = (next: HTMLIFrameElement | null) => {
    const doc = next?.contentDocument ?? null;
    if (next === frame && (!next || doc === frameDoc)) return;
    detach();
    frame = next;
    if (!next) return;
    frameLoad = () => sync();
    next.addEventListener('load', frameLoad);
    frameDoc = doc;
    if (!doc) return;
    frameObserver = new MutationObserver(() => sync());
    frameObserver.observe(doc.documentElement, { childList: true, subtree: true });
  };

  function sync(): void {
    if (disposed) return;
    attach(root.querySelector<HTMLIFrameElement>('iframe'));
    onChange(frame?.contentDocument ?? null);
  }

  // iframe 在 widget 构造过程中才出现，之后再监听它的文档
  const hostObserver = new MutationObserver(() => sync());
  hostObserver.observe(root, { childList: true, subtree: true });
  sync();

  return () => {
    disposed = true;
    detach();
    hostObserver.disconnect();
    frame = null;
  };
}
