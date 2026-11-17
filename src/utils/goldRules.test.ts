import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoldExportPayload,
  cleanSelectedPdfQuote,
  computeCaseReadiness,
  deriveTimeBucket,
  generateNextEntityId,
  maskPiiText,
  validateFieldRecord,
} from './goldRules';
import { CaseDocument, FieldRecord } from '../types/gold';
import { MASTER_FIELD_SCHEMA } from '../data/schemaCatalog';

test('generateNextEntityId follows ACC and two-digit prefix conventions', () => {
  assert.equal(generateNextEntityId('ACC', []), 'ACC');
  assert.equal(generateNextEntityId('P', []), 'P01');
  assert.equal(
    generateNextEntityId('P', [
      { id: 'ACC', kind: 'ACC', label: '事故' },
      { id: 'P01', kind: 'P', label: '张伟' },
      { id: 'P02', kind: 'P', label: '李桂英' },
    ]),
    'P03',
  );
  assert.equal(
    generateNextEntityId('V', [{ id: 'V01', kind: 'V', label: '陕A88X99' }]),
    'V02',
  );
});

test('cleanSelectedPdfQuote joins split table lines cleanly', () => {
  assert.equal(cleanSelectedPdfQuote('SMITH\nJOHN'), 'SMITHJOHN');
  assert.equal(cleanSelectedPdfQuote('61\n0113199208141234'), '610113199208141234');
  assert.equal(cleanSelectedPdfQuote('  阴（路面湿滑） \n '), '阴（路面湿滑）');
});

test('deriveTimeBucket computes bucket from datetime string', () => {
  assert.equal(deriveTimeBucket('2026年04月12日23时15分许'), '晚间/夜间 (18:00-23:59)');
  assert.equal(deriveTimeBucket('2026年10月28日06时40分'), '早高峰/上午 (06:00-11:59)');
  assert.equal(deriveTimeBucket('2026年10月18日 14:25'), '午后 (12:00-17:59)');
});

test('maskPiiText masks 18-digit IDs, phone numbers, and passport numbers', () => {
  const raw = '身份证 610113199208141234，电话 13891881122，护照:P98765432';
  const masked = maskPiiText(raw);
  assert.ok(!masked.includes('610113199208141234'));
  assert.ok(!masked.includes('13891881122'));
  assert.ok(!masked.includes('P98765432'));
});

test('validateFieldRecord enforces present evidence and forbids values on not_mentioned', () => {
  const missingEvidence: FieldRecord = {
    recordId: 'R1',
    entityId: 'ACC',
    fieldCode: 'D07.F041',
    presenceStatus: 'present',
    rawValue: '阴',
    normalizedValues: ['阴'],
    evidences: [],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
    updatedByRole: 'annotator',
    updatedAt: '2026-11-16T00:00:00Z',
  };
  assert.equal(
    validateFieldRecord(missingEvidence).some((i) => i.code === 'MISSING_EVIDENCE'),
    true,
  );

  const silenceAsNegative: FieldRecord = {
    ...missingEvidence,
    presenceStatus: 'not_mentioned',
    rawValue: '无',
    normalizedValues: [],
  };
  assert.equal(
    validateFieldRecord(silenceAsNegative).some((i) => i.code === 'VALUE_FORBIDDEN_FOR_STATUS'),
    true,
  );
});

test('computeCaseReadiness blocks scoring until checked/adjudicated and all 10 checklist items pass', () => {
  const baseCase: CaseDocument = {
    caseId: 'CASE-TEST',
    title: '测试样本',
    pilotCode: '01',
    scenarioSummary: '单方样本',
    pdfUrl: '/assets/aistudio/accident_report_01_single_vehicle_793cce74.pdf',
    sourceFilename: 'test.pdf',
    fileSha256: 'abc',
    pageCount: 2,
    manualVersion: '试行版 v1',
    annotationVersion: 'v1.0',
    maskPiiOnExport: true,
    annotatorName: '标注员A',
    reviewerName: '复核员B',
    adjudicatorName: '',
    entities: [{ id: 'ACC', kind: 'ACC', label: '测试事故' }],
    fieldRecords: [
      {
        recordId: 'FR-1',
        entityId: 'ACC',
        fieldCode: 'D07.F041',
        presenceStatus: 'present',
        rawValue: '阴',
        normalizedValues: ['阴'],
        evidences: [{ id: 'EV-1', page: 1, quote: '天气 阴（路面湿滑）' }],
        reviewStatus: 'draft',
        disputeReason: '',
        adjudicatorNote: '',
        updatedByRole: 'annotator',
        updatedAt: '2026-11-16T00:00:00Z',
      },
    ],
    legalConclusions: [],
    relations: [],
    checklist: {
      check_1: true,
      check_2: true,
      check_3: true,
      check_4: true,
      check_5: true,
      check_6: true,
      check_7: true,
      check_8: true,
      check_9: true,
      check_10: true,
    },
    auditLog: [],
  };

  const draftReadiness = computeCaseReadiness(baseCase);
  assert.equal(draftReadiness.eligibleForScoring, false);
  assert.equal(draftReadiness.statusCounts.draft, 1);

  baseCase.fieldRecords[0].reviewStatus = 'checked';
  const checkedReadiness = computeCaseReadiness(baseCase);
  assert.equal(checkedReadiness.eligibleForScoring, true);

  const payload = buildGoldExportPayload(baseCase, true);
  assert.equal(payload.meta.eligible_for_scoring, true);
});

test('G01-G06 fact fields have single-entity ownership except D05.F075 (P or V), and G07/G08 are isolated', () => {
  for (const field of MASTER_FIELD_SCHEMA) {
    if (!field.isLegalOrRelation) {
      if (field.fieldCode === 'D05.F075') {
        assert.deepEqual(field.applicableKinds, ['P', 'V']);
      } else {
        assert.equal(
          field.applicableKinds.length,
          1,
          `${field.fieldCode} (${field.fieldName}) should map to exactly 1 entity kind`,
        );
      }
    } else {
      if (field.groupCode === 'G07') {
        assert.deepEqual(field.applicableKinds, ['E']);
      } else {
        assert.deepEqual(field.applicableKinds, ['P', 'O']);
      }
    }
  }
});
