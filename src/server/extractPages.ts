import { version as renderVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizePdfTextForDisplay } from '../utils/goldRules';
import { openInspectedPdf } from './inspectPages';
import { OCR_ENGINE, recognizePage } from './paddleOcr';
import type { PdfPageEvidence } from './pageEvidence';
import {
  readCachedPageText, readPdfArtifact, savePageEvidence, savePdfArtifact,
  updatePdfProgress, withOcrSlot, type PdfLease,
} from './pdfQueue';
import { PermanentPdfError, readOriginal } from './readPdf';

// Bump the routing/render revision when a cached page could yield different evidence.
const extractionVersion = `pdf-inspector@1.26.1/pdfjs@${renderVersion}/display-v1/${OCR_ENGINE}`;
interface RunPages {
  pageCount: number;
  pageTexts: Record<number, string>;
  extractionVersion: string;
}

export async function loadRunPages(lease: PdfLease, signal: AbortSignal): Promise<RunPages> {
  const previous = await readPdfArtifact<RunPages>(lease, 'text');
  if (previous?.extractionVersion) return previous;
  const pdf = await openInspectedPdf(await readOriginal(lease.originalPath, lease.task.fileSha256));
  const pageTexts: Record<number, string> = {};
  try {
    for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber++) {
      signal.throwIfAborted();
      const cached = await readCachedPageText(lease, extractionVersion, pageNumber);
      if (cached !== null) {
        pageTexts[pageNumber] = cached;
        continue;
      }
      const page = await pdf.inspectPage(pageNumber);
      const save = (evidence: PdfPageEvidence) => savePageEvidence(lease, extractionVersion, evidence);
      let text: string | null;
      if (page.source === 'ocr') {
        const label = `正在识别原件第 ${pageNumber} / ${pdf.pageCount} 页`;
        if (!await updatePdfProgress(lease, 'parsing_pdf', label, 10 + Math.floor(55 * (pageNumber - 1) / pdf.pageCount))) {
          throw new Error('任务租约已失效');
        }
        try {
          text = await withOcrSlot(signal, async (slotSignal) => {
            // A second run for this document may have published the same page while we waited.
            const completed = await readCachedPageText(lease, extractionVersion, pageNumber);
            if (completed !== null) return completed;
            const image = await pdf.renderPage(pageNumber);
            const ocr = await recognizePage(image, slotSignal);
            if (!ocr.lines.length) throw new PermanentPdfError('未识别出可定位的文字行，请核查原件。');
            return save({
              ...page, text: normalizePdfTextForDisplay(ocr.lines.map(line => line.text).join('\n')),
              lines: ocr.lines, engine: ocr.engine, renderWidth: ocr.width, renderHeight: ocr.height,
            });
          });
        } catch (error) {
          const detail = `原件第 ${pageNumber} 页 OCR 失败：${error instanceof Error ? error.message : '服务异常'}`;
          if (error instanceof PermanentPdfError) throw new PermanentPdfError(detail);
          throw new Error(detail, { cause: error });
        }
      } else {
        text = await save(page);
      }
      if (text === null) throw new Error('任务租约已失效');
      pageTexts[pageNumber] = text;
    }
    if (!Object.values(pageTexts).some(text => text.trim())) throw new PermanentPdfError('原件没有可解析的文字。');
    const pages = { extractionVersion, pageCount: pdf.pageCount, pageTexts };
    if (!await savePdfArtifact(lease, 'text', pages)) throw new Error('任务租约已失效');
    return pages;
  } finally {
    await pdf.close();
  }
}
