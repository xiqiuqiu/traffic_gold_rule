import type { CaseDocument } from '../types/gold';

/** Derive a display title from the current draft so reviewed facts take effect immediately. */
export function accidentTitle(doc: CaseDocument): string {
  function fact(code: string) {
    const field = doc.fieldRecords.find(row => row.entityId === 'ACC' && row.fieldCode === code &&
      row.presenceStatus === 'present' && row.reviewStatus !== 'disputed');
    return field?.normalizedValues.find(value => value.trim())?.trim() || field?.rawValue.trim() || '';
  }

  const time = fact('D02.F006');
  const place = fact('D02.F008');
  const curatedTitle = doc.title && doc.title !== doc.caseId && !doc.title.startsWith(doc.caseId + ' · ')
    ? doc.title.replace(/^\d+ · /, '').trim() : '';
  let name = curatedTitle || doc.entities.find(entity => entity.kind === 'ACC')?.label.trim() || '';
  // Some model drafts repeat the date and full address inside the accident name.
  for (const prefix of [time, time.match(/^\d{4}-\d{2}-\d{2}/)?.[0], place]) {
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  }
  if (/^(?:整起事故|事故\s*[\d-]*|道路交通事故认定书.*)$/.test(name)) name = '';
  if (name.endsWith('事故') && place.includes(name.slice(0, -2))) name = '';

  const events = [...new Set(doc.entities.filter(entity => entity.kind === 'E').map(entity => entity.label.trim()).filter(Boolean))];
  const hasEventDetail = events.some(event => !/^第[一二三四五六七八九十\d]+阶段(?:碰撞|事故|事件)?$/.test(event));
  const eventSummary = !name || hasEventDetail
    ? events.filter(event => !name.includes(event)).join('、') : '';
  const description = name && eventSummary ? name + '（' + eventSummary + '）' : name || eventSummary;
  return [time, place, description].filter(Boolean).join(' · ') || doc.sourceFilename;
}
