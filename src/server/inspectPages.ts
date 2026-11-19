import { resolve, sep } from 'node:path';
import { extractPagesMarkdownAsync, extractTextWithPositionsAsync, type TextItem } from '@firecrawl/pdf-inspector';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { normalizePdfTextForDisplay } from '../utils/goldRules';
import type { PdfBox, PdfEvidenceLine, PdfPageEvidence } from './pageEvidence';
import { PermanentPdfError } from './readPdf';

// PDF.js supplies this native canvas factory in Node; its public type declares only "object".
interface NodeCanvasFactory {
  create(width: number, height: number): {
    canvas: HTMLCanvasElement & { toBuffer(type: 'image/png'): Buffer };
    context: CanvasRenderingContext2D;
  };
  destroy(pair: ReturnType<NodeCanvasFactory['create']>): void;
}

function nativeEvidence(items: TextItem[], width: number, height: number, unit: number): PdfEvidenceLine[] {
  const lines: PdfEvidenceLine[] = [];
  let lastRotation: number | undefined;
  for (const item of items) {
    const text = item.text.replaceAll('\0', '');
    if (item.itemType !== 'Text' || !text.trim()) continue;
    // Display-frame y is measured upwards from the crop's lower edge, before PDF UserUnit scaling.
    const left = Math.max(0, item.x * unit);
    const top = Math.max(0, height - (item.y + item.height) * unit);
    const right = Math.min(width, (item.x + item.width) * unit);
    const bottom = Math.min(height, height - item.y * unit);
    if (!(right > left && bottom > top)) continue;
    const rawBox: PdfBox = [left, top, right, bottom];
    const previous = lines.at(-1);
    const prev = previous?.rawBox;
    const em = item.fontSize * unit;
    // Join adjacent styled runs on one physical line; table cells and distant columns keep separate anchors.
    if (prev && lastRotation === 0 && item.rotation === 0 && Math.abs(prev[3] - bottom) < em * 0.2 &&
        left >= prev[2] - em * 0.2 && left - prev[2] < em * 0.8) {
      const wordGap = left - prev[2] > em * 0.2 && !/\s$/.test(previous.text) && !/^\s/.test(text);
      previous.text += (wordGap ? ' ' : '') + text;
      prev[1] = Math.min(prev[1], top);
      prev[2] = Math.max(prev[2], right);
      prev[3] = Math.max(prev[3], bottom);
      previous.bbox = [prev[0] / width, prev[1] / height, prev[2] / width, prev[3] / height];
    } else {
      lines.push({ text, bbox: [left / width, top / height, right / width, bottom / height], rawBox });
    }
    lastRotation = item.rotation;
  }
  return lines;
}

async function rasterize(doc: PDFDocumentProxy, page: PDFPageProxy) {
  const base = page.getViewport({ scale: 1 });
  // Render at 144 DPI, bounding RGBA allocations for oversize sheets. Both axes map to the full crop.
  const maxPixels = 16_000_000;
  const maxScale = Math.min(2, Math.sqrt(maxPixels / (base.width * base.height)), 8192 / Math.max(base.width, base.height));
  const factory = doc.canvasFactory as NodeCanvasFactory;
  async function render(scale: number) {
    const viewport = page.getViewport({ scale });
    const round = Math.ceil(viewport.width) * Math.ceil(viewport.height) <= maxPixels ? Math.ceil : Math.floor;
    const width = Math.max(1, Math.min(8192, round(viewport.width)));
    const height = Math.max(1, Math.min(8192, round(viewport.height)));
    const surface = factory.create(width, height);
    try {
      await page.render({
        canvas: surface.canvas, viewport, background: '#ffffff',
        transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0],
      }).promise;
      const blank = scale === 2 && surface.context.getImageData(0, 0, width, height).data.every(channel => channel === 255);
      return { width, height, blank, png: blank ? Buffer.alloc(0) : surface.canvas.toBuffer('image/png') };
    } finally {
      factory.destroy(surface);
    }
  }
  try {
    const image = await render(maxScale);
    // A noisy scan can fit the decoder's pixel limit but exceed the OCR service's PNG byte limit.
    return image.png.length <= 25_000_000 ? image : await render(maxScale / 2);
  } finally {
    page.cleanup();
  }
}

export async function openInspectedPdf(bytes: Buffer) {
  const loading = getDocument({
    data: new Uint8Array(bytes), stopAtErrors: true,
    cMapUrl: resolve('public/pdfjs/cmaps') + sep, cMapPacked: true,
    standardFontDataUrl: resolve('public/pdfjs/standard_fonts') + sep,
    wasmUrl: resolve('node_modules/pdfjs-dist/wasm') + sep,
  });
  try {
    const doc = await loading.promise;
    const [markdown, positioned] = await Promise.all([
      extractPagesMarkdownAsync(bytes), extractTextWithPositionsAsync(bytes, undefined, { frame: 'display' }),
    ]);
    const pageInfo = new Map(markdown.pages.map(page => [page.page + 1, page]));
    if (pageInfo.size !== doc.numPages) throw new Error('分页取文结果与 PDF 原件的页数不符');
    const itemsByPage = new Map<number, TextItem[]>();
    for (const item of positioned) {
      if (!itemsByPage.has(item.page)) itemsByPage.set(item.page, []);
      itemsByPage.get(item.page)!.push(item);
    }

    let cached: { pageNumber: number; raster: Awaited<ReturnType<typeof rasterize>> } | undefined;
    async function imageOf(page: PDFPageProxy) {
      if (cached?.pageNumber !== page.pageNumber) {
        cached = { pageNumber: page.pageNumber, raster: await rasterize(doc, page) };
      }
      return cached.raster;
    }

    async function inspectPage(pageNumber: number): Promise<PdfPageEvidence> {
      const page = await doc.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });
      const metadata = { pageNumber, width, height, rotation: page.rotate };
      const info = pageInfo.get(pageNumber);
      if (!info) throw new Error(`pdf-inspector 缺少原件第 ${pageNumber} 页`);
      const items = itemsByPage.get(pageNumber) ?? [];
      const lines = nativeEvidence(items, width, height, page.userUnit);
      const text = normalizePdfTextForDisplay(lines.map(line => line.text).join('\n'));
      const largeImage = items.some(i => i.itemType === 'Image' && i.width * i.height * page.userUnit ** 2 >= width * height * 0.5);
      const hasBodyText = lines.some(line => line.bbox[1] < 0.82 && line.bbox[3] > 0.18);
      const headerOnly = largeImage && (!hasBodyText || text.length < 40);
      if (!info.needsOcr && info.markdown.trim() && text && !headerOnly) {
        return { ...metadata, source: 'native', reason: null, text, lines };
      }
      const image = await imageOf(page);
      if (image.blank) return { ...metadata, source: 'blank', reason: 'white_render', lines: [], text: '' };
      const reason = info.ocrReason || (headerOnly ? 'sparse_text_on_image' : 'unreliable_native_text');
      return { ...metadata, source: 'ocr', reason, lines: [], text: '' };
    }

    return {
      pageCount: doc.numPages, inspectPage,
      async renderPage(pageNumber: number) {
        const image = await imageOf(await doc.getPage(pageNumber));
        if (image.blank) throw new Error(`原件第 ${pageNumber} 页已确认空白`);
        return { png: image.png, width: image.width, height: image.height };
      },
      async close() { cached = undefined; await loading.destroy(); },
    };
  } catch (error) {
    await loading.destroy();
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new PermanentPdfError('PDF 需要密码，请提供已解密的原件。');
    }
    throw new PermanentPdfError(`PDF 原件无法逐页取文：${error instanceof Error ? error.message : '文档无效'}`);
  }
}
