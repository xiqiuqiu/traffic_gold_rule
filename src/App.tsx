import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Settings,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { AcceptanceExportPanel } from './components/AcceptanceExportPanel';
import { EntityRegistryBar } from './components/EntityRegistryBar';
import { FieldAnnotationPanel } from './components/FieldAnnotationPanel';
import { LegalRelationsPanel } from './components/LegalRelationsPanel';
import { ManualDrawer } from './components/ManualDrawer';
import { ModelSettingsPanel } from './components/ModelSettingsPanel';
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
import {
  AiMergeMode,
  AiPreanalyzeMergeResult,
  AiPreanalyzePayload,
  buildAiSchemaCatalogPayload,
  mapAiExtractionToCaseDraft,
} from './utils/aiPreanalyze';
import {
  AiProviderSettings,
  getActiveModelSummary,
  loadAiProviderSettings,
  saveAiProviderSettings,
} from './utils/aiSettings';

type WorkspaceTab = 'fields' | 'legal' | 'vocab' | 'export' | 'settings';

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
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(false);
  const [aiMergeMode, setAiMergeMode] = useState<AiMergeMode>('merge_missing');
  const [aiRunning, setAiRunning] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLastResult, setAiLastResult] = useState<
    (Omit<AiPreanalyzeMergeResult, 'nextCase'> & { caseId: string }) | null
  >(null);
  const [aiSettings, setAiSettings] = useState<AiProviderSettings>(loadAiProviderSettings);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeCase = useMemo(
    () => cases.find((c) => c.caseId === activeCaseId) || cases[0],
    [cases, activeCaseId],
  );

  const activeModelSummary = useMemo(
    () => getActiveModelSummary(aiSettings),
    [aiSettings],
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

  useEffect(() => {
    saveAiProviderSettings(aiSettings);
  }, [aiSettings]);

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
    setAiError(null);
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
    setAiError(null);
    setAiLastResult(null);
    setAiPanelOpen(true);
    e.target.value = '';
  };

  const arrayBufferToBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  };

  const handleRunAiPreanalyze = async () => {
    if (!activeCase || aiRunning) return;
    const targetCaseId = activeCase.caseId;
    setAiPanelOpen(true);

    if (!activeModelSummary.isConfigured) {
      setAiError(activeModelSummary.issueHint || '请先前往“模型设置”完成接口与模型选择。');
      return;
    }

    setAiRunning(true);
    setAiError(null);

    try {
      const totalChars = Object.values(pdfPageTexts)
        .join('')
        .replace(/\s+/g, '').length;

      let pdfBase64: string | undefined;
      if (aiSettings.provider === 'gemini' && totalChars < 40 && activeCase.pdfUrl) {
        const pdfRes = await fetch(activeCase.pdfUrl);
        if (pdfRes.ok) {
          const buf = await pdfRes.arrayBuffer();
          pdfBase64 = arrayBufferToBase64(buf);
        }
      }

      const providerConfig =
        aiSettings.provider === 'openai_compatible'
          ? {
              provider: 'openai_compatible' as const,
              baseUrl: aiSettings.openai.baseUrl,
              apiKey: aiSettings.openai.apiKey,
              model: aiSettings.openai.selectedModel,
            }
          : { provider: 'gemini' as const };

      const fetchController = new AbortController();
      const clientTimeoutId = window.setTimeout(() => {
        fetchController.abort(new Error('timeout'));
      }, 250_000);

      let response: Response;
      try {
        response = await fetch('/api/ai/preanalyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: fetchController.signal,
          body: JSON.stringify({
            caseId: activeCase.caseId,
            sourceFilename: activeCase.sourceFilename,
            pageCount: activeCase.pageCount,
            pageTexts: pdfPageTexts,
            pdfBase64,
            schemaCatalog: buildAiSchemaCatalogPayload(supplements),
            providerConfig,
          }),
        });
      } finally {
        window.clearTimeout(clientTimeoutId);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : `AI 预分析请求失败 (${response.status})`,
        );
      }

      const aiPayload = data as AiPreanalyzePayload;
      const actorLabel =
        aiSettings.provider === 'openai_compatible'
          ? `OpenAI 兼容 (${aiSettings.openai.selectedModel})`
          : 'Gemini AI 预分析';

      const baseCase = cases.find((c) => c.caseId === targetCaseId) || activeCase;
      const merged = mapAiExtractionToCaseDraft(baseCase, aiPayload, {
        supplements,
        mergeMode: aiMergeMode,
        actorRole: userRole,
        actorLabel,
      });
      const { nextCase, ...summaryStats } = merged;

      setCases((prevList) =>
        prevList.map((item) => (item.caseId === targetCaseId ? nextCase : item)),
      );

      setAiLastResult({
        caseId: targetCaseId,
        ...summaryStats,
      });
      setActiveTab('fields');
      if (summaryStats.createdFieldsCount + summaryStats.updatedDraftFieldsCount > 0) {
        setFieldBucketRequest({ bucket: 'draft', nonce: Date.now() });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isTimeout =
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
        /timeout|aborted/i.test(msg);
      setAiError(
        isTimeout
          ? '模型响应超时，请重试或前往“模型设置”切换响应更快的模型。'
          : msg || 'AI 预分析失败，请稍后重试',
      );
    } finally {
      setAiRunning(false);
    }
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
              ['settings', '模型设置'],
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

          <button
            type="button"
            onClick={() => setAiPanelOpen((v) => !v)}
            aria-expanded={aiPanelOpen}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors ${
              aiPanelOpen
                ? 'bg-blue-50 text-blue-800'
                : 'text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI 预分析
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

          {aiPanelOpen && (
            <section
              aria-label="AI 预分析模块"
              className="border-b border-slate-200 bg-white px-5 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  <Sparkles className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
                  <span className="font-semibold text-slate-900">AI 预分析初稿提取</span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="truncate text-slate-600" title={activeCase.sourceFilename}>
                    {activeCase.sourceFilename}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono-tabular text-slate-700">
                    {activeModelSummary.providerLabel}：{activeModelSummary.modelName}
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveTab('settings')}
                    className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-blue-700 hover:underline"
                  >
                    <Settings className="h-3 w-3" aria-hidden="true" />
                    切换/配置模型
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="AI 预分析写入策略"
                    value={aiMergeMode}
                    onChange={(e) => setAiMergeMode(e.target.value as AiMergeMode)}
                    disabled={aiRunning}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800"
                  >
                    <option value="merge_missing">仅补充空白字段（保留现有标注）</option>
                    <option value="overwrite_drafts">覆盖未复核草稿（保留已复核/裁定）</option>
                  </select>

                  <button
                    type="button"
                    onClick={handleRunAiPreanalyze}
                    disabled={aiRunning}
                    className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-blue-400"
                  >
                    {aiRunning ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        正在提取初稿…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        开始提取初稿
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    aria-label="收起 AI 预分析模块"
                    onClick={() => setAiPanelOpen(false)}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {aiError && (
                <div
                  role="alert"
                  className="mt-2.5 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{aiError}</span>
                </div>
              )}

              {aiLastResult && aiLastResult.caseId === activeCase.caseId && !aiError && (
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" aria-hidden="true" />
                    <span className="font-medium text-slate-900">{aiLastResult.summaryText}</span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono-tabular">
                      新增对象 {aiLastResult.addedEntitiesCount} / 新建字段{' '}
                      {aiLastResult.createdFieldsCount} / 更新草稿{' '}
                      {aiLastResult.updatedDraftFieldsCount} / 校验通过{' '}
                      {aiLastResult.validDraftCount} / 待核对 {aiLastResult.errorDraftCount}
                    </span>
                    {aiLastResult.skippedProtectedFieldsCount > 0 && (
                      <span className="text-slate-500">
                        （已保留 {aiLastResult.skippedProtectedFieldsCount} 条已有/已复核字段）
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('fields');
                      setFieldBucketRequest({ bucket: 'draft', nonce: Date.now() });
                    }}
                    className="whitespace-nowrap font-medium text-blue-700 hover:underline"
                  >
                    查看草稿队列 →
                  </button>
                </div>
              )}
            </section>
          )}

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

          {activeTab === 'settings' && (
            <ModelSettingsPanel
              settings={aiSettings}
              onChangeSettings={(next) => {
                setAiSettings(next);
                setAiError(null);
              }}
              onJumpToPreanalyze={() => {
                setActiveTab('fields');
                setAiPanelOpen(true);
              }}
            />
          )}
        </div>
      </main>

      <ManualDrawer open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  );
}
