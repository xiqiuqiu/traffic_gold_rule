import assert from 'node:assert/strict';
import test from 'node:test';
import { SEED_CASES } from '../data/seedCases';
import type { LegalConclusionItem, LiabilitySourceLine } from '../types/gold';
import { getVerifiedLiabilitySource } from '../utils/liabilitySourceKey';
import { resolveLiabilitySource } from './liabilityEvidence';

const fileSha256 = 'sha256:' + 'a'.repeat(64);
const extractionVersion = 'test-version';
const mixed = SEED_CASES.find(doc => doc.caseId === 'CASE-08')!;
const staged = SEED_CASES.find(doc => doc.caseId === 'CASE-13')!;
const linesFor = (texts: string[], first: number): LiabilitySourceLine[] =>
  texts.map((text, i) => ({
    text, page: 2, lineNumber: first + i, lineId: '100:' + (first + i),
    bbox: [0.09, 0.04 * i, 0.91, 0.04 * i + 0.02],
  }));
const wrapped = linesFor([
  '门不得妨碍其他车辆和行人通行”）之规定，认定当事人周伟杰承担本起道路交通事故的全部责任；当事人王小',
  '明无责任。',
], 2);
const stageLines = [
  ...linesFor(['之规定，赵勇强承担第一阶段碰撞', '事故的全部责任。'], 4),
  ...linesFor(['之规定，吴建华承担第二阶段追尾', '碰撞事故的全部责任。'], 8),
  ...linesFor(['之规定，郑国平承担第三阶段追尾', '碰撞事故的全部责任。'], 12),
  ...linesFor(['之规定，孙丽敏无责任。'], 15),
];
const liab = (id: string) => [...mixed.legalConclusions, ...staged.legalConclusions].find(item => item.id === id)!;
const resolve = (record: LegalConclusionItem, lines: LiabilitySourceLine[], entities = staged.entities) =>
  resolveLiabilitySource(record, entities, { fileSha256, extractionVersion, lines });
function numbers(record: LegalConclusionItem, lines = stageLines, entities = staged.entities) {
  const source = resolve(record, lines, entities);
  assert.equal(source.status, 'verified');
  return source.lines.map(line => line.lineNumber);
}
const withQuote = (record: LegalConclusionItem, quote: string, lineIds?: string[]): LegalConclusionItem => ({
  ...record, evidences: [{ id: 'quote', page: 2, quote, lineIds }],
});

test('跨行姓名与同页前一主体分别定位到必要行', () => {
  assert.deepEqual(numbers(liab('LIA-08-1'), wrapped, mixed.entities), [2]);
  assert.deepEqual(numbers(liab('LIA-08-2'), wrapped, mixed.entities), [2, 3]);
  const item = withQuote(liab('LIA-08-2'), '王小明无责任。', ['100:2', '100:3']);
  const source = resolve(item, wrapped, mixed.entities);
  assert.equal(source.status, 'verified');
  assert.equal(source.quote, '王小明无责任。');
});

test('同等级的多阶段责任回到相应主体的连续原文，跨行短引文可补全', () => {
  assert.deepEqual(numbers(liab('LIA-13-1')), [4, 5]);
  assert.deepEqual(numbers(liab('LIA-13-2')), [8, 9]);
  assert.deepEqual(numbers(liab('LIA-13-3')), [12, 13]);
  assert.deepEqual(numbers(withQuote(liab('LIA-13-2'), '碰撞事故的全部责任。')), [8, 9]);
  assert.deepEqual(numbers(withQuote(liab('LIA-13-2'), '碰撞事故的全部责任。', ['100:8', '100:9'])), [8, 9]);
  assert.deepEqual(numbers({ ...liab('LIA-13-4'), eventId: '' }), [15]);
  assert.equal(resolve(liab('LIA-13-4'), stageLines).status, 'needs_review');
});

test('错阶段、未知阶段、错主体、错等级、虚构原文和错误行号均待核对', () => {
  const item = liab('LIA-13-2');
  const bad = [
    { ...item, eventId: 'E03' }, { ...item, eventId: 'E99' }, { ...item, subjectId: 'P04' },
    { ...item, conclusionLabel: '次要责任' }, { ...item, presenceStatus: 'not_mentioned' as const },
    withQuote(item, '吴建华承担第二阶段道路事故全部责任。'),
    withQuote(item, '碰撞事故的全部责任。', ['100:13']),
    withQuote(item, '碰撞事故的全部责任。', ['999:2']),
    withQuote(item, '碰撞事故的全部责任。', []),
    withQuote(item, '吴建华承担第二阶段追尾碰撞事故的全部责任。', ['100:9', '100:8']),
  ];
  for (const record of bad) assert.equal(resolve(record, stageLines).status, 'needs_review');
});

test('同一主体两次承担全部责任，按阶段匹配，重复同一结论时要求明确引用', () => {
  const item = liab('LIA-13-2');
  const repeated = linesFor([
    '吴建华承担第三阶段追尾碰撞事故的全部责任。',
    '吴建华承担第二阶段追尾碰撞事故的全部责任。',
  ], 1);
  assert.deepEqual(numbers(withQuote(item, '全部责任'), repeated), [2]);
  repeated.push(...linesFor(['吴建华承担第二阶段追尾碰撞事故的全部责任。'], 3));
  assert.equal(resolve(withQuote(item, '全部责任'), repeated).status, 'needs_review');
  assert.deepEqual(numbers(withQuote(item, '全部责任', ['100:3']), repeated), [3]);
});

test('不将否定、其他主体或不连续页行拼成该人的责任', () => {
  const item = withQuote({ ...liab('LIA-08-1'), eventId: '' }, '全部责任');
  for (const sentence of [
    '周伟杰不承担本起事故的全部责任。', '周伟杰认为王小明承担全部责任。',
    '周伟杰无责任，王小明承担全部责任。', '是否周伟杰承担全部责任？',
    '建议周伟杰承担全部责任。', '周伟杰承担全部责任的说法证据不足。', '李周伟杰承担全部责任。',
  ]) assert.equal(resolve(item, linesFor([sentence], 1), mixed.entities).status, 'needs_review');
  const gap = wrapped.map((line, i) => i ? { ...line, lineNumber: line.lineNumber + 1 } : line);
  assert.equal(resolve(liab('LIA-08-2'), gap, mixed.entities).status, 'needs_review');
});

test('已有定位绑定当前原件与修订内容，编辑主体、阶段、引文、等级后即时失效', () => {
  const record = liab('LIA-13-2');
  const item = { ...record, sourceLocation: resolve(record, stageLines) };
  const doc = { ...staged, fileSha256 };
  assert.ok(getVerifiedLiabilitySource(item, doc));
  assert.equal(getVerifiedLiabilitySource(record, doc), null);
  for (const edited of [
    { ...item, rawText: '修订原文' }, { ...item, eventId: 'E01' }, { ...item, conclusionLabel: '无责任' },
    { ...item, subjectId: 'P04' }, withQuote(item, '别的引文'), { ...item, evidences: [{ ...item.evidences[0], page: 1 }] },
  ]) assert.equal(getVerifiedLiabilitySource(edited, doc), null);
  assert.equal(getVerifiedLiabilitySource(item, { ...doc, fileSha256: 'different' }), null);
  const renamed = doc.entities.map(e => e.id === item.subjectId ? { ...e, label: '重名' } : e);
  assert.equal(getVerifiedLiabilitySource(item, { ...doc, entities: renamed }), null);
  const source = item.sourceLocation;
  assert.equal(source.status, 'verified');
  const malformed = { ...source, lines: [{ ...source.lines[0], bbox: [-1, 0, 1, 1] as LiabilitySourceLine['bbox'] }] };
  assert.equal(getVerifiedLiabilitySource({ ...item, sourceLocation: malformed }, doc), null);
});


test('明确的单位责任与该单位驾驶员的责任分别核验', () => {
  const record = withQuote({ ...liab('LIA-08-1'), subjectId: 'O01', eventId: '' }, '全部责任');
  const entities = [...mixed.entities, { id: 'O01', kind: 'O' as const, label: '某运输公司' }];
  const lines = linesFor(['某运输公司驾驶人周伟杰承担全部责任；某运输公司负本起事故的全部责任。'], 1);
  const source = resolve(record, lines, entities);
  assert.equal(source.status, 'verified');
  assert.equal(source.quote, '某运输公司负本起事故的全部责任。');
});

test('五方事故逐字核对认定分句和共同无责，保留整组原文', () => {
  const law1 = '当事人1 SMITH JOHN DAVID 违反《道路交通安全法实施条例》第四十四条第二款（变道不得影响正常行驶车辆），负事故主要责任';
  const law5 = '当事人5黄世明违反《道路交通安全法》第四十二条第一款（超速及安全跟车距离），负事故次要责任';
  const group = '当事人2赵晓峰、当事人3 MOHAMMED ALI、当事人4周卫东均无责任。';
  const lines = linesFor([
    law1.slice(0, law1.indexOf('负事故')),
    '负事故主要责任；' + law5.slice(0, -2),
    '责任；' + group,
  ], 6);
  const names = ['SMITH JOHN DAVID', '赵晓峰', 'MOHAMMED ALI', '周卫东', '黄世明'];
  const people = names.map((label, i) => ({ id: 'P0' + (i + 1), kind: 'P' as const, label, subtitle: '当事人' + (i + 1) }));
  function record(n: number, rawText: string) {
    const conclusionLabel = ['主要责任', '无责任', '无责任', '无责任', '次要责任'][n - 1];
    return withQuote({ ...liab('LIA-08-1'), subjectId: people[n - 1].id, eventId: '', conclusionLabel, rawText }, rawText);
  }
  assert.deepEqual(numbers(record(1, law1), lines, people), [6, 7]);
  assert.deepEqual(numbers(record(5, law5), lines, people), [7, 8]);
  for (const n of [2, 3, 4]) {
    const source = resolve(record(n, group), lines, people);
    assert.equal(source.status, 'verified');
    assert.equal(source.quote, group);
    assert.deepEqual(source.lines.map(line => line.lineNumber), [8]);
  }
  assert.equal(resolve(withQuote(record(1, law1), '负事故主要责任'), lines, people).status, 'needs_review');
  assert.equal(resolve(withQuote(record(4, group), group.slice(group.indexOf('当事人3'))), lines, people).status, 'needs_review');
  const missingParty = people.filter(p => p.id !== 'P02');
  assert.equal(resolve(record(3, group), lines, missingParty).status, 'needs_review');
  const wrongLabels = people.map(p => p.id === 'P02' ? { ...p, subtitle: '当事人4' } : p);
  assert.equal(resolve(record(3, group), lines, wrongLabels).status, 'needs_review');
});

test('保留旧引文但人工原文对同一责任明确改判，重核须待核对', () => {
  const record = liab('LIA-08-2');
  assert.equal(resolve({ ...record, rawText: '王小明承担本起事故的全部责任。' }, wrapped, mixed.entities).status, 'needs_review');
  assert.equal(resolve({ ...liab('LIA-08-1'), rawText: '周伟杰不承担全部责任。' }, wrapped, mixed.entities).status, 'needs_review');
});

test('新增同名当事人或新增事故阶段时，重新校验原有绑定', () => {
  const record = liab('LIA-08-2');
  const item = { ...record, sourceLocation: resolve(record, wrapped, mixed.entities) };
  for (const entity of [
    { id: 'P99', kind: 'P' as const, label: '王小明' },
    { id: 'E03', kind: 'E' as const, label: '第三阶段' },
  ]) {
    const entities = [...mixed.entities, entity];
    assert.equal(getVerifiedLiabilitySource(item, { fileSha256, entities }), null);
    assert.equal(resolve(item, wrapped, entities).status, 'needs_review');
  }
});
