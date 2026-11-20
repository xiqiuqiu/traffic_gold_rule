import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_VOCABULARY_SUPPLEMENTS, MASTER_FIELD_SCHEMA } from '../data/schemaCatalog';
import { CaseDocument } from '../types/gold';
import {
  AiPreanalyzePayload,
  buildAiSchemaCatalogPayload,
  mapAiExtractionToCaseDraft,
  normalizeAiFieldValues,
} from './aiPreanalyze';

function makeLocalEmptyCase(): CaseDocument {
  return {
    caseId: 'CASE-LOCAL-01',
    documentId: 'case-local-01',
    title: 'CASE-LOCAL-01 · 测试认定书',
    pilotCode: '新增',
    scenarioSummary: '本地导入测试材料',
    pdfUrl: 'blob:local-test',
    sourceFilename: 'test_report.pdf',
    fileSha256: 'sha256:1234',
    pageCount: 2,
    manualVersion: '试行版',
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
        subtitle: 'test_report.pdf',
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

test('buildAiSchemaCatalogPayload includes all 35 fields with merged controlled vocab options', () => {
  const catalog = buildAiSchemaCatalogPayload(INITIAL_VOCABULARY_SUPPLEMENTS);
  assert.equal(catalog.length, MASTER_FIELD_SCHEMA.length);

  const f041 = catalog.find((c) => c.fieldCode === 'D07.F041');
  assert.ok(f041);
  assert.equal(f041.allowMultiple, true);
  assert.ok(f041.options.includes('浓雾（团雾）'));

  const f042 = catalog.find((c) => c.fieldCode === 'D07.F042');
  assert.ok(f042);
  assert.ok(f042.options.includes('干燥（沥青路面）'));
  assert.ok(f042.synonyms.includes('沥青路面干燥平整'));
});

test('normalizeAiFieldValues aligns synonyms, enforces single-select limit, and derives D02.F007', () => {
  const f042 = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D07.F042')!;
  const s042 = INITIAL_VOCABULARY_SUPPLEMENTS.find((s) => s.fieldCode === 'D07.F042')!;
  assert.deepEqual(
    normalizeAiFieldValues(f042, ['沥青路面干燥平整'], '沥青路面干燥平整', s042),
    ['干燥（沥青路面）'],
  );

  const f003 = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D01.F003')!;
  assert.deepEqual(
    normalizeAiFieldValues(f003, ['财产损失事故', '伤人事故'], '财产损失事故'),
    ['财产损失事故'],
  );

  const f007 = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D02.F007')!;
  assert.deepEqual(
    normalizeAiFieldValues(f007, [], '2026年04月12日23时15分许'),
    ['晚间/夜间 (18:00-23:59)'],
  );
});

test('mapAiExtractionToCaseDraft reconciles entities, maps valid drafts, enforces forbidsValue, and respects mergeMode', () => {
  const base = makeLocalEmptyCase();

  const aiPayload: AiPreanalyzePayload = {
    summary: '提取了夜间单方撞护栏事故初稿',
    entities: [
      { id: 'ACC', kind: 'ACC', label: '丈八东路夜间撞护栏事故' },
      { id: 'P01', kind: 'P', label: '张伟', subtitle: '机动车驾驶人' },
      { id: 'V01', kind: 'V', label: '陕A88X99', subtitle: '小型普通客车' },
    ],
    fieldRecords: [
      {
        entityId: 'ACC',
        fieldCode: 'D01.F003',
        presenceStatus: 'present',
        rawValue: '财产损失事故',
        normalizedValues: ['财产损失事故'],
        evidences: [{ page: 1, quote: '事故类别：财产损失事故', lineIds: ['31:2'] }],
      },
      {
        entityId: 'ACC',
        fieldCode: 'D07.F041',
        presenceStatus: 'present',
        rawValue: '阴（受微雨影响）',
        normalizedValues: ['阴', '微雨'],
        evidences: [{ page: 1, quote: '天气 阴' }],
      },
      {
        entityId: 'ACC',
        fieldCode: 'D09.F053',
        presenceStatus: 'not_mentioned',
        rawValue: '不应保留的值',
        normalizedValues: ['0'],
        evidences: [],
      },
      {
        // Invalid kind ownership: D04.F021 belongs to V, not P -> must be ignored
        entityId: 'P01',
        fieldCode: 'D04.F021',
        presenceStatus: 'present',
        rawValue: '小型普通客车',
        normalizedValues: ['小型普通客车'],
        evidences: [{ page: 1, quote: '小型普通客车' }],
      },
      {
        // Present without evidence -> counted in errorDraftCount for human check
        entityId: 'V01',
        fieldCode: 'D04.F021',
        presenceStatus: 'present',
        rawValue: '小型普通客车',
        normalizedValues: ['小型普通客车'],
        evidences: [],
      },
    ],
    legalConclusions: [
      {
        category: 'liability',
        subjectId: 'P01',
        presenceStatus: 'present',
        rawText: '张伟承担全部责任',
        conclusionLabel: '全部责任',
        evidences: [{ page: 2, quote: '张伟承担全部责任' }],
      },
    ],
  };

  const firstRun = mapAiExtractionToCaseDraft(base, aiPayload, {
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
    mergeMode: 'merge_missing',
    nowIso: '2026-11-18T18:00:00Z',
  });

  assert.equal(firstRun.addedEntitiesCount, 2); // P01, V01
  assert.equal(firstRun.nextCase.entities.find((e) => e.id === 'ACC')?.label, '丈八东路夜间撞护栏事故');
  assert.equal(firstRun.createdFieldsCount, 4); // ACC.D01.F003, ACC.D07.F041, ACC.D09.F053, V01.D04.F021
  assert.equal(firstRun.validDraftCount, 3);
  assert.equal(firstRun.errorDraftCount, 1);
  assert.equal(firstRun.createdLegalCount, 1);
  assert.deepEqual(firstRun.nextCase.fieldRecords.find(r => r.fieldCode === 'D01.F003')?.evidences[0].lineIds, ['31:2']);

  const notMentionedRec = firstRun.nextCase.fieldRecords.find(
    (r) => r.entityId === 'ACC' && r.fieldCode === 'D09.F053',
  );
  assert.ok(notMentionedRec);
  assert.equal(notMentionedRec.rawValue, '');
  assert.deepEqual(notMentionedRec.normalizedValues, []);
  assert.equal(notMentionedRec.reviewStatus, 'draft');

  // Mark D01.F003 as checked (protected) and re-run with overwrite_drafts
  const protectedCase = structuredClone(firstRun.nextCase);
  const f003 = protectedCase.fieldRecords.find((r) => r.fieldCode === 'D01.F003')!;
  f003.reviewStatus = 'checked';

  const secondPayload: AiPreanalyzePayload = {
    entities: [{ id: 'ACC', kind: 'ACC', label: '丈八东路夜间撞护栏事故' }],
    fieldRecords: [
      {
        entityId: 'ACC',
        fieldCode: 'D01.F003',
        presenceStatus: 'present',
        rawValue: '伤人事故',
        normalizedValues: ['伤人事故'],
        evidences: [{ page: 1, quote: '伤人事故' }],
      },
      {
        entityId: 'ACC',
        fieldCode: 'D07.F041',
        presenceStatus: 'present',
        rawValue: '晴',
        normalizedValues: ['晴'],
        evidences: [{ page: 1, quote: '晴' }],
      },
    ],
  };

  const overwriteRun = mapAiExtractionToCaseDraft(protectedCase, secondPayload, {
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
    mergeMode: 'overwrite_drafts',
  });

  // D01.F003 (checked) is protected; D07.F041 (draft) is updated
  assert.equal(overwriteRun.skippedProtectedFieldsCount, 1);
  assert.equal(overwriteRun.updatedDraftFieldsCount, 1);
  assert.equal(
    overwriteRun.nextCase.fieldRecords.find((r) => r.fieldCode === 'D01.F003')?.rawValue,
    '财产损失事故',
  );
  assert.equal(
    overwriteRun.nextCase.fieldRecords.find((r) => r.fieldCode === 'D07.F041')?.rawValue,
    '晴',
  );
});

test('mapAiExtractionToCaseDraft aligns extracted violation conclusionLabel with D10.F058 controlled vocabulary', () => {
  const base = makeLocalEmptyCase();
  const payload: AiPreanalyzePayload = {
    entities: [
      { id: 'ACC', kind: 'ACC', label: '交叉路口碰撞事故' },
      { id: 'P01', kind: 'P', label: '陈某', roleLabel: '机动车驾驶人' },
    ],
    fieldRecords: [],
    legalConclusions: [
      {
        category: 'violation',
        subjectId: 'P01',
        presenceStatus: 'present',
        rawText: '陈某驾驶机动车未按照操作规范安全驾驶、文明驾驶。',
        lawArticle: '《中华人民共和国道路交通安全法》第二十二条第一款',
        conclusionLabel: '未按照操作规范安全驾驶',
        evidences: [{ page: 3, quote: '未按照操作规范安全驾驶', lineIds: ['37:6'] }],
      },
    ],
  };

  const res = mapAiExtractionToCaseDraft(base, payload, {
    catalog: { 'D10.F058': [{ code: 'v1', value: '码表违法名称', aliases: ['未按照操作规范安全驾驶'] }] },
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
  });
  const vio = res.nextCase.legalConclusions.find((l) => l.category === 'violation');
  assert.ok(vio);
  assert.equal(vio.conclusionLabel, '码表违法名称');
  assert.equal(vio.conclusionCode, 'v1');
  assert.equal(vio.linkConsistencyConfirmed, false);
  assert.equal(vio.evidences[0].page, 3);
  assert.deepEqual(vio.evidences[0].lineIds, ['37:6']);
});

test('mapAiExtractionToCaseDraft merges duplicate whole-accident liability for a subject even in overwrite_drafts mode', () => {
  const base = makeLocalEmptyCase();
  const payload: AiPreanalyzePayload = {
    entities: [
      { id: 'ACC', kind: 'ACC', label: '两车追尾事故' },
      { id: 'P01', kind: 'P', label: '甲某', roleLabel: '机动车驾驶人' },
    ],
    fieldRecords: [],
    legalConclusions: [
      {
        category: 'liability',
        subjectId: 'P01',
        presenceStatus: 'present',
        rawText: '甲某承担全部责任',
        conclusionLabel: '全部责任',
        evidences: [{ page: 1, quote: '甲某承担全部责任' }],
      },
      {
        category: 'liability',
        subjectId: 'P01',
        presenceStatus: 'present',
        rawText: '甲某负事故全部责任（重复条目）',
        conclusionLabel: '主要责任',
        evidences: [{ page: 1, quote: '甲某负事故全部责任' }],
      },
    ],
  };

  const res = mapAiExtractionToCaseDraft(base, payload, {
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
    mergeMode: 'overwrite_drafts',
  });
  const p01Liabilities = res.nextCase.legalConclusions.filter(
    (l) => l.category === 'liability' && l.subjectId === 'P01',
  );
  assert.equal(p01Liabilities.length, 1);
});

test('同一主体分阶段责任分别保留，重跑保留人工修订和各阶段的原文行引用', () => {
  const payload: AiPreanalyzePayload = {
    entities: [
      { id: 'P01', kind: 'P', label: '王小明' },
      { id: 'E01', kind: 'E', label: '追尾碰撞', subtitle: '第一阶段碰撞' },
      { id: 'E02', kind: 'E', label: '追尾碰撞', subtitle: '第二阶段碰撞' },
    ],
    fieldRecords: [],
    legalConclusions: ['E01', 'E02'].map((eventId, i) => ({
      category: 'liability',
      subjectId: 'P01',
      eventId,
      presenceStatus: 'present',
      rawText: '王小明承担全部责任',
      conclusionLabel: '全部责任',
      evidences: [{ page: 2, quote: '王小明承担全部责任', lineIds: [`19:${i + 1}`] }],
    })),
  };
  const base = mapAiExtractionToCaseDraft(makeLocalEmptyCase(), {
    ...payload, legalConclusions: payload.legalConclusions!.slice(0, 1),
  }).nextCase;
  base.legalConclusions[0].conclusionLabel = '人工核定结论';
  base.legalConclusions[0].reviewStatus = 'checked';

  for (const mergeMode of ['merge_missing', 'overwrite_drafts'] as const) {
    const items = mapAiExtractionToCaseDraft(base, payload, { mergeMode }).nextCase.legalConclusions;
    assert.deepEqual(items.map(it => it.eventId), ['E01', 'E02']);
    assert.deepEqual(items[0], base.legalConclusions[0]);
    assert.deepEqual(items[1].evidences[0].lineIds, ['19:2']);
    assert.notEqual(items[0].id, items[1].id);
  }
});

