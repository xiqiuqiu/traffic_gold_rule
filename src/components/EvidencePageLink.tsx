import type { CaseDocument, EventRelationItem, EvidenceItem, FieldRecord, LegalConclusionItem } from '../types/gold';
import { getVerifiedLiabilitySource } from '../utils/liabilitySourceKey';

type EvidenceRecord = FieldRecord | LegalConclusionItem | EventRelationItem;
export type LocateEvidence = (record: EvidenceRecord, evidence: EvidenceItem) => void;

export function EvidencePageLink({ record, evidence, onLocate, editablePage, showQuote }: {
  record: EvidenceRecord;
  evidence: EvidenceItem;
  onLocate: LocateEvidence;
  editablePage?: boolean;
  showQuote?: boolean;
}) {
  const label = `定位第 ${evidence.page} 页原文 · ${evidence.quote}`;
  return (
    <button type="button" aria-label={label} title={label}
      onClick={event => { event.stopPropagation(); onLocate(record, evidence); }}
      className="inline-flex min-w-0 items-baseline gap-1 text-left text-xs text-blue-700 hover:underline focus-visible:underline">
      <span className="font-mono-tabular shrink-0 font-medium">{editablePage ? '定位' : `p.${evidence.page}`}</span>
      {showQuote && <span className="max-w-[220px] truncate text-slate-700">{evidence.quote}</span>}
    </button>
  );
}

export function LiabilitySourceNote({ item, caseDoc, onLocate }: {
  item: LegalConclusionItem;
  caseDoc: CaseDocument;
  onLocate: LocateEvidence;
}) {
  if (item.category !== 'liability' || !item.sourceLocation) return null;
  const source = getVerifiedLiabilitySource(item, caseDoc);
  if (!source) {
    const reason = item.sourceLocation?.status === 'needs_review' ? item.sourceLocation.reason : '请核对原文与当前记录。';
    return <span title={reason} className="text-xs text-amber-800">责任结论待核对</span>;
  }
  if (item.evidences.length) return null;
  return <EvidencePageLink record={item} evidence={{ id: '', page: source.page, quote: source.quote }} onLocate={onLocate} />;
}
