import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOpenAiSseDeltaText,
  isTimeoutError,
  parseStructuredModelJson,
} from './aiResponseParser';

test('parseStructuredModelJson strips think blocks, markdown fences, and surrounding prose', () => {
  const raw = `<think>分析一下文书字段...</think>
  \`\`\`json
  {"summary":"ok","entities":[],"fieldRecords":[]}
  \`\`\``;
  const parsed = parseStructuredModelJson(raw) as { summary: string };
  assert.equal(parsed.summary, 'ok');

  const proseWrapped = '以下是提取结果：\n{"summary":"wrapped","entities":[],"fieldRecords":[]}\n请核对。';
  const parsedWrapped = parseStructuredModelJson(proseWrapped) as { summary: string };
  assert.equal(parsedWrapped.summary, 'wrapped');
});

test('extractOpenAiSseDeltaText parses SSE delta chunks and ignores [DONE] and reasoning', () => {
  assert.equal(extractOpenAiSseDeltaText('data: [DONE]'), null);
  assert.equal(extractOpenAiSseDeltaText(': keep-alive'), null);
  assert.equal(
    extractOpenAiSseDeltaText('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}'),
    null,
  );
  assert.equal(
    extractOpenAiSseDeltaText('data: {"choices":[{"delta":{"content":"{\\"summary\\":"}}]}'),
    '{"summary":',
  );
});

test('isTimeoutError detects AbortSignal.timeout and network timeout errors', () => {
  const domTimeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(isTimeoutError(domTimeout), true);
  assert.equal(isTimeoutError(new Error('The operation was aborted due to timeout')), true);
  assert.equal(isTimeoutError(new Error('401 Unauthorized')), false);
});
