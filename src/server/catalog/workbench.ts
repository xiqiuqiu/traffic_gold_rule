import { legalFields } from '../../utils/legalCatalog';
import { MASTER_FIELD_SCHEMA } from '../../data/schemaCatalog';
import { SEED_CASES } from '../../data/seedCases';
import type { CaseDocument } from '../../types/gold';
import type { ObservationTask, TagResidue } from '../../types/catalog';
import { extractAccidentBizId } from '../../utils/systemEngine';
import { pool } from '../pdfQueue';
import { loadSystemState } from '../systemStore';
import { readPhraseClassifier, seedPhraseClassifier } from './codebook';
import { textKey } from './textKey';

const fields = new Map(MASTER_FIELD_SCHEMA.map(field => [field.fieldCode, field]));
type Source = Pick<CaseDocument, 'fieldRecords' | 'legalConclusions'>;

export function observationReader(reader = readPhraseClassifier()) {
  return (source: Source): TagResidue[] => {
    const residues: TagResidue[] = [];
    function observe(fieldCode: string, term: string, subject: string, evidence?: { page: number; quote: string }) {
      const field = fields.get(fieldCode);
      const key = textKey(term);
      if (!key || !field || !(field.valueType.includes('枚举') || field.isLegalOrRelation && field.existingCodeTable)) return;
      const match = reader.classify(fieldCode, key);
      if (match.kind !== 'open' && match.kind !== 'group') return;
      const reason = match.kind === 'group' ? 'broad_group_match'
        : reader.authorityFor(fieldCode) ? 'unmapped_code' : 'no_code_list';
      residues.push({ fieldCode, textKey: key, rawText: term,
        reason,
        subjects: [subject], suggestedDmz: match.kind === 'group' ? match.members : [], evidencePage: evidence?.page ?? 0, evidenceQuote: evidence?.quote ?? '' });
    }
    for (const row of source.fieldRecords) {
      if (row.presenceStatus === 'present') observe(row.fieldCode, row.rawValue, row.entityId, row.evidences[0]);
    }
    for (const row of source.legalConclusions) {
      if (row.presenceStatus === 'present') observe(legalFields[row.category], row.unmatchedConclusion || row.conclusionCode || row.conclusionLabel, row.subjectId, row.evidences[0]);
    }
    return residues;
  };
}

export async function getObservationTasks(): Promise<ObservationTask[]> {
  const readLegacy = observationReader(seedPhraseClassifier());
  const state = await loadSystemState();
  const seeds = new Set(state.tasks.filter(t => t.source === 'seed_archive').map(t => t.caseId));
  const tasks = SEED_CASES.filter(c => seeds.has(c.caseId)).map(c => ({
    id: c.caseId, accidentKey: extractAccidentBizId(c), tagResidue: readLegacy(c),
  }));
  const { rows } = await pool.query<ObservationTask & { legacy: Source | null }>(`
    SELECT id, task->>'accidentBizId' AS "accidentKey", draft->'tagResidue' AS "tagResidue",
      CASE WHEN NOT (draft ? 'tagResidue') THEN jsonb_build_object(
        'fieldRecords', draft->'fieldRecords', 'legalConclusions', draft->'legalConclusions') END AS legacy
    FROM pdf_tasks WHERE draft IS NOT NULL ORDER BY created_at, id`);
  return tasks.concat(rows.map(row => ({ id: row.id, accidentKey: row.accidentKey,
    tagResidue: row.legacy ? readLegacy(row.legacy) : row.tagResidue })));
}
