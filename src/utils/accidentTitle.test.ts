import assert from 'node:assert/strict';
import test from 'node:test';
import { SEED_CASES } from '../data/seedCases';
import type { CaseDocument } from '../types/gold';
import { accidentTitle } from './accidentTitle';

const draft: CaseDocument = {
  ...SEED_CASES[0], title: 'CASE-01 · 材料', sourceFilename: '材料.pdf',
  fieldRecords: ['D02.F006', 'D02.F008'].map((fieldCode, i) => ({
    ...SEED_CASES[0].fieldRecords[0], fieldCode, normalizedValues: [i ? '建设路口' : '2026-11-12 08:30'],
  })),
  entities: [
    { id: 'ACC', kind: 'ACC', label: '2026-11-12 建设路口多车事故' },
    { id: 'E01', kind: 'E', label: '第一阶段碰撞' },
    { id: 'E02', kind: 'E', label: '第二阶段追尾' },
  ],
};

test('时间和地点只出现一次，保留事故名称和不同阶段的事件', () => {
  assert.equal(accidentTitle(draft), '2026-11-12 08:30 · 建设路口 · 多车事故（第一阶段碰撞、第二阶段追尾）');
});

test('只有地点时使用地点，缺失或有争议的字段不用于拼接标题', () => {
  const partial: CaseDocument = { ...draft, entities: [], fieldRecords: draft.fieldRecords.map((row, i) =>
    i ? row : { ...row, reviewStatus: 'disputed' }) };
  assert.equal(accidentTitle(partial), '建设路口');
  assert.equal(accidentTitle({ ...partial, fieldRecords: [] }), '材料.pdf');
});
