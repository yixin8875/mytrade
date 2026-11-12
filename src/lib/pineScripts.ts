/**
 * Pine Script（实验）脚本存储与元信息解析。
 *
 * 真正的 Pine 运行由 PineTS（AGPL-3.0 / 商业授权）在本地完成，见 pineRunner.ts。
 * 这里只做两件事：
 *  1. 把用户粘贴的源码存进 localStorage；
 *  2. 用 PineTS 的 Indicator 扫描 inputs，并用一小段模拟 K 线试跑一次，
 *     得到 plot 的标题/颜色，供图表库生成指标元信息。
 *
 * 注意：PineTS 与 TradingView 无关联，脚本能力只覆盖它实现的部分；
 * strategy、绘图对象和外部数据源不在原型范围内。
 */

export type PineInputType =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'source'
  | 'color'
  | 'enum'
  | 'price'
  | 'time'
  | 'session'
  | 'symbol'
  | 'timeframe'
  | 'text_area';

export interface PineInputMeta {
  id: string;
  title: string;
  type: PineInputType;
  defval: unknown;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: unknown[];
}

export interface PinePlotMeta {
  /** PineTS 运行结果里的 key，用来取数据 */
  key: string;
  /** 图表图例里显示的名字 */
  title: string;
  color: string;
}

export interface PineScriptRecord {
  id: string;
  /** 展示名，也是图表库里指标的 description（必须唯一） */
  title: string;
  source: string;
  savedAt: number;
  overlay: boolean;
  plots: PinePlotMeta[];
  inputs: PineInputMeta[];
  /** 试跑失败时的提示；脚本仍会保存，但不保证能正常出图 */
  warning?: string;
}

const STORAGE_KEY = 'mytrade.pineScripts';
const PALETTE = [
  '#2962FF',
  '#FF6D00',
  '#AB47BC',
  '#00897B',
  '#78909C',
  '#FFEB3B',
  '#E040FB',
  '#26A69A',
  '#EF5350',
  '#42A5F5',
];

export function readPineScripts(): PineScriptRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PineScriptRecord =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as PineScriptRecord).id === 'string' &&
        typeof (item as PineScriptRecord).source === 'string' &&
        Array.isArray((item as PineScriptRecord).plots),
    );
  } catch {
    return [];
  }
}

function writePineScripts(records: PineScriptRecord[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  window.dispatchEvent(new CustomEvent('mytrade:pine-scripts'));
}

export function deletePineScript(id: string): void {
  writePineScripts(readPineScripts().filter((item) => item.id !== id));
}

function newId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return `p${Date.now().toString(36)}`;
  }
}

function uniqueTitle(base: string, records: PineScriptRecord[]): string {
  let title = base;
  let index = 2;
  while (records.some((item) => item.title === title)) {
    title = `${base} (${index})`;
    index += 1;
  }
  return title;
}

function parseDeclaration(source: string): { title: string; overlay: boolean } {
  const head = source.slice(0, 1200);
  const match = head.match(/indicator\s*\(\s*(?:title\s*=\s*)?(['"])([\s\S]*?)\1/);
  const title = match?.[2]?.trim() || 'Pine 指标';
  const overlay = /indicator\s*\([\s\S]{0,400}?overlay\s*=\s*true/.test(head);
  return { title, overlay };
}

const NAMED_COLORS: Record<string, string> = {
  blue: '#2962FF',
  orange: '#FF9800',
  red: '#F23645',
  green: '#089981',
  purple: '#9C27B0',
  gray: '#787B86',
  grey: '#787B86',
  yellow: '#FFEB3B',
  white: '#FFFFFF',
  black: '#000000',
  aqua: '#00BCD4',
  fuchsia: '#E040FB',
  lime: '#00E676',
  maroon: '#880E4F',
  navy: '#1E88E5',
  olive: '#808000',
  silver: '#B2B5BE',
  teal: '#00897B',
};

/** 试跑失败时的兜底：从源码里找 plot/hline 的标题和颜色 */
function regexPlots(source: string): PinePlotMeta[] {
  const plots: PinePlotMeta[] = [];
  const callRe = /\b(plot|hline)\s*\(([\s\S]*?)\)\s*(?:\/\/[^\n]*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source)) && plots.length < 20) {
    const body = match[2];
    const titleMatch = body.match(/,\s*(['"])((?:\\.|(?!\1).)*)\1/);
    const title = titleMatch?.[2]?.trim();
    if (!title) continue;
    const named =
      body.match(/color\s*=\s*color\.(\w+)/)?.[1] ??
      body.match(/color\s*=\s*(#[0-9a-fA-F]{6,8})/)?.[1];
    let color = PALETTE[plots.length % PALETTE.length];
    if (named?.startsWith('#')) color = named;
    else if (named) {
      const namedColor = NAMED_COLORS[named.toLowerCase()];
      if (namedColor) color = namedColor;
    }
    plots.push({ key: title, title, color });
  }
  return plots;
}

function syntheticCandles(): {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}[] {
  const candles = [];
  let price = 100;
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  for (let index = 0; index < 120; index += 1) {
    const open = price;
    const close = price + Math.sin(index / 6) * 1.2 + (index % 5 === 0 ? -0.9 : 0.6);
    candles.push({
      openTime: start + index * 5 * 60_000,
      open,
      high: Math.max(open, close) + 0.8,
      low: Math.min(open, close) - 0.8,
      close,
      volume: 1000 + (index % 37) * 10,
    });
    price = close;
  }
  return candles;
}

function inputTitle(item: { title?: string; name?: string }): string {
  return item.title?.trim() || item.name?.trim() || '参数';
}

/**
 * 解析并保存一个 Pine 脚本。会先试跑 120 根模拟 K 线，确认能出图并拿到曲线
 * 标题/颜色；试跑失败时退回源码解析，并在记录里带上 warning。
 */
export async function savePineScript(source: string): Promise<PineScriptRecord> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('脚本为空');
  if (/^\s*\/\/\s*@version\s*=\s*[1-4]\b/m.test(trimmed)) {
    throw new Error('只支持 //@version=5 或 6 的脚本');
  }
  if (/\bstrategy\s*\(/.test(trimmed)) {
    throw new Error('暂不支持 strategy 策略脚本，只支持 indicator 指标');
  }
  if (!/\bindicator\s*\(/.test(trimmed)) {
    throw new Error('没有找到 indicator() 声明');
  }

  const { title: rawTitle, overlay } = parseDeclaration(trimmed);
  const { PineTS, Indicator } = await import('pinets');
  const indicator = new Indicator(trimmed);
  indicator.prepare();
  const inputs: PineInputMeta[] = indicator.getInputsMeta().map((item) => ({
    id: item.id,
    title: inputTitle(item),
    type: item.type,
    defval: item.defval,
    minval: item.minval,
    maxval: item.maxval,
    step: item.step,
    options: item.options,
  }));

  let plots: PinePlotMeta[] = [];
  let warning: string | undefined;
  try {
    const pine = new PineTS(syntheticCandles());
    const ctx = await pine.run(indicator);
    const names = Object.keys(ctx.plots).filter(
      (key) => !key.startsWith('__') && !key.startsWith('bgcolor#'),
    );
    for (const name of names) {
      if (plots.length >= 20) break;
      const data = (ctx.plots[name]?.data ?? []) as {
        value: unknown;
        options?: { color?: string };
      }[];
      const lastValue = [...data].reverse().find((point) => point.value != null)?.value;
      // plotshape/plotchar 是布尔序列，图表库的折线表达不了，先跳过
      if (typeof lastValue === 'boolean') continue;
      if (!data.some((point) => typeof point.value === 'number')) continue;
      const color =
        data.find((point) => point.options?.color)?.options?.color ??
        PALETTE[plots.length % PALETTE.length];
      const title = /^(plot|hline)#/.test(name) ? `曲线 ${plots.length + 1}` : name;
      plots.push({ key: name, title, color });
    }
  } catch (error) {
    warning = `试跑失败：${(error as Error)?.message || '未知错误'}`;
  }

  if (plots.length === 0) plots = regexPlots(trimmed);
  if (plots.length === 0) {
    throw new Error(warning ?? '没有找到可显示的 plot/hline 曲线');
  }

  const records = readPineScripts();
  const title = uniqueTitle(rawTitle, records);
  const record: PineScriptRecord = {
    id: newId(),
    title,
    source: trimmed,
    savedAt: Date.now(),
    overlay,
    plots,
    inputs,
    warning,
  };
  writePineScripts([...records, record]);
  return record;
}
