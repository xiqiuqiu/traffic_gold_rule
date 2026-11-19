import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceItem, LiabilitySourceLine } from '../types/gold';
import { resolveEvidenceLocation } from './evidenceLocation';

function line(page: number, lineNumber: number, text: string): LiabilitySourceLine {
  return { page, lineNumber, text, lineId: `${page}:${lineNumber}`, bbox: [0.1, 0.1, 0.8, 0.2] };
}
const evidence = (quote: string, lineIds?: string[]): EvidenceItem => ({ page: 2, id: 'ev', quote, lineIds });

test('逐条引用按原页匹配全半角、空白和跨行文本', () => {
  const lines = [
    line(1, 1, '日期：12月20日'), line(2, 2, '２０ 日，天气晴。'), line(2, 1, '日期：１２月'),
  ];
  const result = resolveEvidenceLocation(evidence('12 月 20日'), lines);
  assert.deepEqual(result?.lines.map(l => l.lineId), ['2:1', '2:2']);
  assert.deepEqual(resolveEvidenceLocation(evidence('天气晴。'), lines)?.lines, [lines[1]]);
  for (const quote of ['天气阴', ' ', '１２月25日']) assert.equal(resolveEvidenceLocation(evidence(quote), lines), null);
  assert.equal(resolveEvidenceLocation({ ...evidence('天气晴。'), page: 1 }, lines), null);
});

test('相同摘录要求唯一命中；行标须完整且有序', () => {
  const rows = [line(2, 1, '第一次碰'), line(2, 2, '撞，第二次碰'), line(2, 3, '撞。')];
  assert.equal(resolveEvidenceLocation(evidence('碰撞'), rows), null);
  assert.deepEqual(resolveEvidenceLocation(evidence('碰撞', ['2:2', '2:3']), rows)?.lines, rows.slice(1));
  for (const ids of [[], ['2:2'], ['2:3', '2:2'], ['2:1', '2:2', '2:3'], ['1:2', '1:3']])
    assert.equal(resolveEvidenceLocation(evidence('碰撞', ids), rows), null);
  assert.equal(resolveEvidenceLocation(evidence('日', ['2:1']), [line(2, 1, '日日')]), null);
});

test('跨缺失行和无效坐标的证据不产生高亮', () => {
  const rows = [line(2, 1, '第一次碰'), line(2, 3, '撞')];
  assert.equal(resolveEvidenceLocation(evidence('碰撞'), rows), null);
  assert.equal(resolveEvidenceLocation(evidence('第一次'), [{ ...rows[0], bbox: [0.1, 0.8, 0.8, 0.2] }]), null);
});

test('旧引文遗漏排版括号时保留原文标点与行框，优先精确命中', () => {
  const wrapped = line(2, 2, '【吴某（Ａ２）】：未保持安全车距。');
  const plain = line(2, 4, '吴某（Ａ２）：未保持安全车距。');
  const ev = evidence('吴某(A2):未保持安全车距');
  const match = resolveEvidenceLocation(ev, [wrapped]);
  assert.deepEqual(match?.lines, [wrapped]);
  assert.equal(match?.quote, '【吴某（Ａ２）】：未保持安全车距');
  assert.deepEqual(resolveEvidenceLocation(ev, [wrapped, plain])?.lines, [plain]);
  assert.equal(resolveEvidenceLocation(ev, [wrapped, { ...wrapped, lineNumber: 6 }]), null);
  assert.equal(resolveEvidenceLocation(evidence('吴某(A2):保持安全车距'), [wrapped]), null);
});
