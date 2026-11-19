import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makePagePdf } from '../server/fixtures/pagePdf';
import { readNativeSourceLines } from './pdfNativeSourceLines';

const load = (bytes: Buffer) => getDocument({
  data: new Uint8Array(bytes), cMapPacked: true, cMapUrl: process.cwd() + '/public/pdfjs/cmaps/',
  standardFontDataUrl: process.cwd() + '/public/pdfjs/standard_fonts/',
});
const signal = new AbortController().signal;

test('native line overlays cover rendered ink for every page rotation, cropped page and zoom', async () => {
  const pages = [0, 90, 180, 270].map(rotation => ({
    rotation, userUnit: 2, content: 'BT /F0 10 Tf 45 175 Td (Monitor) Tj ET',
  }));
  const task = load(makePagePdf([...pages, { content: 'q 190 0 0 240 10 20 cm /Im0 Do Q' }]));
  try {
    const doc = await task.promise;
    for (let p = 1; p <= pages.length; p++) {
      const [line] = await readNativeSourceLines(doc, p, signal);
      assert.equal(line.text, 'Monitor');
      const page = await doc.getPage(p);
      for (const scale of [1, 1.5]) {
        const viewport = page.getViewport({ scale });
        const factory = doc.canvasFactory as {
          create(w: number, h: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
        };
        const { width, height } = viewport;
        const { canvas, context } = factory.create(width, height);
        await page.render({ canvas, viewport }).promise;
        const pixels = context.getImageData(0, 0, width, height).data;
        let ink = 0;
        const [left, top, right, bottom] = line.bbox;
        assert((right - left) * (bottom - top) < 0.02);
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 90) continue;
          ink++;
          const x = i / 4 % width, y = Math.floor(i / 4 / width);
          assert(x >= left * width - 1 && x <= right * width + 1);
          assert(y >= top * height - 1 && y <= bottom * height + 1);
        }
        assert(ink > 10);
      }
    }
    assert.deepEqual(await readNativeSourceLines(doc, 5, signal), []);
    await assert.rejects(readNativeSourceLines(doc, 1, AbortSignal.abort()), { name: 'AbortError' });
  } finally { await task.destroy(); }
});

test('CASE-08 native text runs form two physical lines across the wrapped name', async () => {
  const task = load(await readFile('public/assets/aistudio/accident_report_08_dooring_collision_ecc07031.pdf'));
  try {
    const lines = await readNativeSourceLines(await task.promise, 2, signal);
    const i = lines.findIndex(line => line.text.endsWith('当事人王小'));
    assert(i >= 0);
    assert.equal(lines[i + 1].text, '明无责任。');
    assert(lines[i].bbox[3] < lines[i + 1].bbox[1]);
  } finally { await task.destroy(); }
});
