import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { makePagePdf } from './fixtures/pagePdf';
import { openInspectedPdf } from './inspectPages';

test('native positions and raster dimensions use the same rotated crop and PDF UserUnit', async () => {
  const turns = [0, 90, 180, 270];
  const doc = await openInspectedPdf(makePagePdf(turns.map(rotation => ({
    rotation, userUnit: 2, content: 'BT /F0 10 Tf 45 175 Td (Monitor) Tj ET',
  }))));
  try {
    const boxes = [
      [70, 150, 136.68, 170], [310, 70, 330, 136.68],
      [243.32, 310, 310, 330], [150, 243.32, 170, 310],
    ];
    for (const [i, rotation] of turns.entries()) {
      const page = await doc.inspectPage(i + 1);
      assert.equal(page.source, 'native');
      assert.equal(page.rotation, rotation);
      assert.equal(page.lines[0].text, 'Monitor');
      const image = await doc.renderPage(i + 1);
      assert.deepEqual([image.width, image.height], i % 2 ? [960, 760] : [760, 960]);
      const restored = page.lines[0].bbox.map((v, axis) => v * (axis % 2 ? image.height : image.width) / 2);
      assert(restored.every((v, axis) => Math.abs(v - boxes[i][axis]) < 0.01));
    }
  } finally {
    await doc.close();
  }
});

test('a scan with a page header and a vector-only page require OCR; a rendered empty page is blank', async () => {
  const doc = await openInspectedPdf(makePagePdf([
    { content: 'q 190 0 0 240 10 20 cm /Im0 Do Q\nBT /F0 9 Tf 20 250 Td (Page 1) Tj ET' },
    { content: '0 g 50 130 90 50 re f' },
    { content: '' },
  ]));
  try {
    const routes = [];
    for (let n = 1; n <= doc.pageCount; n++) {
      const page = await doc.inspectPage(n);
      routes.push(page.source);
      assert.equal(page.pageNumber, n);
      if (page.source === 'ocr') {
        const image = await doc.renderPage(n);
        assert.equal(image.png.toString('ascii', 1, 4), 'PNG');
        assert.deepEqual([image.width, image.height], [380, 480]);
      }
    }
    assert.deepEqual(routes, ['ocr', 'ocr', 'blank']);
  } finally {
    await doc.close();
  }
});

test('large page raster stays within the OCR pixel and byte limits after integer rounding', async () => {
  const doc = await openInspectedPdf(makePagePdf([{ content: '0 g 50 130 90 50 re f', userUnit: 30 }]));
  try {
    const image = await doc.renderPage(1);
    assert(image.width * image.height <= 16_000_000);
    assert(image.png.length <= 25_000_000);
    assert(Math.abs(image.width / image.height - 190 / 240) < 0.001);
  } finally {
    await doc.close();
  }
});

test('CASE-08 native lines preserve the physical split in the responsibility quote', async () => {
  const file = 'public/assets/aistudio/accident_report_08_dooring_collision_ecc07031.pdf';
  const doc = await openInspectedPdf(await readFile(file));
  try {
    const page = await doc.inspectPage(2);
    assert.equal(page.source, 'native');
    const first = page.lines.findIndex(line => line.text.trimEnd().endsWith('当事人王小'));
    assert(first >= 0);
    assert.equal(page.lines[first + 1].text.trim(), '明无责任。');
    assert(page.lines[first + 1].bbox[1] > page.lines[first].bbox[3]);
    assert.match(page.text, /王小明无责任/);
  } finally {
    await doc.close();
  }
});
