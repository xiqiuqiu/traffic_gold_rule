import type { CaseDocument, EntityItem, LegalConclusionItem, LiabilitySourceLine } from '../types/gold';

export function liabilitySourceKey(item: LegalConclusionItem, entities: EntityItem[]) {
  const identities = entities.filter(e => e.kind === 'P' || e.kind === 'O' || e.kind === 'E')
    .map(e => [e.id, e.kind, e.label, e.subtitle]);
  return JSON.stringify([
    item.id, item.category, item.subjectId, item.eventId, identities,
    item.presenceStatus, item.conclusionLabel, item.rawText,
    item.evidences.map(evidence => [evidence.page, evidence.quote, evidence.lineIds]),
  ]);
}

export function validSourceLine(line: LiabilitySourceLine, page: number) {
  const box = line?.bbox;
  return line?.page === page && Number.isInteger(page) && page > 0 &&
    Number.isInteger(line.lineNumber) && line.lineNumber > 0 && Boolean(line.lineId && line.text) &&
    Array.isArray(box) && box.length === 4 &&
    box.every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    box[0] < box[2] && box[1] < box[3];
}

export function getVerifiedLiabilitySource(
  item: LegalConclusionItem, doc: Pick<CaseDocument, 'entities' | 'fileSha256'>,
) {
  const source = item.sourceLocation;
  if (source?.status !== 'verified' || source.fileSha256 !== doc.fileSha256 ||
      !source.extractionVersion || !source.quote?.trim() ||
      source.recordKey !== liabilitySourceKey(item, doc.entities) ||
      !source.lines?.length || !source.lines.every((line, i) =>
        validSourceLine(line, source.page) && (i === 0 || line.lineNumber === source.lines[i - 1].lineNumber + 1),
      )) return null;
  return source;
}
