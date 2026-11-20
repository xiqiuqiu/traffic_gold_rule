import assert from 'node:assert/strict';
import test from 'node:test';
import { SEED_CASES } from '../data/seedCases';
import { canonicalLegalItem, legalRows, matchLegalConclusion } from './legalCatalog';

const catalog = { 'D10.F059': [
  { code: '01', value: '同名', aliases: ['别名'] },
  { code: '02', value: '同名', aliases: [] },
  { code: 'x', value: '临时', aliases: [], extension: true },
] };
const item = { ...SEED_CASES[0].legalConclusions[0], category: 'cause' as const, conclusionLabel: '同名' };
test('同名多码与冲突代码待核对，唯一码或别名能定位，扩充词不作为标准结论', () => {
  const rows = legalRows(catalog, 'cause');
  assert.equal(matchLegalConclusion(rows, '别名')?.code, '01');
  assert.equal(matchLegalConclusion(rows, '01')?.value, '同名');
  for (const [text, code] of [['临时', ''], ['同名', '01'], ['同名', ''], ['别名', '02']]) {
    assert.equal(matchLegalConclusion(rows, text, code), undefined);
  }
  const unresolved = canonicalLegalItem(item, catalog);
  assert.equal(unresolved.conclusionCode, '');
  assert.equal(unresolved.conclusionLabel, '');
  assert.equal(unresolved.unmatchedConclusion, '同名');
  assert.equal(unresolved.rawText, item.rawText);
  assert.deepEqual(unresolved.evidences, item.evidences);
  const resolved = canonicalLegalItem({ ...item, conclusionLabel: '别名' }, catalog);
  assert.equal(resolved.conclusionCode, '01');
  const renamed = canonicalLegalItem(resolved, { 'D10.F059': [{ code: '01', value: '新名称', aliases: [] }] });
  assert.equal(renamed.conclusionLabel, '新名称');
  const retired = canonicalLegalItem(renamed, {});
  assert.equal(retired.conclusionCode, '');
  assert.equal(canonicalLegalItem(retired, { 'D10.F059': [{ code: '02', value: '新名称', aliases: [] }] }).conclusionCode, '');
});
