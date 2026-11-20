import type { CatalogOption, CatalogOptions } from '../types/catalog';
import type { CaseDocument, LegalCategory, LegalConclusionItem } from '../types/gold';
import { textKey } from '../server/catalog/textKey';

export const legalFields = { violation: 'D10.F058', cause: 'D10.F059', liability: 'D10.F060' } as const;

// These are the business meanings of sgzr codes used when checking the original wording.
export const liabilityGrades: Record<string, string> = {
  '1': '全部责任', '2': '主要责任', '3': '同等责任', '4': '次要责任', '5': '无责任',
};

export function legalRows(catalog: CatalogOptions, category: LegalCategory) {
  return (catalog[legalFields[category]] ?? []).filter(row => !row.extension);
}

// Limit model context for large tables. Ranking supplies candidates only; acceptance uses exact matches below.
export function promptLegalRows(rows: CatalogOption[], documentText: string) {
  const source = textKey(documentText);
  if (!source) return [];
  const pairs = new Set(Array.from({ length: source.length - 1 }, (_, i) => source.slice(i, i + 2)));
  const ranked = rows.map(row => {
    const scores = [row.value, ...row.aliases].map(name => {
      const term = textKey(name);
      if (term.length < 2) return 0;
      if (source.includes(term)) return 2;
      let hits = 0;
      for (let i = 1; i < term.length; i++) if (pairs.has(term.slice(i - 1, i + 1))) hits++;
      return hits / (term.length - 1);
    });
    return { row, score: Math.max(...scores) };
  });
  return ranked.filter(entry => entry.score >= 0.5).sort((a, b) => b.score - a.score)
    .slice(0, 32).map(entry => entry.row);
}

export function matchLegalConclusion(rows: CatalogOption[], wording: string, proposedCode = '') {
  const key = textKey(wording);
  if (!key) return undefined;
  const matches = rows.filter(row => [row.code, row.value, ...row.aliases].some(name => textKey(name) === key));
  return matches.length === 1 && (!proposedCode || matches[0].code === proposedCode) ? matches[0] : undefined;
}

export function canonicalLegalItem(item: LegalConclusionItem, catalog: CatalogOptions): LegalConclusionItem {
  const rows = legalRows(catalog, item.category);
  const row = item.conclusionCode
    ? rows.find(row => row.code === item.conclusionCode)
    : matchLegalConclusion(rows, item.unmatchedConclusion || item.conclusionLabel, item.unmatchedConclusionCode);
  const code = row?.code ?? '';
  const label = row?.value ?? '';
  if (item.conclusionCode === code && item.conclusionLabel === label) return item;
  return { ...item, conclusionCode: code, conclusionLabel: label,
    unmatchedConclusion: row ? undefined : item.unmatchedConclusion || item.conclusionLabel || item.conclusionCode,
    unmatchedConclusionCode: row ? undefined : item.conclusionCode || item.unmatchedConclusionCode };
}

export function canonicalLegalDraft(doc: CaseDocument, catalog: CatalogOptions): CaseDocument {
  const items = doc.legalConclusions.map(item => canonicalLegalItem(item, catalog));
  return items.some((item, i) => item !== doc.legalConclusions[i]) ? { ...doc, legalConclusions: items } : doc;
}
