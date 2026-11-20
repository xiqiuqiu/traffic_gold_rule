import { useCallback, useContext, createContext } from 'react';
import type { CatalogOptions } from '../types/catalog';
import type { FieldDefinition, VocabularySupplementItem } from '../types/gold';
import { buildControlledVocabOptions } from '../utils/goldRules';

import { legalFields } from '../utils/legalCatalog';

export const CatalogContext = createContext<CatalogOptions>({});

export function useCatalogOptions() {
  const catalog = useContext(CatalogContext);
  return useCallback((field: FieldDefinition, supplement?: VocabularySupplementItem) => {
    if (Object.values(legalFields).some(code => code === field.fieldCode)) {
      return (catalog[field.fieldCode] ?? []).filter(row => !row.extension).map(row => ({
        value: row.value, source: 'preset' as const, standardCode: row.code, codeTable: field.existingCodeTable,
        synonymsText: row.aliases.join('、'),
      }));
    }
    const options = new Map(buildControlledVocabOptions(field, supplement).map(row => [row.value, row]));
    for (const row of catalog[field.fieldCode] ?? []) {
      const previous = options.get(row.value);
      options.set(row.value, {
        ...previous, value: row.value, source: previous?.source ?? (row.extension ? 'supplement' : 'preset'),
        standardCode: row.code, codeTable: field.existingCodeTable,
        synonymsText: [previous?.synonymsText, ...row.aliases].filter(Boolean).join('、'),
      });
    }
    return Array.from(options.values());
  }, [catalog]);
}
