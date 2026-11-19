import { useEffect, useMemo, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { CaseDocument, EventRelationItem, EvidenceItem, FieldRecord, LegalConclusionItem, LiabilitySourceLocation } from '../types/gold';
import type { LiabilityLineSet } from '../server/liabilityEvidence';
import { resolveEvidenceLocation } from './evidenceLocation';
import { getVerifiedLiabilitySource, liabilitySourceKey } from './liabilitySourceKey';
import { readNativeSourceLines } from './pdfNativeSourceLines';

type RecordWithEvidence = FieldRecord | LegalConclusionItem | EventRelationItem;
type Location = NonNullable<ReturnType<typeof resolveEvidenceLocation>>;
type Citation = { record: RecordWithEvidence; evidence: EvidenceItem; context: string; key: string };
type Result = { citation: Citation; location?: Location; message?: string };

function keyFor(record: RecordWithEvidence, ev: EvidenceItem, doc: CaseDocument) {
  return 'category' in record && record.category === 'liability'
    ? liabilitySourceKey(record, doc.entities)
    : JSON.stringify([ev.id, ev.page, ev.quote, ev.lineIds]);
}

export function useEvidenceLocator(
  doc: CaseDocument, taskId: string | null, context: string, focusedKey: string | null,
  goToPage: (page: number) => void,
  saveLiability: (caseId: string, item: LegalConclusionItem, location: LiabilitySourceLocation) => void,
) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const cache = useMemo((): { stored?: LiabilityLineSet | null; digest?: Promise<string> } => ({}), [taskId, doc.pdfUrl, doc.fileSha256, pdf]);
  const target = citation?.record;
  const record = target && ('recordId' in target ? doc.fieldRecords.find(r => r.recordId === target.recordId)
    : 'category' in target ? doc.legalConclusions.find(r => r.id === target.id) : doc.relations.find(r => r.id === target.id));
  const focus = record && ('recordId' in record ? `${record.entityId}:${record.fieldCode}` : record.id);
  const evidence = record?.evidences.find(ev => ev.id === citation?.evidence.id)
    ?? (!record?.evidences.length && citation?.evidence.id === '' ? citation.evidence : undefined);
  const active = citation && citation.context === context && record && focus === focusedKey && evidence &&
    citation.key === keyFor(record, evidence, doc) ? citation : null;
  const visible = active && result?.citation === active ? result : null;

  useEffect(() => {
    if (!active || !evidence || !record) {
      setCitation(null);
      return;
    }
    if (visible) return;
    const controller = new AbortController();
    const { signal } = controller;
    const show = (location: Location) => {
      if (!signal.aborted) { goToPage(location.page); setResult({ citation: active, location }); }
    };
    const showExcerpt = (lines: LiabilityLineSet['lines']) => {
      const location = resolveEvidenceLocation(evidence, lines);
      if (!location) {
        goToPage(evidence.page);
        throw new Error('已打开引用页。未能唯一匹配这条摘录，请核对原文。');
      }
      show(location);
    };
    (async () => {
      const liability = 'category' in record && record.category === 'liability' ? record : null;
      const single = liability !== null && liability.evidences.length <= 1;
      const verified = single && getVerifiedLiabilitySource(liability, doc);
      if (verified) { show(verified); return; }
      if (!Number.isInteger(evidence.page) || evidence.page < 1 || evidence.page > (pdf?.numPages ?? doc.pageCount))
        throw new Error('引用页码超出原件范围，请核对页码。');

      if (taskId && cache.stored === undefined) {
        const response = await fetch(`/api/system/tasks/${encodeURIComponent(taskId)}/source-lines`, { signal });
        if (!response.ok && response.status !== 404) throw new Error('原文行读取失败，请再点页码重试。');
        const stored: LiabilityLineSet | null = response.ok ? await response.json() : null;
        signal.throwIfAborted();
        if (stored && stored.fileSha256 !== doc.fileSha256) throw new Error('该次解析的原件与当前 PDF 不一致。');
        cache.stored = stored;
      }
      let lineSet = cache.stored;
      if (!lineSet) {
        if (!pdf) return; // Resume when the viewer finishes opening this original.
        const lines = await readNativeSourceLines(pdf, evidence.page, signal);
        signal.throwIfAborted();
        if (!lines.length) {
          goToPage(evidence.page);
          throw new Error('已打开引用页。该页没有可定位的文字行。');
        }
        if (!liability) return showExcerpt(lines);
        cache.digest ??= pdf.getData().then(async bytes => {
          const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
          return 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        }).catch(error => { delete cache.digest; throw error; });
        const fileSha256 = await cache.digest;
        const expected = doc.sourceHashFull ? 'sha256:' + doc.sourceHashFull : doc.fileSha256;
        if (/^sha256:[0-9a-f]{64}$/i.test(expected) && expected !== fileSha256)
          throw new Error('原件校验失败，请核对当前 PDF。');
        lineSet = { fileSha256, extractionVersion: 'pdfjs-native-viewer-v1', lines };
      }
      signal.throwIfAborted();
      if (liability) {
        const { resolveLiabilitySource } = await import('../server/liabilityEvidence');
        signal.throwIfAborted();
        const location = resolveLiabilitySource(single ? liability : { ...liability, evidences: [evidence] }, doc.entities, lineSet);
        if (single && cache.stored) saveLiability(doc.caseId, liability, location);
        if (location.status === 'needs_review') throw new Error(location.reason);
        show(location);
      } else {
        showExcerpt(lineSet.lines);
      }
    })().catch(error => {
      if (!signal.aborted) setResult({ citation: active, message: error instanceof Error ? error.message : '原文定位失败，请重试。' });
    });
    return () => controller.abort();
  }, [active, visible, record, evidence, doc, taskId, pdf, cache, goToPage, saveLiability]);

  return {
    locate(record: RecordWithEvidence, evidence: EvidenceItem) {
      setCitation({ record, evidence, context, key: keyFor(record, evidence, doc) });
    },
    clear: () => setCitation(null),
    setPdf,
    active,
    location: visible?.location ?? null,
    message: active && !visible ? '正在定位引用原文…' : visible?.message,
  };
}
