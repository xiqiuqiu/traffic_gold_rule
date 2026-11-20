import type { LegalConclusionItem } from '../types/gold';
import { textKey } from '../server/catalog/textKey';

function clauses(text: string) {
  return textKey(text).split(/[,;。；、]+/u).map(part => part.replace(/^(?:并且|而且|且)/u, '')).join(',');
}

function containsFact(source: string, fact: string) {
  return Boolean(fact) && (',' + clauses(source) + ',').includes(',' + fact + ',');
}

// “使其车辆” can be transcribed as “使车辆”; other owners, objects and negations remain significant.
function factWordings(fact: string) {
  const wording = clauses(fact);
  return [...new Set([wording, wording.replace(/使(?=车辆|机动车|非机动车|叉车)/gu, '使其'),
    wording.replace(/使其(?=车辆|机动车|非机动车|叉车)/gu, '使')])];
}

export function sameBehaviorFact(a: LegalConclusionItem, b: LegalConclusionItem) {
  const fact = textKey(a.behaviorFact || '');
  if (fact && fact === textKey(b.behaviorFact || '')) return true;
  const variants = factWordings(fact);
  if (!variants.includes(clauses(b.behaviorFact || ''))) return false;
  return variants.some(term => containsFact(a.rawText, term) && containsFact(b.rawText, term));
}

export function legacyViolationSupports(existing: LegalConclusionItem, incoming: LegalConclusionItem) {
  if (existing.behaviorFact || !incoming.behaviorFact || existing.subjectId !== incoming.subjectId ||
      existing.eventId !== incoming.eventId || existing.presenceStatus !== incoming.presenceStatus ||
      (existing.conclusionCode && existing.conclusionCode !== incoming.conclusionCode) ||
      !existing.lawArticle.trim() || textKey(existing.lawArticle) !== textKey(incoming.lawArticle)) return false;
  const [wording, ...variants] = factWordings(incoming.behaviorFact);
  if (containsFact(existing.rawText, wording)) return true;
  return variants.some(term => containsFact(existing.rawText, term) &&
    (containsFact(incoming.rawText, wording) || containsFact(incoming.rawText, term)));
}

export function addViolationSources(existing: LegalConclusionItem, incoming: LegalConclusionItem) {
  const articles = new Map<string, string>();
  for (const part of [existing.lawArticle, incoming.lawArticle].join('；').split(/[；;\n]+/u)) {
    const key = textKey(part);
    if (key && !articles.has(key)) articles.set(key, part.trim());
  }
  existing.lawArticle = [...articles.values()].join('；');
  for (const evidence of incoming.evidences) {
    if (!existing.evidences.some(ev => ev.page === evidence.page && ev.quote === evidence.quote &&
        JSON.stringify(ev.lineIds) === JSON.stringify(evidence.lineIds))) existing.evidences.push(evidence);
  }
}

// Keep the older ID so existing reviews and cause links still address the same record.
export function reconcileViolationDrafts(items: LegalConclusionItem[]): LegalConclusionItem[] {
  const violations = items.filter(item => item.category === 'violation');
  const pairs = violations.filter(item => !item.behaviorFact).flatMap(old =>
    violations.filter(item => legacyViolationSupports(old, item)).map(fact => ({ old, fact })));
  const replacements = new Map<string, string>();
  const updated = new Map<string, LegalConclusionItem>();
  for (const { old, fact } of pairs) {
    if (pairs.filter(pair => pair.old === old || pair.fact === fact).length !== 1) continue;
    if (![old, fact].every(v => v.id.startsWith('VIO-AI-') && v.reviewStatus === 'draft')) continue;
    if (fact.adjudicatorNote || fact.disputeReason || fact.sourceLocation) continue;
    const oldStatus = old.causalLinkStatus || 'unspecified';
    const factStatus = fact.causalLinkStatus || 'unspecified';
    if (oldStatus !== 'unspecified' && factStatus !== 'unspecified' && oldStatus !== factStatus) continue;

    const merged = { ...old, behaviorFact: fact.behaviorFact, evidences: [...old.evidences],
      causalLinkStatus: oldStatus === 'unspecified' ? factStatus : oldStatus };
    if (!old.conclusionCode) {
      merged.conclusionCode = fact.conclusionCode;
      merged.conclusionLabel = fact.conclusionLabel;
      merged.unmatchedConclusion = fact.unmatchedConclusion;
      merged.unmatchedConclusionCode = fact.unmatchedConclusionCode;
    }
    addViolationSources(merged, fact);
    for (const key of ['linkedCauseIds', 'linkedViolationIds', 'linkedEntityIds', 'linkedVocabTerms'] as const) {
      if (fact[key]?.length) merged[key] = [...new Set([...(old[key] || []), ...fact[key]])];
    }
    updated.set(old.id, merged);
    replacements.set(fact.id, old.id);
  }
  if (!replacements.size) return items;
  return items.filter(item => !replacements.has(item.id)).map(original => {
    const item = updated.get(original.id) ?? original;
    if (!item.linkedViolationIds?.some(id => replacements.has(id))) return item;
    return { ...item, linkedViolationIds: [...new Set(item.linkedViolationIds.map(id => replacements.get(id) ?? id))] };
  });
}
