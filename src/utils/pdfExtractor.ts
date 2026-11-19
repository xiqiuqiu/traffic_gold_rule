import * as pdfjsLib from 'pdfjs-dist';
import { readPdfPageTexts } from './pdfPageText';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface ExtractedPdfContent {
  pageCount: number;
  pageTexts: Record<number, string>;
  pdfBase64?: string;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

export async function extractPdfPagesFromUrl(
  pdfUrl: string,
  options?: { includeBase64IfEmptyText?: boolean },
): Promise<ExtractedPdfContent> {
  const res = await fetch(pdfUrl);
  if (!res.ok) {
    throw new Error(`无法读取 PDF 文件（HTTP ${res.status}）`);
  }
  const buf = await res.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  });
  const doc = await loadingTask.promise;

  const pageTexts = await readPdfPageTexts(doc);

  const totalChars = Object.values(pageTexts)
    .join('')
    .replace(/\s+/g, '').length;

  let pdfBase64: string | undefined;
  if (options?.includeBase64IfEmptyText && totalChars < 40) {
    pdfBase64 = arrayBufferToBase64(buf);
  }

  return {
    pageCount: doc.numPages,
    pageTexts,
    pdfBase64,
  };
}
