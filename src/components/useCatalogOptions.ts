import { useCallback, useContext, createContext } from 'react';
import type { CatalogOptions } from '../types/catalog';
import type { FieldDefinition, VocabularySupplementItem } from '../types/gold';
import { buildControlledVocabOptions } from '../utils/goldRules';

export const CatalogContext = createContext<CatalogOptions>({});

export function useCatalogOptions() {
  const catalog = useContext(CatalogContext);
  return useCallback((field: FieldDefinition, supplement?: VocabularySupplementItem) => {
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
