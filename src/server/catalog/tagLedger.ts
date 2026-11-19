import fs from 'node:fs';
import path from 'node:path';
import { MASTER_FIELD_SCHEMA } from '../../data/schemaCatalog';
import type {
  ObservationTask,
  ObservationReport,
  ObservationRow,
  ObservationStats,
  PromoteTarget,
  ReviewStatus,
  TagResidueReason,
} from '../../types/catalog';
import {
  catalogDir,
  addAlias,
  readPhraseClassifier,
  CodebookError,
  createExtensionTag,
  listCodes,
  listExtensionTags,
  updateExtensionTag,
} from './codebook';
import { writeAtomic } from './orderedJson';
import { textKey } from './textKey';

export const TAG_REVIEWS_FILE = path.join(catalogDir, 'tag_reviews.json');

export interface ObservationFilter {
  fieldCode?: string;
  status?: ReviewStatus | 'all';
  q?: string;
}

export interface ReviewActor {
  id: string;
  name: string;
}

export interface LedgerPaths {
  reviewFile?: string;
  codeFile?: string;
  bindingFile?: string;
  tagFile?: string;
}

interface ReviewRecord {
  fieldCode: string;
  textKey: string;
  status: ReviewStatus;
  weight: number | null;
  reviewerId: string;
  reviewerName: string;
  reviewedAt: string;
  linkedDmz: string | null;
}

interface Bucket {
  fieldCode: string;
  textKey: string;
  rawText: string;
  reason: TagResidueReason;
  accidents: Set<string>;
  samples: ObservationRow['samples'];
}

export function listObservations(
  tasks: ObservationTask[],
  filter: ObservationFilter = {},
  paths?: LedgerPaths,
): ObservationReport {
  const rows = deriveRows(tasks, paths);
  const stats = statsOf(rows);
  const visible = rows.filter((row) => matches(row, filter));
  visible.sort(
    (a, b) =>
      b.accidentCount - a.accidentCount ||
      a.fieldCode.localeCompare(b.fieldCode) ||
      a.textKey.localeCompare(b.textKey),
  );
  return { total: visible.length, rows: visible, stats };
}

export function reviewObservation(
  tasks: ObservationTask[],
  input: { fieldCode: string; textKey: string; status: ReviewStatus; weight?: number },
  actor: ReviewActor,
  paths?: LedgerPaths,
): ObservationRow {
  const fieldCode = input.fieldCode.trim();
  const key = input.textKey.trim();
  findRow(tasks, fieldCode, key, paths);
  let weight: number | null = null;
  if (input.status === 'confirmed') {
    const requested = input.weight === undefined ? 1 : input.weight;
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new CodebookError('确认准确时权重必须是大于 0 的数字');
    }
    weight = requested;
  }
  const file = reviewFile(paths);
  const reviews = readReviews(file);
  const index = reviews.findIndex((review) => review.fieldCode === fieldCode && review.textKey === key);
  const previous = index >= 0 ? reviews[index] : undefined;
  const record: ReviewRecord = {
    fieldCode,
    textKey: key,
    status: input.status,
    weight,
    reviewerId: actor.id,
    reviewerName: actor.name,
    reviewedAt: new Date().toISOString(),
    linkedDmz: previous?.linkedDmz ?? null,
  };
  if (index >= 0) reviews[index] = record;
  else reviews.push(record);
  writeReviews(file, reviews);
  return findRow(tasks, fieldCode, key, paths);
}

export function promoteObservation(
  tasks: ObservationTask[],
  input: { fieldCode: string; textKey: string; target: PromoteTarget },
  paths?: LedgerPaths,
): ObservationRow {
  const fieldCode = input.fieldCode.trim();
  const key = input.textKey.trim();
  const row = findRow(tasks, fieldCode, key, paths);
  if (row.status !== 'confirmed' || row.weight === null || row.weight <= 0) {
    throw new CodebookError('先确认准确并赋权重，再归入标签库');
  }
  const target = input.target;
  if (target.kind === 'alias') {
    if (!row.authority) throw new CodebookError('该字段没有代码表，不能归入同义读法');
    addAlias(row.authority, row.rawText, target.dmz, paths?.codeFile, paths?.bindingFile, paths?.tagFile);
  } else if (target.kind === 'link_standard') {
    if (!row.authority) throw new CodebookError('该字段没有代码表，不能关联标准码');
    const codes = listCodes(row.authority, paths?.codeFile, paths?.bindingFile, paths?.tagFile);
    if (!codes.some((item) => item.dmz === target.dmz.trim())) {
      throw new CodebookError(`代码 ${target.dmz.trim() || target.dmz} 不存在`);
    }
    const file = reviewFile(paths);
    const reviews = readReviews(file);
    const record = reviews.find((item) => item.fieldCode === fieldCode && item.textKey === key);
    if (!record || record.status !== 'confirmed') {
      throw new CodebookError('先确认准确并赋权重，再归入标签库');
    }
    record.linkedDmz = target.dmz.trim();
    writeReviews(file, reviews);
  } else if (target.kind === 'new_extension') {
    const aliases = textKey(target.label) === textKey(row.rawText) ? [] : [row.rawText];
    createExtensionTag(
      fieldCode,
      target.label,
      aliases,
      paths?.codeFile,
      paths?.bindingFile,
      paths?.tagFile,
    );
  } else {
    const tags = listExtensionTags(undefined, paths?.codeFile, paths?.tagFile);
    const found = tags.find((item) => item.extCode === target.extCode);
    if (!found) throw new CodebookError(`扩充标签 ${target.extCode} 不存在`);
    if (found.fieldCode !== fieldCode) throw new CodebookError('扩充标签不属于这个字段');
    const already =
      textKey(found.label) === key || found.aliases.some((alias) => textKey(alias) === key);
    if (!already) {
      updateExtensionTag(
        found.extCode,
        { aliases: [...found.aliases, row.rawText] },
        paths?.codeFile,
        paths?.bindingFile,
        paths?.tagFile,
        );
    }
  }
  return findRow(tasks, fieldCode, key, paths);
}

function deriveRows(tasks: ObservationTask[], paths?: LedgerPaths): ObservationRow[] {
  const buckets = new Map<string, Bucket>();
  for (const task of tasks) {
    const accidentKey = task.accidentKey?.trim() || task.id;
    for (const residue of task.tagResidue ?? []) {
      const key = residue.textKey.trim() || textKey(residue.rawText);
      if (!residue.fieldCode.trim() || !key) continue;
      const id = `${residue.fieldCode}\0${key}`;
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = {
          fieldCode: residue.fieldCode,
          textKey: key,
          rawText: residue.rawText,
          reason: residue.reason,
          accidents: new Set(),
          samples: [],
        };
        buckets.set(id, bucket);
      }
      bucket.accidents.add(accidentKey);
      const quote = residue.evidenceQuote.trim() || residue.rawText;
      if (
        bucket.samples.length < 3 &&
        quote &&
        !bucket.samples.some((sample) => sample.accidentKey === accidentKey && sample.quote === quote)
      ) {
        bucket.samples.push({ accidentKey, rawText: residue.rawText, quote });
      }
    }
  }
  const reviews = new Map(
    readReviews(reviewFile(paths)).map((review) => [`${review.fieldCode}\0${review.textKey}`, review]),
  );
  const names = new Map(MASTER_FIELD_SCHEMA.map((field) => [field.fieldCode, field.fieldName]));
  const { classify, authorityFor } = readPhraseClassifier(paths?.codeFile, paths?.bindingFile, paths?.tagFile);
  const rows: ObservationRow[] = [];
  for (const bucket of buckets.values()) {
    const review = reviews.get(`${bucket.fieldCode}\0${bucket.textKey}`);
    const confirmedWeight =
      review?.status === 'confirmed' && typeof review.weight === 'number' && review.weight > 0 ? review.weight : null;
    const status: ReviewStatus = confirmedWeight !== null ? 'confirmed' : review?.status === 'rejected' ? 'rejected' : 'pending';
    rows.push({
      fieldCode: bucket.fieldCode,
      fieldName: names.get(bucket.fieldCode) ?? bucket.fieldCode,
      textKey: bucket.textKey,
      rawText: bucket.rawText,
      reason: bucket.reason,
      accidentCount: bucket.accidents.size,
      status,
      weight: confirmedWeight,
      disposition: classify(bucket.fieldCode, bucket.textKey, review?.linkedDmz ?? null),
      authority: authorityFor(bucket.fieldCode),
      samples: bucket.samples,
    });
  }
  return rows;
}

function findRow(tasks: ObservationTask[], fieldCode: string, key: string, paths?: LedgerPaths): ObservationRow {
  const row = deriveRows(tasks, paths).find((item) => item.fieldCode === fieldCode && item.textKey === key);
  if (!row) throw new CodebookError('没有这条表外观察');
  return row;
}

function matches(row: ObservationRow, filter: ObservationFilter): boolean {
  if (filter.fieldCode && filter.fieldCode !== 'all' && row.fieldCode !== filter.fieldCode) return false;
  if (filter.status && filter.status !== 'all' && row.status !== filter.status) return false;
  const needle = filter.q?.trim().toLowerCase();
  if (!needle) return true;
  return [row.rawText, row.textKey, row.fieldName, row.fieldCode].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

function statsOf(rows: ObservationRow[]): ObservationStats {
  let pending = 0;
  let confirmed = 0;
  let rejected = 0;
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (row.status === 'pending') pending += 1;
    if (row.status === 'confirmed') confirmed += 1;
    if (row.status === 'rejected') rejected += 1;
    if (row.status !== 'confirmed' && row.status !== 'rejected') continue;
    denominator += row.accidentCount;
    if (row.status === 'confirmed' && row.weight) numerator += row.accidentCount * row.weight;
  }
  const reviewed = confirmed + rejected;
  return {
    pending,
    confirmed,
    rejected,
    termAccuracy: reviewed ? confirmed / reviewed : 0,
    weightedAccuracy: denominator ? numerator / denominator : 0,
  };
}

function reviewFile(paths?: LedgerPaths): string {
  return paths?.reviewFile ?? TAG_REVIEWS_FILE;
}

function readReviews(file: string): ReviewRecord[] {
  if (!fs.existsSync(file)) return [];
  let parsed: { reviews?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { reviews?: unknown };
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : '无法读取表外评估');
  }
  if (!Array.isArray(parsed.reviews)) return [];
  return parsed.reviews.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Partial<ReviewRecord>;
    if (typeof row.fieldCode !== 'string' || typeof row.textKey !== 'string') return [];
    const status: ReviewStatus =
      row.status === 'confirmed' || row.status === 'rejected' || row.status === 'pending' ? row.status : 'pending';
    const weight = typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : null;
    return [
      {
        fieldCode: row.fieldCode,
        textKey: row.textKey,
        status,
        weight,
        reviewerId: typeof row.reviewerId === 'string' ? row.reviewerId : '',
        reviewerName: typeof row.reviewerName === 'string' ? row.reviewerName : '',
        reviewedAt: typeof row.reviewedAt === 'string' ? row.reviewedAt : '',
        linkedDmz: typeof row.linkedDmz === 'string' ? row.linkedDmz : null,
      },
    ];
  });
}

function writeReviews(file: string, reviews: ReviewRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ format: 1, reviews }, null, 2)}\n`);
}
