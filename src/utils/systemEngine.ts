import { accidentTitle } from './accidentTitle';
import { INITIAL_VOCABULARY_SUPPLEMENTS } from '../data/schemaCatalog';
import { CaseDocument, UserRole, VocabularySupplementItem } from '../types/gold';
import {
  AnalysisTask,
  BatchScheduleConfig,
  BizIdConflictGroup,
  BizIdUniquenessReport,
  CaseSimilarityFilter,
  ExtendedRole,
  FusionExportBundle,
  PermissionKey,
  RolePermissionMatrix,
  SimilarCaseMatch,
  SystemAuditCategory,
  SystemAuditEvent,
  TaskStatus,
  UserIdentityProfile,
} from '../types/system';
import { buildGoldV02ExportPayload, computeCaseReadiness } from './goldRules';

export const EXTENDED_ROLE_META: Record<
  ExtendedRole,
  { label: string; shortLabel: string; description: string }
> = {
  admin: {
    label: '系统管理员',
    shortLabel: '管理员',
    description: '管理定时批量扫描调度、模型接入、角色权限矩阵与全链路审计日志',
  },
  annotator: {
    label: '第一标注人',
    shortLabel: '标注员',
    description: '手动上传材料并启停解析，核对与修正 AI 提取的初稿字段与证据链',
  },
  reviewer: {
    label: '第二复核人',
    shortLabel: '复核员',
    description: '复核字段标注与法律结论一致性，批量放行无错草稿或退回争议项',
  },
  adjudicator: {
    label: '业务裁定人',
    shortLabel: '裁定人',
    description: '对争议项作出专业裁定、核定增补词表并签发终版入库与融合导出',
  },
  viewer: {
    label: '只读检索员',
    shortLabel: '检索员',
    description: '仅可检索类案、浏览详情与预览标准数据融合结果，禁止修改或调度',
  },
};

export const PERMISSION_CATALOG: Array<{
  key: PermissionKey;
  label: string;
  description: string;
}> = [
  {
    key: 'task:view',
    label: '查看任务总览与详情',
    description: '访问任务队列、实时进度及案件只读详情视图',
  },
  {
    key: 'task:schedule_manage',
    label: '定时批量调度配置',
    description: '修改服务器扫描目录、执行时间并触发批量扫盘任务',
  },
  {
    key: 'task:upload_run',
    label: '手动上传与启停解析',
    description: '上传本地 PDF 文件、启动/重试任务解析、删除待处理任务',
  },
  {
    key: 'case:edit_annotate',
    label: '字段修正与 AI 预提取',
    description: '编辑普通事实字段、违法/原因/责任链与运行单案 AI 预分析',
  },
  {
    key: 'case:review',
    label: '复核确认与标记争议',
    description: '将草稿流转为“已复核”或退回“争议中”',
  },
  {
    key: 'case:adjudicate',
    label: '专业裁定与词表核定',
    description: '处理争议项裁定并核定受控词表增补条目',
  },
  {
    key: 'similar:fusion_export',
    label: '类案检索与融合导出',
    description: '多标签类案检索、唯一主键校验及标准化融合数据包导出',
  },
  {
    key: 'system:audit_permissions',
    label: '审计日志与权限管理',
    description: '查阅全链路操作审计日志并调整各角色权限矩阵',
  },
];

export const DEFAULT_ROLE_PERMISSIONS: RolePermissionMatrix = {
  admin: {
    'task:view': true,
    'task:schedule_manage': true,
    'task:upload_run': true,
    'case:edit_annotate': true,
    'case:review': true,
    'case:adjudicate': true,
    'similar:fusion_export': true,
    'system:audit_permissions': true,
  },
  annotator: {
    'task:view': true,
    'task:schedule_manage': false,
    'task:upload_run': true,
    'case:edit_annotate': true,
    'case:review': false,
    'case:adjudicate': false,
    'similar:fusion_export': true,
    'system:audit_permissions': false,
  },
  reviewer: {
    'task:view': true,
    'task:schedule_manage': false,
    'task:upload_run': true,
    'case:edit_annotate': true,
    'case:review': true,
    'case:adjudicate': false,
    'similar:fusion_export': true,
    'system:audit_permissions': false,
  },
  adjudicator: {
    'task:view': true,
    'task:schedule_manage': false,
    'task:upload_run': false,
    'case:edit_annotate': true,
    'case:review': true,
    'case:adjudicate': true,
    'similar:fusion_export': true,
    'system:audit_permissions': true,
  },
  viewer: {
    'task:view': true,
    'task:schedule_manage': false,
    'task:upload_run': false,
    'case:edit_annotate': false,
    'case:review': false,
    'case:adjudicate': false,
    'similar:fusion_export': true,
    'system:audit_permissions': false,
  },
};

export const DEFAULT_IDENTITIES: UserIdentityProfile[] = [
  {
    id: 'USR-ADMIN',
    name: '系统管理员·张工',
    role: 'admin',
    department: '交管智能分析中心',
    title: '平台调度与权限管理员',
  },
  {
    id: 'USR-ANN',
    name: '标注员·林默',
    role: 'annotator',
    department: '事故研判一科',
    title: '第一标注与材料录入员',
  },
  {
    id: 'USR-REV',
    name: '复核员·周敏',
    role: 'reviewer',
    department: '事故质量复核组',
    title: '第二复核质检员',
  },
  {
    id: 'USR-ADJ',
    name: '裁定专家·陈法',
    role: 'adjudicator',
    department: '法制业务裁定委员会',
    title: '高级业务裁定人',
  },
  {
    id: 'USR-VIEW',
    name: '数据融合分析员·苏明',
    role: 'viewer',
    department: '跨系统数据治理组',
    title: '只读检索与融合专员',
  },
];

export const DEFAULT_SCHEDULE_CONFIG: BatchScheduleConfig = {
  enabled: true,
  scanDirectory: './public/assets/aistudio',
  filePattern: '*.pdf',
  dailyTime: '02:00',
  autoRunAi: true,
  maxConcurrent: 2,
  lastRunAt: '2026-11-18T02:00:05.000Z',
  lastRunSummary: '已扫描服务器目录，匹配 5 份 PDF（4 份完成结构化入库/待审，1 份待手动复核）',
};

export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; toneClass: string; isRunning: boolean }
> = {
  idle: {
    label: '待命（未开始）',
    toneClass: 'text-slate-600',
    isRunning: false,
  },
  queued: {
    label: '排队中',
    toneClass: 'text-slate-700',
    isRunning: true,
  },
  parsing_pdf: {
    label: 'PDF 解析中',
    toneClass: 'text-blue-700',
    isRunning: true,
  },
  ai_extracting: {
    label: '大模型提取中',
    toneClass: 'text-blue-800',
    isRunning: true,
  },
  pending_review: {
    label: '等待人工审核',
    toneClass: 'text-amber-800',
    isRunning: false,
  },
  approved: {
    label: '已成功入库',
    toneClass: 'text-emerald-800',
    isRunning: false,
  },
  failed: {
    label: '解析失败',
    toneClass: 'text-red-700',
    isRunning: false,
  },
};

export function hasPermission(
  matrix: RolePermissionMatrix,
  role: ExtendedRole,
  permission: PermissionKey,
): boolean {
  return Boolean(matrix[role]?.[permission]);
}

export function mapExtendedRoleToWorkbenchRole(role: ExtendedRole): UserRole {
  if (role === 'reviewer') return 'reviewer';
  if (role === 'adjudicator' || role === 'admin') return 'adjudicator';
  return 'annotator';
}

export function extractAccidentBizId(caseDoc: CaseDocument): string {
  const rec = caseDoc.fieldRecords.find(
    (r) => r.entityId === 'ACC' && r.fieldCode === 'D01.F001',
  );
  if (!rec) return '';
  if (rec.normalizedValues.length > 0 && rec.normalizedValues[0].trim()) {
    return rec.normalizedValues[0].trim();
  }
  const raw = rec.rawValue.trim();
  const digits = raw.match(/[0-9A-Za-z-]{8,}/)?.[0];
  return digits || raw;
}

export function buildSeedTasksFromCases(cases: CaseDocument[]): AnalysisTask[] {
  const now = Date.now();
  return cases.map((c, idx) => {
    const bizId = extractAccidentBizId(c);
    const readiness = computeCaseReadiness(c);
    const status: TaskStatus = readiness.eligibleForScoring ? 'approved' : 'pending_review';
    const ts = new Date(now - (cases.length - idx) * 3600_000).toISOString();
    return {
      taskId: `TASK-${c.caseId}`,
      batchId: 'BATCH-20261118-0200',
      source: 'scheduled_batch',
      status,
      progress: 100,
      stageLabel: status === 'approved' ? '已复核并入库' : '大模型初稿提取完成，等待人工审核',
      caseId: c.caseId,
      accidentBizId: bizId,
      title: accidentTitle(c),
      filename: c.sourceFilename,
      filePath: `./public/assets/aistudio/${c.sourceFilename}`,
      pdfUrl: c.pdfUrl,
      fileSha256: c.fileSha256,
      pageCount: c.pageCount,
      modelLabel: 'Gemini 2.5 Flash（批量基线）',
      createdAt: ts,
      updatedAt: ts,
      finishedAt: ts,
      durationMs: 4200 + idx * 850,
      extractedFieldsCount: c.fieldRecords.length + c.legalConclusions.length,
      createdByRole: 'admin',
      createdByName: '定时批量调度器',
    };
  });
}

export function buildInitialSystemAuditEvents(cases: CaseDocument[]): SystemAuditEvent[] {
  const events: SystemAuditEvent[] = [
    {
      id: 'SYSAUD-001',
      timestamp: '2026-11-18T02:00:05.000Z',
      category: 'schedule',
      actorRole: 'admin',
      actorName: '定时批量调度器',
      action: '执行每日定时目录扫描',
      targetRef: './public/assets/aistudio',
      detail: '定时任务触发扫描服务器目录，匹配 5 份交通事故认定书 PDF 文件并校验去重指纹。',
    },
  ];
  cases.forEach((c, idx) => {
    const bizId = extractAccidentBizId(c);
    events.push({
      id: `SYSAUD-INIT-${idx + 1}`,
      timestamp: `2026-11-18T02:0${idx + 1}:12.000Z`,
      category: 'task_pipeline',
      actorRole: 'admin',
      actorName: '定时批量调度器',
      action: 'PDF 解析与大模型结构化入库',
      targetRef: c.caseId,
      accidentBizId: bizId,
      detail: `提取 ${c.fieldRecords.length} 条事实字段、${c.legalConclusions.length} 条违法/原因/责任记录`,
    });
  });
  return events.reverse();
}

export interface TaskSummaryStats {
  total: number;
  running: number;
  idle: number;
  pendingReview: number;
  approved: number;
  failed: number;
}

export function computeTaskSummaryStats(tasks: AnalysisTask[]): TaskSummaryStats {
  const stats: TaskSummaryStats = {
    total: tasks.length,
    running: 0,
    idle: 0,
    pendingReview: 0,
    approved: 0,
    failed: 0,
  };
  for (const t of tasks) {
    if (t.status === 'queued' || t.status === 'parsing_pdf' || t.status === 'ai_extracting') {
      stats.running += 1;
    } else if (t.status === 'idle') {
      stats.idle += 1;
    } else if (t.status === 'pending_review') {
      stats.pendingReview += 1;
    } else if (t.status === 'approved') {
      stats.approved += 1;
    } else if (t.status === 'failed') {
      stats.failed += 1;
    }
  }
  return stats;
}

export function filterAnalysisTasks(
  tasks: AnalysisTask[],
  filter: {
    status: 'ALL' | 'running' | TaskStatus;
    source: 'ALL' | AnalysisTask['source'];
    query: string;
  },
): AnalysisTask[] {
  const q = filter.query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.status === 'running') {
      if (t.status !== 'queued' && t.status !== 'parsing_pdf' && t.status !== 'ai_extracting') {
        return false;
      }
    } else if (filter.status !== 'ALL' && t.status !== filter.status) {
      return false;
    }
    if (filter.source !== 'ALL' && t.source !== filter.source) {
      return false;
    }
    if (q) {
      const hay = `${t.taskId} ${t.caseId} ${t.accidentBizId} ${t.title || ''} ${t.filename} ${t.stageLabel} ${t.modelLabel}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function auditBizIdUniqueness(cases: CaseDocument[]): BizIdUniquenessReport {
  const byBizId = new Map<string, CaseDocument[]>();
  const missingCaseIds: string[] = [];
  const invalidCaseIds: string[] = [];
  const caseStatusById: BizIdUniquenessReport['caseStatusById'] = {};

  for (const c of cases) {
    const bizId = extractAccidentBizId(c);
    if (!bizId) {
      missingCaseIds.push(c.caseId);
      caseStatusById[c.caseId] = { bizId: '', status: 'missing', conflictCaseIds: [] };
      continue;
    }
    const cleanLen = bizId.replace(/[^0-9A-Za-z]/g, '').length;
    if (cleanLen < 8) {
      invalidCaseIds.push(c.caseId);
      caseStatusById[c.caseId] = { bizId, status: 'invalid', conflictCaseIds: [] };
      continue;
    }
    const group = byBizId.get(bizId) || [];
    group.push(c);
    byBizId.set(bizId, group);
  }

  const duplicateGroups: BizIdConflictGroup[] = [];
  let validUniqueCount = 0;

  for (const [bizId, group] of byBizId.entries()) {
    if (group.length > 1) {
      const caseIds = group.map((c) => c.caseId);
      duplicateGroups.push({
        bizId,
        caseIds,
        titles: group.map((c) => c.title),
      });
      for (const c of group) {
        caseStatusById[c.caseId] = {
          bizId,
          status: 'duplicate',
          conflictCaseIds: caseIds.filter((id) => id !== c.caseId),
        };
      }
    } else {
      validUniqueCount += 1;
      caseStatusById[group[0].caseId] = {
        bizId,
        status: 'unique',
        conflictCaseIds: [],
      };
    }
  }

  return {
    totalCases: cases.length,
    validUniqueCount,
    missingCaseIds,
    invalidCaseIds,
    duplicateGroups,
    hasBlockingConflict:
      missingCaseIds.length > 0 || invalidCaseIds.length > 0 || duplicateGroups.length > 0,
    caseStatusById,
  };
}

function getNormalizedFieldValues(caseDoc: CaseDocument, fieldCode: string): string[] {
  const vals: string[] = [];
  for (const rec of caseDoc.fieldRecords) {
    if (rec.fieldCode !== fieldCode) continue;
    if (rec.presenceStatus !== 'present') continue;
    for (const v of rec.normalizedValues) {
      const trimmed = v.trim();
      if (trimmed && !vals.includes(trimmed)) vals.push(trimmed);
    }
    if (rec.normalizedValues.length === 0 && rec.rawValue.trim()) {
      const trimmed = rec.rawValue.trim();
      if (!vals.includes(trimmed)) vals.push(trimmed);
    }
  }
  return vals;
}

export function collectSimilarityTagCatalog(cases: CaseDocument[]) {
  const accidentTypes = new Set<string>();
  const weathers = new Set<string>();
  const surfaces = new Set<string>();
  const lightings = new Set<string>();
  const violations = new Set<string>();
  const liabilities = new Set<string>();

  for (const c of cases) {
    getNormalizedFieldValues(c, 'D01.F003').forEach((v) => accidentTypes.add(v));
    getNormalizedFieldValues(c, 'D07.F041').forEach((v) => weathers.add(v));
    getNormalizedFieldValues(c, 'D07.F042').forEach((v) => surfaces.add(v));
    getNormalizedFieldValues(c, 'D07.F044').forEach((v) => lightings.add(v));
    for (const l of c.legalConclusions) {
      const label = l.conclusionLabel.trim();
      if (!label) continue;
      if (l.category === 'violation' && l.presenceStatus === 'present') {
        violations.add(label);
      } else if (l.category === 'liability' && l.presenceStatus === 'present') {
        liabilities.add(label);
      }
    }
  }

  return {
    accidentTypes: Array.from(accidentTypes),
    weathers: Array.from(weathers),
    surfaces: Array.from(surfaces),
    lightings: Array.from(lightings),
    violations: Array.from(violations),
    liabilities: Array.from(liabilities),
  };
}

export function searchSimilarCases(
  cases: CaseDocument[],
  filter: CaseSimilarityFilter,
  uniquenessReport?: BizIdUniquenessReport,
): SimilarCaseMatch[] {
  const report = uniquenessReport || auditBizIdUniqueness(cases);
  const q = filter.keyword.trim().toLowerCase();
  const matches: SimilarCaseMatch[] = [];

  for (const c of cases) {
    const accidentType = getNormalizedFieldValues(c, 'D01.F003')[0] || '';
    const weatherTags = getNormalizedFieldValues(c, 'D07.F041');
    const surfaceTags = getNormalizedFieldValues(c, 'D07.F042');
    const lightingTag = getNormalizedFieldValues(c, 'D07.F044')[0] || '';
    const violationTags = Array.from(
      new Set(
        c.legalConclusions
          .filter(
            (l) =>
              l.category === 'violation' &&
              l.presenceStatus === 'present' &&
              l.conclusionLabel.trim(),
          )
          .map((l) => l.conclusionLabel.trim()),
      ),
    );
    const liabilityTags = Array.from(
      new Set(
        c.legalConclusions
          .filter(
            (l) =>
              l.category === 'liability' &&
              l.presenceStatus === 'present' &&
              l.conclusionLabel.trim(),
          )
          .map((l) => l.conclusionLabel.trim()),
      ),
    );

    const readiness = computeCaseReadiness(c);
    const isApproved = readiness.eligibleForScoring;
    if (filter.onlyApproved && !isApproved) continue;
    if (filter.accidentType && accidentType !== filter.accidentType) continue;
    if (filter.weather && !weatherTags.includes(filter.weather)) continue;
    if (filter.surface && !surfaceTags.includes(filter.surface)) continue;
    if (filter.lighting && lightingTag !== filter.lighting) continue;
    if (filter.violation && !violationTags.includes(filter.violation)) continue;
    if (filter.liability && !liabilityTags.includes(filter.liability)) continue;

    const bizId = extractAccidentBizId(c);
    if (q) {
      const hay = [
        c.caseId,
        c.title,
        c.scenarioSummary,
        bizId,
        accidentType,
        ...weatherTags,
        ...surfaceTags,
        lightingTag,
        ...violationTags,
        ...liabilityTags,
        ...c.fieldRecords.map((r) => `${r.rawValue} ${r.normalizedValues.join(' ')}`),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }

    const matchedTags: string[] = [];
    if (accidentType) matchedTags.push(accidentType);
    matchedTags.push(...weatherTags, ...surfaceTags);
    if (lightingTag) matchedTags.push(lightingTag);
    matchedTags.push(...violationTags);

    matches.push({
      caseDoc: c,
      accidentBizId: bizId,
      matchedTags: Array.from(new Set(matchedTags)),
      accidentType,
      weatherTags,
      surfaceTags,
      lightingTag,
      violationTags,
      liabilityTags,
      isApproved,
      uniquenessStatus: report.caseStatusById[c.caseId]?.status || 'missing',
    });
  }

  return matches;
}

export function buildCrossSystemFusionPayload(
  caseDoc: CaseDocument,
  uniquenessReport: BizIdUniquenessReport,
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): FusionExportBundle {
  const bizId = extractAccidentBizId(caseDoc);
  const statusInfo = uniquenessReport.caseStatusById[caseDoc.caseId];
  const uniquenessStatus = statusInfo?.status || 'missing';
  const readiness = computeCaseReadiness(caseDoc, supplements);
  const v02 = buildGoldV02ExportPayload(caseDoc, caseDoc.maskPiiOnExport);
  const entityMap = new Map(caseDoc.entities.map((e) => [e.id, e.label]));

  return {
    schema_version: 'fusion-bridge-v1.0',
    fusion_key_name: 'accident_biz_id',
    accident_biz_id: bizId,
    uniqueness_verified: uniquenessStatus === 'unique',
    uniqueness_status: uniquenessStatus,
    case_id: caseDoc.caseId,
    source_filename: caseDoc.sourceFilename,
    source_sha256: caseDoc.sourceHashFull || caseDoc.fileSha256,
    exported_at: new Date().toISOString(),
    readiness_eligible: readiness.eligibleForScoring,
    summary_tags: {
      accident_type: getNormalizedFieldValues(caseDoc, 'D01.F003')[0] || '',
      weather: getNormalizedFieldValues(caseDoc, 'D07.F041'),
      road_surface: getNormalizedFieldValues(caseDoc, 'D07.F042'),
      lighting: getNormalizedFieldValues(caseDoc, 'D07.F044')[0] || '',
      violations: Array.from(
        new Set(
          caseDoc.legalConclusions
            .filter(
              (l) =>
                l.category === 'violation' &&
                l.presenceStatus === 'present' &&
                l.conclusionLabel.trim(),
            )
            .map((l) => l.conclusionLabel.trim()),
        ),
      ),
      liabilities: caseDoc.legalConclusions
        .filter((l) => l.category === 'liability' && l.presenceStatus === 'present')
        .map((l) => ({
          subject_id: l.subjectId,
          subject_label: entityMap.get(l.subjectId) || l.subjectId,
          level: l.conclusionLabel.trim() || '未定责',
        })),
    },
    gold_payload: v02,
  };
}

export function filterSystemAuditLogs(
  logs: SystemAuditEvent[],
  filter: {
    category: 'ALL' | SystemAuditCategory;
    role: 'ALL' | ExtendedRole;
    query: string;
  },
): SystemAuditEvent[] {
  const q = filter.query.trim().toLowerCase();
  return logs.filter((entry) => {
    if (filter.category !== 'ALL' && entry.category !== filter.category) return false;
    if (filter.role !== 'ALL' && entry.actorRole !== filter.role) return false;
    if (q) {
      const hay = `${entry.action} ${entry.targetRef} ${entry.accidentBizId || ''} ${entry.actorName} ${entry.detail}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
