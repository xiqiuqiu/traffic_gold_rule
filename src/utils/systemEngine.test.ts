import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CASES } from '../data/seedCases';
import { AnalysisTask } from '../types/system';
import {
  DEFAULT_ROLE_PERMISSIONS,
  auditBizIdUniqueness,
  buildCrossSystemFusionPayload,
  buildSeedTasksFromCases,
  computeTaskSummaryStats,
  extractAccidentBizId,
  filterAnalysisTasks,
  filterSystemAuditLogs,
  hasPermission,
  searchSimilarCases,
} from './systemEngine';

test('RBAC permission matrix restricts viewer and annotator capabilities cleanly', () => {
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'admin', 'task:schedule_manage'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'admin', 'system:audit_permissions'), true);

  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'task:view'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'similar:fusion_export'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'task:schedule_manage'), false);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'task:upload_run'), false);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'case:edit_annotate'), false);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'case:review'), false);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'viewer', 'system:audit_permissions'), false);

  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'annotator', 'task:upload_run'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'annotator', 'case:edit_annotate'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'annotator', 'case:review'), false);

  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'reviewer', 'case:review'), true);
  assert.equal(hasPermission(DEFAULT_ROLE_PERMISSIONS, 'reviewer', 'case:adjudicate'), false);
});

test('computeTaskSummaryStats and filterAnalysisTasks classify running, pending_review, approved, and failed tasks', () => {
  const baseTasks = buildSeedTasksFromCases(SEED_CASES.slice(0, 2));
  const extraTasks: AnalysisTask[] = [
    {
      ...baseTasks[0],
      taskId: 'TASK-RUN',
      source: 'manual_upload',
      status: 'ai_extracting',
      progress: 70,
      filename: 'manual_upload_test.pdf',
      accidentBizId: '610100202600009999',
    },
    {
      ...baseTasks[0],
      taskId: 'TASK-FAIL',
      source: 'manual_upload',
      status: 'failed',
      progress: 45,
      filename: 'failed_scan.pdf',
      accidentBizId: '',
      errorMessage: '上游模型连接超时',
    },
    {
      ...baseTasks[0],
      taskId: 'TASK-IDLE',
      source: 'manual_upload',
      status: 'idle',
      progress: 0,
      filename: 'queued_only.pdf',
      accidentBizId: '',
    },
  ];
  const all = [...baseTasks, ...extraTasks];
  const stats = computeTaskSummaryStats(all);
  assert.equal(stats.total, all.length);
  assert.equal(stats.running, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.idle, 1);

  const runningList = filterAnalysisTasks(all, {
    status: 'running',
    source: 'ALL',
    query: '',
  });
  assert.deepEqual(
    runningList.map((t) => t.taskId),
    ['TASK-RUN'],
  );

  const queryMatch = filterAnalysisTasks(all, {
    status: 'ALL',
    source: 'manual_upload',
    query: '610100202600009999',
  });
  assert.deepEqual(
    queryMatch.map((t) => t.taskId),
    ['TASK-RUN'],
  );
});

test('auditBizIdUniqueness detects unique, duplicate, missing, and invalid D01.F001 IDs', () => {
  const setBizId = (c: typeof SEED_CASES[number], val: string | null) => {
    c.fieldRecords = c.fieldRecords.filter((r) => !(r.entityId === 'ACC' && r.fieldCode === 'D01.F001'));
    if (val !== null) {
      c.fieldRecords.push({
        recordId: `FR-TEST-${c.caseId}`,
        entityId: 'ACC',
        fieldCode: 'D01.F001',
        presenceStatus: 'present',
        rawValue: val,
        normalizedValues: [val],
        evidences: [{ id: 'EV-T', page: 1, quote: val }],
        reviewStatus: 'checked',
        disputeReason: '',
        adjudicatorNote: '',
        updatedByRole: 'annotator',
        updatedAt: '2026-11-18T00:00:00Z',
      });
    }
  };

  const c1 = structuredClone(SEED_CASES[0]);
  const c2 = structuredClone(SEED_CASES[1]);
  const cDup = structuredClone(SEED_CASES[2]);
  const cMissing = structuredClone(SEED_CASES[3]);
  const cInvalid = structuredClone(SEED_CASES[4]);

  const c1BizId = extractAccidentBizId(c1);
  assert.ok(c1BizId.length >= 8);
  setBizId(c2, '320100202600001234');
  setBizId(cDup, c1BizId);
  setBizId(cMissing, null);
  setBizId(cInvalid, '123');

  const report = auditBizIdUniqueness([c1, c2, cDup, cMissing, cInvalid]);
  assert.equal(report.totalCases, 5);
  assert.equal(report.validUniqueCount, 1);
  assert.equal(report.hasBlockingConflict, true);
  assert.deepEqual(report.missingCaseIds, [cMissing.caseId]);
  assert.deepEqual(report.invalidCaseIds, [cInvalid.caseId]);
  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.duplicateGroups[0].bizId, c1BizId);
  assert.deepEqual(report.duplicateGroups[0].caseIds, [c1.caseId, cDup.caseId]);
  assert.equal(report.caseStatusById[c2.caseId].status, 'unique');
  assert.equal(report.caseStatusById[c1.caseId].status, 'duplicate');
});

test('searchSimilarCases filters by combined tags and buildCrossSystemFusionPayload stamps accident_biz_id', () => {
  const cases = structuredClone(SEED_CASES);
  const case13 = cases.find((c) => c.caseId === 'CASE-13')!;
  case13.fieldRecords.push({
    recordId: 'FR-13-BIZ',
    entityId: 'ACC',
    fieldCode: 'D01.F001',
    presenceStatus: 'present',
    rawValue: '320900120260001089',
    normalizedValues: ['320900120260001089'],
    evidences: [{ id: 'EV-13-BIZ', page: 1, quote: '编号：320900120260001089' }],
    reviewStatus: 'checked',
    disputeReason: '',
    adjudicatorNote: '',
    updatedByRole: 'annotator',
    updatedAt: '2026-11-18T00:00:00Z',
  });
  const report = auditBizIdUniqueness(cases);
  const fogMatches = searchSimilarCases(
    cases,
    {
      keyword: '',
      accidentType: '',
      weather: '浓雾（团雾）',
      surface: '',
      lighting: '',
      violation: '',
      liability: '',
      onlyApproved: false,
    },
    report,
  );
  assert.equal(fogMatches.length, 1);
  assert.equal(fogMatches[0].caseDoc.caseId, 'CASE-13');

  const fusion = buildCrossSystemFusionPayload(fogMatches[0].caseDoc, report);
  assert.equal(fusion.fusion_key_name, 'accident_biz_id');
  assert.equal(fusion.accident_biz_id, '320900120260001089');
  assert.equal(fusion.uniqueness_verified, true);
  assert.ok(fusion.summary_tags.weather.includes('浓雾（团雾）'));
  assert.ok(fusion.gold_payload);
});

test('filterSystemAuditLogs filters by category, role, and search query', () => {
  const logs = [
    {
      id: 'L1',
      timestamp: '2026-11-18T02:00:00Z',
      category: 'schedule' as const,
      actorRole: 'admin' as const,
      actorName: '张工',
      action: '定时扫描目录',
      targetRef: './public/assets/aistudio',
      detail: '扫描 5 个文件',
    },
    {
      id: 'L2',
      timestamp: '2026-11-18T03:00:00Z',
      category: 'fusion_export' as const,
      actorRole: 'viewer' as const,
      actorName: '苏明',
      action: '导出融合数据包',
      targetRef: 'CASE-01',
      accidentBizId: '610113120260000042',
      detail: '唯一主键校验通过',
    },
  ];
  const filtered = filterSystemAuditLogs(logs, {
    category: 'fusion_export',
    role: 'viewer',
    query: '610113120260000042',
  });
  assert.deepEqual(
    filtered.map((x) => x.id),
    ['L2'],
  );
});
