import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { LiabilitySourceLine } from '../types/gold';

// Use the same viewport as the PDF canvas, including its CropBox, UserUnit and rotation.
export async function readNativeSourceLines(
  pdf: Pick<PDFDocumentProxy, 'getPage'>, page: number, signal: AbortSignal,
): Promise<LiabilitySourceLine[]> {
  signal.throwIfAborted();
  const original = await pdf.getPage(page);
  signal.throwIfAborted();
  const viewport = original.getViewport({ scale: 1 });
  const { items, styles } = await original.getTextContent();
  signal.throwIfAborted();
  const lines: LiabilitySourceLine[] = [];
  let previous: { endX: number; endY: number; dx: number; dy: number } | undefined;

  for (const item of items) {
    if (!('str' in item)) continue;
    if (!item.str.trim()) {
      if (item.hasEOL) previous = undefined;
      continue;
    }
    const [a, b, c, d, x, y] = item.transform;
    const style = styles[item.fontName];
    const em = Math.hypot(c, d);
    const axis = Math.hypot(a, b);
    const length = style.vertical ? item.height : item.width;
    if (!axis || !em || !(length > 0)) {
      previous = undefined;
      continue;
    }
    const dx = (style.vertical ? b : a) / axis;
    const dy = (style.vertical ? -a : b) / axis;
    const ascent = (Number.isFinite(style.ascent) ? style.ascent : 0.8) * em;
    const descent = (Number.isFinite(style.descent) ? style.descent : -0.2) * em;
    const corners = [ascent, descent].flatMap(height => [0, length].map(offset =>
      viewport.convertToViewportPoint(x + dx * offset - dy * height, y + dy * offset + dx * height),
    ));
    const xs = corners.map(([cx]) => cx / viewport.width);
    const ys = corners.map(([, cy]) => cy / viewport.height);
    const bbox: LiabilitySourceLine['bbox'] = [
      Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)),
      Math.min(1, Math.max(...xs)), Math.min(1, Math.max(...ys)),
    ];
    if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1])) {
      previous = undefined;
      continue;
    }

    // PDFs often paint one Chinese character per run. Join adjacent runs on the
    // same baseline, keeping distant table cells and separate physical lines apart.
    const last = lines.at(-1);
    const gapX = x - (previous?.endX ?? x);
    const gapY = y - (previous?.endY ?? y);
    const gap = dx * gapX + dy * gapY;
    if (last && previous && Math.abs(dx - previous.dx) + Math.abs(dy - previous.dy) < 0.01 &&
        Math.abs(dx * gapY - dy * gapX) < em * 0.2 && gap >= -em * 0.2 && gap < em * 0.8) {
      last.text += (gap > em * 0.2 ? ' ' : '') + item.str;
      last.bbox = [Math.min(last.bbox[0], bbox[0]), Math.min(last.bbox[1], bbox[1]),
        Math.max(last.bbox[2], bbox[2]), Math.max(last.bbox[3], bbox[3])];
    } else {
      const lineNumber = lines.length + 1;
      lines.push({ page, lineNumber, lineId: `native:${page}:${lineNumber}`, text: item.str, bbox });
    }
    previous = item.hasEOL ? undefined : { endX: x + dx * length, endY: y + dy * length, dx, dy };
  }
  return lines;
}
