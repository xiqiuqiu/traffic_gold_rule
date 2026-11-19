import type { EntityItem, LegalConclusionItem, LiabilitySourceLine, LiabilitySourceLocation } from '../types/gold';
import { liabilitySourceKey, validSourceLine } from '../utils/liabilitySourceKey';

export interface LiabilityLineSet {
  fileSha256: string;
  extractionVersion: string;
  lines: LiabilitySourceLine[];
}

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
const review = (reason: string): LiabilitySourceLocation => ({ status: 'needs_review', reason });

const ordinal = '[零〇一二两三四五六七八九十百0-9]+';
const stagePattern = '第(' + ordinal + ')(?:阶段|次(?:追尾|碰撞|事故))';
function stages(text: string) {
  const digits = '零一二三四五六七八九';
  return [...new Set(Array.from(text.matchAll(new RegExp(stagePattern, 'g')), match => {
    const raw = match[1].replace(/〇/g, '零').replace(/两/g, '二');
    if (/^\d+$/.test(raw)) return String(Number(raw));
    if (raw.includes('十') && !raw.includes('百')) {
      const [tens, units] = raw.split('十');
      return String((tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0));
    }
    return digits.includes(raw) && raw.length === 1 ? String(digits.indexOf(raw)) : raw;
  }))];
}

// Restrict the text between a person and the finding to responsibility language. An
// unrestricted substring search can bind another person's liability or a negated finding.
const scope = '(?:第' + ordinal + '(?:阶段|次)|本次|此次|本起|该起|本案|本阶段|事故|交通|道路|连环|追尾|碰撞|的|中|在|对)*';
const grade = '全部责任|主要责任|同等责任|次要责任|无责任|全责|主责|次责|无责';
const predicate = new RegExp('^(?:应当|应)?' + scope +
  '(?:(?:承担|负有|负|承担起)' + scope + ')?(' + grade + ')');
const noLiability = new RegExp('^' + scope + '(?:不承担|不负|无需承担|不负有)' + scope + '(?:任何)?责任');
const labels: Record<string, string> = {
  全责: '全部责任', 主责: '主要责任', 次责: '次要责任', 无责: '无责任',
};

function subjectName(entity: EntityItem) {
  const label = normalize(entity.label);
  if (entity.kind === 'O') return label;
  return label.replace(/\([^()]*\)$/u, '').replace(/^(?:当事人|驾驶人)[:：]?/u, '');
}

function* occurrences(text: string, term: string) {
  if (!term) return;
  for (let start = text.indexOf(term); start !== -1; start = text.indexOf(term, start + 1)) yield start;
}

function readPredicate(after: string) {
  const negative = noLiability.exec(after);
  if (negative) return { grade: '无责任', text: negative[0], gradeOffset: 0 };
  const match = predicate.exec(after);
  return match && { grade: labels[match[1]] ?? match[1], text: match[0], gradeOffset: match[0].length - match[1].length };
}

interface Finding {
  start: number;
  end: number;
  gradeStart: number;
  grade: string;
}

function* directFindings(text: string, name: string, others: string[]): Generator<Finding> {
  for (const start of occurrences(text, name)) {
    if (others.some(other => other.includes(name) &&
        Array.from(occurrences(other, name)).some(offset => text.startsWith(other, start - offset)))) continue;
    const afterName = start + name.length;
    const reading = readPredicate(text.slice(afterName));
    if (reading) yield {
      start, end: afterName + reading.text.length,
      gradeStart: afterName + reading.gradeOffset, grade: reading.grade,
    };
  }
}

const numberedParticipant = /^当事人(\d+)([\p{L}·]+)$/u;
const namedLawFinding = new RegExp(
  '^(当事人[0-9]+[\\p{L}·]+)违反《[\\p{L}]{2,50}》(?:第' + ordinal + '(?:条|款|项))+' +
  '(?:\\(([\\p{L}]{1,40})\\))?,(?:负|承担)(?:本起|本次)?事故(?:的)?(' + grade + ')$', 'u',
);

// These forms require a literal quotation of the whole finding, including every
// numbered party and the shared predicate, or the specific legal citation.
function numberedFinding(quote: string, subject: EntityItem, parties: EntityItem[]) {
  const clause = quote.replace(/[。;]$/u, '');
  const law = namedLawFinding.exec(clause);
  const group = /^(.+、.+)均无责任$/u.exec(clause);
  if (!law && !group) return null;
  const members = law ? [law[1]] : group![1].split('、');
  const identified = new Set<string>();
  const numbers = new Set<string>();
  for (const member of members) {
    const parsed = numberedParticipant.exec(member);
    if (!parsed || numbers.has(parsed[1])) return null;
    numbers.add(parsed[1]);
    const matching = parties.filter(person => subjectName(person) === parsed[2]);
    if (matching.length !== 1) return null;
    const person = matching[0];
    const declared = normalize(person.subtitle ?? '').match(/当事人(\d+)/u)?.[1];
    if ((declared && declared !== parsed[1]) || identified.has(person.id)) return null;
    identified.add(person.id);
  }
  if (!identified.has(subject.id)) return null;
  if (law?.[2] && (/当事人|责任/u.test(law[2]) ||
      parties.some(p => p !== subject && subjectName(p) && law[2].includes(subjectName(p))))) return null;
  return { length: clause.length, grade: law ? (labels[law[3]] ?? law[3]) : '无责任' };
}

function indexPage(lines: LiabilitySourceLine[]) {
  const raw = lines.map(line => line.text).join('');
  const lineEnds: number[] = [];
  let end = 0;
  for (const line of lines) lineEnds.push(end += line.text.length);
  const offsets: number[] = [];
  const ends: number[] = [];
  let text = '';
  let rawOffset = 0;
  for (const char of raw) {
    const normalized = normalize(char);
    for (let i = 0; i < normalized.length; i++) {
      offsets.push(rawOffset);
      ends.push(rawOffset + char.length);
    }
    text += normalized;
    rawOffset += char.length;
  }
  function source(start: number, end: number) {
    const rawStart = offsets[start];
    const rawEnd = ends[end - 1];
    const first = lineEnds.findIndex(limit => limit > rawStart);
    const last = lineEnds.findIndex(limit => limit >= rawEnd);
    return { quote: raw.slice(rawStart, rawEnd).trim(), lines: lines.slice(first, last + 1) };
  }
  return { text, source };
}

export function resolveLiabilitySource(
  item: LegalConclusionItem, entities: EntityItem[], lineSet: LiabilityLineSet,
): LiabilitySourceLocation {
  if (item.category !== 'liability' || !['present', 'explicit_negative'].includes(item.presenceStatus)) {
    return review('该记录没有明确的责任结论。');
  }
  if (!lineSet.extractionVersion || !/^sha256:[\da-f]{64}$/i.test(lineSet.fileSha256)) return review('缺少原件或取文版本。');
  const subject = entities.find(entity => entity.id === item.subjectId && (entity.kind === 'P' || entity.kind === 'O'));
  const event = entities.find(entity => entity.id === item.eventId && entity.kind === 'E');
  if (!subject || (item.eventId && !event)) return review('责任主体或事故阶段无法确认。');
  const name = subjectName(subject);
  const parties = entities.filter(entity => entity.kind === 'P' || entity.kind === 'O');
  const others = parties.filter(entity => entity !== subject).map(subjectName).filter(Boolean);
  if (!name || others.includes(name)) return review('责任主体无法唯一辨认。');

  const label = labels[item.conclusionLabel] ?? item.conclusionLabel;
  if (!['全部责任', '主要责任', '同等责任', '次要责任', '无责任'].includes(label) ||
      (item.presenceStatus === 'explicit_negative' && label !== '无责任')) return review('责任等级无法确认。');
  const eventStages = event ? stages(normalize(event.label + (event.subtitle ?? ''))) : [];
  // An old evidence quote can survive a manual change to the source-text field.
  // Reject a directly contradictory assertion about the same person and stage.
  const raw = normalize(item.rawText ?? '');
  for (const finding of directFindings(raw, name, others)) {
    const reportedStages = stages(raw.slice(finding.start, finding.end));
    if (finding.grade !== label && (!reportedStages.length || eventStages.some(stage => reportedStages.includes(stage)))) {
      return review('记录原文中的责任等级与结论不一致。');
    }
  }
  const denied = new RegExp('^' + scope + '(?:不应|不|无需)(?:承担|负有|负)' + scope + '(' + grade + ')');
  for (const start of occurrences(raw, name)) {
    const denial = denied.exec(raw.slice(start + name.length));
    if (denial && (labels[denial[1]] ?? denial[1]) === label) return review('记录原文中否定了这项责任。');
  }
  const rawNumbered = numberedFinding(raw, subject, parties);
  if (rawNumbered && rawNumbered.grade !== label) return review('记录原文中的责任等级与结论不一致。');
  const multipleEvents = entities.filter(entity => entity.kind === 'E').length > 1;

  const byPage = new Map<number, LiabilitySourceLine[]>();
  for (const line of lineSet.lines) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page)!.push(line);
  }
  const evidenceList = item.evidences.length ? item.evidences : [{ quote: item.rawText, page: undefined, lineIds: undefined }];
  const verified = new Map<string, Extract<LiabilitySourceLocation, { status: 'verified' }>>();
  for (const evidence of evidenceList) {
    const quote = normalize(evidence.quote ?? '');
    const ids = evidence.lineIds;
    if (ids !== undefined && (!quote || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))) {
      return review('引用行编号缺失或无效。');
    }
    if (!quote) continue;
    let matchedReference = false;
    for (const [page, originalLines] of byPage) {
      if (evidence.page !== undefined && evidence.page !== page) continue;
      const lines = [...originalLines].sort((a, b) => a.lineNumber - b.lineNumber);
      const { text, source } = indexPage(lines);
      const foundQuotes = Array.from(occurrences(text, quote));
      if (!foundQuotes.length) continue;
      const candidates = [...directFindings(text, name, others)];
      const numbered = numberedFinding(quote, subject, parties);
      if (numbered) {
        for (const start of foundQuotes.filter(i => !/[、及与和]/u.test(text[i - 1] ?? ''))) candidates.push({
          start, end: start + numbered.length, gradeStart: start, grade: numbered.grade,
        });
      }
      for (const { start, end, gradeStart, grade: candidateGrade } of candidates) {
        if (candidateGrade !== label) continue;
        // The literal citation must cover at least the stated grade, even when it is
        // only the tail of a wrapped sentence. A shared name or article is insufficient.
        if (end < text.length && !/^[,。;、!]/u.test(text.slice(end))) continue;
        if (/^[,、](?:尚未|有争议|存疑|不予认可|并不属实)/u.test(text.slice(end))) continue;
        const clauseBefore = text.slice(0, start).split(/[。;!?]/u).at(-1) ?? '';
        if (/(?:否认|辩称|主张|建议|认为|未必|可能|并非|如果|假如|是否)[^。;]*$/u.test(clauseBefore)) continue;
        const stagePrefix = clauseBefore.match(new RegExp('(?:在)?' + stagePattern + '(?:追尾|碰撞|事故|中|的)*[:,]?(?:当事人)?$'))?.[0] ?? '';
        if (!stagePrefix && /[\p{L}\d]$/u.test(clauseBefore) &&
            !/(?:当事人|驾驶人|驾驶员|行人|骑行人|认定|判定|确定|由)$/u.test(clauseBefore)) continue;
        const supportStart = start - stagePrefix.length;
        const actualStages = stages(text.slice(supportStart, end));
        if (!actualStages.length && stages(clauseBefore).length) continue;
        if (eventStages.length !== actualStages.length ||
            eventStages.some(stage => !actualStages.includes(stage)) || actualStages.length > 1 ||
            (event && multipleEvents && !eventStages.length)) continue;
        const support = source(supportStart, /[。;]/.test(text[end] ?? ' ') ? end + 1 : end);
        if (!support.lines.length || !support.lines.every((line, i) => validSourceLine(line, page) &&
            (i === 0 || line.lineNumber === support.lines[i - 1].lineNumber + 1))) continue;
        const citationMatches = foundQuotes.some(q => {
          if (q > gradeStart || end > q + quote.length) return false;
          if (!ids) return true;
          // A precise pointer may cover just the literal excerpt, or also include the
          // wrapped name/stage needed to interpret it. Reject unrelated extra rows.
          const matchesIds = (rows: LiabilitySourceLine[]) => rows.length === ids.length &&
            rows.every((line, i) => line.lineId === ids[i]);
          return matchesIds(source(q, q + quote.length).lines) ||
            matchesIds(source(Math.min(q, supportStart), Math.max(q + quote.length, end)).lines);
        });
        if (!citationMatches) continue;
        matchedReference = true;
        verified.set(page + ':' + supportStart + ':' + end, {
          status: 'verified', fileSha256: lineSet.fileSha256, extractionVersion: lineSet.extractionVersion,
          recordKey: liabilitySourceKey(item, entities), page, ...support,
        });
      }
    }
    if (evidence.lineIds?.length && !matchedReference) return review('引用行与原文、主体、责任等级或事故阶段不符。');
  }
  if (verified.size === 1) return verified.values().next().value!;
  return review(verified.size ? '存在多个相符的原文位置。' : '未找到主体、责任等级和事故阶段一致的原文。');
}
