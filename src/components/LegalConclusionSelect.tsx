import { MASTER_FIELD_SCHEMA } from '../data/schemaCatalog';
import { useMemo } from 'react';
import type { LegalConclusionItem } from '../types/gold';
import { legalFields } from '../utils/legalCatalog';
import { useCatalogOptions } from './useCatalogOptions';
import { ControlledVocabCombobox } from './ControlledVocabCombobox';

export function LegalConclusionSelect({ item, onChange }: {
  item: LegalConclusionItem;
  onChange: (patch: Partial<LegalConclusionItem>) => void;
}) {
  const optionsFor = useCatalogOptions();
  const options = useMemo(() => optionsFor(MASTER_FIELD_SCHEMA.find(field => field.fieldCode === legalFields[item.category])!), [optionsFor, item.category]);
  return <ControlledVocabCombobox compact useStandardCode ariaLabel={`${item.id} 标准结论`}
    options={options} selectedValues={item.conclusionCode ? [item.conclusionCode] : []}
    placeholder={item.presenceStatus === 'present' ? '待核对 · 选择标准结论' : '选择标准结论'}
    onChangeValues={([code]) => {
      const row = options.find(o => o.standardCode === code);
      onChange({ conclusionCode: row?.standardCode ?? '', conclusionLabel: row?.value ?? '', unmatchedConclusion: undefined, unmatchedConclusionCode: undefined });
    }} />;
}
