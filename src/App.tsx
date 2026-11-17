import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, RotateCcw, Upload } from 'lucide-react';
import { AcceptanceExportPanel } from './components/AcceptanceExportPanel';
import { EntityRegistryBar } from './components/EntityRegistryBar';
import { FieldAnnotationPanel } from './components/FieldAnnotationPanel';
import { LegalRelationsPanel } from './components/LegalRelationsPanel';
import { ManualDrawer } from './components/ManualDrawer';
import { PdfEvidenceViewer } from './components/PdfEvidenceViewer';
import { VocabularySupplementPanel } from './components/VocabularySupplementPanel';
import {
  INITIAL_VOCABULARY_SUPPLEMENTS,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
  USER_ROLE_META,
} from './data/schemaCatalog';
import { SEED_CASES } from './data/seedCases';
import {
  AuditLogEntry,
  CaseDocument,
  CaseWorkItem,
  EntityKind,
  EventRelationItem,
  FieldFilterBucket,
  FieldRecord,
  LegalConclusionItem,
  UserRole,
  VocabularySupplementItem,
  WorkItemFilterStatus,
} from './types/gold';
import {
  collectCaseWorkItems,
  computeCaseReadiness,
  computeEntityProgressMap,
  generateNextEntityId,
  validateFieldRecord,
} from './utils/goldRules';

type WorkspaceTab = 'fields' | 'legal' | 'vocab' | 'export';

const STORAGE_CASES_KEY = 'gold_workbench_cases_v3';
const STORAGE_SUPPLEMENTS_KEY = 'gold_workbench_supplements_v1';

function loadInitialCases(): CaseDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_CASES_KEY);
    if (!raw) return SEED_CASES;
    const parsed = JSON.parse(raw) as CaseDocument[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Ensure blob URLs from expired sessions don't break seed items
      return parsed.filter((c) => !c.pdfUrl.startsWith('blob:'));
    }
  } catch {
    // Fall back to seed data
  }
  return SEED_CASES;
}

function loadInitialSupplements(): VocabularySupplementItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_SUPPLEMENTS_KEY);
    if (!raw) return INITIAL_VOCABULARY_SUPPLEMENTS;
    const parsed = JSON.parse(raw) as VocabularySupplementItem[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Fall back to initial CSV supplements
  }
  return INITIAL_VOCABULARY_SUPPLEMENTS;
}

export default function App() {
  const [cases, setCases] = useState<CaseDocument[]>(loadInitialCases);
  const [supplements, setSupplements] = useState<VocabularySupplementItem[]>(loadInitialSupplements);
  const [activeCaseId, setActiveCaseId] = useState<string>(() => loadInitialCases()[0]?.caseId || 'CASE-01');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('fields');
  const [userRole, setUserRole] = useState<UserRole>('annotator');
  const [selectedEntityId, setSelectedEntityId] = useState<string>('ACC');
  const [currentPdfPage, setCurrentPdfPage] = useState<number>(1);
  const [selectedPdfQuote, setSelectedPdfQuote] = useState<{ page: number; quote: string } | null>(null);
  const [focusedFieldKey, setFocusedFieldKey] = useState<string | null>(null);
  const [focusedLegalOrRelId, setFocusedLegalOrRelId] = useState<{ id: string; label: string } | null>(null);
  const [queueStatusFilter, setQueueStatusFilter] = useState<WorkItemFilterStatus>('pending_action');
  const [fieldBucketRequest, setFieldBucketRequest] = useState<{
    bucket: FieldFilterBucket;
    nonce: number;
  } | null>(null);
  const [legalFocusRequest, setLegalFocusRequest] = useState<{
    subTab: 'legal' | 'evidence_chain' | 'relations';
    nonce: number;
  } | null>(null);
  const [pdfPageTexts, setPdfPageTexts] = useState<Record<number, string>>({});
  const [highlightedEvidences, setHighlightedEvidences] = useState<
    Array<{ page: number; quote: string; label?: string }>
  >([]);
  const [manualOpen, setManualOpen] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeCase = useMemo(
    () => cases.find((c) => c.caseId === activeCaseId) || cases[0],
    [cases, activeCaseId],
  );

  // Sync persistence
  useEffect(() => {
    try {
      const persistable = cases.filter((c) => !c.pdfUrl.startsWith('blob:'));
      localStorage.setItem(STORAGE_CASES_KEY, JSON.stringify(persistable));
    } catch {
      // Ignore storage quota errors
    }
  }, [cases]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SUPPLEMENTS_KEY, JSON.stringify(supplements));
    } catch {
      // Ignore storage quota errors
    }
  }, [supplements]);

  // Reset entity selection when switching case
  useEffect(() => {
    if (!activeCase) return;
    if (!activeCase.entities.some((e) => e.id === selectedEntityId)) {
      setSelectedEntityId(activeCase.entities[0]?.id || 'ACC');
    }
    setCurrentPdfPage(1);
    setSelectedPdfQuote(null);
    setFocusedFieldKey(null);
    setFocusedLegalOrRelId(null);
    setHighlightedEvidences([]);
  }, [activeCaseId]);

  useEffect(() => {
    if (activeTab !== 'legal') {
      setHighlightedEvidences([]);
    }
  }, [activeTab]);

  const selectedEntity = useMemo(
    () =>
      activeCase.entities.find((e) => e.id === selectedEntityId) ||
      activeCase.entities[0] || { id: 'ACC', kind: 'ACC', label: '整起事故' },
    [activeCase, selectedEntityId],
  );

  const readiness = useMemo(() => computeCaseReadiness(activeCase, supplements), [activeCase, supplements]);
  const entityProgressMap = useMemo(() => computeEntityProgressMap(activeCase, supplements), [activeCase, supplements]);
  const pendingItemsCount = useMemo(
    () => collectCaseWorkItems(activeCase, supplements).filter((item) => item.needsAttention).length,
    [activeCase, supplements],
  );

  const recordCountByEntity = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [id, prog] of Object.entries(entityProgressMap)) {
      counts[id] = prog.totalItems;
    }
    return counts;
  }, [entityProgressMap]);

  const totalCaseItemsCount =
    readiness.totalFieldRecords + readiness.totalLegalItems + readiness.totalRelations;

  const updateActiveCase = (updater: (prev: CaseDocument) => CaseDocument) => {
    setCases((prevList) =>
      prevList.map((item) => (item.caseId === activeCase.caseId ? updater(item) : item)),
    );
  };

  const makeAuditEntry = (action: string, targetRef: string, comment = ''): AuditLogEntry => {
    const actorName =
      userRole === 'annotator'
        ? activeCase.annotatorName
        : userRole === 'reviewer'
          ? activeCase.reviewerName
          : activeCase.adjudicatorName || '业务裁定人';
    return {
      id: `LOG-${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      actorRole: userRole,
      actorName,
      action,
      targetRef,
      comment,
    };
  };

  const handleAddEntity = (kind: EntityKind, label: string, subtitle: string) => {
    const nextId = generateNextEntityId(kind, activeCase.entities);
    updateActiveCase((prev) => ({
      ...prev,
      entities: [
        ...prev.entities,
        { id: nextId, kind, label, subtitle, roleLabel: subtitle || label },
      ],
      auditLog: [
        makeAuditEntry('登记对象', nextId, `${label}${subtitle ? ` (${subtitle})` : ''}`),
        ...prev.auditLog,
      ],
    }));
    setSelectedEntityId(nextId);
  };

  const handleRemoveEntity = (entityId: string) => {
    updateActiveCase((prev) => ({
      ...prev,
      entities: prev.entities.filter((e) => e.id !== entityId),
      fieldRecords: prev.fieldRecords.filter((r) => r.entityId !== entityId),
      auditLog: [makeAuditEntry('移除对象', entityId), ...prev.auditLog],
    }));
    if (selectedEntityId === entityId) {
      setSelectedEntityId('ACC');
    }
  };

  const handleUpsertFieldRecord = (record: FieldRecord, auditNote?: string) => {
    updateActiveCase((prev) => {
      const exists = prev.fieldRecords.some((r) => r.recordId === record.recordId);
      const nextRecords = exists
        ? prev.fieldRecords.map((r) => (r.recordId === record.recordId ? record : r))
        : [...prev.fieldRecords, record];
      return {
        ...prev,
        fieldRecords: nextRecords,
        auditLog: auditNote
          ? [makeAuditEntry(auditNote, `${record.entityId}.${record.fieldCode}`), ...prev.auditLog]
          : prev.auditLog,
      };
    });
  };

  const handleDeleteFieldRecord = (recordId: string) => {
    updateActiveCase((prev) => ({
      ...prev,
      fieldRecords: prev.fieldRecords.filter((r) => r.recordId !== recordId),
    }));
  };

  const handleSaveLegalItem = (item: LegalConclusionItem, auditNote?: string) => {
    updateActiveCase((prev) => {
      const exists = prev.legalConclusions.some((x) => x.id === item.id);
      const next = exists
        ? prev.legalConclusions.map((x) => (x.id === item.id ? item : x))
        : [...prev.legalConclusions, item];
      return {
        ...prev,
        legalConclusions: next,
        auditLog: auditNote
          ? [makeAuditEntry(auditNote, item.id), ...prev.auditLog]
          : prev.auditLog,
      };
    });
  };

  const handleDeleteLegalItem = (id: string) => {
    updateActiveCase((prev) => ({
      ...prev,
      legalConclusions: prev.legalConclusions.filter((x) => x.id !== id),
    }));
  };

  const handleSaveRelationItem = (item: EventRelationItem, auditNote?: string) => {
    updateActiveCase((prev) => {
      const exists = prev.relations.some((x) => x.id === item.id);
      const next = exists
        ? prev.relations.map((x) => (x.id === item.id ? item : x))
        : [...prev.relations, item];
      return {
        ...prev,
        relations: next,
        auditLog: auditNote
          ? [makeAuditEntry(auditNote, item.id), ...prev.auditLog]
          : prev.auditLog,
      };
    });
  };

  const handleDeleteRelationItem = (id: string) => {
    updateActiveCase((prev) => ({
      ...prev,
      relations: prev.relations.filter((x) => x.id !== id),
    }));
  };

  const handleBatchApproveDrafts = () => {
    updateActiveCase((prev) => {
      const nextFieldRecords = prev.fieldRecords.map((r) => {
        if (r.reviewStatus !== 'draft') return r;
        if (PRESENCE_STATUS_META[r.presenceStatus].blocksScoring) return r;
        const errors = validateFieldRecord(r).filter((i) => i.severity === 'error');
        if (errors.length > 0) return r;
        return { ...r, reviewStatus: 'checked' as const };
      });
      const nextLegal = prev.legalConclusions.map((l) =>
        l.reviewStatus === 'draft' && l.rawText.trim() && l.evidences.length > 0
          ? { ...l, reviewStatus: 'checked' as const }
          : l,
      );
      const nextRels = prev.relations.map((rel) =>
        rel.reviewStatus === 'draft' && rel.evidences.length > 0
          ? { ...rel, reviewStatus: 'checked' as const }
          : rel,
      );
      return {
        ...prev,
        fieldRecords: nextFieldRecords,
        legalConclusions: nextLegal,
        relations: nextRels,
        auditLog: [
          makeAuditEntry('批量复核无错草稿', prev.caseId, '第二人批量确认通过'),
          ...prev.auditLog,
        ],
      };
    });
  };

  const handleOpenAcceptanceWithStatus = (status: WorkItemFilterStatus) => {
    setQueueStatusFilter(status);
    setActiveTab('export');
  };

  const handleJumpToWorkItem = (item: CaseWorkItem) => {
    if (item.targetTab === 'fields' && item.fieldCode) {
      setActiveTab('fields');
      setSelectedEntityId(item.entityId);
      setFocusedLegalOrRelId(null);
      setFocusedFieldKey(`${item.entityId}:${item.fieldCode}`);
      setFieldBucketRequest({ bucket: 'all', nonce: Date.now() });
      return;
    }
    if (item.targetTab === 'legal' && item.legalOrRelId) {
      setActiveTab('legal');
      setFocusedFieldKey(null);
      setFocusedLegalOrRelId({ id: item.legalOrRelId, label: item.title });
      setLegalFocusRequest({
        subTab: item.relationSubTab || 'legal',
        nonce: Date.now(),
      });
    }
  };

  const handleJumpToEntityUnstarted = (entityId: string) => {
    setActiveTab('fields');
    setSelectedEntityId(entityId);
    setFocusedFieldKey(null);
    setFocusedLegalOrRelId(null);
    setFieldBucketRequest({ bucket: 'unstarted', nonce: Date.now() });
  };

  const handleQuickTransitionItem = (
    item: CaseWorkItem,
    nextStatus: 'checked' | 'specialist_review',
  ) => {
    const actionLabel = nextStatus === 'checked' ? '队列快捷复核通过' : '队列快捷完成裁定';
    if (item.itemType === 'field' && item.fieldCode) {
      const existing = activeCase.fieldRecords.find(
        (r) => r.entityId === item.entityId && r.fieldCode === item.fieldCode,
      );
      if (!existing) return;
      handleUpsertFieldRecord(
        {
          ...existing,
          reviewStatus: nextStatus,
          disputeReason: nextStatus === 'checked' ? '' : existing.disputeReason,
          updatedByRole: userRole,
          updatedAt: new Date().toISOString(),
        },
        `${actionLabel} ${item.entityId}.${item.fieldCode}`,
      );
      return;
    }
    if (item.itemType === 'legal' && item.legalOrRelId) {
      const existing = activeCase.legalConclusions.find((l) => l.id === item.legalOrRelId);
      if (!existing) return;
      handleSaveLegalItem(
        {
          ...existing,
          reviewStatus: nextStatus,
          disputeReason: nextStatus === 'checked' ? '' : existing.disputeReason,
        },
        `${actionLabel} ${existing.id}`,
      );
      return;
    }
    if (item.itemType === 'relation' && item.legalOrRelId) {
      const existing = activeCase.relations.find((r) => r.id === item.legalOrRelId);
      if (!existing) return;
      handleSaveRelationItem(
        {
          ...existing,
          reviewStatus: nextStatus,
          disputeReason: nextStatus === 'checked' ? '' : existing.disputeReason,
        },
        `${actionLabel} ${existing.id}`,
      );
    }
  };

  // Determine active target label for the left PDF clipboard bar
  const activeTargetInfo = useMemo(() => {
    if (activeTab === 'fields') {
      if (focusedLegalOrRelId) {
        return {
          type: 'legal_or_rel' as const,
          label: focusedLegalOrRelId.label,
          id: focusedLegalOrRelId.id,
        };
      }
      if (focusedFieldKey) {
        const [entId, fieldCode] = focusedFieldKey.split(':');
        const def = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === fieldCode);
        return {
          type: 'field' as const,
          label: `${entId} · ${def?.fieldName || fieldCode}`,
          entityId: entId,
          fieldCode,
        };
      }
    }
    if (activeTab === 'legal' && focusedLegalOrRelId) {
      return {
        type: 'legal_or_rel' as const,
        label: focusedLegalOrRelId.label,
        id: focusedLegalOrRelId.id,
      };
    }
    return null;
  }, [activeTab, focusedFieldKey, focusedLegalOrRelId]);

  const handleApplyQuoteToTarget = (page: number, quote: string) => {
    if (!activeTargetInfo) return;
    if (activeTargetInfo.type === 'field') {
      const existing = activeCase.fieldRecords.find(
        (r) =>
          r.entityId === activeTargetInfo.entityId &&
          r.fieldCode === activeTargetInfo.fieldCode,
      );
      const base: FieldRecord = existing
        ? { ...existing }
        : {
            recordId: `FR-${Date.now().toString(36)}`,
            entityId: activeTargetInfo.entityId,
            fieldCode: activeTargetInfo.fieldCode,
            presenceStatus: 'present',
            rawValue: quote,
            normalizedValues: [],
            evidences: [],
            reviewStatus: 'draft',
            disputeReason: '',
            adjudicatorNote: '',
            updatedByRole: userRole,
            updatedAt: new Date().toISOString(),
          };
      base.evidences = [
        ...base.evidences,
        { id: `EV-${Date.now().toString(36)}`, page, quote },
      ];
      if (!base.rawValue.trim() && !PRESENCE_STATUS_META[base.presenceStatus].forbidsValue) {
        base.rawValue = quote;
      }
      handleUpsertFieldRecord(base);
    } else if (activeTargetInfo.type === 'legal_or_rel') {
      const legal = activeCase.legalConclusions.find((l) => l.id === activeTargetInfo.id);
      if (legal) {
        handleSaveLegalItem({
          ...legal,
          evidences: [...legal.evidences, { id: `EV-${Date.now().toString(36)}`, page, quote }],
        });
        return;
      }
      const rel = activeCase.relations.find((r) => r.id === activeTargetInfo.id);
      if (rel) {
        handleSaveRelationItem({
          ...rel,
          evidences: [...rel.evidences, { id: `EV-${Date.now().toString(36)}`, page, quote }],
        });
      }
    }
  };

  const handleImportLocalPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const blobUrl = URL.createObjectURL(file);
    let shaShort = 'local-file';
    let shaFull = '';
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      shaFull = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      shaShort = shaFull.slice(0, 16);
    } catch {
      // Ignore crypto fallback
    }

    const nextNum = cases.length + 1;
    const newId = `CASE-LOCAL-${String(nextNum).padStart(2, '0')}`;
    const newCase: CaseDocument = {
      caseId: newId,
      documentId: newId.toLowerCase(),
      title: `${newId} · ${file.name.replace(/\.pdf$/i, '')}`,
      pilotCode: '新增',
      scenarioSummary: '本地导入的受控测试材料（仅保存在当前浏览器会话内存中，不上传服务器）。',
      pdfUrl: blobUrl,
      sourceFilename: file.name,
      fileSha256: `sha256:${shaShort}`,
      sourceHashFull: shaFull || undefined,
      pageCount: 1,
      manualVersion: '试行版 · 首批6份',
      annotationVersion: 'v1.0',
      maskPiiOnExport: true,
      annotatorName: '第一标注人',
      reviewerName: '第二复核人',
      adjudicatorName: '',
      entities: [
        {
          id: 'ACC',
          kind: 'ACC',
          label: '新建事故材料',
          subtitle: file.name,
          roleLabel: '事故主体',
        },
      ],
      fieldRecords: [],
      legalConclusions: [],
      relations: [],
      checklist: {},
      auditLog: [],
    };
    setCases((prev) => [...prev, newCase]);
    setActiveCaseId(newId);
    setActiveTab('fields');
    e.target.value = '';
  };

  const handleResetDemo = () => {
    localStorage.removeItem(STORAGE_CASES_KEY);
    localStorage.removeItem(STORAGE_SUPPLEMENTS_KEY);
    setCases(SEED_CASES);
    setSupplements(INITIAL_VOCABULARY_SUPPLEMENTS);
    setActiveCaseId(SEED_CASES[0].caseId);
    setSelectedEntityId('ACC');
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 Zones, single row */}
      <header className="flex shrink-0 items-center justify-between gap-8 border-b border-slate-200 bg-white px-5 py-3">
        <span className="whitespace-nowrap shrink-0 text-base font-bold tracking-tight text-slate-900">
          Gold 标注工作台
        </span>

        <nav
          aria-label="主工作区切换"
          className="flex items-center gap-6 overflow-x-auto text-sm font-medium"
        >
          {(
            [
              ['fields', '标注工作台'],
              ['legal', '法律与关系'],
              ['vocab', '受控词表增补'],
              ['export', '交付验收与导出'],
            ] as Array<[WorkspaceTab, string]>
          ).map(([tabKey, label]) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setActiveTab(tabKey)}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                activeTab === tabKey
                  ? 'border-blue-700 text-blue-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setActiveTab('export')}
            className="whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"
          >
            导出 Gold JSON
          </button>
        </div>
      </header>

      {/* Secondary Workspace Context & Role Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="case-selector" className="text-xs font-medium text-slate-600">
              测试材料
            </label>
            <select
              id="case-selector"
              value={activeCase.caseId}
              onChange={(e) => setActiveCaseId(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900"
            >
              {cases.map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleImportLocalPdf}
            className="hidden"
            aria-label="导入本地 PDF 文件"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200/70 hover:text-slate-900"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            导入本地 PDF
          </button>

          <div className="flex items-center gap-0.5 rounded-md bg-slate-200/70 p-0.5">
            {(['annotator', 'reviewer', 'adjudicator'] as UserRole[]).map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => setUserRole(role)}
                className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  userRole === role
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {USER_ROLE_META[role].label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-mono-tabular">
            {activeCase.caseId} · {activeCase.pageCount} 页 · 全案 {totalCaseItemsCount} 项（草稿{' '}
            {readiness.statusCounts.draft} / 争议 {readiness.statusCounts.disputed} / 已复核{' '}
            {readiness.statusCounts.checked} / 裁定 {readiness.statusCounts.specialist_review}）
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() =>
              handleOpenAcceptanceWithStatus(pendingItemsCount > 0 ? 'pending_action' : 'all')
            }
            className={`inline-flex items-center gap-1 whitespace-nowrap font-medium underline-offset-2 hover:underline ${
              pendingItemsCount > 0 ? 'text-amber-800' : 'text-emerald-800'
            }`}
          >
            {pendingItemsCount > 0 ? `待处理 ${pendingItemsCount} 项（去验收排查）` : '全部已处理'}
          </button>

          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200/70 hover:text-slate-900"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            标注手册
          </button>

          <button
            type="button"
            onClick={handleResetDemo}
            title="重置为初始授权样本状态"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-200/70 hover:text-slate-900"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            重置样本
          </button>
        </div>
      </div>

      {/* Main Split Workbench */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
        {/* Left Pane: Real PDF Renderer & Evidence Selector */}
        <div className="min-h-[380px] lg:col-span-5 lg:h-full lg:min-h-0">
          <PdfEvidenceViewer
            pdfUrl={activeCase.pdfUrl}
            sourceFilename={activeCase.sourceFilename}
            currentPage={currentPdfPage}
            onPageChange={setCurrentPdfPage}
            onPageCountDetected={(count) => {
              if (count > 0 && count !== activeCase.pageCount) {
                updateActiveCase((prev) => ({ ...prev, pageCount: count }));
              }
            }}
            onPageTextsExtracted={setPdfPageTexts}
            highlightedEvidences={activeTab === 'legal' ? highlightedEvidences : []}
            selectedQuote={selectedPdfQuote}
            onSelectQuote={setSelectedPdfQuote}
            activeTargetLabel={activeTargetInfo?.label || null}
            onApplyQuoteToTarget={handleApplyQuoteToTarget}
          />
        </div>

        {/* Right Pane: Structured Annotation & Workflow Views */}
        <div className="flex min-h-0 flex-col overflow-y-auto bg-slate-50 lg:col-span-7">
          {/* Document Identity Strip */}
          <div className="border-b border-slate-200 bg-white px-5 py-2 text-xs text-slate-500">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono-tabular font-medium text-slate-800">
                  {activeCase.documentId || activeCase.caseId.toLowerCase()}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">{activeCase.annotationVersion}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">{activeCase.fileSha256}</span>
              </div>
              <span className="text-slate-600">{USER_ROLE_META[userRole].badgeText}</span>
            </div>
          </div>

          {activeTab === 'fields' && (
            <>
              <EntityRegistryBar
                entities={activeCase.entities}
                selectedEntityId={selectedEntity.id}
                onSelectEntity={(id) => {
                  setSelectedEntityId(id);
                  setFocusedFieldKey(null);
                  setFocusedLegalOrRelId(null);
                }}
                onAddEntity={handleAddEntity}
                onRemoveEntity={handleRemoveEntity}
                recordCountByEntity={recordCountByEntity}
                progressByEntity={entityProgressMap}
              />
              <FieldAnnotationPanel
                caseDoc={activeCase}
                selectedEntity={selectedEntity}
                userRole={userRole}
                supplements={supplements}
                activeRecordKey={focusedFieldKey}
                activeLegalOrRelId={focusedLegalOrRelId?.id || null}
                onFocusRecord={(entityId, fieldCode) => {
                  setFocusedLegalOrRelId(null);
                  setFocusedFieldKey(`${entityId}:${fieldCode}`);
                }}
                onFocusLegalOrRel={(id, label) => {
                  setFocusedFieldKey(null);
                  setFocusedLegalOrRelId({ id, label });
                }}
                selectedPdfQuote={selectedPdfQuote}
                onJumpToPage={(page) => setCurrentPdfPage(page)}
                onUpsertFieldRecord={handleUpsertFieldRecord}
                onDeleteFieldRecord={handleDeleteFieldRecord}
                onSaveLegalItem={handleSaveLegalItem}
                onDeleteLegalItem={handleDeleteLegalItem}
                onSaveRelationItem={handleSaveRelationItem}
                onDeleteRelationItem={handleDeleteRelationItem}
                onOpenLegalTab={() => setActiveTab('legal')}
                externalBucketRequest={fieldBucketRequest}
              />
            </>
          )}

          {activeTab === 'legal' && (
            <LegalRelationsPanel
              caseDoc={activeCase}
              userRole={userRole}
              supplements={supplements}
              selectedPdfQuote={selectedPdfQuote}
              pdfPageTexts={pdfPageTexts}
              activeTargetId={focusedLegalOrRelId?.id || null}
              onFocusTarget={(id, label) => setFocusedLegalOrRelId({ id, label })}
              onJumpToPage={(page) => setCurrentPdfPage(page)}
              onHighlightEvidences={setHighlightedEvidences}
              onJumpToEntityField={(entityId, fieldCode) => {
                setActiveTab('fields');
                setSelectedEntityId(entityId);
                setFocusedLegalOrRelId(null);
                setFocusedFieldKey(fieldCode ? `${entityId}:${fieldCode}` : null);
                setFieldBucketRequest({ bucket: 'all', nonce: Date.now() });
              }}
              onSaveLegalItem={handleSaveLegalItem}
              onDeleteLegalItem={handleDeleteLegalItem}
              onSaveRelationItem={handleSaveRelationItem}
              onDeleteRelationItem={handleDeleteRelationItem}
              externalFocusRequest={legalFocusRequest}
            />
          )}

          {activeTab === 'vocab' && (
            <VocabularySupplementPanel
              supplements={supplements}
              onUpdateSupplement={(updated) =>
                setSupplements((prev) =>
                  prev.map((item) => (item.fieldCode === updated.fieldCode ? updated : item)),
                )
              }
            />
          )}

          {activeTab === 'export' && (
            <AcceptanceExportPanel
              caseDoc={activeCase}
              allCases={cases}
              userRole={userRole}
              supplements={supplements}
              statusFilter={queueStatusFilter}
              onStatusFilterChange={setQueueStatusFilter}
              onJumpToItem={handleJumpToWorkItem}
              onJumpToEntityUnstarted={handleJumpToEntityUnstarted}
              onQuickTransitionItem={handleQuickTransitionItem}
              onToggleChecklistItem={(checkId, checked) =>
                updateActiveCase((prev) => ({
                  ...prev,
                  checklist: { ...prev.checklist, [checkId]: checked },
                }))
              }
              onToggleMaskPii={(mask) =>
                updateActiveCase((prev) => ({ ...prev, maskPiiOnExport: mask }))
              }
              onBatchApproveDrafts={handleBatchApproveDrafts}
            />
          )}
        </div>
      </main>

      <ManualDrawer open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  );
}
