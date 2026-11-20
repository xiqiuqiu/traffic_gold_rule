import {
  ENTITY_KIND_META,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  EntityItem,
  EntityKind,
  EvidenceItem,
  FieldDefinition,
  FieldRecord,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
  VocabularySupplementItem,
} from '../types/gold';
import {
  buildControlledVocabOptions,
  deriveTimeBucket,
  generateNextEntityId,
  hasLiabilityScopeConflict,
  validateFieldRecord,
} from './goldRules';

import type { CatalogOptions } from '../types/catalog';
import { textKey } from '../server/catalog/textKey';
import { addViolationSources, legacyViolationSupports, reconcileViolationDrafts, sameBehaviorFact } from './violationDrafts';
import { legalFields, legalRows, matchLegalConclusion } from './legalCatalog';

export type AiMergeMode = 'merge_missing' | 'overwrite_drafts';

export interface AiExtractedEntity {
  id: string;
  kind: EntityKind;
  label: string;
  subtitle?: string;
  roleLabel?: string;
}

type AiEvidence = Omit<EvidenceItem, 'id'>;

export interface AiExtractedFieldRecord {
  entityId: string;
  fieldCode: string;
  presenceStatus: PresenceStatus | string;
  rawValue: string;
  normalizedValues: string[];
  evidences: AiEvidence[];
}

export interface AiExtractedLegalItem {
  category: 'violation' | 'cause' | 'liability';
  subjectId: string;
  eventId?: string;
  presenceStatus: PresenceStatus | string;
  rawText: string;
  lawArticle?: string;
  behaviorFact?: string;
  conclusionLabel: string;
  conclusionCode?: string;
  evidences: AiEvidence[];
}

export interface AiPreanalyzePayload {
  summary?: string;
  entities: AiExtractedEntity[];
  fieldRecords: AiExtractedFieldRecord[];
  legalConclusions?: AiExtractedLegalItem[];
}

export interface AiSchemaDescriptor {
  fieldCode: string;
  fieldName: string;
  groupCode: string;
  applicableKinds: EntityKind[];
  valueType: string;
  allowMultiple: boolean;
  isLegalOrRelation: boolean;
  options: string[];
  synonyms: string;
  definition: string;
}

export interface AiPreanalyzeMergeResult {
  nextCase: CaseDocument;
  summaryText: string;
  addedEntitiesCount: number;
  createdFieldsCount: number;
  updatedDraftFieldsCount: number;
  skippedProtectedFieldsCount: number;
  createdLegalCount: number;
  validDraftCount: number;
  errorDraftCount: number;
}

const VALID_ENTITY_KINDS = new Set<EntityKind>(['ACC', 'P', 'V', 'E', 'R', 'I', 'O']);

const VALID_PRESENCE_STATUSES = new Set<PresenceStatus>([
  'present',
  'explicit_negative',
  'not_mentioned',
  'not_applicable',
  'unreadable',
  'source_conflict',
  'needs_review',
]);

export function normalizeAiPresenceStatus(raw: string | undefined): PresenceStatus {
  const cleaned = (raw || '').trim() as PresenceStatus;
  if (VALID_PRESENCE_STATUSES.has(cleaned)) {
    return cleaned;
  }
  return 'needs_review';
}

export function buildAiSchemaCatalogPayload(
  supplements: VocabularySupplementItem[],
): AiSchemaDescriptor[] {
  const suppByCode = new Map(supplements.map((s) => [s.fieldCode, s]));
  return MASTER_FIELD_SCHEMA.map((def) => {
    const supp = suppByCode.get(def.fieldCode);
    const legal = Object.values(legalFields).some(code => code === def.fieldCode);
    const vocabOpts = legal ? [] : buildControlledVocabOptions(def, supp).map((o) => o.value);
    return {
      fieldCode: def.fieldCode,
      fieldName: def.fieldName,
      groupCode: def.groupCode,
      applicableKinds: def.applicableKinds,
      valueType: def.valueType,
      allowMultiple: def.allowMultiple,
      isLegalOrRelation: Boolean(def.isLegalOrRelation),
      options: vocabOpts,
      synonyms: supp?.synonyms || '',
      definition: supp?.definition || def.statusNote,
    };
  });
}

export function normalizeAiFieldValues(
  def: FieldDefinition,
  rawValues: string[],
  rawValueText: string,
  supplement?: VocabularySupplementItem,
): string[] {
  const vocabOptions = buildControlledVocabOptions(def, supplement);
  const cleanedInputs = rawValues.map((v) => v.trim()).filter(Boolean);

  if (def.fieldCode === 'D02.F007' && cleanedInputs.length === 0 && rawValueText.trim()) {
    const derived = deriveTimeBucket(rawValueText);
    if (derived) cleanedInputs.push(derived);
  }

  let mapped: string[];
  if (vocabOptions.length > 0) {
    mapped = cleanedInputs.map((candidate) => {
      const exact = vocabOptions.find((o) => o.value === candidate);
      if (exact) return exact.value;

      const lower = candidate.toLowerCase();
      const ciExact = vocabOptions.find((o) => o.value.toLowerCase() === lower);
      if (ciExact) return ciExact.value;

      const valueSubstringMatches = vocabOptions.filter(
        (o) => o.value.toLowerCase().includes(lower) || lower.includes(o.value.toLowerCase()),
      );
      if (valueSubstringMatches.length === 1) {
        return valueSubstringMatches[0].value;
      }

      // Score unique character overlap against option value (strip punctuation)
      const candChars = Array.from(
        new Set(lower.replace(/[（）()，,、。.\s/]/g, '').split('').filter(Boolean)),
      );
      if (candChars.length >= 2) {
        const scored = vocabOptions
          .map((o) => {
            const valLower = o.value.toLowerCase();
            const hits = candChars.filter((ch) => valLower.includes(ch)).length;
            return { value: o.value, hits };
          })
          .sort((a, b) => b.hits - a.hits);
        if (
          scored.length > 0 &&
          scored[0].hits >= 2 &&
          (scored.length === 1 || scored[0].hits > scored[1].hits)
        ) {
          return scored[0].value;
        }
      }

      return candidate;
    });
  } else {
    mapped = cleanedInputs;
  }

  const deduped = Array.from(new Set(mapped));
  return def.allowMultiple ? deduped : deduped.slice(0, 1);
}

function isValidEntityIdForKind(id: string, kind: EntityKind): boolean {
  if (kind === 'ACC') return id === 'ACC';
  const prefix = ENTITY_KIND_META[kind].prefix;
  return new RegExp(`^${prefix}\\d{2,}$`).test(id);
}

function sameViolation(a: LegalConclusionItem, b: LegalConclusionItem) {
  if (a.category !== 'violation' || a.subjectId !== b.subjectId || a.eventId !== b.eventId ||
      a.presenceStatus !== b.presenceStatus) return false;
  const factA = textKey(a.behaviorFact || a.rawText);
  const factB = textKey(b.behaviorFact || b.rawText);
  if (a.behaviorFact && b.behaviorFact) return sameBehaviorFact(a, b);
  if (a.behaviorFact || b.behaviorFact) return Boolean(factA && factA === factB);
  // Legacy responses can quote the same whole paragraph for two different acts.
  const label = (item: LegalConclusionItem) => textKey(item.conclusionCode || item.unmatchedConclusion || item.conclusionLabel);
  return factA === factB && label(a) === label(b) && Boolean(factA || label(a));
}

export function mapAiExtractionToCaseDraft(
  activeCase: CaseDocument,
  payload: AiPreanalyzePayload,
  options?: {
    supplements?: VocabularySupplementItem[];
    catalog?: CatalogOptions;
    mergeMode?: AiMergeMode;
    actorRole?: UserRole;
    actorLabel?: string;
    nowIso?: string;
  },
): AiPreanalyzeMergeResult {
  const supplements = options?.supplements || [];
  const mergeMode: AiMergeMode = options?.mergeMode || 'merge_missing';
  const actorRole: UserRole = options?.actorRole || 'annotator';
  const actorLabel = (options?.actorLabel || '').trim() || 'Gemini AI 预分析';
  const nowIso = options?.nowIso || new Date().toISOString();

  const schemaByCode = new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f]));
  const suppByCode = new Map(supplements.map((s) => [s.fieldCode, s]));

  const nextEntities: EntityItem[] = activeCase.entities.map((e) => ({ ...e }));
  const entityIdMap = new Map<string, string>();
  let addedEntitiesCount = 0;

  // Always anchor ACC
  entityIdMap.set('ACC', 'ACC');

  for (const rawEnt of payload.entities || []) {
    const kind = rawEnt.kind;
    if (!VALID_ENTITY_KINDS.has(kind)) continue;
    const rawId = (rawEnt.id || '').trim();
    const label = (rawEnt.label || '').trim();
    if (!label && kind !== 'ACC') continue;

    if (kind === 'ACC') {
      const accIdx = nextEntities.findIndex((e) => e.id === 'ACC');
      if (accIdx >= 0) {
        if (
          label &&
          (nextEntities[accIdx].label === '新建事故材料' ||
            nextEntities[accIdx].label === '整起事故')
        ) {
          nextEntities[accIdx] = {
            ...nextEntities[accIdx],
            label,
            subtitle: rawEnt.subtitle || nextEntities[accIdx].subtitle,
          };
        }
      } else {
        nextEntities.unshift({
          id: 'ACC',
          kind: 'ACC',
          label: label || '整起事故',
          subtitle: rawEnt.subtitle,
          roleLabel: rawEnt.roleLabel || '事故主体',
        });
        addedEntitiesCount += 1;
      }
      if (rawId) entityIdMap.set(rawId, 'ACC');
      continue;
    }

    // 1. Match existing by ID + kind
    const existingById = rawId
      ? nextEntities.find((e) => e.id === rawId && e.kind === kind)
      : undefined;
    if (existingById) {
      entityIdMap.set(rawId, existingById.id);
      continue;
    }

    // 2. Match existing by normalized label + kind
    const normLabel = label.replace(/\s+/g, '').toLowerCase();
    // Numbered collision stages can share a description (for example two separate rear-end collisions).
    const numberedEvent = kind === 'E' && isValidEntityIdForKind(rawId, kind);
    const existingByLabel = !numberedEvent && nextEntities.find(
      (e) =>
        e.kind === kind &&
        e.label.replace(/\s+/g, '').toLowerCase() === normLabel,
    );
    if (existingByLabel) {
      if (rawId) entityIdMap.set(rawId, existingByLabel.id);
      continue;
    }

    // 3. Allocate ID and append new entity
    const idTaken = Boolean(rawId && nextEntities.some((e) => e.id === rawId));
    const allocatedId =
      rawId && !idTaken && isValidEntityIdForKind(rawId, kind)
        ? rawId
        : generateNextEntityId(kind, nextEntities);

    nextEntities.push({
      id: allocatedId,
      kind,
      label,
      subtitle: rawEnt.subtitle?.trim() || undefined,
      roleLabel: rawEnt.roleLabel?.trim() || rawEnt.subtitle?.trim() || ENTITY_KIND_META[kind].label,
    });
    if (rawId) entityIdMap.set(rawId, allocatedId);
    entityIdMap.set(allocatedId, allocatedId);
    addedEntitiesCount += 1;
  }

  const entityById = new Map(nextEntities.map((e) => [e.id, e]));
  const nextFieldRecords: FieldRecord[] = activeCase.fieldRecords.map((r) => ({
    ...r,
    normalizedValues: [...r.normalizedValues],
    evidences: r.evidences.map((ev) => ({ ...ev })),
  }));

  let createdFieldsCount = 0;
  let updatedDraftFieldsCount = 0;
  let skippedProtectedFieldsCount = 0;
  const touchedDraftKeys = new Set<string>();

  let idSeq = 0;
  function mapEvidences(input: AiEvidence[]): EvidenceItem[] {
    return (Array.isArray(input) ? input : [])
      .filter(ev => ev && typeof ev.quote === 'string' && ev.quote.trim())
      .map(ev => ({
        id: `EV-AI-${Date.now().toString(36)}-${++idSeq}`,
        page: ev.page,
        quote: ev.quote.trim(),
        ...(ev.lineIds === undefined ? {} : {
          lineIds: Array.isArray(ev.lineIds) && ev.lineIds.every(id => typeof id === 'string') ? ev.lineIds : [],
        }),
      }));
  }

  for (const item of payload.fieldRecords || []) {
    const def = schemaByCode.get((item.fieldCode || '').trim());
    if (!def || def.isLegalOrRelation) continue;

    const rawEntId = (item.entityId || '').trim();
    const resolvedEntityId = entityIdMap.get(rawEntId) || rawEntId;
    const targetEntity = entityById.get(resolvedEntityId);
    if (!targetEntity || !def.applicableKinds.includes(targetEntity.kind)) {
      continue;
    }

    const presenceStatus = normalizeAiPresenceStatus(item.presenceStatus);
    const presenceMeta = PRESENCE_STATUS_META[presenceStatus];

    const rawValue = presenceMeta.forbidsValue ? '' : (item.rawValue || '').trim();
    const supp = suppByCode.get(def.fieldCode);
    const normalizedValues = presenceMeta.forbidsValue
      ? []
      : normalizeAiFieldValues(
          def,
          Array.isArray(item.normalizedValues) ? item.normalizedValues : [],
          rawValue,
          supp,
        );

    const evidences = mapEvidences(item.evidences);

    // Skip empty non-informative extractions when presence is not_mentioned and nothing existed
    const existingIdx = nextFieldRecords.findIndex(
      (r) => r.entityId === resolvedEntityId && r.fieldCode === def.fieldCode,
    );

    if (existingIdx >= 0) {
      const existing = nextFieldRecords[existingIdx];
      const isProtectedStatus =
        existing.reviewStatus === 'checked' ||
        existing.reviewStatus === 'specialist_review';

      if (isProtectedStatus) {
        skippedProtectedFieldsCount += 1;
        continue;
      }

      if (mergeMode === 'merge_missing') {
        const hasExistingContent =
          existing.reviewStatus === 'disputed' ||
          Boolean(existing.rawValue.trim()) ||
          existing.normalizedValues.length > 0 ||
          existing.evidences.length > 0 ||
          PRESENCE_STATUS_META[existing.presenceStatus].forbidsValue;
        if (hasExistingContent) {
          skippedProtectedFieldsCount += 1;
          continue;
        }
      }

      nextFieldRecords[existingIdx] = {
        ...existing,
        presenceStatus,
        rawValue,
        normalizedValues,
        evidences,
        reviewStatus: 'draft',
        disputeReason: '',
        updatedByRole: actorRole,
        updatedAt: nowIso,
      };
      updatedDraftFieldsCount += 1;
      touchedDraftKeys.add(`${resolvedEntityId}:${def.fieldCode}`);
    } else {
      idSeq += 1;
      const newRecord: FieldRecord = {
        recordId: `FR-AI-${Date.now().toString(36)}-${idSeq}`,
        entityId: resolvedEntityId,
        fieldCode: def.fieldCode,
        presenceStatus,
        rawValue,
        normalizedValues,
        evidences,
        reviewStatus: 'draft',
        disputeReason: '',
        adjudicatorNote: '',
        updatedByRole: actorRole,
        updatedAt: nowIso,
      };
      nextFieldRecords.push(newRecord);
      createdFieldsCount += 1;
      touchedDraftKeys.add(`${resolvedEntityId}:${def.fieldCode}`);
    }
  }

  // Optional legal conclusion drafts if returned by Gemini
  const nextLegal: LegalConclusionItem[] = reconcileViolationDrafts(activeCase.legalConclusions).map((l) => ({
    ...l,
    evidences: l.evidences.map((ev) => ({ ...ev })),
  }));
  let createdLegalCount = 0;
  const violationGroups: LegalConclusionItem[][] = [];

  for (const rawLeg of payload.legalConclusions || []) {
    if (!['violation', 'cause', 'liability'].includes(rawLeg.category)) continue;
    const rawSubj = (rawLeg.subjectId || '').trim();
    const subjectId = entityIdMap.get(rawSubj) || rawSubj;
    const subjEnt = entityById.get(subjectId);
    if (!subjEnt || (subjEnt.kind !== 'P' && subjEnt.kind !== 'O')) continue;

    const rawEvId = (rawLeg.eventId || '').trim();
    const resolvedEventId = rawEvId ? entityIdMap.get(rawEvId) || rawEvId : '';
    const isLiability = rawLeg.category === 'liability';
    // Keep an unknown liability event visible for review instead of turning it into a whole-accident claim.
    const eventId = isLiability || entityById.get(resolvedEventId)?.kind === 'E' ? resolvedEventId : '';

    const presenceStatus = normalizeAiPresenceStatus(rawLeg.presenceStatus);
    const rawText = (rawLeg.rawText || '').trim();
    const conclusionLabel = (rawLeg.conclusionLabel || '').trim();
    const behaviorFact = rawLeg.category === 'violation' && typeof rawLeg.behaviorFact === 'string'
      ? rawLeg.behaviorFact.trim() : '';
    if (!rawText && !behaviorFact && !conclusionLabel && !rawLeg.conclusionCode) continue;
    const row = matchLegalConclusion(legalRows(options?.catalog ?? {}, rawLeg.category), conclusionLabel || behaviorFact || rawText, rawLeg.conclusionCode);

    const alreadyCovered = rawLeg.category !== 'violation' && nextLegal.some((l) => {
      if (l.subjectId !== subjectId || l.category !== rawLeg.category) return false;
      if (isLiability) return hasLiabilityScopeConflict(l, { subjectId, eventId });
      return (row && l.conclusionCode === row.code && l.eventId === eventId) || (rawText && l.rawText === rawText) ||
        (mergeMode === 'merge_missing' && activeCase.legalConclusions.some(original => original.id === l.id));
    });
    if (alreadyCovered) continue;

    idSeq += 1;
    const prefix =
      rawLeg.category === 'violation'
        ? 'VIO-AI'
        : rawLeg.category === 'cause'
          ? 'CAU-AI'
          : 'LIA-AI';
    const evidences = mapEvidences(rawLeg.evidences);

    while (nextLegal.some(item => item.id === `${prefix}-${idSeq}`)) idSeq += 1;
    const draftLegalItem: LegalConclusionItem = {
      id: `${prefix}-${idSeq}`,
      category: rawLeg.category,
      subjectId,
      eventId,
      presenceStatus,
      rawText: rawText || behaviorFact,
      ...(behaviorFact ? { behaviorFact } : {}),
      lawArticle: (rawLeg.lawArticle || '').trim(),
      conclusionCode: row?.code ?? '',
      conclusionLabel: row?.value ?? '',
      unmatchedConclusionCode: row ? undefined : rawLeg.conclusionCode || undefined,
      unmatchedConclusion: row ? undefined : conclusionLabel || rawLeg.conclusionCode || behaviorFact || rawText,
      causalLinkStatus: rawLeg.category === 'liability' ? undefined : 'unspecified',
      linkedViolationIds: [],
      linkedCauseIds: [],
      linkedEntityIds: [],
      linkedVocabTerms: [],
      linkConsistencyConfirmed: false,
      evidences,
      reviewStatus: 'draft',
      disputeReason: '',
      adjudicatorNote: '',
    };

    if (draftLegalItem.category === 'violation') {
      const group = violationGroups.find(([first]) => sameViolation(first, draftLegalItem));
      if (group) group.push(draftLegalItem);
      else violationGroups.push([draftLegalItem]);
    } else {
      nextLegal.push(draftLegalItem);
      createdLegalCount += 1;
    }
  }

  const violations = violationGroups.map(group => {
    const [item, ...otherMentions] = group;
    for (const other of otherMentions) addViolationSources(item, other);
    if (group.some(other => other.conclusionCode !== item.conclusionCode)) {
      item.unmatchedConclusion = [...new Set(group.map(v => v.conclusionCode
        ? `${v.conclusionLabel}（${v.conclusionCode}）` : v.unmatchedConclusion))].join(' / ');
      item.unmatchedConclusionCode = undefined;
      item.conclusionCode = '';
      item.conclusionLabel = '';
    }
    return item;
  });
  const storedViolations = nextLegal.filter(item => item.category === 'violation');
  const matchedIds = new Set<string>();
  for (const item of violations) {
    let existing = storedViolations.find(record => sameViolation(record, item));
    if (!existing) {
      // Old drafts can summarize several acts in one paragraph. Reuse an ID only for an unambiguous fact and citation.
      const possible = storedViolations.filter(record => legacyViolationSupports(record, item));
      if (possible.length === 1 && violations.filter(other => legacyViolationSupports(possible[0], other)).length === 1) {
        existing = possible[0];
      }
    }
    if (!existing || matchedIds.has(existing.id)) {
      nextLegal.push(item);
      createdLegalCount += 1;
    } else {
      matchedIds.add(existing.id);
      if (existing.reviewStatus !== 'draft') continue;
      addViolationSources(existing, item);
      if (item.behaviorFact) existing.behaviorFact ??= item.behaviorFact;
      if (!existing.conclusionCode) {
        existing.conclusionCode = item.conclusionCode;
        existing.conclusionLabel = item.conclusionLabel;
        existing.unmatchedConclusion = item.unmatchedConclusion;
        existing.unmatchedConclusionCode = item.unmatchedConclusionCode;
      }
    }
  }

  let validDraftCount = 0;
  let errorDraftCount = 0;
  for (const r of nextFieldRecords) {
    if (!touchedDraftKeys.has(`${r.entityId}:${r.fieldCode}`)) continue;
    const hasErr =
      PRESENCE_STATUS_META[r.presenceStatus].blocksScoring ||
      validateFieldRecord(r).some((i) => i.severity === 'error');
    if (hasErr) errorDraftCount += 1;
    else validDraftCount += 1;
  }

  const summaryText =
    (payload.summary || '').trim() ||
    `已提取 ${createdFieldsCount + updatedDraftFieldsCount} 条字段初稿`;

  const nextCase: CaseDocument = {
    ...activeCase,
    entities: nextEntities,
    fieldRecords: nextFieldRecords,
    legalConclusions: nextLegal,
    auditLog: [
      {
        id: `LOG-AI-${Date.now().toString(36)}`,
        timestamp: nowIso,
        actorRole,
        actorName: actorLabel,
        action: 'AI 预分析生成字段初稿',
        targetRef: activeCase.caseId,
        comment: `新增对象 ${addedEntitiesCount} 个，新建字段 ${createdFieldsCount} 条，更新草稿 ${updatedDraftFieldsCount} 条（校验通过 ${validDraftCount} / 待核对 ${errorDraftCount}）`,
      },
      ...activeCase.auditLog,
    ],
  };

  return {
    nextCase,
    summaryText,
    addedEntitiesCount,
    createdFieldsCount,
    updatedDraftFieldsCount,
    skippedProtectedFieldsCount,
    createdLegalCount,
    validDraftCount,
    errorDraftCount,
  };
}
