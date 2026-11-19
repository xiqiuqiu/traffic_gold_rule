import { CaseDocument, UserRole } from './gold';

export type ExtendedRole = UserRole | 'admin' | 'viewer';

export type PermissionKey =
  | 'task:view'
  | 'task:schedule_manage'
  | 'task:upload_run'
  | 'case:edit_annotate'
  | 'case:review'
  | 'case:adjudicate'
  | 'similar:fusion_export'
  | 'system:audit_permissions';

export type RolePermissionMatrix = Record<ExtendedRole, Record<PermissionKey, boolean>>;

export type TaskSource = 'scheduled_batch' | 'manual_upload' | 'seed_archive';

export type TaskStatus =
  | 'idle'
  | 'queued'
  | 'parsing_pdf'
  | 'ai_extracting'
  | 'pending_review'
  | 'approved'
  | 'failed';

export interface AnalysisTask {
  taskId: string;
  batchId?: string;
  source: TaskSource;
  status: TaskStatus;
  progress: number;
  stageLabel: string;
  caseId: string;
  accidentBizId: string;
  title?: string;
  filename: string;
  filePath?: string;
  pdfUrl: string;
  fileSha256: string;
  fileSizeBytes?: number;
  pageCount: number;
  modelLabel: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  extractedFieldsCount?: number;
  createdByRole: ExtendedRole;
  createdByName: string;
}

export interface BatchScheduleConfig {
  enabled: boolean;
  scanDirectory: string;
  filePattern: string;
  dailyTime: string;
  autoRunAi: boolean;
  maxConcurrent: number;
  lastRunAt?: string;
  lastRunSummary?: string;
}

export type SystemAuditCategory =
  | 'schedule'
  | 'task_pipeline'
  | 'annotation'
  | 'review_adjudicate'
  | 'fusion_export'
  | 'permission';

export interface SystemAuditEvent {
  id: string;
  timestamp: string;
  category: SystemAuditCategory;
  actorRole: ExtendedRole;
  actorName: string;
  action: string;
  targetRef: string;
  accidentBizId?: string;
  detail: string;
  beforeValue?: string;
  afterValue?: string;
}

export interface UserIdentityProfile {
  id: string;
  name: string;
  role: ExtendedRole;
  department: string;
  title: string;
}

export interface BizIdConflictGroup {
  bizId: string;
  caseIds: string[];
  titles: string[];
}

export interface BizIdUniquenessReport {
  totalCases: number;
  validUniqueCount: number;
  missingCaseIds: string[];
  invalidCaseIds: string[];
  duplicateGroups: BizIdConflictGroup[];
  hasBlockingConflict: boolean;
  caseStatusById: Record<
    string,
    {
      bizId: string;
      status: 'unique' | 'missing' | 'invalid' | 'duplicate';
      conflictCaseIds: string[];
    }
  >;
}

export interface CaseSimilarityFilter {
  keyword: string;
  accidentType: string;
  weather: string;
  surface: string;
  lighting: string;
  violation: string;
  liability: string;
  onlyApproved: boolean;
}

export interface SimilarCaseMatch {
  caseDoc: CaseDocument;
  accidentBizId: string;
  matchedTags: string[];
  accidentType: string;
  weatherTags: string[];
  surfaceTags: string[];
  lightingTag: string;
  violationTags: string[];
  liabilityTags: string[];
  isApproved: boolean;
  uniquenessStatus: 'unique' | 'missing' | 'invalid' | 'duplicate';
}

export interface FusionExportBundle {
  schema_version: string;
  fusion_key_name: 'accident_biz_id';
  accident_biz_id: string;
  uniqueness_verified: boolean;
  uniqueness_status: 'unique' | 'missing' | 'invalid' | 'duplicate';
  case_id: string;
  source_filename: string;
  source_sha256: string;
  exported_at: string;
  readiness_eligible: boolean;
  summary_tags: {
    accident_type: string;
    weather: string[];
    road_surface: string[];
    lighting: string;
    violations: string[];
    liabilities: Array<{ subject_id: string; subject_label: string; level: string }>;
  };
  gold_payload: Record<string, unknown>;
}
