import assert from 'node:assert/strict';
import test from 'node:test';
import { nextLiabilityScope } from './nextLiabilityScope';
import type { LegalConclusionItem } from '../types/gold';

test('assigns each party once per event and preserves the whole-accident scope', () => {
  const conclusions = ['E01', ''].map(eventId => ({
    category: 'liability', subjectId: 'P01', eventId,
  }) as LegalConclusionItem);
  assert.deepEqual(nextLiabilityScope(['P01'], ['E01', 'E02'], conclusions), { subjectId: 'P01', eventId: 'E02' });
  assert.equal(nextLiabilityScope(['P01'], ['E01'], conclusions), null);
  assert.deepEqual(nextLiabilityScope(['P01','P02'], [], conclusions), { subjectId: 'P02', eventId: '' });
});
