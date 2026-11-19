import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAllViolationLinks,
  applyViolationEntityLink,
  applyViolationVocabLink,
  buildControlledVocabOptions,
  buildGoldExportPayload,
  buildGoldV02ExportPayload,
  cleanSelectedPdfQuote,
  collectCaseWorkItems,
  computeCaseReadiness,
  computeEntityProgressMap,
  computeEntityWorkbenchStats,
  confirmViolationLinkConsistency,
  deriveTimeBucket,
  extractPdfParagraphMatches,
  filterControlledVocabOptions,
  filterWorkItems,
  findTextMatchRanges,
  generateNextEntityId,
  getScopedCauseCandidatesForLiability,
  getScopedViolationCandidatesForCause,
  getSubjectLiabilityRecords,
  maskPiiText,
  matchesFieldRecordBucket,
  normalizePdfTextForDisplay,
  pickDefaultLiabilitySubjectId,
  scanViolationLinkMatches,
  sortLegalConclusionsByChain,
  splitPdfPageIntoParagraphs,
  stepVocabHighlightIndex,
  traceLegalEvidenceChain,
  validateFieldRecord,
  validateLegalConclusion,
} from './goldRules';
import { CaseDocument, FieldRecord, LegalConclusionItem } from '../types/gold';
import { INITIAL_VOCABULARY_SUPPLEMENTS, MASTER_FIELD_SCHEMA } from '../data/schemaCatalog';
import { SEED_CASES } from '../data/seedCases';

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

test('buildGoldV02ExportPayload matches v0.2 schema structure, multi-value splitting, PII masking, and causal links', () => {
  const case01 = SEED_CASES[0];
  const v02 = buildGoldV02ExportPayload(case01, true);

  assert.equal(v02.case_id, 'CASE-01');
  assert.equal(v02.document_id, 'real-full-01');
  assert.equal(v02.schema_version, '1.1-draft');
  assert.equal(v02.ownership_version, '0.2-draft');
  assert.equal(v02.source_hash.length, 64);
  assert.equal(v02.subjects.length, 6);
  assert.deepEqual(v02.subjects[1], {
    subject_id: 'P01',
    subject_type: 'P',
    role: '机动车驾驶人',
  });

  // 29 records with FR-01-005 split into -A and -B => 30 facts
  assert.equal(v02.facts.length, 30);

  const f001 = v02.facts.find((f) => f.record_id === 'FR-01-001') as Record<string, unknown>;
  assert.equal(f001.raw_value, '[REDACTED_PII]');
  assert.equal(f001.candidate_value, '610113120260000042');
  const f001Ev = f001.evidence as Array<{ excerpt: string }>;
  assert.ok(f001Ev[0].excerpt.includes('6101************42'));

  const splitA = v02.facts.find((f) => f.record_id === 'FR-01-005-A') as Record<string, unknown>;
  const splitB = v02.facts.find((f) => f.record_id === 'FR-01-005-B') as Record<string, unknown>;
  assert.equal(splitA.candidate_value, '阴');
  assert.equal(splitB.candidate_value, '微雨');

  const notMentioned = v02.facts.find((f) => f.record_id === 'FR-01-009') as Record<string, unknown>;
  assert.equal(notMentioned.presence, 'not_mentioned');
  assert.equal('raw_value' in notMentioned, false);
  assert.equal('candidate_value' in notMentioned, false);

  assert.equal(v02.legal_records.length, 2);
  assert.equal(v02.legal_records[1].causal_link_status, 'explicit_linked');
  assert.deepEqual(v02.legal_records[1].linked_violation_record_ids, ['VIO-01']);

  assert.equal(v02.responsibilities.length, 1);
  assert.equal(v02.responsibilities[0].field_code, 'D10.F060');
  assert.deepEqual(v02.responsibilities[0].linked_cause_record_ids, ['CAU-01']);

  assert.equal(v02.relations.length, 1);
  assert.equal(v02.relations[0].field_code, 'D08.F049');
  assert.equal(v02.relations[0].object_id, 'R01');
  assert.equal(v02.relations[0].relation_type, '撞击路侧固定设施');
});

test('collectCaseWorkItems, filterWorkItems, and computeEntityProgressMap classify pending vs finished records accurately', () => {
  const case06 = structuredClone(SEED_CASES[1]);
  const allItems = collectCaseWorkItems(case06);

  assert.ok(allItems.length > 0);
  const pendingItems = filterWorkItems(allItems, { status: 'pending_action' });
  const disputedItems = filterWorkItems(allItems, { status: 'disputed' });
  const draftItems = filterWorkItems(allItems, { status: 'draft' });
  const blockingItems = filterWorkItems(allItems, { status: 'blocking_or_error' });

  assert.ok(pendingItems.length >= disputedItems.length);
  assert.ok(pendingItems.length >= draftItems.length);
  assert.ok(pendingItems.every((i) => i.needsAttention));
  assert.ok(disputedItems.every((i) => i.reviewStatus === 'disputed'));
  assert.ok(blockingItems.every((i) => i.hasBlockingOrError));

  // Filter by entity and text query
  const p01Disputed = filterWorkItems(allItems, {
    status: 'disputed',
    entityId: 'P01',
  });
  assert.ok(p01Disputed.every((i) => i.entityId === 'P01' && i.reviewStatus === 'disputed'));

  // Entity progress summary tracks unstarted fields and pending items
  const progressMap = computeEntityProgressMap(case06);
  assert.ok(progressMap['ACC']);
  assert.equal(
    progressMap['ACC'].pendingCount,
    allItems.filter((i) => i.entityId === 'ACC' && i.needsAttention).length,
  );
  assert.equal(matchesFieldRecordBucket(undefined, 'unstarted'), true);
  assert.equal(matchesFieldRecordBucket(undefined, 'draft'), false);
  assert.equal(matchesFieldRecordBucket(case06.fieldRecords[0], 'unstarted'), false);
});

test('case-wide readiness counts match the sum of per-entity workbench and progress counts', () => {
  for (const seed of SEED_CASES) {
    const readiness = computeCaseReadiness(seed);
    const progressMap = computeEntityProgressMap(seed);

    let sumDraft = 0;
    let sumDisputed = 0;
    let sumChecked = 0;
    let sumSpecialist = 0;

    for (const ent of seed.entities) {
      const stats = computeEntityWorkbenchStats(seed, ent.id);
      const prog = progressMap[ent.id];
      assert.equal(stats.draft, prog.draftCount);
      assert.equal(stats.disputed, prog.disputedCount);
      assert.equal(stats.checked, prog.checkedCount);
      assert.equal(stats.specialist_review, prog.specialistCount);
      assert.equal(stats.unstarted, prog.applicableUnstartedCount);
      assert.equal(stats.all, prog.totalItems + prog.applicableUnstartedCount);

      sumDraft += stats.draft;
      sumDisputed += stats.disputed;
      sumChecked += stats.checked;
      sumSpecialist += stats.specialist_review;
    }

    assert.equal(sumDraft, readiness.statusCounts.draft);
    assert.equal(sumDisputed, readiness.statusCounts.disputed);
    assert.equal(sumChecked, readiness.statusCounts.checked);
    assert.equal(sumSpecialist, readiness.statusCounts.specialist_review);
  }
});

test('sortLegalConclusionsByChain orders violation -> cause -> liability stably', () => {
  const mk = (id: string, category: LegalConclusionItem['category']): LegalConclusionItem => ({
    id,
    category,
    subjectId: 'P01',
    eventId: 'E01',
    presenceStatus: 'present',
    rawText: id,
    lawArticle: '',
    conclusionLabel: id,
    evidences: [{ id: `ev-${id}`, page: 1, quote: id }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  });
  const sorted = sortLegalConclusionsByChain([
    mk('LIA-1', 'liability'),
    mk('CAU-1', 'cause'),
    mk('VIO-1', 'violation'),
    mk('CAU-2', 'cause'),
    mk('VIO-2', 'violation'),
  ]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ['VIO-1', 'VIO-2', 'CAU-1', 'CAU-2', 'LIA-1'],
  );
});

test('validateLegalConclusion warns when explicit_linked cause lacks violations or liable party lacks causes', () => {
  const unlinkedCause: LegalConclusionItem = {
    id: 'CAU-X',
    category: 'cause',
    subjectId: 'P01',
    eventId: 'E01',
    presenceStatus: 'present',
    rawText: '全部原因',
    lawArticle: '',
    conclusionLabel: '全部原因',
    causalLinkStatus: 'explicit_linked',
    linkedViolationIds: [],
    evidences: [{ id: 'ev1', page: 1, quote: '全部原因' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };
  assert.equal(
    validateLegalConclusion(unlinkedCause).some(
      (i) => i.code === 'MISSING_LINKED_VIOLATION' && i.severity === 'warning',
    ),
    true,
  );

  const unlinkedLiable: LegalConclusionItem = {
    id: 'LIA-X',
    category: 'liability',
    subjectId: 'P01',
    eventId: 'E01',
    presenceStatus: 'present',
    rawText: '全部责任',
    lawArticle: '',
    conclusionLabel: '全部责任',
    linkedCauseIds: [],
    evidences: [{ id: 'ev2', page: 1, quote: '全部责任' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };
  assert.equal(
    validateLegalConclusion(unlinkedLiable).some(
      (i) => i.code === 'MISSING_LINKED_CAUSE' && i.severity === 'warning',
    ),
    true,
  );

  const noFault: LegalConclusionItem = {
    ...unlinkedLiable,
    id: 'LIA-NO-FAULT',
    conclusionLabel: '无责任',
    rawText: '无责任',
  };
  assert.equal(
    validateLegalConclusion(noFault).some((i) => i.code === 'MISSING_LINKED_CAUSE'),
    false,
  );
});

test('all seed cases maintain grounded VIO -> CAU -> LIA chains without missing link warnings', () => {
  for (const seed of SEED_CASES) {
    const vioIds = new Set(
      seed.legalConclusions.filter((l) => l.category === 'violation').map((l) => l.id),
    );
    const cauIds = new Set(
      seed.legalConclusions.filter((l) => l.category === 'cause').map((l) => l.id),
    );
    assert.ok(vioIds.size > 0, `${seed.caseId} should include violation records`);
    assert.ok(cauIds.size > 0, `${seed.caseId} should include cause records`);

    for (const item of seed.legalConclusions) {
      const issues = validateLegalConclusion(item);
      assert.equal(
        issues.length,
        0,
        `${seed.caseId} ${item.id} unexpected issues: ${issues.map((i) => i.code).join(',')}`,
      );
      for (const vid of item.linkedViolationIds || []) {
        assert.ok(vioIds.has(vid), `${seed.caseId} ${item.id} references missing ${vid}`);
      }
      for (const cid of item.linkedCauseIds || []) {
        assert.ok(cauIds.has(cid), `${seed.caseId} ${item.id} references missing ${cid}`);
      }
    }
  }
});

test('normalizePdfTextForDisplay and splitPdfPageIntoParagraphs clean CJK justified spacing and preserve logical sections', () => {
  const rawPage = [
    '道路交通事故认定书',
    '一、基本情况',
    '张晓峰 驾驶 机 动 车行 经 人行横道 未 减速 礼让 行人 李桂英。',
    '【事故原因分析】 张晓峰负全部原因。',
    '二、责任认定',
    '认定当事人张晓峰承担本起道路交通事故的全部责任，李桂英无责任。',
  ].join('\n');

  assert.equal(
    normalizePdfTextForDisplay('张晓峰驾驶机 动 车行 经 人行横道'),
    '张晓峰驾驶机动车行经人行横道',
  );

  const paragraphs = splitPdfPageIntoParagraphs(rawPage);
  assert.ok(paragraphs.length >= 4);
  assert.ok(paragraphs.some((p) => p.includes('张晓峰驾驶机动车行经人行横道未减速礼让行人李桂英')));
  assert.ok(paragraphs.some((p) => p.includes('认定当事人张晓峰承担本起道路交通事故的全部责任')));
});

test('findTextMatchRanges matches CJK spaced quotes and ellipsis segments accurately', () => {
  const display = '张晓峰驾驶机动车行经人行横道未减速礼让行人，依据《中华人民共和国道路交通安全法》第四十七条第一款承担全部责任。';
  const ranges = findTextMatchRanges(display, [
    '张晓峰驾驶机 动 车行 经 人行横道...第四十七条第一款',
  ]);
  assert.equal(ranges.length, 2);
  assert.equal(display.slice(ranges[0].start, ranges[0].end), '张晓峰驾驶机动车行经人行横道');
  assert.equal(display.slice(ranges[1].start, ranges[1].end), '第四十七条第一款');
});

test('traceLegalEvidenceChain traces VIO <-> CAU <-> LIA links, subjects, party records, and consistency checks', () => {
  const case06 = SEED_CASES[1];
  const vio06 = case06.legalConclusions.find((l) => l.category === 'violation');
  assert.ok(vio06);

  const chainFromVio = traceLegalEvidenceChain(case06, vio06.id);
  assert.ok(chainFromVio);
  assert.equal(chainFromVio.violations.length, 1);
  assert.ok(chainFromVio.causes.length >= 1);
  assert.ok(chainFromVio.liabilities.length >= 1);
  assert.ok(chainFromVio.subjectIds.includes(vio06.subjectId));
  assert.ok(chainFromVio.partyFieldRecords.every((r) => chainFromVio.subjectIds.includes(r.entityId)));
  assert.ok(chainFromVio.evidences.length >= 3);
  assert.equal(
    chainFromVio.consistencyChecks.some((c) => c.code === 'CHAIN_COMPLETE_AND_CONSISTENT'),
    true,
  );

  // Explicit no-fault liability in CASE-06 should pass without cause warning
  const noFaultLia = case06.legalConclusions.find(
    (l) => l.category === 'liability' && l.conclusionLabel === '无责任',
  );
  if (noFaultLia) {
    const noFaultChain = traceLegalEvidenceChain(case06, noFaultLia.id);
    assert.ok(noFaultChain);
    assert.equal(
      noFaultChain.consistencyChecks.some((c) => c.code === 'NO_FAULT_LIABILITY_EXEMPT'),
      true,
    );
  }

  // Missing link / missing evidence detection
  const brokenCase = structuredClone(case06);
  const targetLia = brokenCase.legalConclusions.find(
    (l) => l.category === 'liability' && l.conclusionLabel !== '无责任',
  );
  assert.ok(targetLia);
  targetLia.linkedCauseIds = [];
  targetLia.evidences = [];
  const brokenChain = traceLegalEvidenceChain(brokenCase, targetLia.id);
  assert.ok(brokenChain);
  assert.equal(
    brokenChain.consistencyChecks.some(
      (c) => c.code === 'LIABILITY_MISSING_CAUSE_LINK' && c.severity === 'warning',
    ),
    true,
  );
  assert.equal(
    brokenChain.consistencyChecks.some(
      (c) => c.code === 'CHAIN_NODE_MISSING_EVIDENCE' && c.severity === 'error',
    ),
    true,
  );
});

test('extractPdfParagraphMatches links chain evidences to matching extracted PDF paragraphs', () => {
  const case06 = SEED_CASES[1];
  const vio06 = case06.legalConclusions.find((l) => l.category === 'violation');
  assert.ok(vio06);
  const chain = traceLegalEvidenceChain(case06, vio06.id);
  assert.ok(chain);

  const firstEv = chain.evidences[0];
  assert.ok(firstEv);
  const pageTexts: Record<number, string> = {
    [firstEv.page]: `一、事故基本事实\n无关背景描述段落。\n${firstEv.quote.split('').join(' ')}`,
  };
  const matches = extractPdfParagraphMatches(pageTexts, chain.evidences);
  const hitParagraphs = matches.filter((m) => m.matchedEvidences.length > 0);
  assert.equal(hitParagraphs.length, 1);
  assert.equal(hitParagraphs[0].page, firstEv.page);
});

test('scanViolationLinkMatches scans D10.F058 controlled vocab, supplements, and case entities and blocks until confirmed', () => {
  const case06 = structuredClone(SEED_CASES[1]);
  const newVio: LegalConclusionItem = {
    id: 'VIO-NEW-1',
    category: 'violation',
    subjectId: 'P01',
    eventId: '',
    presenceStatus: 'present',
    rawText: '张晓峰驾驶赣A5M821行经人行横道未减速行驶且未停车让行',
    lawArticle: '',
    conclusionLabel: '',
    causalLinkStatus: 'unspecified',
    linkedViolationIds: [],
    linkedEntityIds: [],
    linkedVocabTerms: [],
    linkConsistencyConfirmed: false,
    evidences: [{ id: 'EV-NEW-1', page: 1, quote: '行经人行横道未减速行驶且未停车让行' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };

  const scan = scanViolationLinkMatches(
    newVio,
    case06.entities,
    INITIAL_VOCABULARY_SUPPLEMENTS,
  );
  assert.equal(scan.hasAnyMatch, true);
  assert.equal(scan.needsConfirmationError, true);
  assert.ok(
    scan.vocabMatches.some(
      (m) => m.fieldCode === 'D10.F058' && m.standardTerm === '行经人行横道未停车让行',
    ),
  );
  assert.ok(
    scan.vocabMatches.some(
      (m) => m.fieldCode === 'D05.F027' && m.standardTerm === '未减速行驶',
    ),
  );
  assert.ok(
    scan.vocabMatches.some(
      (m) => m.fieldCode === 'D05.F075' && m.standardTerm === '人行横道',
    ),
  );
  assert.ok(scan.entityMatches.some((e) => e.entityId === 'P01' && e.isCurrentSubject));
  assert.ok(scan.entityMatches.some((e) => e.entityId === 'V01'));
  assert.ok(scan.entityMatches.some((e) => e.entityId === 'R01'));
  assert.equal(scan.entityMatches.some((e) => e.entityId === 'ACC'), false);

  // Validation must return red error before confirmation
  const unconfirmedIssues = validateLegalConclusion(newVio, {
    entities: case06.entities,
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
  });
  assert.equal(
    unconfirmedIssues.some(
      (i) => i.code === 'VIOLATION_LINK_CONSISTENCY_UNCONFIRMED' && i.severity === 'error',
    ),
    true,
  );

  // Readiness and entity workbench stats must count the blocking error
  const baselineStats = computeEntityWorkbenchStats(case06, 'P01', INITIAL_VOCABULARY_SUPPLEMENTS);
  const withNewVio = structuredClone(case06);
  withNewVio.legalConclusions.push(newVio);
  const newStats = computeEntityWorkbenchStats(withNewVio, 'P01', INITIAL_VOCABULARY_SUPPLEMENTS);
  assert.equal(newStats.blocking_or_error, baselineStats.blocking_or_error + 1);

  // One-click apply all populates standard conclusion and entity/vocab links, but keeps error until confirmed
  const linked = applyAllViolationLinks(newVio, scan);
  assert.equal(linked.conclusionLabel, '行经人行横道未停车让行');
  assert.ok((linked.linkedEntityIds || []).includes('V01'));
  assert.ok((linked.linkedEntityIds || []).includes('R01'));
  assert.equal(linked.linkConsistencyConfirmed, false);
  const stillUnconfirmed = validateLegalConclusion(linked, {
    entities: case06.entities,
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
  });
  assert.equal(
    stillUnconfirmed.some((i) => i.code === 'VIOLATION_LINK_CONSISTENCY_UNCONFIRMED'),
    true,
  );

  // Confirming clears the red error and drops blocking_or_error count back to baseline
  const confirmed = confirmViolationLinkConsistency(linked);
  const afterConfirmIssues = validateLegalConclusion(confirmed, {
    entities: case06.entities,
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
  });
  assert.equal(
    afterConfirmIssues.some((i) => i.code === 'VIOLATION_LINK_CONSISTENCY_UNCONFIRMED'),
    false,
  );
  const withConfirmedVio = structuredClone(case06);
  withConfirmedVio.legalConclusions.push(confirmed);
  const confirmedStats = computeEntityWorkbenchStats(
    withConfirmedVio,
    'P01',
    INITIAL_VOCABULARY_SUPPLEMENTS,
  );
  assert.equal(confirmedStats.blocking_or_error, baselineStats.blocking_or_error);

  // Editing rawText after confirmation invalidates fingerprint & re-triggers consistency error
  const editedAfterConfirm: LegalConclusionItem = {
    ...confirmed,
    rawText: `${confirmed.rawText}（补充超速行驶描述）`,
  };
  const retriggered = validateLegalConclusion(editedAfterConfirm, {
    entities: case06.entities,
    supplements: INITIAL_VOCABULARY_SUPPLEMENTS,
  });
  assert.equal(
    retriggered.some((i) => i.code === 'VIOLATION_LINK_CONSISTENCY_UNCONFIRMED'),
    true,
  );
});

test('applyViolationVocabLink and applyViolationEntityLink update fields deterministically without premature confirmation', () => {
  const case06 = structuredClone(SEED_CASES[1]);
  const baseVio: LegalConclusionItem = {
    id: 'VIO-SINGLE-1',
    category: 'violation',
    subjectId: 'P02',
    eventId: '',
    presenceStatus: 'present',
    rawText: '张晓峰在第一阶段行经人行横道未减速行驶',
    lawArticle: '',
    conclusionLabel: '',
    evidences: [{ id: 'EV-S1', page: 1, quote: '行经人行横道未减速行驶' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };

  const scan = scanViolationLinkMatches(
    baseVio,
    case06.entities,
    INITIAL_VOCABULARY_SUPPLEMENTS,
  );
  const primaryMatch = scan.vocabMatches.find((m) => m.isPrimaryStandard);
  assert.ok(primaryMatch);
  const afterVocab = applyViolationVocabLink(baseVio, primaryMatch);
  assert.equal(afterVocab.conclusionLabel, '行经人行横道未停车让行');
  assert.ok((afterVocab.linkedVocabTerms || []).includes(primaryMatch.vocabKey));
  assert.equal(afterVocab.linkConsistencyConfirmed, false);

  const p01Match = scan.entityMatches.find((e) => e.entityId === 'P01');
  assert.ok(p01Match);
  const afterSubject = applyViolationEntityLink(afterVocab, p01Match, 'subject');
  assert.equal(afterSubject.subjectId, 'P01');
  assert.equal(afterSubject.linkConsistencyConfirmed, false);

  const e01Match = scan.entityMatches.find((e) => e.entityKind === 'E');
  if (e01Match) {
    const afterEvent = applyViolationEntityLink(afterSubject, e01Match, 'event');
    assert.equal(afterEvent.eventId, e01Match.entityId);
  }
});

test('buildControlledVocabOptions merges platform presets and supplements without duplicates', () => {
  const zmtjDef = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D07.F044');
  assert.ok(zmtjDef);
  const zmtjOpts = buildControlledVocabOptions(zmtjDef);
  assert.equal(zmtjOpts.length, zmtjDef.presetOptions.length);
  assert.ok(zmtjOpts.every((o) => o.source === 'preset' && o.codeTable === 'zmtj'));

  const surfaceDef = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D07.F042');
  const surfaceSupp = INITIAL_VOCABULARY_SUPPLEMENTS.find((s) => s.fieldCode === 'D07.F042');
  assert.ok(surfaceDef && surfaceSupp);
  const surfaceOpts = buildControlledVocabOptions(surfaceDef, surfaceSupp);
  assert.equal(surfaceOpts.length, surfaceSupp.candidateOptions.length);
  assert.ok(surfaceOpts.every((o) => o.source === 'supplement' && o.standardCode === 'SURFACE_COND'));

  // Deduplicate overlapping value
  const mergedOpts = buildControlledVocabOptions(
    { presetOptions: ['阴', '晴'], existingCodeTable: 'tq' },
    { candidateOptions: ['晴', '浓雾（团雾）'], standardCode: 'WEATHER', synonyms: '雾天' },
  );
  assert.deepEqual(
    mergedOpts.map((o) => [o.value, o.source]),
    [
      ['阴', 'preset'],
      ['晴', 'both'],
      ['浓雾（团雾）', 'supplement'],
    ],
  );
});

test('filterControlledVocabOptions ranks exact, prefix, substring, and synonym matches cleanly', () => {
  const zmtjDef = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D07.F044')!;
  const zmtjOpts = buildControlledVocabOptions(zmtjDef);

  assert.equal(filterControlledVocabOptions(zmtjOpts, '').length, zmtjOpts.length);
  const nightMatches = filterControlledVocabOptions(zmtjOpts, '夜间');
  assert.deepEqual(
    nightMatches.map((m) => m.value),
    ['夜间无照明视线偏暗', '夜间有路灯照明'],
  );

  // Synonym match on D07.F042
  const surfaceDef = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D07.F042')!;
  const surfaceSupp = INITIAL_VOCABULARY_SUPPLEMENTS.find((s) => s.fieldCode === 'D07.F042')!;
  const surfaceOpts = buildControlledVocabOptions(surfaceDef, surfaceSupp);
  const synonymHits = filterControlledVocabOptions(surfaceOpts, '沥青路面干燥平整');
  assert.ok(synonymHits.length > 0);
  assert.equal(synonymHits[0].value, '干燥（沥青路面）');

  // Ranking order: exact > prefix > substring
  const custom = buildControlledVocabOptions({
    presetOptions: ['机动车道违停', '机动车', '非机动车道'],
    existingCodeTable: '',
  });
  const ranked = filterControlledVocabOptions(custom, '机动车');
  assert.deepEqual(
    ranked.map((r) => r.value),
    ['机动车', '机动车道违停', '非机动车道'],
  );
});

test('stepVocabHighlightIndex wraps cleanly on next/prev arrow navigation', () => {
  assert.equal(stepVocabHighlightIndex(-1, 0, 'next'), -1);
  assert.equal(stepVocabHighlightIndex(-1, 3, 'next'), 0);
  assert.equal(stepVocabHighlightIndex(0, 3, 'next'), 1);
  assert.equal(stepVocabHighlightIndex(2, 3, 'next'), 0);
  assert.equal(stepVocabHighlightIndex(0, 3, 'prev'), 2);
  assert.equal(stepVocabHighlightIndex(2, 3, 'prev'), 1);
  assert.equal(stepVocabHighlightIndex(-1, 3, 'prev'), 2);
});

test('scanViolationLinkMatches rejects negated/opposite substrings and matches real-world D10.F058 wfxw violations accurately', () => {
  const entities = [
    { id: 'ACC', kind: 'ACC' as const, label: '测试事故' },
    { id: 'P01', kind: 'P' as const, label: '王某', roleLabel: '机动车驾驶人' },
    { id: 'P02', kind: 'P' as const, label: '李某', roleLabel: '行人' },
    { id: 'V01', kind: 'V' as const, label: '京A12345', subtitle: '小型轿车' },
  ];

  // Case 1: Driver on 非机动车道, 逆向行驶, 未按照操作规范安全驾驶, 经鉴定未超速, 未开启危险报警闪光灯
  const vioReal: LegalConclusionItem = {
    id: 'VIO-AI-72',
    category: 'violation',
    subjectId: 'P01',
    eventId: '',
    presenceStatus: 'present',
    rawText:
      '王某驾驶机动车占用非机动车道逆向行驶，未按照操作规范安全驾驶、文明驾驶，未按规定开启危险报警闪光灯，经鉴定未超速行驶。',
    lawArticle: '《中华人民共和国道路交通安全法》第二十二条第一款、第三十五条、第三十七条',
    conclusionLabel: '',
    evidences: [{ id: 'EV-72', page: 1, quote: '王某驾驶机动车占用非机动车道逆向行驶' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };

  const scanReal = scanViolationLinkMatches(vioReal, entities, INITIAL_VOCABULARY_SUPPLEMENTS);
  const terms = scanReal.vocabMatches.map((m) => `${m.fieldCode}:${m.standardTerm}`);

  // Must match actual D10.F058 violations
  assert.ok(terms.includes('D10.F058:未按操作规范安全驾驶'));
  assert.ok(terms.includes('D10.F058:逆向行驶'));
  assert.ok(terms.includes('D10.F058:不按规定车道行驶'));
  assert.ok(terms.includes('D10.F058:故障停车未按规定设警示/开警示灯'));
  assert.ok(terms.includes('D05.F075:非机动车道'));

  // Primary D10.F058 matches must be sorted before auxiliary vocab matches
  assert.equal(scanReal.vocabMatches[0].isPrimaryStandard, true);

  // Must NOT falsely match opposite/negated/cross-domain items
  assert.equal(terms.includes('D05.F075:机动车道'), false);
  assert.equal(terms.includes('D10.F058:超速行驶'), false);
  assert.equal(terms.includes('D05.F027:超速行驶'), false);
  assert.equal(terms.includes('D05.F074:超速运行'), false);
  assert.equal(terms.includes('D05.F074:开启危险报警闪光灯'), false);
  assert.equal(terms.includes('D05.F029:逆行'), false);
  assert.equal(terms.includes('D03.F015:行人'), false);

  // Case 2: Turning driver failing to yield to straight vehicle / traffic signal / statutory phrasing
  const vioYield: LegalConclusionItem = {
    id: 'VIO-AI-73',
    category: 'violation',
    subjectId: 'P01',
    eventId: '',
    presenceStatus: 'present',
    rawText: '王某驾驶机动车违反交通信号灯通行，转弯的机动车未让直行的车辆先行，影响其他车辆正常行驶。',
    lawArticle: '《中华人民共和国道路交通安全法》第三十八条',
    conclusionLabel: '',
    evidences: [{ id: 'EV-73', page: 1, quote: '违反交通信号灯通行' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };
  const scanYield = scanViolationLinkMatches(vioYield, entities, INITIAL_VOCABULARY_SUPPLEMENTS);
  const yieldTerms = scanYield.vocabMatches.map((m) => `${m.fieldCode}:${m.standardTerm}`);
  assert.ok(yieldTerms.includes('D10.F058:违反交通信号灯通行'));
  assert.ok(yieldTerms.includes('D10.F058:未按规定让行'));
  assert.equal(yieldTerms.includes('D05.F027:直行'), false);
  assert.equal(yieldTerms.includes('D05.F074:正常行驶'), false);

  // Case 3: Highway 未减速行驶 without crosswalk must NOT trigger 行经人行横道未停车让行, and combined text mentioning other party 无违法行为 must NOT add 无违法行为 to violator
  const vioHighway: LegalConclusionItem = {
    id: 'VIO-AI-74',
    category: 'violation',
    subjectId: 'P01',
    eventId: '',
    presenceStatus: 'present',
    rawText: '王某在高速公路未减速行驶且未与前车保持足以采取紧急制动措施的安全距离追尾前车；前车驾驶人无违法行为。',
    lawArticle: '《中华人民共和国道路交通安全法》第四十三条',
    conclusionLabel: '',
    evidences: [{ id: 'EV-74', page: 1, quote: '未与前车保持足以采取紧急制动措施的安全距离' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };
  const scanHighway = scanViolationLinkMatches(
    vioHighway,
    entities,
    INITIAL_VOCABULARY_SUPPLEMENTS,
  );
  const highwayTerms = scanHighway.vocabMatches.map((m) => `${m.fieldCode}:${m.standardTerm}`);
  assert.ok(highwayTerms.includes('D10.F058:未保持安全车距'));
  assert.equal(highwayTerms.includes('D10.F058:行经人行横道未停车让行'), false);
  assert.equal(highwayTerms.includes('D10.F058:无违法行为'), false);
});

test('getScopedViolationCandidatesForCause and getScopedCauseCandidatesForLiability isolate same-subject items and preserve multiple violations for one party', () => {
  const mkLegal = (
    id: string,
    category: 'violation' | 'cause' | 'liability',
    subjectId: string,
    extra: Partial<LegalConclusionItem> = {},
  ): LegalConclusionItem => ({
    id,
    category,
    subjectId,
    eventId: 'E01',
    presenceStatus: 'present',
    rawText: `${id} 原文`,
    lawArticle: '',
    conclusionLabel: '',
    evidences: [{ id: `EV-${id}`, page: 1, quote: `${id} 摘录` }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
    ...extra,
  });

  const violations = [
    mkLegal('VIO-01', 'violation', 'P01', { conclusionLabel: '超速行驶' }),
    mkLegal('VIO-02', 'violation', 'P01', { conclusionLabel: '未按规定让行' }),
    mkLegal('VIO-03', 'violation', 'P02', { conclusionLabel: '逆向行驶' }),
    mkLegal('VIO-04', 'violation', 'P03', { conclusionLabel: '违法停车' }),
  ];

  // P01 cause must see BOTH of P01's violations, and NOT P02/P03 in primaryItems
  const causeP01 = mkLegal('CAU-01', 'cause', 'P01', { linkedViolationIds: ['VIO-01'] });
  const scopedVios = getScopedViolationCandidatesForCause(causeP01, violations);
  assert.deepEqual(
    scopedVios.primaryItems.map((v) => v.id),
    ['VIO-01', 'VIO-02'],
  );
  assert.deepEqual(
    scopedVios.otherItems.map((v) => v.id),
    ['VIO-03', 'VIO-04'],
  );

  // If a cause explicitly linked a cross-subject violation previously, preserve it in primaryItems
  const mixedCause = mkLegal('CAU-MIX', 'cause', 'P01', { linkedViolationIds: ['VIO-03'] });
  const scopedMixed = getScopedViolationCandidatesForCause(mixedCause, violations);
  assert.deepEqual(
    scopedMixed.primaryItems.map((v) => v.id),
    ['VIO-01', 'VIO-02', 'VIO-03'],
  );
  assert.deepEqual(
    scopedMixed.otherItems.map((v) => v.id),
    ['VIO-04'],
  );

  const causes = [
    mkLegal('CAU-01', 'cause', 'P01', { conclusionLabel: '主要原因' }),
    mkLegal('CAU-02', 'cause', 'P02', { conclusionLabel: '次要原因' }),
    mkLegal('CAU-03', 'cause', 'P03', { conclusionLabel: '无因果关系' }),
  ];
  const liaP01 = mkLegal('LIA-01', 'liability', 'P01', {
    conclusionLabel: '主要责任',
    linkedCauseIds: ['CAU-01'],
  });
  const scopedCauses = getScopedCauseCandidatesForLiability(liaP01, causes);
  assert.deepEqual(
    scopedCauses.primaryItems.map((c) => c.id),
    ['CAU-01'],
  );
  assert.deepEqual(
    scopedCauses.otherItems.map((c) => c.id),
    ['CAU-02', 'CAU-03'],
  );
});

test('single liability per subject helpers pick un-liabled subjects and flag duplicate subject liabilities', () => {
  const subjects = [
    { id: 'P01' },
    { id: 'P02' },
    { id: 'P03' },
  ];
  const lia1: LegalConclusionItem = {
    id: 'LIA-01',
    category: 'liability',
    subjectId: 'P01',
    eventId: '',
    presenceStatus: 'present',
    rawText: 'P01 负全部责任',
    lawArticle: '',
    conclusionLabel: '全部责任',
    linkedCauseIds: [],
    evidences: [{ id: 'EV-1', page: 1, quote: 'P01 负全部责任' }],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
  };

  assert.equal(getSubjectLiabilityRecords([lia1], 'P01').length, 1);
  assert.equal(getSubjectLiabilityRecords([lia1], 'P02').length, 0);
  assert.equal(pickDefaultLiabilitySubjectId(subjects, [lia1], 'P01'), 'P02');
  assert.equal(pickDefaultLiabilitySubjectId(subjects, [lia1], 'P03'), 'P03');

  const allThree: LegalConclusionItem[] = [
    lia1,
    { ...lia1, id: 'LIA-02', subjectId: 'P02' },
    { ...lia1, id: 'LIA-03', subjectId: 'P03' },
  ];
  assert.equal(pickDefaultLiabilitySubjectId(subjects, allThree), null);

  // Duplicate P01 liability triggers DUPLICATE_SUBJECT_LIABILITY error
  const dup = { ...lia1, id: 'LIA-DUP', subjectId: 'P01' };
  const dupIssues = validateLegalConclusion(dup, {
    allLegalConclusions: [lia1, dup],
  });
  assert.equal(
    dupIssues.some((i) => i.code === 'DUPLICATE_SUBJECT_LIABILITY' && i.severity === 'error'),
    true,
  );
});







