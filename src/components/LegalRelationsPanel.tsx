import { RecordInfo } from './RecordInfo';
import { useCatalogOptions } from './useCatalogOptions';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  GitBranch,
  Link2,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  INITIAL_VOCABULARY_SUPPLEMENTS,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
  REVIEW_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  CausalLinkStatus,
  EventRelationItem,
  LegalCategory,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
  VocabularySupplementItem,
  WorkItemFilterStatus,
} from '../types/gold';
import {
  cleanRelationEntityId,
  extractPdfParagraphMatches,
  findTextMatchRanges,
  getScopedCauseCandidatesForLiability,
  getScopedViolationCandidatesForCause,
  matchesWorkItemStatus,
  hasLiabilityScopeConflict,
  sortLegalConclusionsByChain,
  traceLegalEvidenceChain,
  validateLegalConclusion,
  validateRelation,
} from '../utils/goldRules';
import { EvidencePageLink, LiabilitySourceNote, type LocateEvidence } from './EvidencePageLink';
import { nextLiabilityScope } from '../utils/nextLiabilityScope';
import { ControlledVocabCombobox } from './ControlledVocabCombobox';
import { ReviewLifecycleBar, getCardStatusBorderClass } from './ReviewLifecycleBar';
import { ViolationLinkConsistencyBox } from './ViolationLinkConsistencyBox';

interface HighlightedEvidenceInput {
  page: number;
  quote: string;
  label?: string;
}

interface LegalRelationsPanelProps {
  caseDoc: CaseDocument;
  userRole: UserRole;
  supplements?: VocabularySupplementItem[];
  selectedPdfQuote: { page: number; quote: string } | null;
  pdfPageTexts?: Record<number, string>;
  activeTargetId: string | null;
  onFocusTarget: (id: string, label: string, reveal?: boolean) => void;
  onJumpToPage: (page: number) => void;
  onLocateEvidence: LocateEvidence;
  onHighlightEvidences?: (items: HighlightedEvidenceInput[]) => void;
  onJumpToEntityField?: (entityId: string, fieldCode?: string) => void;
  onSaveLegalItem: (item: LegalConclusionItem, auditNote?: string) => void;
  onDeleteLegalItem: (id: string) => void;
  onSaveRelationItem: (item: EventRelationItem, auditNote?: string) => void;
  onDeleteRelationItem: (id: string) => void;
  externalFocusRequest?: { subTab: 'legal' | 'evidence_chain' | 'relations'; nonce: number } | null;
}

const HighlightedQuoteText: React.FC<{ text: string; quotes: string[] }> = ({ text, quotes }) => {
  const ranges = useMemo(() => findTextMatchRanges(text, quotes), [text, quotes]);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, idx) => {
    if (r.start > cursor) {
      parts.push(<React.Fragment key={`t-${idx}`}>{text.slice(cursor, r.start)}</React.Fragment>);
    }
    parts.push(
      <mark
        key={`m-${idx}`}
        className="rounded-xs bg-amber-200/80 px-0.5 font-medium text-slate-950"
      >
        {text.slice(r.start, r.end)}
      </mark>,
    );
    cursor = r.end;
  });
  if (cursor < text.length) {
    parts.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>);
  }
  return <>{parts}</>;
};

const CATEGORY_LABELS: Record<LegalCategory, { title: string; fieldCode: string; hint: string }> = {
  violation: {
    title: '认定违法行为',
    fieldCode: 'D10.F058',
    hint: '每项违法单独记录，挂在文书指明的参与方或组织上；一人可有多项违法。',
  },
  cause: {
    title: '认定事故原因',
    fieldCode: 'D10.F059',
    hint: '只记录文书明确认定的原因。违法与原因同时出现不代表自动因果，严禁补推断。',
  },
  liability: {
    title: '事故责任划分',
    fieldCode: 'D10.F060',
    hint: '同一主体在同一事故阶段记录一条责任结论。文书写明“无责任”时同样属于有明确记载的责任结果。',
  },
};

const CAUSAL_LINK_OPTIONS: Array<{ value: CausalLinkStatus; label: string }> = [
  { value: 'unspecified', label: '未明确' },
  { value: 'explicit_linked', label: '明确关联违法' },
  { value: 'explicit_unlinked', label: '明确无直接因果' },
  { value: 'multiple_mixed', label: '多因混合' },
];

const RELATION_FIELD_CODES = [
  { code: 'D08.F049', label: 'D08.F049 · 主客体碰撞关系' },
  { code: 'D08.F048', label: 'D08.F048 · 碰撞方式' },
  { code: 'D08.F047', label: 'D08.F047 · 事件阶段顺序' },
];

export const LegalRelationsPanel: React.FC<LegalRelationsPanelProps> = ({
  caseDoc,
  userRole,
  supplements = INITIAL_VOCABULARY_SUPPLEMENTS,
  selectedPdfQuote,
  pdfPageTexts = {},
  activeTargetId,
  onFocusTarget,
  onJumpToPage,
  onLocateEvidence,
  onHighlightEvidences,
  onJumpToEntityField,
  onSaveLegalItem,
  onDeleteLegalItem,
  onSaveRelationItem,
  onDeleteRelationItem,
  externalFocusRequest,
}) => {
  const buildControlledVocabOptions = useCatalogOptions();
  const [subTab, setSubTab] = useState<'legal' | 'evidence_chain' | 'relations'>('legal');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | LegalCategory>('ALL');
  const [subjectFilter, setSubjectFilter] = useState<'ALL' | string>('ALL');
  const [statusFilter, setStatusFilter] = useState<WorkItemFilterStatus>('all');
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [showAllParagraphs, setShowAllParagraphs] = useState<boolean>(false);
  const [expandedCrossSubjectMap, setExpandedCrossSubjectMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (externalFocusRequest) {
      setSubTab(externalFocusRequest.subTab);
      setCategoryFilter('ALL');
      setSubjectFilter('ALL');
      setStatusFilter('all');
    }
  }, [externalFocusRequest]);

  const subjects = caseDoc.entities.filter((e) => e.kind === 'P' || e.kind === 'O');
  const events = caseDoc.entities.filter((e) => e.kind === 'E');
  const allTargets = caseDoc.entities;
  const effectiveSubjectFilter =
    subjectFilter === 'ALL' || subjects.some((s) => s.id === subjectFilter)
      ? subjectFilter
      : 'ALL';

  const violationRecords = caseDoc.legalConclusions.filter((l) => l.category === 'violation');
  const causeRecords = caseDoc.legalConclusions.filter((l) => l.category === 'cause');
  const liabilityRecords = caseDoc.legalConclusions.filter((l) => l.category === 'liability');

  const availableScope = nextLiabilityScope(
    effectiveSubjectFilter === 'ALL' ? subjects.map(s => s.id) : [effectiveSubjectFilter],
    events.map(e => e.id), liabilityRecords,
  );

  const schemaNameByCode = useMemo(
    () => new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f.fieldName])),
    [],
  );

  // Keep a valid default anchor when in Evidence Chain view or switching cases
  const resolvedChainAnchorId = useMemo(() => {
    if (
      selectedChainId &&
      caseDoc.legalConclusions.some((l) => l.id === selectedChainId)
    ) {
      return selectedChainId;
    }
    return (
      violationRecords[0]?.id ||
      liabilityRecords[0]?.id ||
      caseDoc.legalConclusions[0]?.id ||
      null
    );
  }, [selectedChainId, caseDoc.legalConclusions, violationRecords, liabilityRecords]);

  const activeChain = useMemo(
    () =>
      resolvedChainAnchorId
        ? traceLegalEvidenceChain(caseDoc, resolvedChainAnchorId)
        : null,
    [caseDoc, resolvedChainAnchorId],
  );

  // A responsibility quotation can recur for several parties; only verified line boxes may mark it.
  const searchableCitations = useMemo(
    () => activeChain?.evidences.filter(ev => ev.sourceKind !== 'liability') || [],
    [activeChain],
  );
  useEffect(() => {
    onHighlightEvidences?.(subTab === 'evidence_chain'
      ? searchableCitations.map(ev => ({ page: ev.page, quote: ev.quote, label: ev.sourceLabel })) : []);
    return () => onHighlightEvidences?.([]);
  }, [subTab, searchableCitations, onHighlightEvidences]);

  const matchedParagraphs = useMemo(
    () => extractPdfParagraphMatches(pdfPageTexts, searchableCitations),
    [pdfPageTexts, searchableCitations],
  );

  const visibleParagraphs = useMemo(() => {
    const hits = matchedParagraphs.filter((p) => p.matchedEvidences.length > 0);
    if (showAllParagraphs) return matchedParagraphs;
    return hits;
  }, [matchedParagraphs, showAllParagraphs]);

  const handleSelectChainAnchor = (item: LegalConclusionItem, switchToChainTab = false) => {
    setSelectedChainId(item.id);
    if (switchToChainTab) {
      setSubTab('evidence_chain');
    }
    const catMeta = CATEGORY_LABELS[item.category];
    onFocusTarget(item.id, `${catMeta.title} (${item.id})`);
  };

  const handleAddLegal = (category: LegalCategory) => {
    const preferredSubjectId =
      effectiveSubjectFilter !== 'ALL' ? effectiveSubjectFilter : subjects[0]?.id || 'P01';
    if (category === 'liability' && !availableScope) {
      const existing = liabilityRecords.find(item => effectiveSubjectFilter === 'ALL' || item.subjectId === effectiveSubjectFilter);
      if (existing) onFocusTarget(existing.id, `${CATEGORY_LABELS.liability.title} (${existing.id})`);
      return;
    }

    const newItem: LegalConclusionItem = {
      id: `${category === 'violation' ? 'VIO' : category === 'cause' ? 'CAU' : 'LIA'}-${Date.now().toString(36)}`,
      category,
      subjectId: category === 'liability' ? availableScope!.subjectId : preferredSubjectId,
      eventId: category === 'liability' ? availableScope!.eventId : events[0]?.id || '',
      presenceStatus: 'present',
      rawText: '',
      lawArticle: '',
      conclusionLabel: category === 'liability' ? '全部责任' : '',
      ...(category !== 'liability'
        ? { causalLinkStatus: 'unspecified' as CausalLinkStatus, linkedViolationIds: [] }
        : { linkedCauseIds: [] }),
      ...(category === 'violation'
        ? { linkedEntityIds: [], linkedVocabTerms: [], linkConsistencyConfirmed: false }
        : {}),
      evidences: selectedPdfQuote
        ? [{ id: `EV-${Date.now().toString(36)}`, page: selectedPdfQuote.page, quote: selectedPdfQuote.quote }]
        : [],
      reviewStatus: 'draft',
      disputeReason: '',
      adjudicatorNote: '',
    };
    onSaveLegalItem(newItem);
    onFocusTarget(newItem.id, `${CATEGORY_LABELS[category].title} (${newItem.id})`);
  };

  const handleAddRelation = () => {
    const nextOrder = caseDoc.relations.length + 1;
    const newRel: EventRelationItem = {
      id: `REL-${Date.now().toString(36)}`,
      fieldCode: 'D08.F049',
      eventId: events[0]?.id || 'E01',
      stageOrder: nextOrder,
      sourceId: caseDoc.entities.find((e) => e.kind === 'V')?.id || 'P01',
      action: '撞击',
      relationType: '追尾碰撞',
      targetId: caseDoc.entities.filter((e) => e.kind === 'V' || e.kind === 'P')[1]?.id || 'R01',
      collisionMode: '追尾碰撞',
      directionNote: '',
      presenceStatus: 'present',
      evidences: selectedPdfQuote
        ? [{ id: `EV-${Date.now().toString(36)}`, page: selectedPdfQuote.page, quote: selectedPdfQuote.quote }]
        : [],
      reviewStatus: 'draft',
      disputeReason: '',
      adjudicatorNote: '',
    };
    onSaveRelationItem(newRel);
    onFocusTarget(newRel.id, `事件关系 (${newRel.id})`);
  };

  const categoryFilteredLegal = useMemo(
    () =>
      caseDoc.legalConclusions.filter(
        (item) =>
          (categoryFilter === 'ALL' || item.category === categoryFilter) &&
          (effectiveSubjectFilter === 'ALL' || item.subjectId === effectiveSubjectFilter),
      ),
    [caseDoc.legalConclusions, categoryFilter, effectiveSubjectFilter],
  );

  const legalStatusCounts = useMemo(() => {
    const counts: Record<WorkItemFilterStatus, number> = {
      all: categoryFilteredLegal.length,
      pending_action: 0,
      draft: 0,
      disputed: 0,
      blocking_or_error: 0,
      checked: 0,
      specialist_review: 0,
    };
    for (const item of categoryFilteredLegal) {
      const hasBlockingOrError =
        PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
        validateLegalConclusion(item, {
          entities: caseDoc.entities,
          supplements,
          allLegalConclusions: caseDoc.legalConclusions,
        }).some((i) => i.severity === 'error');
      const arg = {
        reviewStatus: item.reviewStatus,
        presenceStatus: item.presenceStatus,
        hasBlockingOrError,
      };
      if (matchesWorkItemStatus(arg, 'pending_action')) counts.pending_action += 1;
      if (matchesWorkItemStatus(arg, 'draft')) counts.draft += 1;
      if (matchesWorkItemStatus(arg, 'disputed')) counts.disputed += 1;
      if (matchesWorkItemStatus(arg, 'blocking_or_error')) counts.blocking_or_error += 1;
      if (matchesWorkItemStatus(arg, 'checked')) counts.checked += 1;
      if (matchesWorkItemStatus(arg, 'specialist_review')) counts.specialist_review += 1;
    }
    return counts;
  }, [categoryFilteredLegal, caseDoc.entities, caseDoc.legalConclusions, supplements]);

  const filteredLegal = useMemo(
    () =>
      sortLegalConclusionsByChain(
        categoryFilteredLegal.filter((item) => {
          const hasBlockingOrError =
            PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
            validateLegalConclusion(item, {
              entities: caseDoc.entities,
              supplements,
              allLegalConclusions: caseDoc.legalConclusions,
            }).some((i) => i.severity === 'error');
          return matchesWorkItemStatus(
            {
              reviewStatus: item.reviewStatus,
              presenceStatus: item.presenceStatus,
              hasBlockingOrError,
            },
            statusFilter,
          );
        }),
      ),
    [categoryFilteredLegal, statusFilter, caseDoc.entities, caseDoc.legalConclusions, supplements],
  );

  const relationStatusCounts = useMemo(() => {
    const counts: Record<WorkItemFilterStatus, number> = {
      all: caseDoc.relations.length,
      pending_action: 0,
      draft: 0,
      disputed: 0,
      blocking_or_error: 0,
      checked: 0,
      specialist_review: 0,
    };
    for (const rel of caseDoc.relations) {
      const presence = rel.presenceStatus || 'present';
      const hasBlockingOrError =
        PRESENCE_STATUS_META[presence].blocksScoring ||
        validateRelation(rel).some((i) => i.severity === 'error');
      const arg = {
        reviewStatus: rel.reviewStatus,
        presenceStatus: presence,
        hasBlockingOrError,
      };
      if (matchesWorkItemStatus(arg, 'pending_action')) counts.pending_action += 1;
      if (matchesWorkItemStatus(arg, 'draft')) counts.draft += 1;
      if (matchesWorkItemStatus(arg, 'disputed')) counts.disputed += 1;
      if (matchesWorkItemStatus(arg, 'blocking_or_error')) counts.blocking_or_error += 1;
      if (matchesWorkItemStatus(arg, 'checked')) counts.checked += 1;
      if (matchesWorkItemStatus(arg, 'specialist_review')) counts.specialist_review += 1;
    }
    return counts;
  }, [caseDoc.relations]);

  const filteredRelations = useMemo(
    () =>
      caseDoc.relations
        .filter((rel) => {
          const presence = rel.presenceStatus || 'present';
          const hasBlockingOrError =
            PRESENCE_STATUS_META[presence].blocksScoring ||
            validateRelation(rel).some((i) => i.severity === 'error');
          return matchesWorkItemStatus(
            {
              reviewStatus: rel.reviewStatus,
              presenceStatus: presence,
              hasBlockingOrError,
            },
            statusFilter,
          );
        })
        .slice()
        .sort((a, b) => a.stageOrder - b.stageOrder),
    [caseDoc.relations, statusFilter],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-slate-100 p-0.5">
          <button
            type="button"
            onClick={() => setSubTab('legal')}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === 'legal' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            违法 / 原因 / 责任 ({caseDoc.legalConclusions.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('evidence_chain')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === 'evidence_chain'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
            证据链视图
          </button>
          <button
            type="button"
            onClick={() => setSubTab('relations')}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === 'relations' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            事件顺序与碰撞关系 ({caseDoc.relations.length})
          </button>
        </div>

        {subTab === 'legal' ? (
          <div className="flex flex-wrap items-center gap-3">
            {(['violation', 'cause', 'liability'] as LegalCategory[]).map((cat) => {
              const isExisting = cat === 'liability' && !availableScope && subjects.length > 0;
              return (
                <button
                  key={cat}
                  type="button"
                  disabled={cat === 'liability' && !subjects.length}
                  title={isExisting ? '所选主体各阶段的责任记录均已建立，点击查看。' : undefined}
                  onClick={() => handleAddLegal(cat)}
                  className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium ${
                    isExisting
                      ? 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      : 'text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
                  }`}
                >
                  {isExisting ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-700" />
                      已有责任记录
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      新增{CATEGORY_LABELS[cat].title.replace('认定', '').replace('划分', '')}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ) : subTab === 'relations' ? (
          <button
            type="button"
            onClick={handleAddRelation}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            新增碰撞 / 事件关系
          </button>
        ) : null}
      </div>

      {/* Legal Conclusions List */}
      {subTab === 'legal' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-4 pt-3 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="sr-only">结论类别</span>
                <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                  {(['ALL', 'violation', 'cause', 'liability'] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      aria-pressed={categoryFilter === cat}
                      onClick={() => setCategoryFilter(cat)}
                      className={`whitespace-nowrap rounded px-2.5 py-1 font-medium transition-colors ${
                        categoryFilter === cat
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {cat === 'ALL' ? '全部' : CATEGORY_LABELS[cat].title}
                    </button>
                  ))}
                </div>
              </div>
              {subjects.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">

                  <select
                    aria-label="法律结论主体筛选"
                    value={effectiveSubjectFilter}
                    onChange={(e) => setSubjectFilter(e.target.value)}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800"
                  >
                    <option value="ALL">全部主体 ({caseDoc.legalConclusions.length})</option>
                    {subjects.map((subj) => {
                      const subjCount = caseDoc.legalConclusions.filter(
                        (l) => l.subjectId === subj.id,
                      ).length;
                      return (
                        <option key={subj.id} value={subj.id}>
                          {subj.id} · {subj.label} ({subjCount})
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-2 text-xs">
              <span className="pb-1.5 text-slate-500">审核状态</span>
              {(
                [
                  ['all', '全部'],
                  ['pending_action', '待处理'],
                  ['draft', '草稿'],
                  ['disputed', '争议中'],
                  ['blocking_or_error', '阻断/报错'],
                  ['checked', '已复核'],
                  ['specialist_review', '专业裁定'],
                ] as Array<[WorkItemFilterStatus, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={statusFilter === key}
                  onClick={() => setStatusFilter(key)}
                  className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 transition-colors ${
                    statusFilter === key
                      ? 'border-slate-900 font-semibold text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  <span>{label}</span>
                  <span className="font-mono-tabular text-[11px] opacity-75">
                    ({legalStatusCounts[key]})
                  </span>
                </button>
              ))}
            </div>
          </div>

          {filteredLegal.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              没有匹配的法律结论
            </div>
          )}

          {filteredLegal.map((item) => {
            const catMeta = CATEGORY_LABELS[item.category];
            const issues = validateLegalConclusion(item, {
              entities: caseDoc.entities,
              supplements,
              allLegalConclusions: caseDoc.legalConclusions,
            });
            const hasError =
              PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
              issues.some((i) => i.severity === 'error');
            const focused = activeTargetId === item.id;
            const saveEditedLegal = (patch: Partial<LegalConclusionItem>) => {
              onSaveLegalItem({
                ...item,
                ...patch,
                ...(item.category === 'violation'
                  ? { linkConsistencyConfirmed: false, linkConsistencyFingerprint: '' }
                  : {}),
              });
            };
            const scopedViolations = getScopedViolationCandidatesForCause(item, violationRecords);
            const scopedCauses = getScopedCauseCandidatesForLiability(item, causeRecords);
            const isCrossVioExpanded = !!expandedCrossSubjectMap[`${item.id}:vio`];
            const isCrossCauExpanded = !!expandedCrossSubjectMap[`${item.id}:cau`];
            const referencingCauses =
              item.category === 'violation'
                ? causeRecords.filter((c) => (c.linkedViolationIds || []).includes(item.id))
                : [];
            const handleCreateLinkedViolation = () => {
              const newVioId = `VIO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
              const newVio: LegalConclusionItem = {
                id: newVioId,
                category: 'violation',
                subjectId: item.subjectId,
                eventId: item.eventId || events[0]?.id || '',
                presenceStatus: 'present',
                rawText: '',
                lawArticle: '',
                conclusionLabel: '',
                causalLinkStatus: 'explicit_linked',
                linkedViolationIds: [],
                linkedEntityIds: [],
                linkedVocabTerms: [],
                linkConsistencyConfirmed: false,
                evidences: selectedPdfQuote
                  ? [
                      {
                        id: `EV-${Date.now().toString(36)}`,
                        page: selectedPdfQuote.page,
                        quote: selectedPdfQuote.quote,
                      },
                    ]
                  : [],
                reviewStatus: 'draft',
                disputeReason: '',
                adjudicatorNote: '',
              };
              onSaveLegalItem(newVio, `补录并关联违法行为 ${newVioId}`);
              const nextLinked = Array.from(
                new Set([...(item.linkedViolationIds || []), newVioId]),
              );
              const nextCausalStatus: CausalLinkStatus =
                !item.causalLinkStatus || item.causalLinkStatus === 'unspecified'
                  ? 'explicit_linked'
                  : item.causalLinkStatus;
              onSaveLegalItem({
                ...item,
                causalLinkStatus: nextCausalStatus,
                linkedViolationIds: nextLinked,
              });
              onFocusTarget(newVioId, `${CATEGORY_LABELS.violation.title} (${newVioId})`);
            };
            const handleCreateLinkedCause = (fromViolation?: LegalConclusionItem) => {
              const newCauId = `CAU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
              const newCau: LegalConclusionItem = {
                id: newCauId,
                category: 'cause',
                subjectId: item.subjectId,
                eventId: item.eventId || events[0]?.id || '',
                presenceStatus: 'present',
                rawText: '',
                lawArticle: '',
                conclusionLabel: '',
                causalLinkStatus: fromViolation ? 'explicit_linked' : 'unspecified',
                linkedViolationIds: fromViolation ? [fromViolation.id] : [],
                evidences: selectedPdfQuote
                  ? [
                      {
                        id: `EV-${Date.now().toString(36)}`,
                        page: selectedPdfQuote.page,
                        quote: selectedPdfQuote.quote,
                      },
                    ]
                  : [],
                reviewStatus: 'draft',
                disputeReason: '',
                adjudicatorNote: '',
              };
              onSaveLegalItem(newCau, `补录并关联认定原因 ${newCauId}`);
              if (item.category === 'liability') {
                onSaveLegalItem({
                  ...item,
                  linkedCauseIds: Array.from(
                    new Set([...(item.linkedCauseIds || []), newCauId]),
                  ),
                });
              }
              onFocusTarget(newCauId, `${CATEGORY_LABELS.cause.title} (${newCauId})`);
            };

            return (
              <div
                key={item.id}
                data-focus-id={item.id}
                onClick={() => onFocusTarget(item.id, `${catMeta.title} (${item.id})`, false)}
                className={`rounded-lg border p-4 transition-colors ${getCardStatusBorderClass(
                  item.reviewStatus,
                  hasError,
                  focused,
                )}`}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2 text-xs">
                    <h3 className="text-sm font-semibold text-slate-900">{catMeta.title}</h3>
                    <RecordInfo label={`${catMeta.title}的记录信息`} rows={[['记录编号', item.id], ['字段编码', catMeta.fieldCode]]} />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectChainAnchor(item, true);
                      }}
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                    >
                      <GitBranch className="h-3 w-3" aria-hidden="true" />
                      证据链
                    </button>
                    <ReviewLifecycleBar
                      reviewStatus={item.reviewStatus}
                      hasError={hasError}
                    />
                    <button
                      type="button"
                      aria-label={`删除 ${item.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteLegalItem(item.id);
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      归属主体 (P/O)
                    </label>
                    <select
                      value={item.subjectId}
                      onChange={(e) => saveEditedLegal({ subjectId: e.target.value })}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
                    >
                      {subjects.map((s) => {
                        const alreadyHasLiability =
                          item.category === 'liability' &&
                          s.id !== item.subjectId &&
                          liabilityRecords.some(other => hasLiabilityScopeConflict(other, { subjectId: s.id, eventId: item.eventId }));
                        return (
                          <option key={s.id} value={s.id} disabled={alreadyHasLiability}>
                            {s.id} · {s.label}
                            {alreadyHasLiability ? ' (本阶段已有责任)' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      对应阶段事件 (E)
                    </label>
                    <select
                      value={item.eventId}
                      onChange={(e) => saveEditedLegal({ eventId: e.target.value })}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
                    >
                      <option value="">整起事故 (ACC)</option>
                      {events.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {ev.id} · {ev.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      存在性状态
                    </label>
                    <select
                      value={item.presenceStatus}
                      onChange={(e) =>
                        saveEditedLegal({
                          presenceStatus: e.target.value as PresenceStatus,
                        })
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
                    >
                      {(Object.keys(PRESENCE_STATUS_META) as PresenceStatus[]).map((st) => (
                        <option key={st} value={st}>
                          {PRESENCE_STATUS_META[st].label} ({st})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      标准结论
                    </label>
                    {(() => {
                      const legalFieldCode =
                        item.category === 'violation'
                          ? 'D10.F058'
                          : item.category === 'cause'
                            ? 'D10.F059'
                            : 'D10.F060';
                      const legalDef = MASTER_FIELD_SCHEMA.find(
                        (f) => f.fieldCode === legalFieldCode,
                      );
                      const legalSupp = supplements.find(
                        (s) => s.fieldCode === legalFieldCode,
                      );
                      const legalVocabOptions = legalDef
                        ? buildControlledVocabOptions(legalDef, legalSupp)
                        : [];
                      const legalPlaceholder =
                        item.category === 'liability'
                          ? '全部责任 / 主要责任 / 次要责任 / 无责任'
                          : item.category === 'cause'
                            ? '根本原因 / 全部原因 / 主要原因 / 次要原因'
                            : '检索标准违法词表或输入自定义结论…';
                      return (
                        <ControlledVocabCombobox
                          compact
                          ariaLabel={`${item.id} 标准结论`}
                          options={legalVocabOptions}
                          selectedValues={item.conclusionLabel ? [item.conclusionLabel] : []}
                          allowCustomInput
                          onChangeValues={(vals) =>
                            saveEditedLegal({ conclusionLabel: vals[0] || '' })
                          }
                          placeholder={legalPlaceholder}
                        />
                      );
                    })()}
                  </div>
                </div>

                {/* v0.2 Causal Link & Responsibility-Cause Link Controls */}
                {item.category !== 'liability' ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-slate-50/70 p-2.5 sm:grid-cols-12">
                    <div className="sm:col-span-5">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        因果关联状态
                      </label>
                      <select
                        value={item.causalLinkStatus || 'unspecified'}
                        onChange={(e) =>
                          onSaveLegalItem({
                            ...item,
                            causalLinkStatus: e.target.value as CausalLinkStatus,
                          })
                        }
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                      >
                        {CAUSAL_LINK_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {item.category === 'violation' && (
                      <div className="sm:col-span-7">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-700">
                            被认定原因引用
                          </span>
                          {item.presenceStatus === 'present' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCreateLinkedCause(item);
                              }}
                              className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                            >
                              <Plus className="h-3 w-3" />
                              基于此违法补录原因
                            </button>
                          )}
                        </div>
                        {referencingCauses.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            {item.presenceStatus === 'explicit_negative'
                              ? '明确无违法，不产生因果引用'
                              : '尚未被认定原因记录引用'}
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {referencingCauses.map((cau) => (
                              <button
                                key={cau.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFocusTarget(
                                    cau.id,
                                    `${CATEGORY_LABELS.cause.title} (${cau.id})`,
                                  );
                                }}
                                className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-900 hover:bg-blue-100"
                              >
                                <span className="font-mono-tabular">{cau.id}</span>
                                <span>({cau.conclusionLabel || '已关联'})</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {item.category === 'cause' && (
                      <div className="sm:col-span-7">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-700">
                            关联违法记录
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCreateLinkedViolation();
                            }}
                            className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                          >
                            <Plus className="h-3 w-3" />
                            补录违法行为并关联
                          </button>
                        </div>
                        {scopedViolations.primaryItems.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            当前主体 {item.subjectId} 暂无可关联的违法记录
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {scopedViolations.primaryItems.map((vio) => {
                              const linked = (item.linkedViolationIds || []).includes(vio.id);
                              return (
                                <label
                                  key={vio.id}
                                  className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                    linked
                                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                                      : 'border-slate-200 bg-white text-slate-700'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={linked}
                                    onChange={(e) => {
                                      const current = item.linkedViolationIds || [];
                                      const next = e.target.checked
                                        ? [...current, vio.id]
                                        : current.filter((x) => x !== vio.id);
                                      const nextCausalStatus: CausalLinkStatus =
                                        e.target.checked &&
                                        (!item.causalLinkStatus ||
                                          item.causalLinkStatus === 'unspecified')
                                          ? 'explicit_linked'
                                          : item.causalLinkStatus || 'unspecified';
                                      onSaveLegalItem({
                                        ...item,
                                        causalLinkStatus: nextCausalStatus,
                                        linkedViolationIds: next,
                                      });
                                    }}
                                    className="h-3 w-3 accent-blue-700"
                                  />
                                  <span className="font-mono-tabular">{vio.id}</span>
                                  <span className="max-w-[140px] truncate">
                                    ({vio.subjectId} · {vio.conclusionLabel || '未填'})
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                        {scopedViolations.otherItems.length > 0 && (
                          <div className="mt-1.5 border-t border-slate-200/70 pt-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedCrossSubjectMap((prev) => ({
                                  ...prev,
                                  [`${item.id}:vio`]: !prev[`${item.id}:vio`],
                                }));
                              }}
                              className="text-[11px] font-medium text-slate-500 hover:text-slate-800 hover:underline"
                            >
                              {isCrossVioExpanded
                                ? '收起其他主体违法记录'
                                : `显示其他主体违法 (+${scopedViolations.otherItems.length})`}
                            </button>
                            {isCrossVioExpanded && (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {scopedViolations.otherItems.map((vio) => {
                                  const linked = (item.linkedViolationIds || []).includes(vio.id);
                                  return (
                                    <label
                                      key={vio.id}
                                      className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                        linked
                                          ? 'border-blue-600 bg-blue-50 text-blue-900'
                                          : 'border-slate-200 bg-white text-slate-600'
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={linked}
                                        onChange={(e) => {
                                          const current = item.linkedViolationIds || [];
                                          const next = e.target.checked
                                            ? [...current, vio.id]
                                            : current.filter((x) => x !== vio.id);
                                          const nextCausalStatus: CausalLinkStatus =
                                            e.target.checked &&
                                            (!item.causalLinkStatus ||
                                              item.causalLinkStatus === 'unspecified')
                                              ? 'multiple_mixed'
                                              : item.causalLinkStatus || 'unspecified';
                                          onSaveLegalItem({
                                            ...item,
                                            causalLinkStatus: nextCausalStatus,
                                            linkedViolationIds: next,
                                          });
                                        }}
                                        className="h-3 w-3 accent-blue-700"
                                      />
                                      <span className="font-mono-tabular">{vio.id}</span>
                                      <span className="max-w-[140px] truncate">
                                        ({vio.subjectId} · {vio.conclusionLabel || '未填'})
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 rounded-md border border-slate-200 bg-slate-50/70 p-2.5">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700">
                        责任依据的认定原因
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCreateLinkedCause();
                        }}
                        className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                      >
                        <Plus className="h-3 w-3" />
                        补录认定原因并关联
                      </button>
                    </div>
                    {scopedCauses.primaryItems.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        当前主体 {item.subjectId} 暂无可关联的认定原因
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {scopedCauses.primaryItems.map((cau) => {
                          const linked = (item.linkedCauseIds || []).includes(cau.id);
                          return (
                            <label
                              key={cau.id}
                              className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                linked
                                  ? 'border-blue-600 bg-blue-50 text-blue-900'
                                  : 'border-slate-200 bg-white text-slate-700'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={linked}
                                onChange={(e) => {
                                  const current = item.linkedCauseIds || [];
                                  const next = e.target.checked
                                    ? [...current, cau.id]
                                    : current.filter((x) => x !== cau.id);
                                  onSaveLegalItem({ ...item, linkedCauseIds: next });
                                }}
                                className="h-3 w-3 accent-blue-700"
                              />
                              <span className="font-mono-tabular">{cau.id}</span>
                              <span className="max-w-[160px] truncate">
                                ({cau.subjectId} · {cau.conclusionLabel || '未填'})
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {scopedCauses.otherItems.length > 0 && (
                      <div className="mt-1.5 border-t border-slate-200/70 pt-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedCrossSubjectMap((prev) => ({
                              ...prev,
                              [`${item.id}:cau`]: !prev[`${item.id}:cau`],
                            }));
                          }}
                          className="text-[11px] font-medium text-slate-500 hover:text-slate-800 hover:underline"
                        >
                          {isCrossCauExpanded
                            ? '收起其他主体原因记录'
                            : `显示其他主体原因 (+${scopedCauses.otherItems.length})`}
                        </button>
                        {isCrossCauExpanded && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {scopedCauses.otherItems.map((cau) => {
                              const linked = (item.linkedCauseIds || []).includes(cau.id);
                              return (
                                <label
                                  key={cau.id}
                                  className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                    linked
                                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                                      : 'border-slate-200 bg-white text-slate-600'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={linked}
                                    onChange={(e) => {
                                      const current = item.linkedCauseIds || [];
                                      const next = e.target.checked
                                        ? [...current, cau.id]
                                        : current.filter((x) => x !== cau.id);
                                      onSaveLegalItem({ ...item, linkedCauseIds: next });
                                    }}
                                    className="h-3 w-3 accent-blue-700"
                                  />
                                  <span className="font-mono-tabular">{cau.id}</span>
                                  <span className="max-w-[160px] truncate">
                                    ({cau.subjectId} · {cau.conclusionLabel || '未填'})
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {item.category !== 'cause' && (
                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      援引法律条款原文
                    </label>
                    <input
                      type="text"
                      value={item.lawArticle}
                      onChange={(e) => saveEditedLegal({ lawArticle: e.target.value })}
                      placeholder="如：《中华人民共和国道路交通安全法》第四十三条第一款"
                      className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                )}

                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    文书原文结论
                  </label>
                  <textarea
                    rows={2}
                    value={item.rawText}
                    onChange={(e) => saveEditedLegal({ rawText: e.target.value })}
                    placeholder={
                      item.category === 'violation'
                        ? '按文书原文录入违法行为；系统将自动扫描受控词表与案件实体…'
                        : '按文书表达完整摘记，不得改变否定词或责任限定语…'
                    }
                    className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </div>

                {item.category === 'violation' && (
                  <ViolationLinkConsistencyBox
                    item={item}
                    entities={caseDoc.entities}
                    supplements={supplements}
                    onUpdateItem={onSaveLegalItem}
                  />
                )}

                {/* Evidence Box */}
                <div className="mt-3 rounded border border-slate-200 bg-slate-50/60 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-700">证据摘录</span>
                      <LiabilitySourceNote item={item} caseDoc={caseDoc} onLocate={onLocateEvidence} />
                    </div>
                    <button
                      type="button"
                      disabled={!selectedPdfQuote?.quote.trim()}
                      onClick={() => {
                        if (!selectedPdfQuote?.quote.trim()) return;
                        onSaveLegalItem({
                          ...item,
                          evidences: [
                            ...item.evidences,
                            {
                              id: `EV-${Date.now().toString(36)}`,
                              page: selectedPdfQuote.page,
                              quote: selectedPdfQuote.quote.trim(),
                            },
                          ],
                        });
                      }}
                      className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                    >
                      <Link2 className="h-3 w-3" />
                      引用左侧选区
                    </button>
                  </div>
                  {item.evidences.map((ev) => (
                    <div key={ev.id} className="mt-1 flex items-center gap-2 text-xs">
                      <EvidencePageLink record={item} evidence={ev} onLocate={onLocateEvidence} />
                      <input
                        type="text"
                        value={ev.quote}
                        onChange={(e) =>
                          onSaveLegalItem({
                            ...item,
                            evidences: item.evidences.map((x) =>
                              x.id === ev.id ? { ...x, quote: e.target.value } : x,
                            ),
                          })
                        }
                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
                      />
                      <button
                        type="button"
                        aria-label="删除证据"
                        onClick={() =>
                          onSaveLegalItem({
                            ...item,
                            evidences: item.evidences.filter((x) => x.id !== ev.id),
                          })
                        }
                        className="p-1 text-slate-400 hover:text-red-700"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {item.evidences.length === 0 && (
                    <p className="text-xs text-slate-400">暂无证据</p>
                  )}
                </div>

                {issues.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {issues.map((iss) => (
                      <div
                        key={iss.code}
                        className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs ${
                          iss.severity === 'error'
                            ? 'border-red-200 bg-red-50 text-red-800'
                            : 'border-amber-200 bg-amber-50 text-amber-900'
                        }`}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{iss.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Role actions */}
                {userRole !== 'annotator' && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                    <input
                      type="text"
                      value={userRole === 'reviewer' ? item.disputeReason : item.adjudicatorNote}
                      onChange={(e) =>
                        onSaveLegalItem(
                          userRole === 'reviewer'
                            ? { ...item, disputeReason: e.target.value }
                            : { ...item, adjudicatorNote: e.target.value },
                        )
                      }
                      placeholder={
                        userRole === 'reviewer' ? '记录复核分歧原因…' : '记录业务裁定理由…'
                      }
                      className="min-w-[220px] flex-1 rounded border border-slate-300 px-2.5 py-1 text-xs"
                    />
                    {userRole === 'reviewer' ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onSaveLegalItem(
                              { ...item, reviewStatus: 'checked', disputeReason: '' },
                              `复核通过法律结论 ${item.id}`,
                            )
                          }
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                          已复核
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onSaveLegalItem(
                              { ...item, reviewStatus: 'disputed' },
                              `标记争议法律结论 ${item.id}`,
                            )
                          }
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          争议中
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          onSaveLegalItem(
                            { ...item, reviewStatus: 'specialist_review' },
                            `完成裁定法律结论 ${item.id}`,
                          )
                        }
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                      >
                        <Check className="h-3.5 w-3.5" />
                        完成专业裁定
                      </button>
                    )}
                  </div>
                )}
                {userRole === 'annotator' && (item.disputeReason || item.adjudicatorNote) && (
                  <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                    {item.disputeReason && <p>复核争议：{item.disputeReason}</p>}
                    {item.adjudicatorNote && <p>裁定说明：{item.adjudicatorNote}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Evidence Chain View */}
      {subTab === 'evidence_chain' && (
        <div className="flex flex-col gap-3" data-testid="evidence-chain-view">
          {caseDoc.legalConclusions.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              当前案例暂无违法行为或责任认定记录，请先在「违法 / 原因 / 责任」中录入。
            </div>
          ) : (
            <>
              {/* Anchor Selector: Violation & Liability items */}
              <div className="flex flex-col gap-2.5 rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-800">
                      选择违法行为或责任认定作为链路锚点
                    </span>
                    {activeChain && (
                      <span className="font-mono-tabular text-slate-500">
                        当前锚点：{activeChain.anchorItem.id} · {CATEGORY_LABELS[activeChain.anchorItem.category].title}
                      </span>
                    )}
                  </div>

                  {/* Violations row */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                    <span className="w-20 shrink-0 font-medium text-slate-500">违法行为：</span>
                    {violationRecords.length === 0 ? (
                      <span className="text-slate-400">暂无违法记录</span>
                    ) : (
                      violationRecords.map((vio) => {
                        const selected = activeChain?.anchorItem.id === vio.id;
                        return (
                          <button
                            key={vio.id}
                            type="button"
                            onClick={() => handleSelectChainAnchor(vio)}
                            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-left transition-colors ${
                              selected
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-400 hover:bg-white'
                            }`}
                          >
                            <span className="font-mono-tabular font-semibold">{vio.id}</span>
                            <span className="opacity-75">·</span>
                            <span className="font-mono-tabular">{vio.subjectId}</span>
                            <span className="max-w-[180px] truncate">
                              {vio.conclusionLabel || vio.rawText || PRESENCE_STATUS_META[vio.presenceStatus].label}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>

                  {/* Liabilities row */}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="w-20 shrink-0 font-medium text-slate-500">责任认定：</span>
                    {liabilityRecords.length === 0 ? (
                      <span className="text-slate-400">暂无责任划分记录</span>
                    ) : (
                      liabilityRecords.map((lia) => {
                        const selected = activeChain?.anchorItem.id === lia.id;
                        return (
                          <button
                            key={lia.id}
                            type="button"
                            onClick={() => handleSelectChainAnchor(lia)}
                            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-left transition-colors ${
                              selected
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-400 hover:bg-white'
                            }`}
                          >
                            <span className="font-mono-tabular font-semibold">{lia.id}</span>
                            <span className="opacity-75">·</span>
                            <span className="font-mono-tabular">{lia.subjectId}</span>
                            <span className="max-w-[180px] truncate">
                              {lia.conclusionLabel || lia.rawText || PRESENCE_STATUS_META[lia.presenceStatus].label}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Logic consistency diagnostics */}
                {activeChain && (
                  <div className="mt-1 flex flex-col gap-1.5 border-t border-slate-100 pt-2.5">
                    {activeChain.consistencyChecks.map((chk) => (
                      <div
                        key={chk.code}
                        className={`flex items-center gap-2 rounded border px-3 py-1.5 text-xs ${
                          chk.severity === 'error'
                            ? 'border-red-200 bg-red-50 text-red-800'
                            : chk.severity === 'warning'
                              ? 'border-amber-200 bg-amber-50 text-amber-900'
                              : 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                        }`}
                      >
                        {chk.severity === 'error' ? (
                          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : chk.severity === 'warning' ? (
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span>{chk.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {activeChain && (
                <>
                  {/* 1. 3-Step Causal Chain Overview */}
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <div className="mb-3 flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-900">
                        关联法律链路（违法 → 原因 → 责任）
                      </span>
                      <span className="font-mono-tabular text-slate-500">
                        涉链主体 {activeChain.subjectIds.join(' / ') || '无'} · 证据 {activeChain.evidences.length} 条
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {(
                        [
                          {
                            key: 'violation',
                            title: '1. 违法行为 (D10.F058)',
                            items: activeChain.violations,
                            emptyText: '本链路未绑定违法行为（如属无责免除或未关联可在此核查）',
                          },
                          {
                            key: 'cause',
                            title: '2. 认定原因 (D10.F059)',
                            items: activeChain.causes,
                            emptyText: '本链路尚未绑定认定事故原因',
                          },
                          {
                            key: 'liability',
                            title: '3. 责任划分 (D10.F060)',
                            items: activeChain.liabilities,
                            emptyText: '本链路尚未绑定责任划分结论',
                          },
                        ] as const
                      ).map((col) => (
                        <div
                          key={col.key}
                          className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50/60 p-3"
                        >
                          <div className="flex items-center justify-between border-b border-slate-200/80 pb-1.5 text-xs font-semibold text-slate-800">
                            <span>{col.title}</span>
                            <span className="font-mono-tabular text-slate-500">
                              {col.items.length}
                            </span>
                          </div>
                          {col.items.length === 0 ? (
                            <p className="py-2 text-xs leading-relaxed text-slate-400">
                              {col.emptyText}
                            </p>
                          ) : (
                            col.items.map((node) => {
                              const isAnchor = node.id === activeChain.anchorItem.id;
                              return (
                                <div
                                  key={node.id}
                                  className={`rounded border bg-white p-2.5 text-xs ${
                                    isAnchor
                                      ? 'border-slate-900 ring-1 ring-slate-900/10'
                                      : 'border-slate-200'
                                  }`}
                                >
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <span className="font-mono-tabular font-semibold text-slate-900">
                                      {node.id} · {node.subjectId}
                                    </span>
                                    <span className="font-medium text-slate-600">
                                      {REVIEW_STATUS_META[node.reviewStatus].label}
                                    </span>
                                  </div>
                                  <p className="font-medium text-blue-900">
                                    {node.conclusionLabel || PRESENCE_STATUS_META[node.presenceStatus].label}
                                  </p>
                                  {node.lawArticle && (
                                    <p className="mt-1 text-[11px] text-slate-600">
                                      依据：{node.lawArticle}
                                    </p>
                                  )}
                                  {node.rawText && (
                                    <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-600">
                                      {node.rawText}
                                    </p>
                                  )}
                                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1.5">
                                    <LiabilitySourceNote item={node} caseDoc={caseDoc} onLocate={onLocateEvidence} />
                                    {node.evidences.map(ev => (
                                      <EvidencePageLink key={ev.id} record={node} evidence={ev} onLocate={onLocateEvidence} showQuote={node.evidences.length > 1} />
                                    ))}
                                    {!node.evidences.length && node.category !== 'liability' && (
                                      <span className="text-[11px] text-red-700">无页码证据</span>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSubTab('legal');
                                        onFocusTarget(
                                          node.id,
                                          `${CATEGORY_LABELS[node.category].title} (${node.id})`,
                                        );
                                      }}
                                      className="inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-700 hover:text-slate-900 hover:underline"
                                    >
                                      编辑
                                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 2. Filtered & Highlighted Document Paragraphs */}
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                      <div className="flex items-center gap-2 text-xs">
                        <FileSearch className="h-4 w-4 text-amber-700" aria-hidden="true" />
                        <span className="font-semibold text-slate-900">
                          关联原文段落
                        </span>
                        <span className="font-mono-tabular text-slate-500">
                          命中 {matchedParagraphs.filter((p) => p.matchedEvidences.length > 0).length} / 共 {matchedParagraphs.length} 段
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAllParagraphs((prev) => !prev)}
                        className="text-xs font-medium text-blue-700 hover:underline"
                      >
                        {showAllParagraphs ? '仅看命中段落' : '查看全页文档段落'}
                      </button>
                    </div>

                    {Object.keys(pdfPageTexts).length === 0 ? (
                      <p className="py-4 text-center text-xs text-slate-400">
                        正在从左侧 PDF 提取文书文本段落…
                      </p>
                    ) : visibleParagraphs.length === 0 ? (
                      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                        未精确匹配原文。可查看全页段落，或在 PDF 中重新选取摘录。
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {visibleParagraphs.map((para) => {
                          const hasHit = para.matchedEvidences.length > 0;
                          const hitQuotes = para.matchedEvidences.map((ev) => ev.quote);
                          return (
                            <div
                              key={`${para.page}-${para.paragraphIndex}`}
                              onClick={() => onJumpToPage(para.page)}
                              className={`cursor-pointer rounded-md border p-3 text-xs transition-colors ${
                                hasHit
                                  ? 'border-amber-300 bg-amber-50/40 hover:border-amber-400'
                                  : 'border-slate-200 bg-slate-50/40 hover:border-slate-300'
                              }`}
                            >
                              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                                <span className="font-mono-tabular font-semibold text-blue-800">
                                  第 {para.page} 页 · 第 {para.paragraphIndex + 1} 段
                                </span>
                                {hasHit ? (
                                  <span className="font-medium text-amber-900">
                                    命中引用：
                                    {Array.from(
                                      new Set(para.matchedEvidences.map((ev) => ev.sourceId)),
                                    ).join('、')}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">上下文段落</span>
                                )}
                              </div>
                              <p className="leading-relaxed text-slate-800">
                                <HighlightedQuoteText text={para.text} quotes={hitQuotes} />
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 3. Linked Party Records + Linked Evidence Citations */}
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {/* Party records & related collision relations */}
                    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                        <span className="font-semibold text-slate-900">
                          关联当事人 / 组织记录 ({activeChain.partyFieldRecords.length})
                        </span>
                        <span className="font-mono-tabular text-slate-500">
                          主体：{activeChain.subjects.map((s) => `${s.id} ${s.label}`).join(' / ') || '无'}
                        </span>
                      </div>

                      {activeChain.partyFieldRecords.length === 0 ? (
                        <p className="py-3 text-xs text-slate-400">
                          当前涉链主体暂未录入基础字段记录。
                        </p>
                      ) : (
                        <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                          {activeChain.partyFieldRecords.map((rec) => {
                            const fieldName = schemaNameByCode.get(rec.fieldCode) || rec.fieldCode;
                            const valText =
                              rec.normalizedValues.length > 0
                                ? rec.normalizedValues.join(' / ')
                                : rec.rawValue || PRESENCE_STATUS_META[rec.presenceStatus].label;
                            const sharesEvidence = rec.evidences.some((fev) =>
                              activeChain.evidences.some(
                                (cev) =>
                                  cev.page === fev.page &&
                                  (findTextMatchRanges(fev.quote, [cev.quote]).length > 0 ||
                                    findTextMatchRanges(cev.quote, [fev.quote]).length > 0),
                              ),
                            );
                            return (
                              <div
                                key={rec.recordId}
                                className={`rounded border p-2.5 text-xs ${
                                  sharesEvidence
                                    ? 'border-amber-300 bg-amber-50/30'
                                    : 'border-slate-200 bg-slate-50/40'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono-tabular font-semibold text-slate-900">
                                      {rec.entityId}
                                    </span>
                                    <span className="font-mono-tabular text-slate-500">
                                      {rec.fieldCode}
                                    </span>
                                    <span className="font-medium text-slate-800">{fieldName}</span>
                                  </div>
                                  <span className="text-[11px] text-slate-500">
                                    {REVIEW_STATUS_META[rec.reviewStatus].label}
                                  </span>
                                </div>
                                <div className="mt-1 flex items-center justify-between gap-2">
                                  <span className="text-slate-700">{valText}</span>
                                  <div className="flex shrink-0 items-center gap-2">
                                    {rec.evidences.map(ev => (
                                      <EvidencePageLink key={ev.id} record={rec} evidence={ev} onLocate={onLocateEvidence} showQuote={rec.evidences.length > 1} />
                                    ))}
                                    {onJumpToEntityField && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onJumpToEntityField(rec.entityId, rec.fieldCode)
                                        }
                                        className="text-[11px] font-medium text-blue-700 hover:underline"
                                      >
                                        核对字段
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {activeChain.relatedRelations.length > 0 && (
                        <div className="mt-1 border-t border-slate-100 pt-2.5">
                          <div className="mb-1.5 text-xs font-semibold text-slate-800">
                            关联碰撞与事件关系 ({activeChain.relatedRelations.length})
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {activeChain.relatedRelations.map((rel) => (
                              <div
                                key={rel.id}
                                className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs"
                              >
                                <span className="text-slate-800">
                                  <span className="font-mono-tabular font-semibold">#{rel.stageOrder}</span>{' '}
                                  {cleanRelationEntityId(rel.sourceId)} →{' '}
                                  {rel.relationType || rel.action} →{' '}
                                  {cleanRelationEntityId(rel.targetId)}
                                </span>
                                {rel.evidences.map(ev => (
                                  <EvidencePageLink key={ev.id} record={rel} evidence={ev} onLocate={onLocateEvidence} showQuote={rel.evidences.length > 1} />
                                ))}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSubTab('relations');
                                    onFocusTarget(rel.id, `事件关系 (${rel.id})`);
                                  }}
                                  className="shrink-0 text-[11px] font-medium text-blue-700 hover:underline"
                                >
                                  查看关系
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Evidence Citations List */}
                    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                        <span className="font-semibold text-slate-900">
                          链路证据引用清单 ({activeChain.evidences.length})
                        </span>
                      </div>

                      {activeChain.evidences.length === 0 ? (
                        <p className="py-3 text-xs text-slate-400">
                          当前链路暂无带页码的证据摘录。
                        </p>
                      ) : (
                        <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                          {activeChain.evidences.map(ev => {
                            const record = caseDoc.legalConclusions.find(item => item.id === ev.sourceId);
                            const evidence = record?.evidences.find(item => `${record.id}:${item.id}` === ev.id);
                            if (!record || !evidence) return null;
                            return (
                              <button
                                key={ev.id}
                                type="button"
                                aria-label={`定位第 ${ev.page} 页原文 · ${ev.quote}`}
                                onClick={() => onLocateEvidence(record, evidence)}
                                className="flex flex-col gap-1 rounded border border-amber-200 bg-amber-50/40 p-2.5 text-left text-xs transition-colors hover:border-amber-400 hover:bg-amber-50"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-slate-900">
                                    {ev.sourceLabel} ·{' '}
                                    <span className="font-mono-tabular">{ev.subjectId}</span>
                                  </span>
                                  <span className="font-mono-tabular font-semibold text-blue-700">
                                    p.{ev.page}
                                  </span>
                                </div>
                                <p className="leading-relaxed text-slate-700">{ev.quote}</p>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Event Relations List */}
      {subTab === 'relations' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 pt-3 pb-1.5 text-xs">
            <span className="pb-1.5 text-slate-500">审核状态</span>
            {(
              [
                ['all', '全部'],
                ['pending_action', '待处理'],
                ['draft', '草稿'],
                ['disputed', '争议中'],
                ['blocking_or_error', '阻断/报错'],
                ['checked', '已复核'],
                ['specialist_review', '专业裁定'],
              ] as Array<[WorkItemFilterStatus, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={statusFilter === key}
                  onClick={() => setStatusFilter(key)}
                className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 transition-colors ${
                  statusFilter === key
                    ? 'border-slate-900 font-semibold text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                <span>{label}</span>
                <span className="font-mono-tabular text-[11px] opacity-75">
                  ({relationStatusCounts[key]})
                </span>
              </button>
            ))}
          </div>

          {filteredRelations.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              没有匹配的事件关系
            </div>
          )}

          {filteredRelations.map((rel) => {
              const issues = validateRelation(rel);
              const hasError =
                PRESENCE_STATUS_META[rel.presenceStatus || 'present'].blocksScoring ||
                issues.some((i) => i.severity === 'error');
              const focused = activeTargetId === rel.id;

              return (
                <div
                  key={rel.id}
                  data-focus-id={rel.id}
                  onClick={() => onFocusTarget(rel.id, `事件关系 (${rel.id})`, false)}
                  className={`rounded-lg border p-4 transition-colors ${getCardStatusBorderClass(
                    rel.reviewStatus,
                    hasError,
                    focused,
                  )}`}
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono-tabular font-semibold text-slate-900">
                        顺序 #{rel.stageOrder}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular text-blue-800">{rel.eventId}</span>
                      <span aria-hidden="true">·</span>
                      <RecordInfo label="碰撞关系的记录信息" rows={[['记录编号', rel.id]]} />
                    </div>
                    <div className="flex items-center gap-2">
                      <ReviewLifecycleBar
                        reviewStatus={rel.reviewStatus}
                        hasError={hasError}
                      />
                      <button
                        type="button"
                        aria-label={`删除关系 ${rel.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteRelationItem(rel.id);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Directed Relation Row (v0.2 Graph Triple) */}
                  <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        字段编码
                      </label>
                      <select
                        value={rel.fieldCode || 'D08.F049'}
                        onChange={(e) => onSaveRelationItem({ ...rel, fieldCode: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {RELATION_FIELD_CODES.map((fc) => (
                          <option key={fc.code} value={fc.code}>
                            {fc.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        存在性状态
                      </label>
                      <select
                        value={rel.presenceStatus || 'present'}
                        onChange={(e) =>
                          onSaveRelationItem({
                            ...rel,
                            presenceStatus: e.target.value as PresenceStatus,
                          })
                        }
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {(Object.keys(PRESENCE_STATUS_META) as PresenceStatus[]).map((st) => (
                          <option key={st} value={st}>
                            {PRESENCE_STATUS_META[st].label} ({st})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        所属阶段事件
                      </label>
                      <select
                        value={rel.eventId}
                        onChange={(e) => onSaveRelationItem({ ...rel, eventId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {events.map((ev) => (
                          <option key={ev.id} value={ev.id}>
                            {ev.id} · {ev.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        阶段顺序
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={rel.stageOrder}
                        onChange={(e) =>
                          onSaveRelationItem({
                            ...rel,
                            stageOrder: Math.max(1, parseInt(e.target.value, 10) || 1),
                          })
                        }
                        className="font-mono-tabular w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        施动主体
                      </label>
                      <select
                        value={cleanRelationEntityId(rel.sourceId)}
                        onChange={(e) => onSaveRelationItem({ ...rel, sourceId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {allTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.id} · {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-4">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        标准关系类型
                      </label>
                      <div className="flex items-center gap-1">
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <input
                          type="text"
                          value={rel.relationType ?? rel.collisionMode ?? rel.action}
                          onChange={(e) =>
                            onSaveRelationItem({
                              ...rel,
                              relationType: e.target.value,
                              collisionMode: e.target.value,
                            })
                          }
                          placeholder="如：撞击路侧固定设施 / 追尾碰撞"
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                        />
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </div>
                    </div>
                    <div className="sm:col-span-3">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        受动客体
                      </label>
                      <select
                        value={cleanRelationEntityId(rel.targetId)}
                        onChange={(e) => onSaveRelationItem({ ...rel, targetId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {allTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.id} · {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        碰撞动作原文
                      </label>
                      <input
                        type="text"
                        value={rel.action}
                        onChange={(e) => onSaveRelationItem({ ...rel, action: e.target.value })}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        事件与方向说明
                      </label>
                      <input
                        type="text"
                        value={rel.directionNote}
                        onChange={(e) =>
                          onSaveRelationItem({ ...rel, directionNote: e.target.value })
                        }
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  </div>

                  <div className="mt-3 rounded border border-slate-200 bg-slate-50/60 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700">事件关系证据</span>
                      <button
                        type="button"
                        disabled={!selectedPdfQuote?.quote.trim()}
                        onClick={() => {
                          if (!selectedPdfQuote?.quote.trim()) return;
                          onSaveRelationItem({
                            ...rel,
                            evidences: [
                              ...rel.evidences,
                              {
                                id: `EV-${Date.now().toString(36)}`,
                                page: selectedPdfQuote.page,
                                quote: selectedPdfQuote.quote.trim(),
                              },
                            ],
                          });
                        }}
                        className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                      >
                        <Link2 className="h-3 w-3" />
                        引用左侧选区
                      </button>
                    </div>
                    {rel.evidences.map((ev) => (
                      <div key={ev.id} className="mt-1 flex items-center gap-2 text-xs">
                        <EvidencePageLink record={rel} evidence={ev} onLocate={onLocateEvidence} />
                        <input
                          type="text"
                          value={ev.quote}
                          onChange={(e) =>
                            onSaveRelationItem({
                              ...rel,
                              evidences: rel.evidences.map((x) =>
                                x.id === ev.id ? { ...x, quote: e.target.value } : x,
                              ),
                            })
                          }
                          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
                        />
                        <button
                          type="button"
                          aria-label="删除证据"
                          onClick={() =>
                            onSaveRelationItem({
                              ...rel,
                              evidences: rel.evidences.filter((x) => x.id !== ev.id),
                            })
                          }
                          className="p-1 text-slate-400 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {issues.length > 0 && (
                    <p className="mt-2 text-xs text-red-700">
                      {issues.map((i) => i.message).join('；')}
                    </p>
                  )}

                  {userRole !== 'annotator' && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                      <input
                        type="text"
                        aria-label={
                          userRole === 'reviewer' ? '碰撞关系复核分歧说明' : '碰撞关系裁定理由'
                        }
                        value={
                          userRole === 'reviewer' ? rel.disputeReason : rel.adjudicatorNote
                        }
                        onChange={(e) =>
                          onSaveRelationItem(
                            userRole === 'reviewer'
                              ? { ...rel, disputeReason: e.target.value }
                              : { ...rel, adjudicatorNote: e.target.value },
                          )
                        }
                        placeholder={
                          userRole === 'reviewer' ? '记录复核分歧原因…' : '记录业务裁定理由…'
                        }
                        className="min-w-[220px] flex-1 rounded border border-slate-300 px-2.5 py-1 text-xs"
                      />
                      {userRole === 'reviewer' ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              onSaveRelationItem(
                                { ...rel, reviewStatus: 'checked', disputeReason: '' },
                                `复核通过事件关系 ${rel.id}`,
                              )
                            }
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white"
                          >
                            <Check className="h-3.5 w-3.5" />
                            已复核
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSaveRelationItem(
                                { ...rel, reviewStatus: 'disputed' },
                                `标记争议事件关系 ${rel.id}`,
                              )
                            }
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            争议中
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            onSaveRelationItem(
                              { ...rel, reviewStatus: 'specialist_review' },
                              `完成裁定事件关系 ${rel.id}`,
                            )
                          }
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                          完成专业裁定
                        </button>
                      )}
                    </div>
                  )}
                  {userRole === 'annotator' && (rel.disputeReason || rel.adjudicatorNote) && (
                    <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                      {rel.disputeReason && <p>复核争议：{rel.disputeReason}</p>}
                      {rel.adjudicatorNote && <p>裁定说明：{rel.adjudicatorNote}</p>}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};
