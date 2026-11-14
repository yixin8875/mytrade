/**
 * 复盘卡片：把一天的复盘画成一张 1080×1350 的 PNG。
 * 不用第三方库，画布 API 足够，也方便以后加图表截图。
 */

import { imagePdf } from './pdf';

const W = 1080;
const H = 1350;
const PAD = 72;

const BG = '#17140f';
const CARD = '#211c16';
const INK = '#f4efe5';
const MUTED = '#a39a8a';
const FAINT = '#6f675a';
const GAIN = '#3fae86';
const LOSS = '#d0655b';
const ACCENT = '#d9a441';

const FONT = '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';

export interface ReviewCardData {
  /** YYYY-MM-DD */
  date: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  rTrades: number;
  best: number | null;
  worst: number | null;
  bookName?: string | null;
  followed?: number;
  broken?: number;
  note?: string;
  /** 截图等附加图，可空 */
  image?: CanvasImageSource | null;
}

export function reviewCardFileName(date: string): string {
  return `tally-review-${date.replace(/[^0-9-]/g, '') || 'day'}.png`;
}

export function cardHeadline(data: ReviewCardData): string {
  const sign = data.net > 0 ? '+' : '';
  return `${sign}${data.net.toFixed(2)}`;
}

/** 把长文本按画布宽度折行；中英文都按字符宽度估算 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of text) {
    if (char === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawReviewCard(canvas: HTMLCanvasElement, data: ReviewCardData): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // 顶部强调条
  ctx.fillStyle = ACCENT;
  ctx.fillRect(PAD, PAD, 120, 6);

  ctx.fillStyle = MUTED;
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText('TALLY · 每日复盘', PAD, PAD + 64);

  ctx.fillStyle = INK;
  ctx.font = `600 64px ${FONT}`;
  ctx.fillText(data.date, PAD, PAD + 148);

  if (data.bookName) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText(`策略 · ${data.bookName}`, PAD, PAD + 196);
  }

  // 主数字
  ctx.fillStyle = data.net >= 0 ? GAIN : LOSS;
  ctx.font = `700 168px ${FONT}`;
  ctx.fillText(cardHeadline(data), PAD - 6, PAD + 372);

  ctx.fillStyle = FAINT;
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText('当日净盈亏（账户货币）', PAD, PAD + 418);

  // 四格数据
  const stats: [string, string][] = [
    ['交易笔数', String(data.trades)],
    ['胜 / 负', `${data.wins} / ${data.losses}`],
    ['胜率', data.winRate == null ? '—' : `${Math.round(data.winRate * 100)}%`],
    ['累计 R', data.rTrades > 0 ? `${data.totalR >= 0 ? '+' : ''}${data.totalR.toFixed(2)}R` : '—'],
  ];
  const cellW = (W - PAD * 2) / 2;
  stats.forEach(([label, value], index) => {
    const x = PAD + (index % 2) * cellW;
    const y = PAD + 500 + Math.floor(index / 2) * 150;
    ctx.fillStyle = CARD;
    roundRect(ctx, x, y, cellW - 20, 128, 18);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText(label, x + 28, y + 44);
    ctx.fillStyle = INK;
    ctx.font = `600 46px ${FONT}`;
    ctx.fillText(value, x + 28, y + 100);
  });

  // 最好 / 最差
  const bestWorstY = PAD + 812;
  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('最好一笔', PAD, bestWorstY);
  ctx.fillText('最差一笔', PAD + 420, bestWorstY);
  ctx.font = `600 38px ${FONT}`;
  ctx.fillStyle = GAIN;
  ctx.fillText(data.best == null ? '—' : signed(data.best), PAD, bestWorstY + 52);
  ctx.fillStyle = LOSS;
  ctx.fillText(data.worst == null ? '—' : signed(data.worst), PAD + 420, bestWorstY + 52);

  // 规则遵守
  if (data.followed != null && data.broken != null) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText('规则执行', PAD, bestWorstY + 132);
    ctx.fillStyle = INK;
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`遵守 ${data.followed} 条 · 违反 ${data.broken} 条`, PAD, bestWorstY + 180);
  }

  // 笔记
  if (data.note?.trim()) {
    ctx.fillStyle = FAINT;
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText('复盘笔记', PAD, PAD + 1050);
    ctx.fillStyle = MUTED;
    ctx.font = `400 26px ${FONT}`;
    const lines = wrapText(ctx, data.note.trim(), W - PAD * 2).slice(0, 4);
    lines.forEach((line, index) => {
      ctx.fillText(line, PAD, PAD + 1096 + index * 42);
    });
  }

  // 页脚
  ctx.strokeStyle = '#3a332a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 104);
  ctx.lineTo(W - PAD, H - 104);
  ctx.stroke();
  ctx.fillStyle = FAINT;
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText('交易记录来自 MT5 · 复盘结论只记事实，不预测行情', PAD, H - 56);

  if (data.image) {
    const size = 168;
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, W - PAD - size, PAD + 20, size, size, 14);
    ctx.clip();
    ctx.drawImage(data.image, W - PAD - size, PAD + 20, size, size);
    ctx.restore();
  }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** 生成并下载；浏览器拦截下载时抛错，由调用方提示 */
export function downloadReviewCard(data: ReviewCardData): void {
  const canvas = document.createElement('canvas');
  drawReviewCard(canvas, data);
  const link = document.createElement('a');
  link.download = reviewCardFileName(data.date);
  link.href = canvas.toDataURL('image/png');
  link.click();
}

export function reviewCardPdfFileName(date: string): string {
  return `tally-review-${date.replace(/[^0-9-]/g, '') || 'day'}.pdf`;
}

/** 把画布上的复盘卡转成单页 PDF；中文已栅格化，不依赖查看端字体 */
export function canvasToPdf(canvas: HTMLCanvasElement): Uint8Array<ArrayBuffer> {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return imagePdf(bytes, canvas.width, canvas.height);
}

export function downloadReviewCardPdf(data: ReviewCardData): void {
  const canvas = document.createElement('canvas');
  drawReviewCard(canvas, data);
  const bytes = canvasToPdf(canvas);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = reviewCardPdfFileName(data.date);
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
