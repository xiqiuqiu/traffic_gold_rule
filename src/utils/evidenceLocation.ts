import type { EvidenceItem, LiabilitySourceLine } from '../types/gold';
import { validSourceLine } from './liabilitySourceKey';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');

export function resolveEvidenceLocation(evidence: EvidenceItem, lines: LiabilitySourceLine[]) {
  const { page, quote, lineIds } = evidence;
  if (!Number.isInteger(page) || page < 1 || typeof quote !== 'string' || !normalize(quote)) return null;

  let rows = lines.filter(line => line.page === page).sort((a, b) => a.lineNumber - b.lineNumber);
  if (lineIds !== undefined) {
    if (!Array.isArray(lineIds) || !lineIds.length) return null;
    const first = rows.findIndex(line => line.lineId === lineIds[0]);
    if (first < 0) return null;
    rows = rows.slice(first, first + lineIds.length);
    if (rows.length !== lineIds.length || rows.some((line, i) => line.lineId !== lineIds[i])) return null;
  }

  const raw = rows.map(line => line.text).join('');
  let needle = normalize(quote);
  // Some older drafts omit the decorative brackets around PDF section labels.
  const pageText = normalize(raw);
  const omitBrackets = !pageText.includes(needle);
  if (omitBrackets) {
    needle = needle.replace(/[【】]/gu, '');
    if (!needle || !pageText.replace(/[【】]/gu, '').includes(needle)) return null;
  }

  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  let text = '';
  for (const { segment, index } of graphemes.segment(raw)) {
    if (omitBrackets && (segment === '【' || segment === '】')) continue;
    const part = normalize(segment);
    text += part;
    for (let i = 0; i < part.length; i++) {
      rawStarts.push(index);
      rawEnds.push(index + segment.length);
    }
  }
  let offset = 0;
  const rowEnds = rows.map(line => offset += line.text.length);
  let match: { page: number; quote: string; lines: LiabilitySourceLine[] } | null = null;
  for (let pos = text.indexOf(needle); pos !== -1; pos = text.indexOf(needle, pos + 1)) {
    let start = rawStarts[pos];
    let end = rawEnds[pos + needle.length - 1];
    if (omitBrackets && raw[start - 1] === '【' && raw.slice(start, end).includes('】')) start--;
    if (omitBrackets && raw[end] === '】' && raw.slice(start, end).includes('【')) end++;
    const first = rowEnds.findIndex(n => n > start);
    const last = rowEnds.findIndex(n => n >= end);
    if (lineIds && (first !== 0 || last !== rows.length - 1)) continue;
    const span = rows.slice(first, last + 1);
    if (span.some((line, i) => !validSourceLine(line, page) ||
        (i > 0 && line.lineNumber !== span[i - 1].lineNumber + 1))) continue;
    if (match) return null;
    match = { page, quote: raw.slice(start, end), lines: span };
  }
  return match;
}
