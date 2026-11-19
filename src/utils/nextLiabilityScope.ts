import type { LegalConclusionItem } from '../types/gold';
import { hasLiabilityScopeConflict } from './goldRules';

export function nextLiabilityScope(
  subjectIds: string[], eventIds: string[], conclusions: LegalConclusionItem[],
) {
  const liabilities = conclusions.filter(item => item.category === 'liability');
  for (const eventId of [...eventIds, '']) {
    for (const subjectId of subjectIds) {
      const scope = { subjectId, eventId };
      if (!liabilities.some(item => hasLiabilityScopeConflict(item, scope))) return scope;
    }
  }
  return null;
}
