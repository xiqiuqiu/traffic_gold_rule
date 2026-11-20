import { canonicalLegalDraft, canonicalLegalItem, legalFields } from './utils/legalCatalog';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Loader2,
  Lock,
  RotateCcw,
  Settings,
  Sparkles,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { accidentTitle } from './utils/accidentTitle';
import { CaseHeading } from './components/CaseHeading';
import { Toaster } from 'sonner';
import { CatalogContext } from './components/useCatalogOptions';
import { api as catalogApi } from './utils/catalogApi';
import type { CatalogOptions } from './types/catalog';
import { CodebookView } from './components/CodebookView';
import { AcceptanceExportPanel } from './components/AcceptanceExportPanel';
import { AuditTrailPanel } from './components/AuditTrailPanel';
import { EntityRegistryBar } from './components/EntityRegistryBar';
import { FieldAnnotationPanel } from './components/FieldAnnotationPanel';
import { LegalRelationsPanel } from './components/LegalRelationsPanel';
import { ManualDrawer } from './components/ManualDrawer';
import { PdfEvidenceViewer } from './components/PdfEvidenceViewer';
import { PermissionsPanel } from './components/PermissionsPanel';
import { SimilarCaseFusionPanel } from './components/SimilarCaseFusionPanel';
import { TaskCenterPanel } from './components/TaskCenterPanel';
import { VocabularySupplementPanel } from './components/VocabularySupplementPanel';
import {
  INITIAL_VOCABULARY_SUPPLEMENTS,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
} from './data/schemaCatalog';
import { SEED_CASES } from './data/seedCases';
import {
  AuditLogEntry,
  CaseDocument,
  CaseWorkItem,
  EntityKind,
  EventRelationItem,
  EvidenceItem,
  LiabilitySourceLocation,
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
  hasLiabilityScopeConflict,
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
  AI_SETTINGS_STORAGE_KEY,
  DEFAULT_AI_PROVIDER_SETTINGS,
} from './utils/aiSettings';
import { useEvidenceLocator } from './utils/useEvidenceLocator';
import { getVerifiedLiabilitySource, liabilitySourceKey } from './utils/liabilitySourceKey';
import { createPlaceholderCaseForTask } from './utils/taskCase';
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

type SystemView = 'catalog' | 'tasks' | 'detail' | 'similar' | 'audit' | 'system';
type WorkspaceTab = 'fields' | 'legal' | 'vocab' | 'export';

const detailMenuItemClass = 'flex items-center gap-2 rounded px-2.5 py-2 data-highlighted:bg-slate-100 data-disabled:opacity-45';

const STORAGE_CASES_KEY = 'gold_workbench_cases_v3';
const STORAGE_SUPPLEMENTS_KEY = 'gold_workbench_supplements_v1';
const STORAGE_IDENTITY_KEY = 'accident_system_active_identity_v1';

function loadInitialCases(): CaseDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_CASES_KEY);
    if (!raw) return SEED_CASES;
    const parsed = JSON.parse(raw) as CaseDocument[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      const available = parsed.filter((c) => !c.pdfUrl.startsWith('blob:'));
      return available.length ? available : SEED_CASES;
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

function clearChangedLineIds<T extends { evidences: EvidenceItem[] }>(record: T, previous?: T): T {
  if (!previous || previous.evidences === record.evidences) return record;
  return { ...record, evidences: record.evidences.map(ev => {
    if (!ev.lineIds) return ev;
    const old = previous.evidences.find(e => e.id === ev.id);
    return old && (ev.page !== old.page || ev.quote !== old.quote) ? { ...ev, lineIds: undefined } : ev;
  }) };
}

async function readApiResult(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error || `服务请求失败（HTTP ${response.status}）`);
  }
  return data;
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
  const [taskPages, setTaskPages] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [taskListError, setTaskListError] = useState('');
  const taskCursor = taskPages.at(-1);
  const activeTask = tasks.find((task) => task.caseId === activeCaseId);
  const detailTaskId = activeTask?.taskId.startsWith('PDF-') ? activeTask.taskId : null;
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
  const [aiSettings, setAiSettings] = useState<AiProviderSettings>(DEFAULT_AI_PROVIDER_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [hasServerKey, setHasServerKey] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [draftAttempt, setDraftAttempt] = useState(0);
  const machineDrafts = useRef(new WeakSet<CaseDocument>());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDialogRef = useRef<HTMLDialogElement>(null);

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

  const [catalogOptions, setCatalogOptions] = useState<CatalogOptions>({});
  useEffect(() => {
    if (systemView !== 'detail') return;
    setCatalogOptions({});
    if (!hasPermission(rolePermissions, activeIdentity.role, 'task:view')) return;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const options = await catalogApi.fieldOptions(activeIdentity.id);
        if (revision !== request) return;
        setCatalogOptions(options);
        setCases(previous => previous.map(doc => {
          const normalized = canonicalLegalDraft(doc, options);
          if (machineDrafts.current.has(doc)) machineDrafts.current.add(normalized);
          return normalized;
        }));
      } catch {
        if (revision === request) {
          setCatalogOptions({});
          setPermissionNotice('标签库暂时不可用，请重新打开详情加载标准结论。');
        }
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { revision++; window.removeEventListener('focus', refresh); };
  }, [systemView, activeIdentity.id, activeIdentity.role, rolePermissions]);

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
        if (!t.taskId.startsWith('PDF-') && !existingIds.has(t.caseId)) {
          existingIds.add(t.caseId);
          additions.push(createPlaceholderCaseForTask(t));
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

  // Refresh the audit view when opened so it includes recent worker activity.
  const viewingAudit = systemView === 'audit';
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
  }, [ensureCasesForTasks, viewingAudit]);

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
      const persistable = cases.filter((c) => !c.pdfUrl.startsWith('blob:') && !machineDrafts.current.has(c));
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
    let active = true;
    (async () => {
      let data = await readApiResult(await fetch('/api/ai/settings'));
      if (!active) return;
      const legacy = loadAiProviderSettings();
      if (canAuditPermissions && !data.settings && legacy.openai.baseUrl && getActiveModelSummary(legacy).isConfigured) {
        data = await readApiResult(await fetch('/api/ai/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: legacy, initializeOnly: true, actorRole: activeIdentityRef.current.role }),
        }));
        if (!active) return;
        if (data.created) {
          localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
        }
      }
      setAiSettings(data.settings || DEFAULT_AI_PROVIDER_SETTINGS);
      setHasServerKey(Boolean(data.hasApiKey));
      setSettingsReady(true);
    })().catch((err) => {
      if (active) notifyPermissionBlocked(`读取后台模型配置失败：${err.message}，请刷新重试。`);
    });
    return () => { active = false; };
  }, [notifyPermissionBlocked, canAuditPermissions]);

  const handleSaveAiSettings = async (settings: AiProviderSettings) => {
    const data = await readApiResult(await fetch('/api/ai/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, actorRole: activeIdentity.role }),
    }));
    setAiSettings(data.settings);
    setHasServerKey(Boolean(data.hasApiKey));
    setAiError(null);
  };

  useEffect(() => {
    const inList = systemView === 'tasks';
    if (!inList && !(systemView === 'detail' && detailTaskId)) return;
    let cancelled = false;
    let timer: number;
    const url = inList
      ? `/api/system/tasks${taskCursor ? '?before=' + encodeURIComponent(taskCursor) : ''}`
      : `/api/system/tasks/${encodeURIComponent(detailTaskId!)}`;
    if (inList) setLoadingPage(true);
    const refresh = async () => {
      try {
        const response = await fetch(url);
        if (cancelled) return;
        if (!inList && response.status === 404) {
          setSystemView('tasks');
          notifyPermissionBlocked('这条任务已移除。');
          return;
        }
        const data = await readApiResult(response);
        if (cancelled) return;
        if (inList) {
          setTasks(data.tasks);
          setNextCursor(data.nextCursor);
          ensureCasesForTasks(data.tasks);
          setTaskListError('');
        } else {
          setTasks(prev => prev.map(task => task.taskId === detailTaskId ? data.task : task));
        }
      } catch (err) {
        if (!cancelled && inList) setTaskListError(err instanceof Error ? err.message : '获取后台任务失败');
      } finally {
        if (!cancelled) {
          setLoadingPage(false);
          timer = window.setTimeout(refresh, 4000);
        }
      }
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [systemView, taskCursor, detailTaskId, ensureCasesForTasks, notifyPermissionBlocked]);

  const isBackgroundCase = Boolean(activeTask?.taskId.startsWith('PDF-'));
  const localCase = cases.find((c) => c.caseId === activeCaseId);
  const activeCase = useMemo(
    () => localCase || (activeTask ? createPlaceholderCaseForTask(activeTask) : cases[0]),
    [localCase, activeTask, cases],
  );
  const waitingForDraft = isBackgroundCase && !localCase;
  const parsedTaskId = activeTask?.status === 'pending_review' || activeTask?.status === 'approved' ? detailTaskId : null;
  const draftTaskId = systemView === 'detail' && waitingForDraft ? parsedTaskId : null;
  useEffect(() => {
    setDraftError('');
    if (!draftTaskId) return;
    let cancelled = false;
    (async () => {
      const { draft } = await readApiResult(await fetch(`/api/system/tasks/${encodeURIComponent(draftTaskId)}/draft`));
      if (cancelled) return;
      if (!draft || draft.caseId !== activeCaseId) throw new Error('后台草稿与当前案件不匹配。');
      machineDrafts.current.add(draft);
      setCases((prev) => prev.some(c => c.caseId === draft.caseId) ? prev : [...prev, draft]);
    })().catch((err) => { if (!cancelled) setDraftError(err.message); });
    return () => { cancelled = true; };
  }, [draftTaskId, activeCaseId, draftAttempt]);

  const activeModelSummary = useMemo(() => getActiveModelSummary(aiSettings), [aiSettings]);

  // Keep task metadata (bizId, status approved/pending_review, extractedFieldsCount) synced with cases
  const displayedTasks = useMemo(() => {
    const localCases = new Map(cases.map((c) => [c.caseId, c]));
    return tasks.map((t) => {
      const matchedCase = localCases.get(t.caseId);
      if (!matchedCase) return t;
      const title = accidentTitle(matchedCase);
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
        t.title === title && t.accidentBizId === bizId &&
        t.extractedFieldsCount === extractedCount &&
        t.status === nextStatus &&
        t.stageLabel === nextStageLabel
      ) {
        return t;
      }
      return {
        ...t,
        title,
        accidentBizId: bizId,
        extractedFieldsCount: extractedCount,
        status: nextStatus,
        stageLabel: nextStageLabel,
      };
    });
  }, [tasks, cases, supplements]);

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

  const saveLiabilityLocation = useCallback((caseId: string, item: LegalConclusionItem, sourceLocation: LiabilitySourceLocation) => {
    setCases(prev => prev.map(doc => {
      if (doc.caseId !== caseId || !doc.legalConclusions.includes(item)) return doc;
      const next = { ...doc, legalConclusions: doc.legalConclusions.map(l => l === item ? { ...l, sourceLocation } : l) };
      if (machineDrafts.current.has(doc)) machineDrafts.current.add(next);
      return next;
    }));
  }, []);
  const locator = useEvidenceLocator(activeCase, detailTaskId,
    JSON.stringify([systemView, activeCaseId, activeTab, selectedEntityId]),
    focusedLegalOrRelId?.id ?? focusedFieldKey, setCurrentPdfPage, saveLiabilityLocation);
  const locateEvidence = (record: FieldRecord | LegalConclusionItem | EventRelationItem, evidence: EvidenceItem) => {
    if ('recordId' in record) {
      setFocusedLegalOrRelId(null);
      setFocusedFieldKey(`${record.entityId}:${record.fieldCode}`);
    } else {
      setFocusedFieldKey(null);
      setFocusedLegalOrRelId({ id: record.id, label: `${record.id} · ${'conclusionLabel' in record ? record.conclusionLabel : record.action}` });
    }
    locator.locate(record, evidence);
  };
  const jumpToPdfPage = (page: number) => {
    locator.clear();
    setCurrentPdfPage(page);
  };

  const selectedEntity = useMemo(
    () =>
      activeCase.entities.find((e) => e.id === selectedEntityId) ||
      activeCase.entities[0] || { id: 'ACC', kind: 'ACC', label: '整起事故' },
    [activeCase, selectedEntityId],
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
    record = clearChangedLineIds(record, prevRecord);
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
    if (catalogOptions[legalFields[item.category]]) {
      item = canonicalLegalItem(item, catalogOptions);
    } else if (item.conclusionCode !== prevItem?.conclusionCode || item.conclusionLabel !== (prevItem?.conclusionLabel || '')) {
      notifyPermissionBlocked('请先加载标签库再选择标准结论。');
      return;
    }
    if (item.presenceStatus === 'present' && !item.conclusionCode && prevItem?.reviewStatus !== item.reviewStatus &&
        (item.reviewStatus === 'checked' || item.reviewStatus === 'specialist_review')) {
      notifyPermissionBlocked('标准结论待核对，请先选择对应码表项。');
      return;
    }
    item = clearChangedLineIds(item, prevItem);
    if (prevItem?.sourceLocation && liabilitySourceKey(prevItem, activeCase.entities) !== liabilitySourceKey(item, activeCase.entities)) {
      item = { ...item, sourceLocation: { status: 'needs_review', reason: '记录已修改，需重新核对原文。' } };
    }
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

    if (item.category === 'liability' && (!prevItem || !hasLiabilityScopeConflict(prevItem, item)) &&
        activeCase.legalConclusions.some(other => other.id !== item.id && other.category === 'liability' && hasLiabilityScopeConflict(other, item))) {
      notifyPermissionBlocked('该主体在此事故阶段已有责任记录，请修改已有记录或选择其他阶段。');
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
    item = clearChangedLineIds(item, prevItem);
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
      const nextLegal = prev.legalConclusions.map(item => {
        if (item.reviewStatus !== 'draft' || !item.rawText.trim() || !item.evidences.length) return item;
        if (item.category === 'liability' && item.sourceLocation && !getVerifiedLiabilitySource(item, prev)) return item;
        return { ...item, reviewStatus: 'checked' as const };
      });
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

  const handleRunTaskPipeline = async (taskId: string) => {
    if (!canUploadAndRun) return;
    try {
      const { task } = await readApiResult(await fetch(`/api/system/tasks/${encodeURIComponent(taskId)}/start`, { method: 'POST' }));
      setTasks(prev => [task, ...prev.filter(t => t.taskId !== task.taskId)]);
      if (systemView === 'detail' && activeTask?.taskId === taskId && task.taskId !== taskId) {
        setActiveCaseId(task.caseId);
      }
    } catch (err) {
      notifyPermissionBlocked(err instanceof Error ? err.message : '启动后台任务失败。');
    }
  };

  const handleManualUploadPdf = async (file: File, startImmediately: boolean) => {
    if (!canUploadAndRun || uploading) return;
    setUploading(true);
    setUploadError('');
    try {
      const params = new URLSearchParams({
        filename: file.name,
        startImmediately: String(startImmediately),
        actorName: activeIdentity.name,
        actorRole: activeIdentity.role,
      });
      const { task, created } = await readApiResult(await fetch(`/api/system/tasks/upload?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      }));
      setTasks(prev => [task, ...prev.filter(t => t.taskId !== task.taskId)]);
      setTaskPages([]);
      if (created === false) notifyPermissionBlocked('这份 PDF 已登记，可在任务列表查看处理进度。');
      return task as AnalysisTask;
    } catch (err) {
      const message = err instanceof Error ? err.message : '上传 PDF 失败。';
      setUploadError(message);
      if (!uploadDialogRef.current?.open) notifyPermissionBlocked(message);
    } finally {
      setUploading(false);
    }
  };

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
          setTaskPages([]);
          setTasks(data.tasks);
          ensureCasesForTasks(data.tasks);
        }
        if (Array.isArray(data.auditLogs)) setAuditLogs(data.auditLogs);

        const count = data.createdTaskCount ?? data.createdTasks?.length ?? 0;
        const summary = `发现 ${data.scannedFileCount} 份 PDF，新增 ${count} 条任务，跳过已登记 ${data.skippedExistingCount} 份。`;
        const errors = data.fileErrors;
        if (errors?.length) {
          setLastScanError(`${summary} 有 ${errors.length} 份未入库。首项：${errors[0].filename}（${errors[0].reason}）`);
        } else {
          setLastScanMessage(summary);
        }
      } catch (err) {
        setLastScanError(err instanceof Error ? err.message : '扫描目录异常');
      } finally {
        setScanningDirectory(false);
      }
    },
    [canManageSchedule, ensureCasesForTasks, notifyPermissionBlocked],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      if (!canUploadAndRun) {
        notifyPermissionBlocked('当前身份无删除任务权限。');
        return;
      }
      try {
        const response = await fetch(
          `/api/system/tasks/${encodeURIComponent(taskId)}?actorName=${encodeURIComponent(activeIdentityRef.current.name)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) await readApiResult(response);
        setTasks(prev => prev.filter(t => t.taskId !== taskId));
      } catch (err) {
        notifyPermissionBlocked(err instanceof Error ? err.message : '删除任务失败。');
      }
    },
    [canUploadAndRun, notifyPermissionBlocked],
  );

  const handleImportLocalPdfFromDetail = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const task = await handleManualUploadPdf(file, false);
    if (task) handleOpenCaseDetail(task.caseId);
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
      const currentCatalog = await catalogApi.fieldOptions(activeIdentity.id);
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
        catalog: currentCatalog,
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

  const activeSection = systemView === 'detail' ? 'tasks' : systemView;

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
      <header className="flex shrink-0 items-center justify-between gap-6 border-b border-slate-200 bg-white px-5 py-3 max-sm:flex-wrap max-sm:gap-2 max-sm:px-3">
        <span className="shrink-0 whitespace-nowrap text-base font-bold tracking-tight text-slate-900">
          智能事故分析系统
        </span>

        <nav
          aria-label="系统主导航"
          className="flex items-center gap-6 overflow-x-auto text-sm font-medium max-sm:order-last max-sm:w-full max-sm:gap-4"
        >
          {(
            [
              ['tasks', '任务调度'],
              ['similar', '类案与融合'],
              ['catalog', '标签库'],
              ['audit', '全链路审计'],
              ['system', '权限与设置'],
            ] as Array<[Exclude<SystemView, 'detail'>, string]>
          ).map(([viewKey, label]) => (
            <button
              key={viewKey}
              type="button"
              aria-current={activeSection === viewKey ? 'location' : undefined}
              onClick={() => setSystemView(viewKey)}
              className={`shrink-0 whitespace-nowrap border-b-2 py-1 transition-colors ${
                activeSection === viewKey
                  ? 'border-blue-700 text-blue-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {systemView === 'detail' ? (
            <button
              type="button"
              disabled={waitingForDraft}
              onClick={() => setActiveTab('export')}
              className="shrink-0 whitespace-nowrap rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:bg-slate-300"
            >
              导出 Gold JSON
            </button>
          ) : (
            <button
              type="button"
              disabled={!canUploadAndRun}
              aria-haspopup="dialog"
              onClick={() => { setUploadError(''); uploadDialogRef.current?.showModal(); }}
              className="shrink-0 whitespace-nowrap rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              上传 PDF 分析
            </button>
          )}
          <button
            type="button"
            popoverTarget="test-user-switcher"
            aria-label={`当前用户：${activeIdentity.name}，切换测试用户`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 [anchor-name:--current-user]"
          >
            <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="max-w-32 truncate max-sm:sr-only">{activeIdentity.name}</span>
            <ChevronDown className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          </button>
          <div
            id="test-user-switcher"
            popover="auto"
            aria-labelledby="test-user-heading"
            className="fixed inset-auto right-5 top-14 mt-1.5 w-64 rounded-lg border border-slate-200 bg-white p-2 text-slate-900 shadow-md max-sm:right-3 supports-[top:anchor(bottom)]:top-[anchor(--current-user_bottom,3.5rem)]"
          >
            <h2 id="test-user-heading" className="px-2 py-1.5 text-xs font-semibold text-slate-600">
              切换测试用户
            </h2>
            {identities.map((profile) => {
              const selected = profile.id === activeIdentity.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  popoverTarget="test-user-switcher"
                  popoverTargetAction="hide"
                  aria-pressed={selected}
                  onClick={() => {
                    if (selected) return;
                    setActiveIdentityId(profile.id);
                    setPermissionNotice(`已切换为：${profile.name}（${EXTENDED_ROLE_META[profile.role].label}）`);
                    window.setTimeout(() => setPermissionNotice(null), 2600);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-xs font-medium ${
                    selected ? 'bg-blue-50 text-blue-800' : 'text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  {profile.name}
                  {selected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                </button>
              );
            })}
            <p className="mt-1 border-t border-slate-100 px-2 pt-2 text-xs leading-relaxed text-slate-600">
              {EXTENDED_ROLE_META[activeIdentity.role].description}
            </p>
          </div>
        </div>
      </header>

      <dialog
        ref={uploadDialogRef}
        aria-labelledby="upload-pdf-title"
        onClose={(e) => e.currentTarget.querySelector('form')?.reset()}
        className="m-auto w-[min(26rem,calc(100%-2rem))] rounded-lg border border-slate-200 bg-white p-5 text-slate-900 shadow-lg backdrop:bg-slate-900/35"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const file = data.get('pdf');
            if (!canUploadAndRun || !(file instanceof File) || !file.name) return;
            if (await handleManualUploadPdf(file, data.get('mode') === 'analyze')) {
              uploadDialogRef.current?.close();
              setSystemView('tasks');
            }
          }}
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <h2 id="upload-pdf-title" className="text-sm font-semibold">上传 PDF 分析</h2>
            <button
              type="button"
              aria-label="关闭上传窗口"
              onClick={() => uploadDialogRef.current?.close()}
              className="rounded p-1 text-slate-500 hover:bg-slate-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <label className="mt-4 block text-xs font-medium text-slate-700">
            PDF 文件
            <input
              type="file"
              name="pdf"
              accept=".pdf,application/pdf"
              required
              className="mt-1.5 block w-full rounded border border-slate-300 p-2 text-xs file:mr-3 file:rounded file:bg-slate-100 file:px-2.5 file:py-1 file:font-medium hover:file:bg-slate-200"
            />
          </label>
          <label className="mt-3 block text-xs font-medium text-slate-700">
            创建后
            <select
              name="mode"
              defaultValue="analyze"
              className="mt-1.5 block w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="analyze">立即开始解析</option>
              <option value="idle">暂存待命，稍后解析</option>
            </select>
          </label>
          {uploadError && <p role="alert" className="mt-3 text-xs text-red-700">{uploadError}</p>}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                uploadDialogRef.current?.close();
                handleOpenModelSettings();
              }}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              配置提取模型
            </button>
            <button
              type="submit"
              disabled={!canUploadAndRun || uploading}
              className="rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:bg-slate-300"
            >
              {uploading ? '正在上传…' : '创建任务'}
            </button>
          </div>
        </form>
      </dialog>

      {systemView === 'detail' && (
        <section aria-label="任务详情" className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-200 bg-white px-5 py-2 max-sm:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 max-sm:basis-full">
            <button type="button" onClick={() => setSystemView('tasks')} aria-label="返回任务列表" title="返回任务列表" className="inline-flex shrink-0 items-center gap-1 rounded py-1.5 text-xs text-slate-600 hover:text-blue-700 focus-visible:outline-blue-700">
              <ArrowLeft className="size-4" aria-hidden="true" />
              <span className="max-sm:hidden">任务列表</span>
            </button>
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-slate-200" />
            <CaseHeading caseDoc={activeCase} taskId={activeTask?.taskId} title={waitingForDraft ? activeTask?.title || activeCase.sourceFilename : accidentTitle(activeCase)} />
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {!canEditCase && <span className="inline-flex items-center gap-1 text-slate-500"><Lock className="size-3.5" aria-hidden="true" />只读</span>}
            {!waitingForDraft && (
              <button
                type="button"
                onClick={() => handleOpenAcceptanceWithStatus(pendingItemsCount ? 'pending_action' : 'all')}
                className="inline-flex items-center gap-1 rounded px-2 py-1.5 font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-blue-700"
              >
                {pendingItemsCount ? <>待处理 <span className="tabular-nums text-amber-800">{pendingItemsCount}</span> 项</> : '查看验收'}
                <ChevronRight className="size-3.5 text-slate-500" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              disabled={!canEditCase || waitingForDraft}
              onClick={() => setAiPanelOpen((v) => !v)}
              aria-expanded={aiPanelOpen}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-50 aria-expanded:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Sparkles className="size-3.5" aria-hidden="true" />AI 预分析
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleImportLocalPdfFromDetail} hidden aria-label="导入本地 PDF 文件" />
            <Menu.Root>
              <Menu.Trigger aria-label="更多操作" title="更多操作" className="inline-flex size-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 data-popup-open:bg-slate-100">
                <Ellipsis className="size-4" aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={4} className="z-50">
                  <Menu.Popup aria-label="更多操作" className="min-w-36 rounded-md border border-slate-200 bg-white p-1 text-xs text-slate-700 shadow-md">
                    <Menu.Item className={detailMenuItemClass} disabled={!canUploadAndRun || uploading} onClick={() => fileInputRef.current?.click()}><Upload className="size-3.5" aria-hidden="true" />导入本地 PDF</Menu.Item>
                    <Menu.Item className={detailMenuItemClass} onClick={() => setManualOpen(true)}><BookOpen className="size-3.5" aria-hidden="true" />标注手册</Menu.Item>
                    <Menu.Separator className="my-1 border-t border-slate-100" />
                    <Menu.Item className={detailMenuItemClass} onClick={handleResetDemo}><RotateCcw className="size-3.5" aria-hidden="true" />重置样本</Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </section>
      )}

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
            tasks={displayedTasks}
            pageNumber={taskPages.length + 1}
            hasOlder={Boolean(nextCursor)}
            loadingPage={loadingPage}
            taskListError={taskListError}
            onOlder={() => { if (nextCursor) setTaskPages(prev => [...prev, nextCursor]); }}
            onNewer={() => setTaskPages(prev => prev.slice(0, -1))}
            scheduleConfig={scheduleConfig}
            canManageSchedule={canManageSchedule}
            canUploadAndRun={canUploadAndRun}
            canEditCase={canEditCase}
            scanningDirectory={scanningDirectory}
            lastScanMessage={lastScanMessage}
            lastScanError={lastScanError}
            onSaveSchedule={handleSaveSchedule}
            onTriggerDirectoryScan={handleTriggerDirectoryScan}
            onRunTaskPipeline={async (taskId) => handleRunTaskPipeline(taskId)}
            onOpenCaseDetail={(caseId) => handleOpenCaseDetail(caseId)}
            onDeleteTask={handleDeleteTask}
          />
        </main>
      )}

      {systemView === 'catalog' && (
        <main className="min-h-0 flex-1 overflow-y-auto">
          {hasPermission(rolePermissions, activeIdentity.role, 'task:view')
            ? <CodebookView key={activeIdentity.id} userId={activeIdentity.id} canManage={canAdjudicate} />
            : <p className="mx-auto max-w-[1400px] px-6 py-5 text-sm text-slate-600">当前身份没有标签库查看权限。</p>}
          <Toaster position="bottom-right" closeButton />
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
            settingsReady={settingsReady}
            hasServerKey={hasServerKey}
            onSaveAiSettings={handleSaveAiSettings}
            onJumpToPreanalyze={() => {
              setSystemView('detail');
              setActiveTab('fields');
              setAiPanelOpen(true);
            }}
          />
        </main>
      )}

      {systemView === 'detail' && (
        <CatalogContext.Provider value={catalogOptions}><main className="grid min-h-0 flex-1 grid-cols-1 max-lg:grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-12">
          {/* Left Pane: Real PDF Renderer & Evidence Selector */}
          <div className="min-h-0 min-w-0 lg:col-span-5 lg:h-full">
            <PdfEvidenceViewer
              key={activeCase.pdfUrl}
              pdfUrl={activeCase.pdfUrl}
              taskId={parsedTaskId}
              fileSha256={activeCase.fileSha256}
              sourceFilename={activeCase.sourceFilename}
              currentPage={currentPdfPage}
              onPageChange={jumpToPdfPage}
              locatedSource={locator.location}
              locateRequest={locator.active}
              sourceMessage={locator.message}
              onDocumentReady={locator.setPdf}
              onPageCountDetected={(count) => {
                if (!waitingForDraft && count > 0 && count !== activeCase.pageCount) {
                  updateActiveCase((prev) => ({ ...prev, pageCount: count }));
                }
              }}
              onPageTextsExtracted={setPdfPageTexts}
              highlightedEvidences={activeTab === 'legal' && !locator.active ? highlightedEvidences : []}
              selectedQuote={selectedPdfQuote}
              onSelectQuote={setSelectedPdfQuote}
              activeTargetLabel={activeTargetInfo?.label || null}
              onApplyQuoteToTarget={handleApplyQuoteToTarget}
            />
          </div>

          {/* Right Pane: Structured Annotation & Workflow Views */}
          <div className="flex min-h-0 flex-col overflow-y-auto bg-slate-50 lg:col-span-7">
            {waitingForDraft && activeTask ? (
              <section aria-live="polite" className="m-5 rounded-lg border border-slate-200 bg-white p-5 text-sm">
                <h2 className="font-semibold text-slate-900">后台解析任务</h2>
                <p className="mt-2 text-slate-700">{draftError || activeTask.errorMessage || (draftTaskId ? '正在加载案件草稿…' : activeTask.stageLabel)}</p>
                {draftError && <button type="button" onClick={() => setDraftAttempt(n => n + 1)} className="mt-3 text-xs font-medium text-blue-700">重新加载草稿</button>}
                {canUploadAndRun && (activeTask.status === 'idle' || activeTask.status === 'failed') && (
                  <button type="button" onClick={() => handleRunTaskPipeline(activeTask.taskId)} className="mt-3 rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800">
                    {activeTask.status === 'idle' ? '开始解析' : '重试解析'}
                  </button>
                )}
              </section>
            ) : <>
            <div className="border-b border-slate-200 bg-white px-5">
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
                      onClick={handleOpenModelSettings}
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
                  onLocateEvidence={locateEvidence}
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
                onJumpToPage={jumpToPdfPage}
                onLocateEvidence={locateEvidence}
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
            </>}
          </div>
        </main></CatalogContext.Provider>
      )}

      <ManualDrawer open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  );
}
