import React, { useEffect, useId, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import type { LiabilitySourceLine } from '../types/gold';
import {
  ChevronLeft,
  ChevronRight,
  CopyCheck,
  FileText,
  ZoomIn,
  ZoomOut,
  AlertCircle,
} from 'lucide-react';
import {
  cleanSelectedPdfQuote,
  findTextMatchRanges,
  splitPdfPageIntoParagraphs,
} from '../utils/goldRules';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const DemoWatermarkOverlay: React.FC = () => {
  const rawId = useId();
  const patternId = `pdf-demo-wm-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div
      data-testid="pdf-demo-watermark"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 select-none overflow-hidden"
    >
      <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern
            id={patternId}
            width="280"
            height="180"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-28)"
          >
            <text
              x="140"
              y="76"
              textAnchor="middle"
              fill="#b91c1c"
              fillOpacity="0.14"
              fontSize="14"
              fontWeight="600"
              letterSpacing="1.5"
            >
              测试演示样本 · 非真实数据
            </text>
            <text
              x="140"
              y="98"
              textAnchor="middle"
              fill="#475569"
              fillOpacity="0.15"
              fontSize="11"
              fontWeight="500"
              letterSpacing="1.5"
            >
              DEMO / TEST DATA ONLY
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
};

interface HighlightedEvidenceInput {
  page: number;
  quote: string;
  label?: string;
}

interface PdfEvidenceViewerProps {
  pdfUrl: string;
  locatedSource: { page: number; quote: string; lines: LiabilitySourceLine[] } | null;
  locateRequest: object | null;
  sourceMessage?: string;
  onDocumentReady: (pdf: pdfjsLib.PDFDocumentProxy | null) => void;
  sourceFilename: string;
  currentPage: number;
  onPageChange: (page: number) => void;
  onPageCountDetected?: (count: number) => void;
  onPageTextsExtracted?: (texts: Record<number, string>) => void;
  highlightedEvidences?: HighlightedEvidenceInput[];
  selectedQuote: { page: number; quote: string } | null;
  onSelectQuote: (selection: { page: number; quote: string } | null) => void;
  activeTargetLabel: string | null;
  onApplyQuoteToTarget: (page: number, quote: string) => void;
}

function applyTextLayerHighlights(container: HTMLElement | null, quotes: string[]): number {
  if (!container) return 0;
  const spans = Array.from(container.querySelectorAll('span'));
  for (const sp of spans) {
    sp.classList.remove('pdf-evidence-match');
  }
  if (quotes.length === 0 || spans.length === 0) return 0;

  let fullText = '';
  const spanRanges: Array<{ span: HTMLSpanElement; start: number; end: number }> = [];
  for (const sp of spans) {
    const t = sp.textContent || '';
    if (!t) continue;
    const start = fullText.length;
    fullText += t;
    spanRanges.push({ span: sp, start, end: fullText.length });
  }
  const matches = findTextMatchRanges(fullText, quotes);
  if (matches.length === 0) return 0;

  for (const { span, start, end } of spanRanges) {
    const overlaps = matches.some((m) => m.start < end && m.end > start);
    if (overlaps) {
      span.classList.add('pdf-evidence-match');
    }
  }
  return matches.length;
}

export const PdfEvidenceViewer: React.FC<PdfEvidenceViewerProps> = ({
  pdfUrl,
  locatedSource,
  locateRequest,
  sourceMessage,
  onDocumentReady,
  sourceFilename,
  currentPage,
  onPageChange,
  onPageCountDetected,
  onPageTextsExtracted,
  highlightedEvidences = [],
  selectedQuote,
  onSelectQuote,
  activeTargetLabel,
  onApplyQuoteToTarget,
}) => {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(0.9);
  const [viewMode, setViewMode] = useState<'canvas' | 'text'>('canvas');
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [manualQuoteDraft, setManualQuoteDraft] = useState<string>('');
  const [textLayerReadyTick, setTextLayerReadyTick] = useState<number>(0);

  const [drawnPage, setDrawnPage] = useState<{ page: number; scale: number } | null>(null);
  const firstLineRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const viewerRegionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (locateRequest) setViewMode('canvas');
  }, [locateRequest]);

  const showSource = viewMode === 'canvas' && locatedSource?.page === currentPage &&
    drawnPage?.page === currentPage && drawnPage.scale === scale;
  useEffect(() => {
    const region = viewerRegionRef.current;
    const line = firstLineRef.current;
    if (!showSource || !line || !region) return;
    // Scroll only the original document, preserving the position of the form on the right.
    const bounds = line.getBoundingClientRect();
    const viewport = region.getBoundingClientRect();
    region.scrollTo({
      top: region.scrollTop + bounds.top - viewport.top - region.clientHeight / 3,
      left: region.scrollLeft + bounds.left - viewport.left - 16,
    });
  }, [locateRequest, showSource]);

  // Load PDF document whenever pdfUrl changes
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    const abortController = new AbortController();
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setPageTexts({});
    onPageTextsExtracted?.({});

    (async () => {
      try {
        const res = await fetch(pdfUrl, { signal: abortController.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} (${res.statusText || '无法读取PDF'})`);
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
        });

        const doc = await loadingTask.promise;
        if (cancelled) return;
        setPdfDoc(doc);
        onDocumentReady(doc);
        setNumPages(doc.numPages);
        setLoading(false);
        onPageCountDetected?.(doc.numPages);
        if (currentPage > doc.numPages) {
          onPageChange(1);
        }

        // Pre-extract clean page text in background for proofreading view
        const texts: Record<number, string> = {};
        for (let p = 1; p <= doc.numPages; p += 1) {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          const lines: string[] = [];
          let lastY: number | null = null;
          let buffer = '';
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
              if (buffer.trim()) lines.push(buffer.trim());
              buffer = item.str;
            } else {
              buffer += (buffer && !buffer.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
            }
            lastY = y;
          }
          if (buffer.trim()) lines.push(buffer.trim());
          texts[p] = lines.join('\n');
        }
        if (!cancelled) {
          setPageTexts(texts);
          onPageTextsExtracted?.(texts);
        }
      } catch (err) {
        if (cancelled || abortController.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'PDF 加载失败');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      onDocumentReady(null);
      loadingTask?.destroy().catch(() => {});
    };
  }, [pdfUrl]);

  // Render active page canvas + selectable text layer
  useEffect(() => {
    setDrawnPage(null);
    if (!pdfDoc || viewMode !== 'canvas') return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let textLayerInstance: TextLayer | null = null;

    pdfDoc.getPage(Math.min(Math.max(1, currentPage), pdfDoc.numPages)).then(async (page) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const textLayerDiv = textLayerRef.current;
      if (!canvas || !textLayerDiv) return;

      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      textLayerDiv.innerHTML = '';
      textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
      textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
      textLayerDiv.style.setProperty('--scale-factor', String(scale));

      const renderContext = {
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      };

      renderTask = page.render(renderContext);
      try {
        await renderTask.promise;
        if (cancelled) return;
        setDrawnPage({ page: currentPage, scale });
        textLayerInstance = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport,
        });
        await textLayerInstance.render();
        if (!cancelled) {
          setTextLayerReadyTick((n) => n + 1);
        }
      } catch (err) {
        if (!cancelled && !(err instanceof pdfjsLib.RenderingCancelledException)) {
          setError(err instanceof Error ? err.message : 'PDF 页面渲染失败');
        }
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerInstance?.cancel();
    };
  }, [pdfDoc, currentPage, scale, viewMode]);

  // Apply highlighted chain quotes onto rendered PDF textLayer without re-rendering canvas
  const currentPageHighlightQuotes = highlightedEvidences
    .filter((ev) => ev.page === currentPage && ev.quote.trim())
    .map((ev) => ev.quote);
  const highlightPages = Array.from(
    new Set(highlightedEvidences.map((ev) => ev.page).filter((p) => p >= 1)),
  ).sort((a, b) => a - b);

  useEffect(() => {
    if (viewMode !== 'canvas') return;
    applyTextLayerHighlights(textLayerRef.current, currentPageHighlightQuotes);
  }, [viewMode, textLayerReadyTick, currentPage, highlightedEvidences]);

  // Capture text selection inside the PDF / proofreading container
  const handleMouseUpCapture = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const container = viewerRegionRef.current;
    if (!container) return;
    if (!container.contains(sel.anchorNode) && !container.contains(sel.focusNode)) return;
    const cleaned = cleanSelectedPdfQuote(sel.toString());
    if (cleaned.length >= 2) {
      onSelectQuote({ page: currentPage, quote: cleaned });
      setManualQuoteDraft(cleaned);
    }
  };

  const activeQuoteText = selectedQuote?.quote || manualQuoteDraft;
  const activeQuotePage = selectedQuote?.page || currentPage;

  return (
    <section
      aria-label="原件 PDF 阅读与划词取证区"
      className="flex h-full flex-col border-r border-slate-200 bg-slate-100/80"
    >
      {/* Viewer Controls Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <FileText className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <span className="truncate text-xs font-medium text-slate-700" title={sourceFilename}>
            {sourceFilename}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('canvas')}
              className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors ${
                viewMode === 'canvas'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              原件图文
            </button>
            <button
              type="button"
              onClick={() => setViewMode('text')}
              className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors ${
                viewMode === 'text'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              文本校对
            </button>
          </div>

          <div className="flex items-center rounded-md border border-slate-200 bg-white">
            <button
              type="button"
              aria-label="上一页"
              disabled={currentPage <= 1}
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              className="p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono-tabular px-2 text-xs text-slate-700">
              {currentPage} / {numPages || '—'}
            </span>
            <button
              type="button"
              aria-label="下一页"
              disabled={numPages > 0 && currentPage >= numPages}
              onClick={() => onPageChange(Math.min(numPages || currentPage, currentPage + 1))}
              className="p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {viewMode === 'canvas' && (
            <div className="flex items-center rounded-md border border-slate-200 bg-white">
              <button
                type="button"
                aria-label="缩小"
                onClick={() => setScale((s) => Math.max(0.7, Number((s - 0.15).toFixed(2))))}
                className="p-1.5 text-slate-600 hover:bg-slate-50"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="font-mono-tabular px-1.5 text-xs text-slate-700">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                aria-label="放大"
                onClick={() => setScale((s) => Math.min(1.8, Number((s + 0.15).toFixed(2))))}
                className="p-1.5 text-slate-600 hover:bg-slate-50"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {sourceMessage && <p role="status" className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{sourceMessage}</p>}
      {showSource && locatedSource && (
        <div role="status" className="border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950">
          <span className="font-medium">引用原文 · 第 {locatedSource.page} 页</span>
          <blockquote className="mt-1 max-h-16 overflow-auto">{locatedSource.quote}</blockquote>
        </div>
      )}

      {/* Active Evidence Chain Highlight Strip */}
      {highlightedEvidences.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/80 px-3 py-1.5 text-xs text-amber-950">
          <span>
            当前证据链高亮 <strong className="font-mono-tabular">{highlightedEvidences.length}</strong> 条引用
            {currentPageHighlightQuotes.length > 0
              ? ` · 本页命中 ${currentPageHighlightQuotes.length} 条`
              : ' · 当前页无引用'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {highlightPages.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                className={`font-mono-tabular whitespace-nowrap rounded px-1.5 py-0.5 text-xs transition-colors ${
                  p === currentPage
                    ? 'bg-amber-200 font-semibold text-amber-950'
                    : 'text-amber-900 underline-offset-2 hover:underline'
                }`}
              >
                第 {p} 页
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Document Viewport */}
      <div
        ref={viewerRegionRef}
        onMouseUp={handleMouseUpCapture}
        data-testid="pdf-viewport"
        className="flex-1 overflow-auto p-4"
      >
        {loading && (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">
            正在解析与渲染受控 PDF 文档第 {currentPage} 页…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">PDF 加载失败</p>
              <p className="mt-1 text-xs text-red-700">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && viewMode === 'canvas' && (
          <div className="pdf-page-container border border-slate-200">
            <canvas ref={canvasRef} />
            <div ref={textLayerRef} className="pdf-text-layer" />
            {showSource && locatedSource && (
              <div role="img" aria-label={`第 ${currentPage} 页引用原文，已核验 ${locatedSource.lines.length} 行`}
                className="pointer-events-none absolute inset-0 z-[3]">
                {locatedSource.lines.map((line, index) => {
                  const [left, top, right, bottom] = line.bbox;
                  return (
                    <div key={line.lineId} ref={index === 0 ? firstLineRef : undefined}
                      data-source-line={line.lineId}
                      className="absolute rounded-[1px] border border-blue-600 bg-blue-400/25"
                      style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` }}
                    />
                  );
                })}
              </div>
            )}
            <DemoWatermarkOverlay />
          </div>
        )}

        {!loading && !error && viewMode === 'text' && (
          <div className="relative mx-auto max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2 text-xs text-slate-500">
              <span>第 {currentPage} 页文本</span>
              <span className="font-mono-tabular">共 {numPages} 页</span>
            </div>
            {!pageTexts[currentPage] ? (
              <p className="relative z-[1] text-sm text-slate-500">
                （本页未提取到文本层，请切回原件图文查看扫描件）
              </p>
            ) : (
              <div className="relative z-[1] flex flex-col gap-2 text-sm leading-7 text-slate-800 select-text">
                {splitPdfPageIntoParagraphs(pageTexts[currentPage]).map((para, pIdx) => {
                  const ranges = findTextMatchRanges(para, currentPageHighlightQuotes);
                  const isMatched = ranges.length > 0;
                  if (!isMatched) {
                    return (
                      <p key={pIdx} className="rounded px-2 py-0.5">
                        {para}
                      </p>
                    );
                  }
                  const parts: React.ReactNode[] = [];
                  let cursor = 0;
                  ranges.forEach((r, rIdx) => {
                    if (r.start > cursor) {
                      parts.push(para.slice(cursor, r.start));
                    }
                    parts.push(
                      <mark
                        key={rIdx}
                        className="rounded-xs bg-amber-200/80 px-0.5 text-slate-900"
                      >
                        {para.slice(r.start, r.end)}
                      </mark>,
                    );
                    cursor = r.end;
                  });
                  if (cursor < para.length) {
                    parts.push(para.slice(cursor));
                  }
                  return (
                    <p
                      key={pIdx}
                      data-highlighted-paragraph="true"
                      className="rounded border border-amber-300 bg-amber-50/80 px-2.5 py-1 text-slate-900"
                    >
                      {parts}
                    </p>
                  );
                })}
              </div>
            )}
            <DemoWatermarkOverlay />
          </div>
        )}
      </div>

      {/* Evidence Capture Bar */}
      <div className="border-t border-slate-200 bg-white px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span className="shrink-0 whitespace-nowrap">
            划词取证剪贴板 · 第{' '}
            <strong className="font-mono-tabular text-slate-800">{activeQuotePage}</strong> 页
          </span>
          {activeTargetLabel && (
            <span className="truncate text-blue-700">当前目标：{activeTargetLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="证据摘录草稿"
            value={activeQuoteText}
            onChange={(e) => {
              setManualQuoteDraft(e.target.value);
              onSelectQuote(
                e.target.value.trim()
                  ? { page: activeQuotePage, quote: e.target.value }
                  : null,
              );
            }}
            placeholder="在上方 PDF 或文本中划选最短支持原文，或在此输入…"
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
          />
          <button
            type="button"
            disabled={!activeQuoteText.trim() || !activeTargetLabel}
            onClick={() => {
              if (!activeQuoteText.trim()) return;
              onApplyQuoteToTarget(activeQuotePage, activeQuoteText.trim());
            }}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          >
            <CopyCheck className="h-3.5 w-3.5" aria-hidden="true" />
            引用到当前项
          </button>
        </div>
      </div>
    </section>
  );
};
