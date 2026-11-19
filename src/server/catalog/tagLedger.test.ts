import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeAlias } from './codebook';
import { listObservations, promoteObservation, reviewObservation, type LedgerPaths } from './tagLedger';
import type { ObservationTask, TagResidue } from '../../types/catalog';

function residue(fieldCode: string, rawText: string, reason: TagResidue['reason'], subjects: string[]): TagResidue {
  return {
    fieldCode,
    textKey: rawText,
    rawText,
    reason,
    subjects,
    suggestedDmz: [],
    evidencePage: 1,
    evidenceQuote: rawText,
  };
}

function task(id: string, accidentKey: string, tagResidue: TagResidue[]): ObservationTask {
  return { id, accidentKey, tagResidue } as ObservationTask;
}

function library(): LedgerPaths & { dir: string; codeFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-ledger-'));
  const codeFile = path.join(dir, 'business_codes.v1.json');
  const bindingFile = path.join(dir, 'code_bindings.v1.json');
  const tagFile = path.join(dir, 'tag_library.v1.json');
  const reviewFile = path.join(dir, 'tag_reviews.json');
  fs.writeFileSync(
    codeFile,
    JSON.stringify({
      authorities: {
        tq: { codes: { '1': '晴', '2': '阴' } },
        cllx: { codes: { M11: '普通二轮摩托车', M22: '轻便三轮摩托车' } },
      },
    }),
  );
  fs.writeFileSync(
    bindingFile,
    JSON.stringify({
      bindings: {
        'D07.F041': { authority: 'tq' },
        'D04.F021': { authority: 'cllx' },
        'D06.F036': { authority: null, reason: '隔离防护无平台码表' },
      },
    }),
  );
  return { dir, codeFile, bindingFile, tagFile, reviewFile };
}

test('observations count distinct accident keys and keep the weight off the code table', () => {
  const paths = library();
  try {
    const tasks = [
      task('t1', 'SYN-SG-1', [residue('D04.F021', '老年代步车', 'unmapped_code', ['V01', 'V02'])]),
      task('t2', 'SYN-SG-1', [residue('D04.F021', '老年代步车', 'unmapped_code', ['P01'])]),
      task('t3', 'SYN-SG-2', [
        residue('D04.F021', '老年代步车', 'unmapped_code', ['V03']),
        residue('D04.F021', '老年代步车', 'unmapped_code', ['V04']),
      ]),
      task('t4', 'SYN-SG-3', [residue('D06.F036', '视线受路侧绿植遮挡', 'no_code_list', ['accident'])]),
    ];
    const before = fs.readFileSync(paths.codeFile);
    const listed = listObservations(tasks, {}, paths);
    const scooter = listed.rows.find((row) => row.textKey === '老年代步车');
    assert.equal(scooter?.accidentCount, 2);
    assert.equal(scooter?.status, 'pending');
    assert.equal(scooter?.weight, null);
    assert.equal(scooter?.disposition.kind, 'open');

    const confirmed = reviewObservation(
      tasks,
      { fieldCode: 'D04.F021', textKey: '老年代步车', status: 'confirmed' },
      { id: 'usr-admin', name: '合成审核' },
      paths,
    );
    assert.equal(confirmed.weight, 1);
    assert.throws(
      () =>
        reviewObservation(
          tasks,
          { fieldCode: 'D04.F021', textKey: '老年代步车', status: 'confirmed', weight: 0 },
          { id: 'usr-admin', name: '合成审核' },
          paths,
        ),
      /大于 0/,
    );
    reviewObservation(
      tasks,
      { fieldCode: 'D06.F036', textKey: '视线受路侧绿植遮挡', status: 'rejected', weight: 3 },
      { id: 'usr-admin', name: '合成审核' },
      paths,
    );
    const afterReview = listObservations(tasks, {}, paths);
    const rejected = afterReview.rows.find((row) => row.fieldCode === 'D06.F036');
    assert.equal(rejected?.status, 'rejected');
    assert.equal(rejected?.weight, null);
    assert.equal(afterReview.stats.termAccuracy, 0.5);
    assert.equal(afterReview.stats.weightedAccuracy, 2 / 3);
    assert.equal(fs.readFileSync(paths.codeFile).equals(before), true);
    assert.equal(fs.existsSync(paths.tagFile ?? ''), false);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('deleting an alias returns the observation to open without a stuck disposition', () => {
  const paths = library();
  try {
    const tasks = [task('t1', 'SYN-SG-1', [residue('D07.F041', '阴天', 'unmapped_code', ['accident'])])];
    reviewObservation(
      tasks,
      { fieldCode: 'D07.F041', textKey: '阴天', status: 'confirmed', weight: 1 },
      { id: 'usr-admin', name: '合成审核' },
      paths,
    );
    const codeBefore = fs.readFileSync(paths.codeFile);
    promoteObservation(
      tasks,
      { fieldCode: 'D07.F041', textKey: '阴天', target: { kind: 'alias', dmz: '2' } },
      paths,
    );
    assert.equal(listObservations(tasks, {}, paths).rows[0]?.disposition.kind, 'alias');
    removeAlias('tq', '阴天', paths.codeFile, paths.bindingFile, paths.tagFile);
    assert.equal(listObservations(tasks, {}, paths).rows[0]?.disposition.kind, 'open');
    assert.equal(fs.readFileSync(paths.codeFile).equals(codeBefore), true);
    const linked = promoteObservation(
      tasks,
      { fieldCode: 'D07.F041', textKey: '阴天', target: { kind: 'link_standard', dmz: '2' } },
      paths,
    );
    assert.equal(linked.disposition.kind, 'linked');
    assert.equal(fs.readFileSync(paths.codeFile).equals(codeBefore), true);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('本项目的案件按字段和参与方提取表外观察，保留宽泛分组供核查', async () => {
  const { observationReader } = await import('./workbench');
  const { seedPhraseClassifier } = await import('./codebook');
  const { SEED_CASES } = await import('../../data/seedCases');
  const base = SEED_CASES[0].fieldRecords[0];
  const read = observationReader(seedPhraseClassifier());
  const field = (fieldCode: string, rawValue: string) => ({
    ...base, fieldCode, rawValue, entityId: 'P01', presenceStatus: 'present' as const,
    evidences: [{ id: 'e1', page: 2, quote: '合成测试引文' }],
  });
  const rows = read({ fieldRecords: [
    field('D07.F041', '阴天'), field('D01.F001', 'TEST-0001'), field('D04.F021', '摩托车'),
    field('D03.F015', '测试角色'), { ...field('D03.F015', '无'), presenceStatus: 'not_mentioned' },
  ], legalConclusions: [] });
  assert.deepEqual(rows.map(row => [row.rawText, row.reason, row.evidencePage]), [
    ['摩托车', 'broad_group_match', 2], ['测试角色', 'no_code_list', 2],
  ]);
  assert.ok(rows[0].suggestedDmz.includes('M11'));
});
