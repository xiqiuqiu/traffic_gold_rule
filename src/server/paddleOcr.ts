import { z } from 'zod';
import { PermanentPdfError } from './readPdf';
import type { PdfBox } from './pageEvidence';

export const OCR_ENGINE = 'PaddleOCR-3.7.0/PP-OCRv6_medium_det+PP-OCRv6_medium_rec/original-pixels-v1';
const pixel = z.number().int().nonnegative();
const pageResponse = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  engine: z.literal(OCR_ENGINE),
  lines: z.array(z.object({
    text: z.string().trim().min(1).refine(text => !text.includes('\0')),
    rawBox: z.tuple([pixel, pixel, pixel, pixel]),
    confidence: z.number().min(0).max(1),
  })),
});

export async function recognizePage(image: { png: Buffer; width: number; height: number }, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(240_000);
  const res = await fetch(process.env.PADDLE_OCR_URL || 'http://127.0.0.1:8867/v1/ocr/lines', {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(image.png),
    redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const message = `PaddleOCR 识别请求失败（HTTP ${res.status}）`;
    if ([400, 413, 415, 422].includes(res.status)) throw new PermanentPdfError(message);
    throw new Error(message);
  }
  const parsed = pageResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('PaddleOCR 返回的引擎版本、行框或置信度不符合接口约定');
  const { width, height, engine, lines } = parsed.data;
  if (width !== image.width || height !== image.height) throw new Error('PaddleOCR 响应尺寸与送识别的页面不一致');
  return {
    width, height, engine,
    lines: lines.map(({ text, rawBox, confidence }) => {
      const [left, top, right, bottom] = rawBox;
      if (right <= left || bottom <= top || right > width || bottom > height) {
        throw new Error('PaddleOCR 返回越界或零面积行框');
      }
      const bbox: PdfBox = [left / width, top / height, right / width, bottom / height];
      return { text, rawBox: rawBox as PdfBox, bbox, confidence };
    }),
  };
}
