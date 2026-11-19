import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Loader2,
  Lock,
  RotateCcw,
  Settings,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { AcceptanceExportPanel } from './components/AcceptanceExportPanel';
import { AuditTrailPanel } from './components/AuditTrailPanel';
import { EntityRegistryBar } from './components/EntityRegistryBar';
import { FieldAnnotationPanel } from './components/FieldAnnotationPanel';
import { LegalRelationsPanel } from './components/LegalRelationsPanel';
import { ManualDrawer } from './components/ManualDrawer';
import { ModelSettingsPanel } from './components/ModelSettingsPanel';
import { PdfEvidenceViewer } from './components/PdfEvidenceViewer';
import { PermissionsPanel } from './components/PermissionsPanel';
import { SimilarCaseFusionPanel } from './components/SimilarCaseFusionPanel';
import { TaskCenterPanel } from './components/TaskCenterPanel';
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
  VocabularySupplementItem,
  WorkItemFilterStatus,
} from './types/gold';
import {
  AnalysisTask,
  BatchScheduleConfig,
  RolePermissionMatrix,
  SystemAuditCategory,
  SystemAuditEvent,
  UserIdentityProfile,
} from './types/system';
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
import { extractPdfPagesFromUrl } from './utils/pdfExtractor';
import {
  DEFAULT_IDENTITIES,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_SCHEDULE_CONFIG,
  EXTENDED_ROLE_META,
  buildInitialSystemAuditEvents,
  buildSeedTasksFromCases,
  extractAccidentBizId,
  hasPermission,
  mapExtendedRoleToWorkbenchRole,
} from './utils/systemEngine';

type SystemView = 'tasks' | 'detail' | 'similar' | 'audit' | 'system';
type WorkspaceTab = 'fields' | 'legal' | 'vocab' | 'export' | 'settings';

const STORAGE_CASES_KEY = 'gold_workbench_cases_v3';
const STORAGE_SUPPLEMENTS_KEY = 'gold_workbench_supplements_v1';
const STORAGE_IDENTITY_KEY = 'accident_system_active_identity_v1';

function loadInitialCases(): CaseDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_CASES_KEY);
    if (!raw) return SEED_CASES;
    const parsed = JSON.parse(raw) as CaseDocument[];
    if (Array.isArray(parsed) && parsed.length > 0) {
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

function createPlaceholderCaseForTask(task: AnalysisTask): CaseDocument {
  return {
    caseId: task.caseId,
    documentId: task.caseId.toLowerCase(),
    title: `${task.caseId} · ${task.filename.replace(/\.pdf$/i, '')}`,
    pilotCode: task.source === 'scheduled_batch' ? '定时批量' : '手工上传',
    scenarioSummary:
      task.source === 'scheduled_batch'
        ? `由定时批量扫盘自动入库的案件材料（${task.filename}）。`
        : `由人工手动上传创建的案件材料（${task.filename}）。`,
    pdfUrl: task.pdfUrl,
    sourceFilename: task.filename,
    fileSha256: task.fileSha256,
    pageCount: task.pageCount || 1,
    manualVersion: '试行版 · 首批6份',
    annotationVersion: 'v1.0',
    maskPiiOnExport: true,
    annotatorName: task.createdByName || '第一标注人',
    reviewerName: '第二复核人',
    adjudicatorName: '',
    entities: [
      {
        id: 'ACC',
        kind: 'ACC',
        label: '整起事故',
        subtitle: task.filename,
        roleLabel: '事故主体',
      },
    ],
    fieldRecords: [],
    legalConclusions: [],
    relations: [],
    checklist: {},
    auditLog: [],
  };
}

export default function App() {
  const [systemView, setSystemView] = useState<SystemView>('tasks');
  const [cases, setCases] = useState<CaseDocument[]>(loadInitialCases);
  const [supplements, setSupplements] = useState<VocabularySupplementItem[]>(loadInitialSupplements);
  const [activeCaseId, setActiveCaseId] = useState<string>(
    () => loadInitialCases()[0]?.caseId || 'CASE-01',
  );
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('fields');

  // System-level state (Tasks, Schedule, RBAC, Identities, Audit)
  const [tasks, setTasks] = useState<AnalysisTask[]>(() => buildSeedTasksFromCases(SEED_CASES));
  const [scheduleConfig, setScheduleConfig] =
    useState<BatchScheduleConfig>(DEFAULT_SCHEDULE_CONFIG);
  const [auditLogs, setAuditLogs] = useState<SystemAuditEvent[]>(() =>
    buildInitialSystemAuditEvents(SEED_CASES),
  );
  const [rolePermissions, setRolePermissions] = useState<RolePermissionMatrix>(
    DEFAULT_ROLE_PERMISSIONS,
  );
  const [identities, setIdentities] = useState<UserIdentityProfile[]>(DEFAULT_IDENTITIES);
  const [activeIdentityId, setActiveIdentityId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_IDENTITY_KEY) || DEFAULT_IDENTITIES[0].id;
    } catch {
      return DEFAULT_IDENTITIES[0].id;
    }
  });
  const [scanningDirectory, setScanningDirectory] = useState(false);
  const [lastScanMessage, setLastScanMessage] = useState<string | null>(null);
  const [lastScanError, setLastScanError] = useState<string | null>(null);
  const [systemSubTabRequest, setSystemSubTabRequest] = useState<{
    tab: 'rbac' | 'model';
    nonce: number;
  } | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  // Workbench detail state
  const [selectedEntityId, setSelectedEntityId] = useState<string>('ACC');
  const [currentPdfPage, setCurrentPdfPage] = useState<number>(1);
  const [selectedPdfQuote, setSelectedPdfQuote] = useState<{ page: number; quote: string } | null>(
    null,
  );
  const [focusedFieldKey, setFocusedFieldKey] = useState<string | null>(null);
  const [focusedLegalOrRelId, setFocusedLegalOrRelId] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [recordScrollRequest, setRecordScrollRequest] = useState<{
    tab: 'fields' | 'legal';
    id: string;
  } | null>(null);
  const [queueStatusFilter, setQueueStatusFilter] =
    useState<WorkItemFilterStatus>('pending_action');
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
  const quickUploadRef = useRef<HTMLInputElement | null>(null);

  // Latest state refs for async pipelines
  const casesRef = useRef(cases);
  casesRef.current = cases;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const supplementsRef = useRef(supplements);
  supplementsRef.current = supplements;
  const aiSettingsRef = useRef(aiSettings);
  aiSettingsRef.current = aiSettings;

  const activeIdentity = useMemo(
    () => identities.find((i) => i.id === activeIdentityId) || identities[0],
    [identities, activeIdentityId],
  );
  const userRole = useMemo(
    () => mapExtendedRoleToWorkbenchRole(activeIdentity.role),
    [activeIdentity.role],
  );
  const activeIdentityRef = useRef(activeIdentity);
  activeIdentityRef.current = activeIdentity;

  // RBAC permissions
  const canManageSchedule = hasPermission(
    rolePermissions,
    activeIdentity.role,
    'task:schedule_manage',
  );
  const canUploadAndRun = hasPermission(rolePermissions, activeIdentity.role, 'task:upload_run');
  const canEditCase = hasPermission(rolePermissions, activeIdentity.role, 'case:edit_annotate');
  const canReview = hasPermission(rolePermissions, activeIdentity.role, 'case:review');
  const canAdjudicate = hasPermission(rolePermissions, activeIdentity.role, 'case:adjudicate');
  const canExportFusion = hasPermission(
    rolePermissions,
    activeIdentity.role,
    'similar:fusion_export',
  );
  const canAuditPermissions = hasPermission(
    rolePermissions,
    activeIdentity.role,
    'system:audit_permissions',
  );

  const notifyPermissionBlocked = useCallback((message: string) => {
    setPermissionNotice(message);
    window.setTimeout(() => {
      setPermissionNotice((prev) => (prev === message ? null : prev));
    }, 4000);
  }, []);

  const ensureCasesForTasks = useCallback((incomingTasks: AnalysisTask[]) => {
    setCases((prev) => {
      const existingIds = new Set(prev.map((c) => c.caseId));
      const additions: CaseDocument[] = [];
      for (const t of incomingTasks) {
        if (!existingIds.has(t.caseId)) {
          existingIds.add(t.caseId);
          additions.push(createPlaceholderCaseForTask(t));
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

  // Bootstrap persisted system state from Express backend
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/bootstrap');
        if (!res.ok) return;
        const data = (await res.json()) as {
          scheduleConfig?: BatchScheduleConfig;
          tasks?: AnalysisTask[];
          auditLogs?: SystemAuditEvent[];
          rolePermissions?: RolePermissionMatrix;
          identities?: UserIdentityProfile[];
        };
        if (cancelled) return;
        if (data.scheduleConfig) setScheduleConfig(data.scheduleConfig);
        if (Array.isArray(data.tasks) && data.tasks.length > 0) {
          setTasks(data.tasks);
          ensureCasesForTasks(data.tasks);
        }
        if (Array.isArray(data.auditLogs)) setAuditLogs(data.auditLogs);
        if (data.rolePermissions) setRolePermissions(data.rolePermissions);
        if (Array.isArray(data.identities) && data.identities.length > 0) {
          setIdentities(data.identities);
        }
      } catch {
        // Offline / bootstrap fallback uses local defaults gracefully
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureCasesForTasks]);

  // Persist identity choice
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_IDENTITY_KEY, activeIdentityId);
    } catch {
      // Ignore storage error
    }
  }, [activeIdentityId]);

  // Sync case & supplement persistence
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

  const activeCase = useMemo(
    () => cases.find((c) => c.caseId === activeCaseId) || cases[0],
    [cases, activeCaseId],
  );

  const activeModelSummary = useMemo(() => getActiveModelSummary(aiSettings), [aiSettings]);

  // Keep task metadata (bizId, status approved/pending_review, extractedFieldsCount) synced with cases
  useEffect(() => {
    setTasks((prevTasks) => {
      let changed = false;
      const next = prevTasks.map((t) => {
        const matchedCase = cases.find((c) => c.caseId === t.caseId);
        if (!matchedCase) return t;
        const bizId = extractAccidentBizId(matchedCase);
        const extractedCount =
          matchedCase.fieldRecords.length + matchedCase.legalConclusions.length;
        const readiness = computeCaseReadiness(matchedCase, supplements);
        const isTerminalSuccess = t.status === 'pending_review' || t.status === 'approved';
        const nextStatus = isTerminalSuccess
          ? readiness.eligibleForScoring
            ? ('approved' as const)
            : ('pending_review' as const)
          : t.status;
        const nextStageLabel =
          nextStatus === 'approved' && t.status !== 'approved'
            ? '已复核并入库'
            : nextStatus === 'pending_review' && t.status === 'approved'
              ? '存在待人工复核/补充项'
              : t.stageLabel;
        if (
          t.accidentBizId === bizId &&
          t.extractedFieldsCount === extractedCount &&
          t.status === nextStatus &&
          t.stageLabel === nextStageLabel
        ) {
          return t;
        }
        changed = true;
        return {
          ...t,
          accidentBizId: bizId,
          extractedFieldsCount: extractedCount,
          status: nextStatus,
          stageLabel: nextStageLabel,
        };
      });
      return changed ? next : prevTasks;
    });
  }, [cases, supplements]);

  // Record a system-wide audit event locally & persist to backend
  const recordAuditEvent = useCallback(
    async (input: {
      category: SystemAuditCategory;
      action: string;
      targetRef: string;
      accidentBizId?: string;
      detail: string;
      beforeValue?: string;
      afterValue?: string;
    }) => {
      const actor = activeIdentityRef.current;
      const optimistic: SystemAuditEvent = {
        id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        timestamp: new Date().toISOString(),
        category: input.category,
        actorRole: actor.role,
        actorName: actor.name,
        action: input.action,
        targetRef: input.targetRef,
        accidentBizId: input.accidentBizId,
        detail: input.detail,
        beforeValue: input.beforeValue,
        afterValue: input.afterValue,
      };
      setAuditLogs((prev) => [optimistic, ...prev].slice(0, 500));
      try {
        await fetch('/api/system/audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input,
            actorRole: actor.role,
            actorName: actor.name,
          }),
        });
      } catch {
        // Keep local optimistic audit trail if offline
      }
    },
    [],
  );

  const patchTaskState = useCallback(async (taskId: string, patch: Partial<AnalysisTask>) => {
    const nowIso = new Date().toISOString();
    setTasks((prev) =>
      prev.map((t) => (t.taskId === taskId ? { ...t, ...patch, updatedAt: nowIso } : t)),
    );
    try {
      await fetch(`/api/system/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch {
      // Non-fatal offline tolerance
    }
  }, []);

  useEffect(() => {
    if (!recordScrollRequest) return;
    if (systemView !== 'detail' || activeTab !== recordScrollRequest.tab) {
      setRecordScrollRequest(null);
      return;
    }
    // Allow the destination panel to apply its filters before revealing the record.
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-focus-id="${CSS.escape(recordScrollRequest.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setRecordScrollRequest(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [recordScrollRequest, activeTab, systemView]);

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

  const readiness = useMemo(
    () => computeCaseReadiness(activeCase, supplements),
    [activeCase, supplements],
  );
  const entityProgressMap = useMemo(
    () => computeEntityProgressMap(activeCase, supplements),
    [activeCase, supplements],
  );
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
    return {
      id: `LOG-${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      actorRole: userRole,
      actorName: activeIdentity.name,
      action,
      targetRef,
      comment,
    };
  };

  const handleAddEntity = (kind: EntityKind, label: string, subtitle: string) => {
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无「字段修正与 AI 预提取」权限，无法新增主体对象。');
      return;
    }
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
    void recordAuditEvent({
      category: 'annotation',
      action: '新增分析主体对象',
      targetRef: `${activeCase.caseId} · ${nextId}`,
      accidentBizId: extractAccidentBizId(activeCase) || undefined,
      detail: `登记主体 ${label}${subtitle ? ` (${subtitle})` : ''}`,
    });
  };

  const handleRemoveEntity = (entityId: string) => {
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无「字段修正与 AI 预提取」权限，无法移除对象。');
      return;
    }
    updateActiveCase((prev) => ({
      ...prev,
      entities: prev.entities.filter((e) => e.id !== entityId),
      fieldRecords: prev.fieldRecords.filter((r) => r.entityId !== entityId),
      auditLog: [makeAuditEntry('移除对象', entityId), ...prev.auditLog],
    }));
    if (selectedEntityId === entityId) {
      setSelectedEntityId('ACC');
    }
    void recordAuditEvent({
      category: 'annotation',
      action: '移除分析主体对象',
      targetRef: `${activeCase.caseId} · ${entityId}`,
      accidentBizId: extractAccidentBizId(activeCase) || undefined,
      detail: `移除主体 ${entityId} 及其名下字段草稿`,
    });
  };

  const handleUpsertFieldRecord = (record: FieldRecord, auditNote?: string) => {
    const prevRecord = activeCase.fieldRecords.find((r) => r.recordId === record.recordId);
    const statusChanged = prevRecord && prevRecord.reviewStatus !== record.reviewStatus;
    if (statusChanged) {
      if (record.reviewStatus === 'specialist_review' && !canAdjudicate) {
        notifyPermissionBlocked('当前身份无「专业裁定与词表核定」权限。');
        return;
      }
      if (
        (record.reviewStatus === 'checked' || record.reviewStatus === 'disputed') &&
        !canReview
      ) {
        notifyPermissionBlocked('当前身份无「复核确认与标记争议」权限。');
        return;
      }
    } else if (!canEditCase) {
      notifyPermissionBlocked('当前身份无「字段修正与 AI 预提取」权限，数据为只读状态。');
      return;
    }

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

    if (auditNote || statusChanged) {
      void recordAuditEvent({
        category: statusChanged ? 'review_adjudicate' : 'annotation',
        action: auditNote || `更新字段 ${record.fieldCode}`,
        targetRef: `${activeCase.caseId} · ${record.entityId}.${record.fieldCode}`,
        accidentBizId:
          record.fieldCode === 'D01.F001'
            ? record.normalizedValues[0] || record.rawValue
            : extractAccidentBizId(activeCase) || undefined,
        detail: `状态=${record.reviewStatus}，取值=${
          record.normalizedValues.join('、') || record.rawValue || record.presenceStatus
        }`,
        beforeValue: prevRecord
          ? prevRecord.normalizedValues.join('、') || prevRecord.rawValue
          : undefined,
        afterValue: record.normalizedValues.join('、') || record.rawValue,
      });
    }
  };

  const handleDeleteFieldRecord = (recordId: string) => {
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无删除字段记录权限。');
      return;
    }
    updateActiveCase((prev) => ({
      ...prev,
      fieldRecords: prev.fieldRecords.filter((r) => r.recordId !== recordId),
    }));
  };

  const handleSaveLegalItem = (item: LegalConclusionItem, auditNote?: string) => {
    const prevItem = activeCase.legalConclusions.find((x) => x.id === item.id);
    const statusChanged = prevItem && prevItem.reviewStatus !== item.reviewStatus;
    if (statusChanged) {
      if (item.reviewStatus === 'specialist_review' && !canAdjudicate) {
        notifyPermissionBlocked('当前身份无「专业裁定与词表核定」权限。');
        return;
      }
      if ((item.reviewStatus === 'checked' || item.reviewStatus === 'disputed') && !canReview) {
        notifyPermissionBlocked('当前身份无「复核确认与标记争议」权限。');
        return;
      }
    } else if (!canEditCase) {
      notifyPermissionBlocked('当前身份无编辑法律结论权限。');
      return;
    }

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

    if (auditNote || statusChanged) {
      void recordAuditEvent({
        category: statusChanged ? 'review_adjudicate' : 'annotation',
        action: auditNote || `更新法律结论 ${item.category}`,
        targetRef: `${activeCase.caseId} · ${item.id}`,
        accidentBizId: extractAccidentBizId(activeCase) || undefined,
        detail: `${item.subjectId} · ${item.conclusionLabel || item.rawText.slice(0, 32)}`,
      });
    }
  };

  const handleDeleteLegalItem = (id: string) => {
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无删除法律结论权限。');
      return;
    }
    updateActiveCase((prev) => ({
      ...prev,
      legalConclusions: prev.legalConclusions.filter((x) => x.id !== id),
    }));
  };

  const handleSaveRelationItem = (item: EventRelationItem, auditNote?: string) => {
    const prevItem = activeCase.relations.find((x) => x.id === item.id);
    const statusChanged = prevItem && prevItem.reviewStatus !== item.reviewStatus;
    if (statusChanged) {
      if (item.reviewStatus === 'specialist_review' && !canAdjudicate) {
        notifyPermissionBlocked('当前身份无「专业裁定与词表核定」权限。');
        return;
      }
      if ((item.reviewStatus === 'checked' || item.reviewStatus === 'disputed') && !canReview) {
        notifyPermissionBlocked('当前身份无「复核确认与标记争议」权限。');
        return;
      }
    } else if (!canEditCase) {
      notifyPermissionBlocked('当前身份无编辑事件关系权限。');
      return;
    }

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

    if (auditNote || statusChanged) {
      void recordAuditEvent({
        category: statusChanged ? 'review_adjudicate' : 'annotation',
        action: auditNote || '更新事发关系链',
        targetRef: `${activeCase.caseId} · ${item.id}`,
        accidentBizId: extractAccidentBizId(activeCase) || undefined,
        detail: `${item.sourceId} → ${item.action || item.relationType || ''} → ${item.targetId}`,
      });
    }
  };

  const handleDeleteRelationItem = (id: string) => {
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无删除事件关系权限。');
      return;
    }
    updateActiveCase((prev) => ({
      ...prev,
      relations: prev.relations.filter((x) => x.id !== id),
    }));
  };

  const handleBatchApproveDrafts = () => {
    if (!canReview) {
      notifyPermissionBlocked('当前身份无「复核确认与标记争议」权限，请切换为复核员或管理员。');
      return;
    }
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
    void recordAuditEvent({
      category: 'review_adjudicate',
      action: '批量复核无错草稿',
      targetRef: activeCase.caseId,
      accidentBizId: extractAccidentBizId(activeCase) || undefined,
      detail: `将 ${activeCase.caseId} 内校验通过的草稿批量流转为已复核状态`,
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
      const id = `${item.entityId}:${item.fieldCode}`;
      setFocusedFieldKey(id);
      setRecordScrollRequest({ tab: 'fields', id });
      setFieldBucketRequest({ bucket: 'all', nonce: Date.now() });
      return;
    }
    if (item.targetTab === 'legal' && item.legalOrRelId) {
      setActiveTab('legal');
      setFocusedFieldKey(null);
      setFocusedLegalOrRelId({ id: item.legalOrRelId, label: item.title });
      setRecordScrollRequest({ tab: 'legal', id: item.legalOrRelId });
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
    if (nextStatus === 'checked' && !canReview) {
      notifyPermissionBlocked('当前身份无「复核确认」权限。');
      return;
    }
    if (nextStatus === 'specialist_review' && !canAdjudicate) {
      notifyPermissionBlocked('当前身份无「专业裁定」权限。');
      return;
    }
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
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无编辑标注权限，无法写入 PDF 摘录证据。');
      return;
    }
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

  // Core Task Pipeline Execution (PDF text extract -> LLM preanalyze -> CaseDraft merge -> Status & Audit)
  const handleRunTaskPipeline = useCallback(
    async (taskId: string, options?: { bypassRoleCheck?: boolean }) => {
      if (!options?.bypassRoleCheck && !canUploadAndRun) {
        notifyPermissionBlocked('当前身份无「手动上传与启停解析」权限。');
        return;
      }
      const targetTask = tasksRef.current.find((t) => t.taskId === taskId);
      if (!targetTask) return;

      const startedAtMs = Date.now();
      const startedIso = new Date(startedAtMs).toISOString();
      const currentModelSummary = getActiveModelSummary(aiSettingsRef.current);

      await patchTaskState(taskId, {
        status: 'parsing_pdf',
        progress: 35,
        stageLabel: '正在抽取 PDF 分页文本与页码索引…',
        startedAt: startedIso,
        errorMessage: undefined,
        modelLabel: `${currentModelSummary.providerLabel} · ${currentModelSummary.modelName}`,
      });

      try {
        const extracted = await extractPdfPagesFromUrl(targetTask.pdfUrl, {
          includeBase64IfEmptyText: aiSettingsRef.current.provider === 'gemini',
        });

        setCases((prev) =>
          prev.map((c) =>
            c.caseId === targetTask.caseId ? { ...c, pageCount: extracted.pageCount } : c,
          ),
        );

        if (!currentModelSummary.isConfigured) {
          throw new Error(
            currentModelSummary.issueHint ||
              '未完成大模型接入配置，请前往「权限与设置 → 大模型接入与探测设置」配置后再重试。',
          );
        }

        await patchTaskState(taskId, {
          status: 'ai_extracting',
          progress: 70,
          pageCount: extracted.pageCount,
          stageLabel: '正在调用大模型执行交通事故字段结构化提取…',
        });

        const providerConfig =
          aiSettingsRef.current.provider === 'openai_compatible'
            ? {
                provider: 'openai_compatible' as const,
                baseUrl: aiSettingsRef.current.openai.baseUrl,
                apiKey: aiSettingsRef.current.openai.apiKey,
                model: aiSettingsRef.current.openai.selectedModel,
              }
            : { provider: 'gemini' as const };

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
          controller.abort(new Error('timeout'));
        }, 250_000);

        let response: Response;
        try {
          response = await fetch('/api/ai/preanalyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              caseId: targetTask.caseId,
              sourceFilename: targetTask.filename,
              pageCount: extracted.pageCount,
              pageTexts: extracted.pageTexts,
              pdfBase64: extracted.pdfBase64,
              schemaCatalog: buildAiSchemaCatalogPayload(supplementsRef.current),
              providerConfig,
            }),
          });
        } finally {
          window.clearTimeout(timeoutId);
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof data?.error === 'string' && data.error
              ? data.error
              : `大模型解析请求失败（HTTP ${response.status}）`,
          );
        }

        const aiPayload = data as AiPreanalyzePayload;
        const baseCase =
          casesRef.current.find((c) => c.caseId === targetTask.caseId) ||
          createPlaceholderCaseForTask(targetTask);

        const merged = mapAiExtractionToCaseDraft(baseCase, aiPayload, {
          supplements: supplementsRef.current,
          mergeMode: 'merge_missing',
          actorRole: mapExtendedRoleToWorkbenchRole(activeIdentityRef.current.role),
          actorLabel: `${currentModelSummary.providerLabel} (${currentModelSummary.modelName})`,
        });

        const updatedCase: CaseDocument = {
          ...merged.nextCase,
          pageCount: extracted.pageCount,
        };

        setCases((prev) => {
          const exists = prev.some((c) => c.caseId === updatedCase.caseId);
          return exists
            ? prev.map((c) => (c.caseId === updatedCase.caseId ? updatedCase : c))
            : [...prev, updatedCase];
        });

        const nextReadiness = computeCaseReadiness(updatedCase, supplementsRef.current);
        const extractedBizId = extractAccidentBizId(updatedCase);
        const extractedFieldsCount =
          updatedCase.fieldRecords.length + updatedCase.legalConclusions.length;
        const durationMs = Date.now() - startedAtMs;

        await patchTaskState(taskId, {
          status: nextReadiness.eligibleForScoring ? 'approved' : 'pending_review',
          progress: 100,
          pageCount: extracted.pageCount,
          accidentBizId: extractedBizId,
          extractedFieldsCount,
          finishedAt: new Date().toISOString(),
          durationMs,
          stageLabel: nextReadiness.eligibleForScoring
            ? '已完成抽取并达到入库标准'
            : `提取 ${extractedFieldsCount} 项结构化草稿，等待人工审核`,
        });

        await recordAuditEvent({
          category: 'task_pipeline',
          action: '完成 PDF 解析与大模型结构化入库',
          targetRef: targetTask.caseId,
          accidentBizId: extractedBizId || undefined,
          detail: `${targetTask.filename}（${extracted.pageCount} 页）提取 ${extractedFieldsCount} 项，耗时 ${(
            durationMs / 1000
          ).toFixed(1)}s`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'PDF 解析或大模型调用失败';
        const isTimeout =
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
          /timeout|aborted/i.test(msg);
        const finalMsg = isTimeout
          ? '大模型响应超时，可重试解析或前往权限与设置切换响应更快的模型。'
          : msg;

        await patchTaskState(taskId, {
          status: 'failed',
          progress: 100,
          stageLabel: '流水线执行中断',
          errorMessage: finalMsg,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
        });

        await recordAuditEvent({
          category: 'task_pipeline',
          action: '任务解析流水线执行失败',
          targetRef: targetTask.caseId,
          detail: `${targetTask.filename}：${finalMsg}`,
        });
      }
    },
    [canUploadAndRun, notifyPermissionBlocked, patchTaskState, recordAuditEvent],
  );

  // Manual PDF upload task creation (shared by TaskCenterPanel and Detail workbench upload)
  const handleManualUploadPdf = useCallback(
    async (
      file: File,
      startImmediately: boolean,
      options?: { openDetailAfterCreate?: boolean },
    ) => {
      if (!canUploadAndRun) {
        notifyPermissionBlocked('当前身份无「手动上传与启停解析」权限。');
        return;
      }

      const blobUrl = URL.createObjectURL(file);
      let shaShort = `local-${Date.now().toString(36)}`;
      let shaFull = '';
      try {
        const buf = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        shaFull = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        shaShort = `sha256:${shaFull.slice(0, 16)}`;
      } catch {
        // Ignore crypto fallback
      }

      const seq = casesRef.current.length + 1;
      const newCaseId = `CASE-MANUAL-${String(seq).padStart(2, '0')}`;
      const newTaskId = `TASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const nowIso = new Date().toISOString();
      const modelSummary = getActiveModelSummary(aiSettingsRef.current);

      const newCase: CaseDocument = {
        caseId: newCaseId,
        documentId: newCaseId.toLowerCase(),
        title: `${newCaseId} · ${file.name.replace(/\.pdf$/i, '')}`,
        pilotCode: '手工上传',
        scenarioSummary: '由人工手动上传的事故认定书材料，支持立即执行或待命后触发 AI 提取。',
        pdfUrl: blobUrl,
        sourceFilename: file.name,
        fileSha256: shaShort,
        sourceHashFull: shaFull || undefined,
        pageCount: 1,
        manualVersion: '试行版 · 首批6份',
        annotationVersion: 'v1.0',
        maskPiiOnExport: true,
        annotatorName: activeIdentityRef.current.name,
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

      const newTask: AnalysisTask = {
        taskId: newTaskId,
        source: 'manual_upload',
        status: startImmediately ? 'queued' : 'idle',
        progress: startImmediately ? 10 : 0,
        stageLabel: startImmediately ? '已上传入队，准备开始解析' : '已暂存待命，等待人工点击开始解析',
        caseId: newCaseId,
        accidentBizId: '',
        filename: file.name,
        pdfUrl: blobUrl,
        fileSha256: shaShort,
        fileSizeBytes: file.size,
        pageCount: 1,
        modelLabel: `${modelSummary.providerLabel} · ${modelSummary.modelName}`,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdByRole: activeIdentityRef.current.role,
        createdByName: activeIdentityRef.current.name,
      };

      setCases((prev) => [...prev, newCase]);
      setTasks((prev) => [newTask, ...prev]);

      try {
        const res = await fetch('/api/system/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: newTask,
            auditDetail: `${file.name}（${startImmediately ? '上传并立即解析' : '暂存待命'}）`,
          }),
        });
        if (res.ok) {
          const payload = (await res.json()) as { auditEvent?: SystemAuditEvent };
          if (payload.auditEvent) {
            setAuditLogs((prev) => [payload.auditEvent!, ...prev].slice(0, 500));
          }
        }
      } catch {
        await recordAuditEvent({
          category: 'task_pipeline',
          action: '手动上传材料创建任务',
          targetRef: newCaseId,
          detail: file.name,
        });
      }

      if (options?.openDetailAfterCreate) {
        setActiveCaseId(newCaseId);
        setSystemView('detail');
        setActiveTab('fields');
      }

      if (startImmediately) {
        await handleRunTaskPipeline(newTaskId, { bypassRoleCheck: true });
      }
    },
    [canUploadAndRun, handleRunTaskPipeline, notifyPermissionBlocked, recordAuditEvent],
  );

  // Batch schedule configuration & directory scan handlers
  const handleSaveSchedule = useCallback(
    async (next: Partial<BatchScheduleConfig>) => {
      if (!canManageSchedule) {
        notifyPermissionBlocked('当前身份无「定时批量调度配置」权限。');
        return;
      }
      setLastScanError(null);
      try {
        const res = await fetch('/api/system/schedule', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleConfig: next,
            actorName: activeIdentityRef.current.name,
            actorRole: activeIdentityRef.current.role,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || '保存定时调度配置失败');
        }
        if (data.scheduleConfig) setScheduleConfig(data.scheduleConfig);
        if (data.auditEvent) {
          setAuditLogs((prev) => [data.auditEvent, ...prev].slice(0, 500));
        }
        setLastScanMessage('定时批量扫盘策略已更新并写入操作审计。');
      } catch (err) {
        setLastScanError(err instanceof Error ? err.message : '保存调度配置失败');
      }
    },
    [canManageSchedule, notifyPermissionBlocked],
  );

  const handleTriggerDirectoryScan = useCallback(
    async (forceRequeue: boolean) => {
      if (!canManageSchedule) {
        notifyPermissionBlocked('当前身份无「定时批量调度配置」权限。');
        return;
      }
      setScanningDirectory(true);
      setLastScanError(null);
      setLastScanMessage(null);
      try {
        const res = await fetch('/api/system/schedule/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            forceRequeue,
            actorName: activeIdentityRef.current.name,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || '扫描服务器目录失败');
        }
        if (data.scheduleConfig) setScheduleConfig(data.scheduleConfig);
        if (Array.isArray(data.tasks)) {
          setTasks(data.tasks);
          ensureCasesForTasks(data.tasks);
        }
        if (Array.isArray(data.auditLogs)) setAuditLogs(data.auditLogs);

        const created: AnalysisTask[] = Array.isArray(data.createdTasks) ? data.createdTasks : [];
        setLastScanMessage(
          created.length > 0
            ? `已扫描目录并新增 ${created.length} 条任务（跳过已存在 ${
                data.skippedExistingCount || 0
              } 份）。`
            : `扫描目录完成：共发现 ${data.scannedFileCount || 0} 份 PDF，均已入库（如欲重新演示可点击“强制重扫目录演示批次”）。`,
        );

        // Execute queued tasks sequentially if autoRunAi is enabled
        const runnable = created.filter((t) => t.status === 'queued');
        for (const t of runnable) {
          await handleRunTaskPipeline(t.taskId, { bypassRoleCheck: true });
        }
      } catch (err) {
        setLastScanError(err instanceof Error ? err.message : '扫描目录异常');
      } finally {
        setScanningDirectory(false);
      }
    },
    [canManageSchedule, ensureCasesForTasks, handleRunTaskPipeline, notifyPermissionBlocked],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      if (!canUploadAndRun) {
        notifyPermissionBlocked('当前身份无删除任务权限。');
        return;
      }
      const existing = tasksRef.current.find((t) => t.taskId === taskId);
      setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
      try {
        await fetch(
          `/api/system/tasks/${encodeURIComponent(taskId)}?actorName=${encodeURIComponent(
            activeIdentityRef.current.name,
          )}`,
          { method: 'DELETE' },
        );
      } catch {
        // Offline fallback
      }
      if (existing) {
        await recordAuditEvent({
          category: 'task_pipeline',
          action: '移除分析任务记录',
          targetRef: existing.caseId,
          accidentBizId: existing.accidentBizId || undefined,
          detail: `删除任务 ${existing.taskId}（${existing.filename}）`,
        });
      }
    },
    [canUploadAndRun, notifyPermissionBlocked, recordAuditEvent],
  );

  const handleImportLocalPdfFromDetail = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await handleManualUploadPdf(file, false, { openDetailAfterCreate: true });
    setAiError(null);
    setAiLastResult(null);
    setAiPanelOpen(true);
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
    if (!canEditCase) {
      notifyPermissionBlocked('当前身份无「字段修正与 AI 预提取」权限。');
      return;
    }
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
      await recordAuditEvent({
        category: 'task_pipeline',
        action: '单案 AI 预分析提取初稿',
        targetRef: targetCaseId,
        accidentBizId: extractAccidentBizId(nextCase) || undefined,
        detail: `${actorLabel}：新建 ${summaryStats.createdFieldsCount} 条，更新 ${summaryStats.updatedDraftFieldsCount} 条`,
      });
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

  const handleOpenCaseDetail = useCallback(
    (caseId: string, targetFieldCode?: string) => {
      setActiveCaseId(caseId);
      setSystemView('detail');
      setActiveTab('fields');
      if (targetFieldCode) {
        setSelectedEntityId('ACC');
        setFocusedLegalOrRelId(null);
        const id = `ACC:${targetFieldCode}`;
        setFocusedFieldKey(id);
        setRecordScrollRequest({ tab: 'fields', id });
        setFieldBucketRequest({ bucket: 'all', nonce: Date.now() });
      }
    },
    [],
  );

  const handleOpenModelSettings = useCallback(() => {
    setSystemView('system');
    setSystemSubTabRequest({ tab: 'model', nonce: Date.now() });
  }, []);

  const handleUpdatePermissions = useCallback(
    async (next: RolePermissionMatrix, changeSummary: string) => {
      if (!canAuditPermissions) {
        notifyPermissionBlocked('当前身份无修改权限矩阵权限。');
        return;
      }
      setRolePermissions(next);
      try {
        const res = await fetch('/api/system/permissions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rolePermissions: next,
            actorName: activeIdentityRef.current.name,
            actorRole: activeIdentityRef.current.role,
            changeSummary,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.auditEvent) {
          setAuditLogs((prev) => [data.auditEvent, ...prev].slice(0, 500));
        }
      } catch {
        await recordAuditEvent({
          category: 'permission',
          action: '更新角色权限矩阵',
          targetRef: 'RBAC-MATRIX',
          detail: changeSummary,
        });
      }
    },
    [canAuditPermissions, notifyPermissionBlocked, recordAuditEvent],
  );

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
      {/* Top Bar Contract: Strict 3 Zones, single row */}
      <header className="flex shrink-0 items-center justify-between gap-6 border-b border-slate-200 bg-white px-5 py-3">
        <span className="shrink-0 whitespace-nowrap text-base font-bold tracking-tight text-slate-900">
          智能事故分析系统
        </span>

        <nav
          aria-label="系统主导航"
          className="flex items-center gap-6 overflow-x-auto text-sm font-medium"
        >
          {(
            [
              ['tasks', '任务调度'],
              ['detail', '案件详情'],
              ['similar', '类案与融合'],
              ['audit', '全链路审计'],
              ['system', '权限与设置'],
            ] as Array<[SystemView, string]>
          ).map(([viewKey, label]) => (
            <button
              key={viewKey}
              type="button"
              onClick={() => setSystemView(viewKey)}
              className={`shrink-0 whitespace-nowrap border-b-2 py-1 transition-colors ${
                systemView === viewKey
                  ? 'border-blue-700 text-blue-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center">
          <input
            ref={quickUploadRef}
            type="file"
            accept="application/pdf"
            aria-label="快捷上传本地 PDF 创建任务"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setSystemView('tasks');
              await handleManualUploadPdf(file, true);
            }}
            className="hidden"
          />
          {systemView === 'detail' ? (
            <button
              type="button"
              onClick={() => setActiveTab('export')}
              className="shrink-0 whitespace-nowrap rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"
            >
              导出 Gold JSON
            </button>
          ) : (
            <button
              type="button"
              disabled={!canUploadAndRun}
              onClick={() => {
                if (systemView !== 'tasks') {
                  setSystemView('tasks');
                }
                quickUploadRef.current?.click();
              }}
              className="shrink-0 whitespace-nowrap rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              上传 PDF 分析
            </button>
          )}
        </div>
      </header>

      {/* Secondary System Context & Quick Identity Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-2">
        <div className="flex flex-wrap items-center gap-3">
          {systemView === 'detail' && (
            <>
              <button
                type="button"
                onClick={() => setSystemView('tasks')}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                返回任务调度
              </button>

              <div className="flex items-center gap-2">
                <label htmlFor="case-selector" className="text-xs font-medium text-slate-600">
                  当前案件
                </label>
                <select
                  id="case-selector"
                  value={activeCase.caseId}
                  onChange={(e) => setActiveCaseId(e.target.value)}
                  className="max-w-[260px] rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900"
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
                onChange={handleImportLocalPdfFromDetail}
                className="hidden"
                aria-label="导入本地 PDF 文件"
              />
              <button
                type="button"
                disabled={!canUploadAndRun}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200/70 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                导入本地 PDF
              </button>

              <button
                type="button"
                disabled={!canEditCase}
                onClick={() => setAiPanelOpen((v) => !v)}
                aria-expanded={aiPanelOpen}
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  aiPanelOpen
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                AI 预分析
              </button>
            </>
          )}

          {/* Quick Identity Switcher (Retained across all system views) */}
          <div className="flex items-center gap-2">
            <label htmlFor="quick-identity-select" className="text-xs font-medium text-slate-600">
              当前演示身份
            </label>
            <select
              id="quick-identity-select"
              value={activeIdentity.id}
              onChange={(e) => {
                const nextId = e.target.value;
                setActiveIdentityId(nextId);
                const nextProfile = identities.find((i) => i.id === nextId);
                if (nextProfile) {
                  setPermissionNotice(
                    `已切换为：${nextProfile.name}（${EXTENDED_ROLE_META[nextProfile.role].label}）`,
                  );
                  window.setTimeout(() => setPermissionNotice(null), 2600);
                }
              }}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900"
            >
              {identities.map((idProfile) => (
                <option key={idProfile.id} value={idProfile.id}>
                  {idProfile.name} · {EXTENDED_ROLE_META[idProfile.role].label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          {systemView === 'detail' ? (
            <>
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
            </>
          ) : (
            <span className="font-mono-tabular text-slate-600">
              {EXTENDED_ROLE_META[activeIdentity.role].description}
            </span>
          )}
        </div>
      </div>

      {/* Transient RBAC / Identity Switch Feedback Bar */}
      {permissionNotice && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900"
        >
          <span>{permissionNotice}</span>
          <button
            type="button"
            onClick={() => setPermissionNotice(null)}
            className="text-amber-700 hover:text-amber-950"
          >
            关闭
          </button>
        </div>
      )}

      {/* System Views vs Detail Workbench Split View */}
      {systemView === 'tasks' && (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <TaskCenterPanel
            tasks={tasks}
            scheduleConfig={scheduleConfig}
            canManageSchedule={canManageSchedule}
            canUploadAndRun={canUploadAndRun}
            canEditCase={canEditCase}
            scanningDirectory={scanningDirectory}
            lastScanMessage={lastScanMessage}
            lastScanError={lastScanError}
            onSaveSchedule={handleSaveSchedule}
            onTriggerDirectoryScan={handleTriggerDirectoryScan}
            onManualUploadPdf={async (file, startImmediately) =>
              handleManualUploadPdf(file, startImmediately)
            }
            onRunTaskPipeline={async (taskId) => handleRunTaskPipeline(taskId)}
            onOpenCaseDetail={(caseId) => handleOpenCaseDetail(caseId)}
            onDeleteTask={handleDeleteTask}
            onOpenModelSettings={handleOpenModelSettings}
          />
        </main>
      )}

      {systemView === 'similar' && (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <SimilarCaseFusionPanel
            cases={cases}
            supplements={supplements}
            canExportFusion={canExportFusion}
            onOpenCaseDetail={handleOpenCaseDetail}
            onRecordFusionExport={(caseId, bizId, method) => {
              const labelMap = {
                copy: '复制跨系统融合 JSON',
                download_single: '导出单案跨系统融合包',
                download_batch: '批量导出跨系统融合包',
              };
              void recordAuditEvent({
                category: 'fusion_export',
                action: labelMap[method],
                targetRef: caseId,
                accidentBizId: bizId || undefined,
                detail: `基于唯一主键 D01.F001（${bizId || '未录入'}）输出跨系统数据融合结构`,
              });
            }}
          />
        </main>
      )}

      {systemView === 'audit' && (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <AuditTrailPanel events={auditLogs} canViewFullAudit={canAuditPermissions} />
        </main>
      )}

      {systemView === 'system' && (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <PermissionsPanel
            identities={identities}
            activeIdentity={activeIdentity}
            rolePermissions={rolePermissions}
            canEditPermissions={canAuditPermissions}
            aiSettings={aiSettings}
            subTabRequest={systemSubTabRequest}
            onSwitchIdentity={(identityId) => setActiveIdentityId(identityId)}
            onUpdatePermissions={handleUpdatePermissions}
            onChangeAiSettings={(next) => {
              setAiSettings(next);
              setAiError(null);
            }}
            onJumpToPreanalyze={() => {
              setSystemView('detail');
              setActiveTab('fields');
              setAiPanelOpen(true);
            }}
          />
        </main>
      )}

      {systemView === 'detail' && (
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
            {/* Case Detail Sub-Tab Switcher + Document Identity Strip */}
            <div className="border-b border-slate-200 bg-white px-5 pt-2">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 text-xs text-slate-500">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono-tabular font-medium text-slate-800">
                    {activeCase.documentId || activeCase.caseId.toLowerCase()}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">
                    业务编号：{extractAccidentBizId(activeCase) || '待补充 D01.F001'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{activeCase.fileSha256}</span>
                </div>
                <span className="text-slate-600">{USER_ROLE_META[userRole].badgeText}</span>
              </div>

              <div
                role="tablist"
                aria-label="案件分析详情子视图"
                className="flex items-center gap-5 overflow-x-auto text-xs font-medium"
              >
                {(
                  [
                    ['fields', '字段标注与修正'],
                    ['legal', '法律与因果关系'],
                    ['vocab', '受控词表增补'],
                    ['export', '交付验收与导出'],
                    ['settings', '模型接口设置'],
                  ] as Array<[WorkspaceTab, string]>
                ).map(([tabKey, label]) => (
                  <button
                    key={tabKey}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tabKey}
                    onClick={() => setActiveTab(tabKey)}
                    className={`shrink-0 whitespace-nowrap border-b-2 py-2 transition-colors ${
                      activeTab === tabKey
                        ? 'border-blue-700 text-blue-800'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {!canEditCase && (
              <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-5 py-2 text-xs text-slate-700">
                <Lock className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                <span>
                  当前身份（{EXTENDED_ROLE_META[activeIdentity.role].label}
                  ）处于只读查看模式：可查阅 PDF 原文与全部标注字段，修改操作将被权限策略拦截。
                </span>
              </div>
            )}

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
                      disabled={aiRunning || !canEditCase}
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
                  onFocusLegalOrRel={(id, label, reveal = true) => {
                    setFocusedFieldKey(null);
                    setFocusedLegalOrRelId({ id, label });
                    if (reveal) setRecordScrollRequest({ tab: 'fields', id });
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
                onFocusTarget={(id, label, reveal = true) => {
                  setFocusedLegalOrRelId({ id, label });
                  if (reveal) setRecordScrollRequest({ tab: 'legal', id });
                }}
                onJumpToPage={(page) => setCurrentPdfPage(page)}
                onHighlightEvidences={setHighlightedEvidences}
                onJumpToEntityField={(entityId, fieldCode) => {
                  setActiveTab('fields');
                  setSelectedEntityId(entityId);
                  setFocusedLegalOrRelId(null);
                  const id = fieldCode ? `${entityId}:${fieldCode}` : null;
                  setFocusedFieldKey(id);
                  if (id) setRecordScrollRequest({ tab: 'fields', id });
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
                onUpdateSupplement={(updated) => {
                  if (!canAdjudicate && updated.approvalStatus === '已核定') {
                    notifyPermissionBlocked('当前身份无「专业裁定与词表核定」权限，无法核定词表条目。');
                    return;
                  }
                  if (!canEditCase) {
                    notifyPermissionBlocked('当前身份无编辑受控词表权限。');
                    return;
                  }
                  setSupplements((prev) =>
                    prev.map((item) => (item.fieldCode === updated.fieldCode ? updated : item)),
                  );
                  void recordAuditEvent({
                    category: 'review_adjudicate',
                    action: '更新受控词表增补条目',
                    targetRef: updated.fieldCode,
                    detail: `${updated.fieldName} · 状态=${updated.approvalStatus}（候选值 ${updated.candidateOptions.length} 项）`,
                  });
                }}
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
                onToggleChecklistItem={(checkId, checked) => {
                  if (!canEditCase) {
                    notifyPermissionBlocked('当前身份无更新验收清单权限。');
                    return;
                  }
                  updateActiveCase((prev) => ({
                    ...prev,
                    checklist: { ...prev.checklist, [checkId]: checked },
                  }));
                }}
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
      )}

      <ManualDrawer open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  );
}
