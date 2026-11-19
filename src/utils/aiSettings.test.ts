import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterModelOptions,
  getActiveModelSummary,
  normalizeOpenAiBaseUrl,
  parseOpenAiModelsPayload,
  pickPreferredModel,
  validateOpenAiBaseUrl,
} from './aiSettings';

test('normalizeOpenAiBaseUrl strips trailing slashes and endpoint suffixes', () => {
  assert.equal(normalizeOpenAiBaseUrl('  https://api.openai.com/v1/  '), 'https://api.openai.com/v1');
  assert.equal(
    normalizeOpenAiBaseUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1',
  );
  assert.equal(
    normalizeOpenAiBaseUrl('http://localhost:11434/v1/models/'),
    'http://localhost:11434/v1',
  );
});

test('validateOpenAiBaseUrl checks protocol and formatting', () => {
  assert.ok(validateOpenAiBaseUrl(''));
  assert.ok(validateOpenAiBaseUrl('ftp://example.com/v1'));
  assert.ok(validateOpenAiBaseUrl('not-a-url'));
  assert.equal(validateOpenAiBaseUrl('https://api.openai.com/v1'), null);
  assert.equal(validateOpenAiBaseUrl('http://127.0.0.1:8000/v1'), null);
});

test('parseOpenAiModelsPayload normalizes OpenAI, array, and models payloads', () => {
  const fromOpenAi = parseOpenAiModelsPayload({
    object: 'list',
    data: [
      { id: 'gpt-4o-mini', owned_by: 'openai', created: 1715000000 },
      { id: 'gpt-4o', owned_by: 'openai', created: 1715000001 },
      { id: 'gpt-4o', owned_by: 'duplicate' },
    ],
  });
  assert.deepEqual(
    fromOpenAi.map((m) => m.id),
    ['gpt-4o', 'gpt-4o-mini'],
  );
  assert.equal(fromOpenAi[0].ownedBy, 'openai');

  const fromCustom = parseOpenAiModelsPayload({
    models: [{ name: 'qwen2.5:14b' }, 'deepseek-chat'],
  });
  assert.deepEqual(
    fromCustom.map((m) => m.id),
    ['deepseek-chat', 'qwen2.5:14b'],
  );
});

test('pickPreferredModel preserves existing choice when still available and falls back otherwise', () => {
  const models = [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }];
  assert.equal(pickPreferredModel(models, 'deepseek-reasoner'), 'deepseek-reasoner');
  assert.equal(pickPreferredModel(models, 'removed-model'), 'deepseek-chat');
  assert.equal(pickPreferredModel([], 'manual-model'), 'manual-model');
});

test('filterModelOptions filters by id or ownedBy case-insensitively', () => {
  const models = [
    { id: 'gpt-4o-mini', ownedBy: 'openai' },
    { id: 'qwen-plus', ownedBy: 'alibaba' },
  ];
  assert.equal(filterModelOptions(models, 'QWEN').length, 1);
  assert.equal(filterModelOptions(models, 'openai')[0].id, 'gpt-4o-mini');
});

test('getActiveModelSummary reports configuration readiness clearly', () => {
  const geminiSummary = getActiveModelSummary({
    provider: 'gemini',
    openai: { baseUrl: '', apiKey: '', selectedModel: '', availableModels: [] },
  });
  assert.equal(geminiSummary.isConfigured, true);
  assert.equal(geminiSummary.modelName, 'gemini-4-hydrogen');

  const missingModelSummary = getActiveModelSummary({
    provider: 'openai_compatible',
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      selectedModel: '',
      availableModels: [],
    },
  });
  assert.equal(missingModelSummary.isConfigured, false);
  assert.ok(missingModelSummary.issueHint);

  const readySummary = getActiveModelSummary({
    provider: 'openai_compatible',
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      selectedModel: 'gpt-4o-mini',
      availableModels: [{ id: 'gpt-4o-mini' }],
    },
  });
  assert.equal(readySummary.isConfigured, true);
  assert.equal(readySummary.modelName, 'gpt-4o-mini');
});
