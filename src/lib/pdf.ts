/**
 * 最小 PDF 写入器：把一张 JPEG 铺满单页，不引第三方库。
 * 复盘卡在画布里已把中文栅格化，PDF 里只是一张位图，
 * 所以不依赖查看端是否装了中文字体，也不会出现缺字方框。
 */

/** 画布像素（96dpi）换算成 PDF 点（72dpi） */
const PX_TO_PT = 0.75;

export function pdfPageSize(width: number, height: number): { width: number; height: number } {
  return { width: width * PX_TO_PT, height: height * PX_TO_PT };
}

/** 去掉无意义的尾零，PDF 里只留必要小数 */
function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export function imagePdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  if (jpeg.length === 0) throw new Error('JPEG 数据为空');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效');
  }

  const page = pdfPageSize(width, height);
  const pageWidth = num(page.width);
  const pageHeight = num(page.height);
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;

  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? asciiBytes(data) : data;
    chunks.push(bytes);
    size += bytes.length;
  };
  const object = (index: number, body: () => void) => {
    offsets[index] = size;
    push(`${index} 0 obj\n`);
    body();
    push('endobj\n');
  };

  push('%PDF-1.4\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>\n'));
  object(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n'));
  object(3, () =>
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\n`,
    ),
  );
  object(4, () => {
    push(
      `<< /Type /XObject /Subtype /Image /Width ${Math.round(width)} /Height ${Math.round(
        height,
      )} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    push('\nendstream\n');
  });
  object(5, () => {
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\n`);
  });

  const xrefStart = size;
  push('xref\n0 6\n');
  push('0000000000 65535 f \n');
  for (let index = 1; index <= 5; index += 1) {
    push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
