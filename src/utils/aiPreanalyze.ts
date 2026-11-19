import {
  ENTITY_KIND_META,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  EntityItem,
  EntityKind,
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
  scanViolationLinkMatches,
  validateFieldRecord,
} from './goldRules';

export type AiMergeMode = 'merge_missing' | 'overwrite_drafts';

export interface AiExtractedEntity {
  id: string;
  kind: EntityKind;
  label: string;
  subtitle?: string;
  roleLabel?: string;
}

export interface AiExtractedFieldRecord {
  entityId: string;
  fieldCode: string;
  presenceStatus: PresenceStatus | string;
  rawValue: string;
  normalizedValues: string[];
  evidences: Array<{ page: number; quote: string }>;
}

export interface AiExtractedLegalItem {
  category: 'violation' | 'cause' | 'liability';
  subjectId: string;
  eventId?: string;
  presenceStatus: PresenceStatus | string;
  rawText: string;
  lawArticle?: string;
  conclusionLabel: string;
  evidences: Array<{ page: number; quote: string }>;
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
    const vocabOpts = buildControlledVocabOptions(def, supp).map((o) => o.value);
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

export function mapAiExtractionToCaseDraft(
  activeCase: CaseDocument,
  payload: AiPreanalyzePayload,
  options?: {
    supplements?: VocabularySupplementItem[];
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
    const existingByLabel = nextEntities.find(
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

  const maxPage = Math.max(1, activeCase.pageCount || 99);
  let idSeq = 0;

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

    const evidences = (Array.isArray(item.evidences) ? item.evidences : [])
      .filter((ev) => ev && typeof ev.quote === 'string' && ev.quote.trim().length > 0)
      .map((ev) => {
        idSeq += 1;
        return {
          id: `EV-AI-${Date.now().toString(36)}-${idSeq}`,
          page: Math.max(1, Math.min(maxPage, Math.round(Number(ev.page) || 1))),
          quote: ev.quote.trim(),
        };
      });

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
  const nextLegal: LegalConclusionItem[] = activeCase.legalConclusions.map((l) => ({
    ...l,
    evidences: l.evidences.map((ev) => ({ ...ev })),
  }));
  let createdLegalCount = 0;

  for (const rawLeg of payload.legalConclusions || []) {
    if (!['violation', 'cause', 'liability'].includes(rawLeg.category)) continue;
    const rawSubj = (rawLeg.subjectId || '').trim();
    const subjectId = entityIdMap.get(rawSubj) || rawSubj;
    const subjEnt = entityById.get(subjectId);
    if (!subjEnt || (subjEnt.kind !== 'P' && subjEnt.kind !== 'O')) continue;

    const rawEvId = (rawLeg.eventId || '').trim();
    const resolvedEventId = rawEvId ? entityIdMap.get(rawEvId) || rawEvId : '';
    const eventId =
      resolvedEventId && entityById.get(resolvedEventId)?.kind === 'E'
        ? resolvedEventId
        : '';

    const presenceStatus = normalizeAiPresenceStatus(rawLeg.presenceStatus);
    const rawText = (rawLeg.rawText || '').trim();
    const conclusionLabel = (rawLeg.conclusionLabel || '').trim();
    if (!rawText && !conclusionLabel) continue;

    const hasSubjectLiability =
      rawLeg.category === 'liability' &&
      nextLegal.some((l) => l.subjectId === subjectId && l.category === 'liability');

    const alreadyCovered = nextLegal.some(
      (l) =>
        l.subjectId === subjectId &&
        l.category === rawLeg.category &&
        (l.conclusionLabel === conclusionLabel || l.rawText === rawText || mergeMode === 'merge_missing'),
    );
    if (alreadyCovered || hasSubjectLiability) continue;

    idSeq += 1;
    const prefix =
      rawLeg.category === 'violation'
        ? 'VIO-AI'
        : rawLeg.category === 'cause'
          ? 'CAU-AI'
          : 'LIA-AI';
    const evidences = (Array.isArray(rawLeg.evidences) ? rawLeg.evidences : [])
      .filter((ev) => ev && typeof ev.quote === 'string' && ev.quote.trim().length > 0)
      .map((ev) => {
        idSeq += 1;
        return {
          id: `EV-AI-${Date.now().toString(36)}-${idSeq}`,
          page: Math.max(1, Math.min(maxPage, Math.round(Number(ev.page) || 1))),
          quote: ev.quote.trim(),
        };
      });

    const draftLegalItem: LegalConclusionItem = {
      id: `${prefix}-${idSeq}`,
      category: rawLeg.category,
      subjectId,
      eventId,
      presenceStatus,
      rawText,
      lawArticle: (rawLeg.lawArticle || '').trim(),
      conclusionLabel,
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
      const scan = scanViolationLinkMatches(draftLegalItem, nextEntities, supplements);
      const primaryHits = scan.vocabMatches.filter((m) => m.isPrimaryStandard);
      const hasExactLabel = primaryHits.some(
        (m) => m.standardTerm === draftLegalItem.conclusionLabel.trim(),
      );
      if (!hasExactLabel && primaryHits.length > 0) {
        draftLegalItem.conclusionLabel = primaryHits[0].standardTerm;
      }
    }

    nextLegal.push(draftLegalItem);
    createdLegalCount += 1;
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
