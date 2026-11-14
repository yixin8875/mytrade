import { describe, expect, it } from 'vitest';
import { imagePdf, pdfPageSize } from './pdf';

function text(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

/** 合成一段“JPEG”，写入器只按字节透传，不做解码 */
function fakeJpeg(length = 100): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7) % 256;
  return bytes;
}

describe('pdfPageSize', () => {
  it('96dpi 像素按 3/4 换算成点', () => {
    expect(pdfPageSize(1080, 1350)).toEqual({ width: 810, height: 1012.5 });
  });
});

describe('imagePdf', () => {
  it('拒绝空图与非法尺寸', () => {
    expect(() => imagePdf(new Uint8Array(0), 1080, 1350)).toThrow('JPEG 数据为空');
    expect(() => imagePdf(fakeJpeg(), 0, 1350)).toThrow('图片尺寸无效');
    expect(() => imagePdf(fakeJpeg(), 1080, Number.NaN)).toThrow('图片尺寸无效');
  });

  it('生成合法的单页 PDF 骨架', () => {
    const bytes = imagePdf(fakeJpeg(), 1080, 1350);
    const body = text(bytes);
    expect(body.startsWith('%PDF-1.4\n')).toBe(true);
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(body).toContain('/Type /Catalog /Pages 2 0 R');
    expect(body).toContain('/Count 1');
    expect(body).toContain('/MediaBox [0 0 810 1012.5]');
    expect(body).toContain('/Resources << /XObject << /Im0 4 0 R >> >>');
    expect(body).toContain('q\n810 0 0 1012.5 0 0 cm\n/Im0 Do\nQ\n');
  });

  it('图片字典记录真实尺寸与字节长度', () => {
    const jpeg = fakeJpeg(321);
    const body = text(imagePdf(jpeg, 1080, 1350));
    expect(body).toContain('/Width 1080 /Height 1350');
    expect(body).toContain('/Filter /DCTDecode /Length 321');
    expect(body).toContain('/BitsPerComponent 8');
  });

  it('xref 偏移指向各对象开头，startxref 指向 xref 表', () => {
    const bytes = imagePdf(fakeJpeg(), 1080, 1350);
    const body = text(bytes);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(body)?.[1]);
    expect(body.slice(startxref, startxref + 4)).toBe('xref');

    const rows = [...body.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(rows).toHaveLength(5);
    rows.forEach((offset, index) => {
      expect(body.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
  });

  it('字节总长与字符串长度一致，图像字节原样嵌入', () => {
    const jpeg = fakeJpeg(64);
    const bytes = imagePdf(jpeg, 1080, 1350);
    expect(bytes.length).toBe(text(bytes).length);

    const marker = text(jpeg);
    expect(text(bytes)).toContain(`stream\n${marker}\nendstream`);
  });
});
