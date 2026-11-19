import type { PDFDocumentProxy } from 'pdfjs-dist';
import { normalizePdfTextForDisplay } from './goldRules';

export async function readPdfPageTexts(doc: PDFDocumentProxy): Promise<Record<number, string>> {
  const pageTexts: Record<number, string> = {};
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const raw = tc.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pageTexts[p] = normalizePdfTextForDisplay(raw);
  }
  return pageTexts;
}
