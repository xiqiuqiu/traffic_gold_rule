import { getVerifiedLiabilitySource } from './liabilitySourceKey';
import {
  ACCEPTANCE_CHECKLIST_ITEMS,
  ENTITY_KIND_META,
  INITIAL_VOCABULARY_SUPPLEMENTS,
  MASTER_FIELD_SCHEMA,
  VIOLATION_REFERENCE_TERMS,
  PRESENCE_STATUS_META,
  REVIEW_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  CaseWorkItem,
  ChainConsistencyCheck,
  ChainEvidenceEntry,
  EntityItem,
  EntityKind,
  EntityProgressSummary,
  EventRelationItem,
  EvidenceItem,
  FieldDefinition,
  FieldFilterBucket,
  FieldRecord,
  LegalConclusionItem,
  LegalEvidenceChain,
  MatchedPdfParagraph,
  PresenceStatus,
  ReadinessSummary,
  ReviewStatus,
  ValidationIssue,
  ViolationEntityMatch,
  ViolationLinkScanResult,
  ViolationVocabMatch,
  VocabularySupplementItem,
  WorkItemFilterStatus,
} from '../types/gold';

export function generateNextEntityId(kind: EntityKind, existing: EntityItem[]): string {
  if (kind === 'ACC') {
    return 'ACC';
  }
  const prefix = ENTITY_KIND_META[kind].prefix;
  let maxNum = 0;
  for (const item of existing) {
    if (item.kind === kind && item.id.startsWith(prefix)) {
      const num = parseInt(item.id.slice(prefix.length), 10);
      if (!Number.isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  const next = maxNum + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}

export function cleanSelectedPdfQuote(rawText: string): string {
  if (!rawText) return '';
  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/([0-9A-Za-z\u4e00-\u9fa5])\n([0-9A-Za-z\u4e00-\u9fa5])/g, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function deriveTimeBucket(dateTimeRaw: string): string {
  if (!dateTimeRaw) return '';
  const hourMatch = dateTimeRaw.match(/(\d{1,2})\s*[:时]/);
  if (!hourMatch) return '';
  const hour = parseInt(hourMatch[1], 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return '';
  if (hour >= 0 && hour < 6) return '凌晨 (00:00-05:59)';
  if (hour >= 6 && hour < 12) return '早高峰/上午 (06:00-11:59)';
  if (hour >= 12 && hour < 18) return '午后 (12:00-17:59)';
  return '晚间/夜间 (18:00-23:59)';
}

export function maskPiiText(text: string): string {
  if (!text) return text;
  // Mask 18-digit Chinese resident IDs (keep first 4 and last 2)
  let masked = text.replace(/\b(\d{4})\d{12}(\d[\dXx])\b/g, '$1************$2');
  // Mask 11-digit mobile phone numbers starting with 1
  masked = masked.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');
  // Mask passport numbers following 护照: or 护照号
  masked = masked.replace(/(护照[:：]\s*[A-Za-z0-9]{2})[A-Za-z0-9]{3,}([A-Za-z0-9]{2})/g, '$1****$2');
  return masked;
}

export function validateFieldRecord(record: FieldRecord): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const statusRule = PRESENCE_STATUS_META[record.presenceStatus];

  if (statusRule.requiresValueAndEvidence) {
    if (!record.rawValue.trim()) {
      issues.push({
        code: 'MISSING_RAW_VALUE',
        severity: 'error',
        message: `状态为“${statusRule.label}”时必须填写原文值`,
      });
    }
    const validEvidences = record.evidences.filter((e) => e.page >= 1 && e.quote.trim().length > 0);
    if (validEvidences.length === 0) {
      issues.push({
        code: 'MISSING_EVIDENCE',
        severity: 'error',
        message: `状态为“${statusRule.label}”时必须附带至少 1 条有效页码与最短证据摘录`,
      });
    }
  }

  if (statusRule.forbidsValue && (record.rawValue.trim() || record.normalizedValues.length > 0)) {
    issues.push({
      code: 'VALUE_FORBIDDEN_FOR_STATUS',
      severity: 'error',
      message: `状态为“${statusRule.label}”时禁止填写原文值或归一值（沉默不等于否定）`,
    });
  }

  if (record.reviewStatus === 'disputed' && !record.disputeReason.trim()) {
    issues.push({
      code: 'DISPUTE_REASON_REQUIRED',
      severity: 'warning',
      message: '标记为“争议中”时建议填写具体分歧原因',
    });
  }

  if (record.reviewStatus === 'specialist_review' && !record.adjudicatorNote.trim()) {
    issues.push({
      code: 'ADJUDICATION_NOTE_REQUIRED',
      severity: 'warning',
      message: '完成“专业裁定”时建议记录裁定理由',
    });
  }

  return issues;
}

function isNoLiability(item: LegalConclusionItem) {
  return item.conclusionCode === undefined ? item.conclusionLabel.trim() === '无责任' : item.conclusionCode === '5';
}

export function validateLegalConclusion(
  item: LegalConclusionItem,
  context?: {
    entities?: EntityItem[];
    supplements?: VocabularySupplementItem[];
    allLegalConclusions?: LegalConclusionItem[];
  },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const statusRule = PRESENCE_STATUS_META[item.presenceStatus];

  if (item.presenceStatus === 'present' && item.conclusionCode === '') {
    issues.push({ code: 'UNMAPPED_LEGAL_CONCLUSION', severity: 'error', message: '标准结论待核对，请选择对应的码表项。' });
  }

  if (!item.subjectId) {
    issues.push({
      code: 'MISSING_SUBJECT',
      severity: 'error',
      message: '法律结论必须绑定明确的主体（如 P01 或 O01）',
    });
  }

  if (statusRule.requiresValueAndEvidence) {
    if (!item.rawText.trim()) {
      issues.push({
        code: 'MISSING_RAW_VALUE',
        severity: 'error',
        message: '必须保留文书原文结论表述',
      });
    }
    const validEvidences = item.evidences.filter((e) => e.page >= 1 && e.quote.trim().length > 0);
    if (validEvidences.length === 0) {
      issues.push({
        code: 'MISSING_EVIDENCE',
        severity: 'error',
        message: '法律结论必须附带准确页码与最短原文证据',
      });
    }
  }

  if (item.category === 'violation' && context?.entities) {
    const scan = scanViolationLinkMatches(
      item,
      context.entities,
      context.supplements || INITIAL_VOCABULARY_SUPPLEMENTS,
    );
    if (scan.needsConfirmationError) {
      issues.push({
        code: 'VIOLATION_LINK_CONSISTENCY_UNCONFIRMED',
        severity: 'error',
        message: `已扫描到 ${scan.vocabMatches.length} 项受控词表与 ${scan.entityMatches.length} 项案件实体匹配，请一键关联并确认关联一致性`,
      });
    }
  }

  if (
    item.category === 'cause' &&
    (item.causalLinkStatus === 'explicit_linked' || item.causalLinkStatus === 'multiple_mixed') &&
    (!item.linkedViolationIds || item.linkedViolationIds.length === 0)
  ) {
    issues.push({
      code: 'MISSING_LINKED_VIOLATION',
      severity: 'warning',
      message: '已标记“明确关联违法 / 多因混合”，请勾选或补录对应的违法行为记录',
    });
  }

  if (
    item.category === 'liability' &&
    item.presenceStatus === 'present' &&
    item.conclusionLabel.trim() &&
    !isNoLiability(item) &&
    (!item.linkedCauseIds || item.linkedCauseIds.length === 0)
  ) {
    issues.push({
      code: 'MISSING_LINKED_CAUSE',
      severity: 'warning',
      message: '有责结论建议关联或补录对应的认定事故原因记录',
    });
  }

  if (item.category === 'liability' && item.subjectId && context?.allLegalConclusions) {
    const sameSubjectLiabilities = context.allLegalConclusions.filter(
      (l) => l.category === 'liability' && hasLiabilityScopeConflict(l, item),
    );
    if (sameSubjectLiabilities.length > 1) {
      issues.push({
        code: 'DUPLICATE_SUBJECT_LIABILITY',
        severity: 'error',
        message: `主体 ${item.subjectId} 在同一事故阶段存在 ${sameSubjectLiabilities.length} 条责任划分记录`,
      });
    }
  }

  return issues;
}

const LEGAL_CATEGORY_ORDER: Record<LegalConclusionItem['category'], number> = {
  violation: 0,
  cause: 1,
  liability: 2,
};

export function sortLegalConclusionsByChain(
  items: LegalConclusionItem[],
): LegalConclusionItem[] {
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const catDiff =
        LEGAL_CATEGORY_ORDER[a.item.category] - LEGAL_CATEGORY_ORDER[b.item.category];
      return catDiff !== 0 ? catDiff : a.idx - b.idx;
    })
    .map((entry) => entry.item);
}

export function validateRelation(item: EventRelationItem): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!item.sourceId || !item.targetId || !item.action.trim()) {
    issues.push({
      code: 'INCOMPLETE_RELATION',
      severity: 'error',
      message: '事件关系必须完整填写施动主体、动作与受动对象',
    });
  }
  const validEvidences = item.evidences.filter((e) => e.page >= 1 && e.quote.trim().length > 0);
  if (validEvidences.length === 0) {
    issues.push({
      code: 'MISSING_EVIDENCE',
      severity: 'error',
      message: '事件关系必须附带页码与最短原文证据',
    });
  }
  return issues;
}

export function computeCaseReadiness(
  caseDoc: CaseDocument,
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): ReadinessSummary {
  const statusCounts: Record<ReviewStatus, number> = {
    draft: 0,
    checked: 0,
    disputed: 0,
    specialist_review: 0,
  };

  let blockingPresenceCount = 0;
  let validationErrors = 0;

  for (const r of caseDoc.fieldRecords) {
    statusCounts[r.reviewStatus] += 1;
    if (PRESENCE_STATUS_META[r.presenceStatus].blocksScoring) {
      blockingPresenceCount += 1;
    }
    const issues = validateFieldRecord(r);
    validationErrors += issues.filter((i) => i.severity === 'error').length;
  }

  for (const l of caseDoc.legalConclusions) {
    statusCounts[l.reviewStatus] += 1;
    if (PRESENCE_STATUS_META[l.presenceStatus].blocksScoring) {
      blockingPresenceCount += 1;
    }
    const issues = validateLegalConclusion(l, {
      entities: caseDoc.entities,
      supplements,
      allLegalConclusions: caseDoc.legalConclusions,
    });
    validationErrors += issues.filter((i) => i.severity === 'error').length;
  }

  for (const rel of caseDoc.relations) {
    statusCounts[rel.reviewStatus] += 1;
    const issues = validateRelation(rel);
    validationErrors += issues.filter((i) => i.severity === 'error').length;
  }

  const checklistTotalCount = ACCEPTANCE_CHECKLIST_ITEMS.length;
  const checklistCheckedCount = ACCEPTANCE_CHECKLIST_ITEMS.filter(
    (item) => caseDoc.checklist[item.id] === true,
  ).length;

  const totalItems =
    caseDoc.fieldRecords.length + caseDoc.legalConclusions.length + caseDoc.relations.length;

  const blockingReasons: string[] = [];
  if (totalItems === 0) {
    blockingReasons.push('尚无任何标注记录');
  }
  if (statusCounts.draft > 0) {
    blockingReasons.push(`仍有 ${statusCounts.draft} 条记录处于“草稿”状态，尚未复核`);
  }
  if (statusCounts.disputed > 0) {
    blockingReasons.push(`仍有 ${statusCounts.disputed} 条记录处于“争议中”，尚未完成专业裁定`);
  }
  if (blockingPresenceCount > 0) {
    blockingReasons.push(`存在 ${blockingPresenceCount} 条“无法辨认 / 来源冲突 / 待判断”阻断状态记录`);
  }
  if (validationErrors > 0) {
    blockingReasons.push(`存在 ${validationErrors} 处字段/证据规则校验错误`);
  }
  if (checklistCheckedCount < checklistTotalCount) {
    blockingReasons.push(`10 项交付验收清单尚有 ${checklistTotalCount - checklistCheckedCount} 项未确认`);
  }

  const eligibleForScoring = blockingReasons.length === 0;

  return {
    totalFieldRecords: caseDoc.fieldRecords.length,
    totalLegalItems: caseDoc.legalConclusions.length,
    totalRelations: caseDoc.relations.length,
    statusCounts,
    blockingPresenceCount,
    validationErrors,
    checklistCheckedCount,
    checklistTotalCount,
    eligibleForScoring,
    blockingReasons,
  };
}

function exportLiabilitySource(item: LegalConclusionItem, doc: CaseDocument, mask: (text: string) => string) {
  const source = getVerifiedLiabilitySource(item, doc);
  if (!source) return {};
  return { source_location: {
    file_sha256: source.fileSha256, extraction_version: source.extractionVersion,
    page: source.page, quote: mask(source.quote),
    lines: source.lines.map(({ lineId, lineNumber, bbox }) => ({ line_id: lineId, line_number: lineNumber, bbox })),
  } };
}

export function buildGoldExportPayload(caseDoc: CaseDocument, maskPii: boolean) {
  const readiness = computeCaseReadiness(caseDoc);
  const schemaByCode = new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f]));

  const maybeMask = (value: string, forceMask = false) => {
    if (!maskPii) return value;
    if (forceMask) return '[REDACTED_PII]';
    return maskPiiText(value);
  };

  return {
    meta: {
      case_id: caseDoc.caseId,
      pilot_code: caseDoc.pilotCode,
      source_filename: caseDoc.sourceFilename,
      file_sha256: caseDoc.fileSha256,
      page_count: caseDoc.pageCount,
      manual_version: caseDoc.manualVersion,
      annotation_version: caseDoc.annotationVersion,
      eligible_for_scoring: readiness.eligibleForScoring,
      blocking_reasons: readiness.blockingReasons,
      pii_masked: maskPii,
      roles: {
        annotator: caseDoc.annotatorName,
        reviewer: caseDoc.reviewerName,
        adjudicator: caseDoc.adjudicatorName || null,
      },
      exported_at: new Date().toISOString(),
    },
    entities: {
      accident: caseDoc.entities.filter((e) => e.kind === 'ACC'),
      parties: caseDoc.entities.filter((e) => e.kind === 'P'),
      vehicles: caseDoc.entities.filter((e) => e.kind === 'V'),
      events: caseDoc.entities.filter((e) => e.kind === 'E'),
      roads: caseDoc.entities.filter((e) => e.kind === 'R'),
      intersections: caseDoc.entities.filter((e) => e.kind === 'I'),
      organizations: caseDoc.entities.filter((e) => e.kind === 'O'),
    },
    field_records: caseDoc.fieldRecords.map((r) => {
      const def = schemaByCode.get(r.fieldCode);
      const isSensitive = Boolean(def?.isSensitivePii);
      return {
        record_id: r.recordId,
        entity_id: r.entityId,
        field_code: r.fieldCode,
        field_name: def?.fieldName ?? r.fieldCode,
        presence_status: r.presenceStatus,
        raw_value: r.rawValue ? maybeMask(r.rawValue, isSensitive && maskPii) : null,
        normalized_values: r.normalizedValues,
        evidences: r.evidences.map((ev) => ({
          page: ev.page,
          quote: maybeMask(ev.quote, false),
        })),
        review_status: r.reviewStatus,
        eligible_for_scoring:
          REVIEW_STATUS_META[r.reviewStatus].eligibleForScoring &&
          !PRESENCE_STATUS_META[r.presenceStatus].blocksScoring,
        dispute_reason: r.disputeReason || null,
        adjudicator_note: r.adjudicatorNote || null,
      };
    }),
    legal_conclusions: {
      violations: caseDoc.legalConclusions
        .filter((l) => l.category === 'violation')
        .map((l) => ({
          id: l.id,
          subject_id: l.subjectId,
          event_id: l.eventId || null,
          presence_status: l.presenceStatus,
          law_article: l.lawArticle || null,
          conclusion_code: l.conclusionCode || null,
          conclusion_label: l.conclusionLabel || null,
          raw_text: maybeMask(l.rawText),
          evidences: l.evidences.map((ev) => ({ page: ev.page, quote: maybeMask(ev.quote) })),
          review_status: l.reviewStatus,
          dispute_reason: l.disputeReason || null,
          adjudicator_note: l.adjudicatorNote || null,
        })),
      causes: caseDoc.legalConclusions
        .filter((l) => l.category === 'cause')
        .map((l) => ({
          id: l.id,
          subject_id: l.subjectId,
          event_id: l.eventId || null,
          presence_status: l.presenceStatus,
          conclusion_code: l.conclusionCode || null,
          conclusion_label: l.conclusionLabel || null,
          raw_text: maybeMask(l.rawText),
          evidences: l.evidences.map((ev) => ({ page: ev.page, quote: maybeMask(ev.quote) })),
          review_status: l.reviewStatus,
          dispute_reason: l.disputeReason || null,
          adjudicator_note: l.adjudicatorNote || null,
        })),
      liabilities: caseDoc.legalConclusions
        .filter((l) => l.category === 'liability')
        .map((l) => ({
          ...exportLiabilitySource(l, caseDoc, maybeMask),
          id: l.id,
          subject_id: l.subjectId,
          event_id: l.eventId || null,
          presence_status: l.presenceStatus,
          law_article: l.lawArticle || null,
          conclusion_code: l.conclusionCode || null,
          conclusion_label: l.conclusionLabel || null,
          raw_text: maybeMask(l.rawText),
          evidences: l.evidences.map((ev) => ({ page: ev.page, quote: maybeMask(ev.quote) })),
          review_status: l.reviewStatus,
          dispute_reason: l.disputeReason || null,
          adjudicator_note: l.adjudicatorNote || null,
        })),
    },
    relations: caseDoc.relations.map((rel) => ({
      id: rel.id,
      event_id: rel.eventId,
      stage_order: rel.stageOrder,
      source_id: rel.sourceId,
      action: rel.action,
      target_id: rel.targetId,
      collision_mode: rel.collisionMode || null,
      direction_note: rel.directionNote || null,
      evidences: rel.evidences.map((ev) => ({ page: ev.page, quote: maybeMask(ev.quote) })),
      review_status: rel.reviewStatus,
      dispute_reason: rel.disputeReason || null,
      adjudicator_note: rel.adjudicatorNote || null,
    })),
    acceptance_checklist: {
      items: caseDoc.checklist,
      checked_count: readiness.checklistCheckedCount,
      total_count: readiness.checklistTotalCount,
      passed: readiness.checklistCheckedCount === readiness.checklistTotalCount,
    },
    audit_log: caseDoc.auditLog,
  };
}

export function cleanRelationEntityId(rawId: string): string {
  const trimmed = rawId.trim();
  const match = trimmed.match(/^(ACC|[PVEORI]\d{2})(?=[\s（(]|$)/);
  return match ? match[1] : trimmed;
}

export function buildGoldV02ExportPayload(caseDoc: CaseDocument, maskPii: boolean) {
  const schemaByCode = new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f]));
  const docId = caseDoc.documentId || caseDoc.caseId.toLowerCase();

  const maybeMask = (value: string, forceMask = false) => {
    if (!maskPii) return value;
    if (forceMask) return '[REDACTED_PII]';
    return maskPiiText(value);
  };

  const mapEvidence = (ev: EvidenceItem) => ({
    source_document_id: docId,
    page: ev.page,
    excerpt: maybeMask(ev.quote, false),
  });

  const facts: Array<Record<string, unknown>> = [];
  for (const r of caseDoc.fieldRecords) {
    const def = schemaByCode.get(r.fieldCode);
    const isSensitive = Boolean(def?.isSensitivePii);
    const forbidsValue = PRESENCE_STATUS_META[r.presenceStatus].forbidsValue;

    if (forbidsValue) {
      facts.push({
        record_id: r.recordId,
        field_code: r.fieldCode,
        subject_id: r.entityId,
        presence: r.presenceStatus,
        claim_type: 'document_fact',
        evidence: r.evidences.map(mapEvidence),
        review: r.reviewStatus,
      });
      continue;
    }

    if (r.normalizedValues.length > 1) {
      r.normalizedValues.forEach((val, idx) => {
        const suffix = String.fromCharCode(65 + idx);
        const pairedEvidences =
          r.evidences.length === r.normalizedValues.length ? [r.evidences[idx]] : r.evidences;
        const item: Record<string, unknown> = {
          record_id: `${r.recordId}-${suffix}`,
          field_code: r.fieldCode,
          subject_id: r.entityId,
          presence: r.presenceStatus,
        };
        if (r.rawValue) {
          item.raw_value = maybeMask(r.rawValue, isSensitive && maskPii);
        }
        item.candidate_value = val;
        item.claim_type = 'document_fact';
        item.evidence = pairedEvidences.map(mapEvidence);
        item.review = r.reviewStatus;
        facts.push(item);
      });
      continue;
    }

    const singleItem: Record<string, unknown> = {
      record_id: r.recordId,
      field_code: r.fieldCode,
      subject_id: r.entityId,
      presence: r.presenceStatus,
    };
    if (r.rawValue) {
      singleItem.raw_value = maybeMask(r.rawValue, isSensitive && maskPii);
    }
    if (r.normalizedValues[0]) {
      singleItem.candidate_value = r.normalizedValues[0];
    }
    singleItem.claim_type = 'document_fact';
    singleItem.evidence = r.evidences.map(mapEvidence);
    singleItem.review = r.reviewStatus;
    facts.push(singleItem);
  }

  const legal_records = caseDoc.legalConclusions
    .filter((l) => l.category === 'violation' || l.category === 'cause')
    .map((l) => {
      const record: Record<string, unknown> = {
        record_id: l.id,
        kind: l.category,
        field_code: l.category === 'violation' ? 'D10.F058' : 'D10.F059',
        subject_id: l.subjectId,
        presence: l.presenceStatus,
      };
      if (l.rawText) {
        record.raw_value = maybeMask(l.rawText, false);
      }
      if (l.conclusionLabel) {
        record.candidate_value = l.conclusionLabel;
        if (l.conclusionCode) record.conclusion_code = l.conclusionCode;
      }
      record.causal_link_status = l.causalLinkStatus || 'unspecified';
      record.linked_violation_record_ids = l.linkedViolationIds || [];
      record.evidence = l.evidences.map(mapEvidence);
      record.review = l.reviewStatus;
      return record;
    });

  const responsibilities = caseDoc.legalConclusions
    .filter((l) => l.category === 'liability')
    .map((l) => {
      const record: Record<string, unknown> = {
        record_id: l.id,
        field_code: 'D10.F060',
        ...exportLiabilitySource(l, caseDoc, maybeMask),
        ...(l.eventId ? { event_id: l.eventId } : {}),
        subject_id: l.subjectId,
        presence: l.presenceStatus,
      };
      if (l.conclusionLabel) {
        record.candidate_value = l.conclusionLabel;
        if (l.conclusionCode) record.conclusion_code = l.conclusionCode;
      }
      if (l.rawText) {
        record.raw_value = maybeMask(l.rawText, false);
      }
      record.linked_cause_record_ids = l.linkedCauseIds || [];
      record.evidence = l.evidences.map(mapEvidence);
      record.review = l.reviewStatus;
      return record;
    });

  const relations = caseDoc.relations.map((rel) => ({
    record_id: rel.id,
    field_code: rel.fieldCode || 'D08.F049',
    subject_id: cleanRelationEntityId(rel.sourceId),
    relation_type: rel.relationType || rel.collisionMode || rel.action,
    object_id: cleanRelationEntityId(rel.targetId),
    event_id: rel.eventId,
    sequence_number: rel.stageOrder,
    presence: rel.presenceStatus || 'present',
    evidence: rel.evidences.map(mapEvidence),
    review: rel.reviewStatus,
  }));

  return {
    case_id: caseDoc.caseId,
    document_id: docId,
    document_version: caseDoc.annotationVersion || 'v1.0',
    source_hash: (caseDoc.sourceHashFull || caseDoc.fileSha256).replace(/^sha256:/, ''),
    schema_version: '1.1-draft',
    ownership_version: '0.2-draft',
    subjects: caseDoc.entities.map((e) => ({
      subject_id: e.id,
      subject_type: e.kind,
      role: e.roleLabel || e.subtitle || e.label,
    })),
    facts,
    legal_records,
    responsibilities,
    relations,
  };
}

export function buildReviewMarkdown(caseDoc: CaseDocument): string {
  const readiness = computeCaseReadiness(caseDoc);
  const schemaByCode = new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f]));
  const lines: string[] = [
    `# 人工 Gold 标注与规则复盘单 — ${caseDoc.caseId}`,
    '',
    `- **材料文件**: ${caseDoc.sourceFilename}（${caseDoc.pageCount} 页）`,
    `- **版本与校验**: 手册 ${caseDoc.manualVersion} · 标注 ${caseDoc.annotationVersion}`,
    `- **是否允许进入正式评分**: ${readiness.eligibleForScoring ? '是（已通过全部门禁）' : '否（存在待处理项）'}`,
    `- **人员**: 第一标注人 ${caseDoc.annotatorName} / 第二复核人 ${caseDoc.reviewerName} / 裁定人 ${caseDoc.adjudicatorName || '待指派'}`,
    '',
  ];

  if (readiness.blockingReasons.length > 0) {
    lines.push('## 阻断正式评分原因');
    readiness.blockingReasons.forEach((reason) => lines.push(`- ${reason}`));
    lines.push('');
  }

  lines.push('## 重点争议与待裁定记录');
  const flaggedFields = caseDoc.fieldRecords.filter(
    (r) => r.reviewStatus === 'disputed' || PRESENCE_STATUS_META[r.presenceStatus].blocksScoring,
  );
  const flaggedLegal = caseDoc.legalConclusions.filter(
    (l) => l.reviewStatus === 'disputed' || PRESENCE_STATUS_META[l.presenceStatus].blocksScoring,
  );
  if (flaggedFields.length === 0 && flaggedLegal.length === 0) {
    lines.push('- 当前无争议或阻断状态记录。');
  } else {
    flaggedFields.forEach((r) => {
      const name = schemaByCode.get(r.fieldCode)?.fieldName ?? r.fieldCode;
      lines.push(
        `- [${r.entityId}] ${r.fieldCode} ${name} | 状态：${PRESENCE_STATUS_META[r.presenceStatus].label} | 复核：${REVIEW_STATUS_META[r.reviewStatus].label} | 说明：${r.disputeReason || r.adjudicatorNote || '待复盘'}`,
      );
    });
    flaggedLegal.forEach((l) => {
      lines.push(
        `- [${l.subjectId}] 法律结论(${l.category}) | 复核：${REVIEW_STATUS_META[l.reviewStatus].label} | 说明：${l.disputeReason || l.rawText}`,
      );
    });
  }

  return lines.join('\n');
}

export function matchesWorkItemStatus(
  item: {
    reviewStatus: ReviewStatus;
    presenceStatus: PresenceStatus;
    hasBlockingOrError: boolean;
  },
  filter: WorkItemFilterStatus,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'pending_action') {
    return (
      item.reviewStatus === 'draft' ||
      item.reviewStatus === 'disputed' ||
      item.hasBlockingOrError
    );
  }
  if (filter === 'blocking_or_error') {
    return item.hasBlockingOrError;
  }
  return item.reviewStatus === filter;
}

export function matchesFieldRecordBucket(
  record: FieldRecord | undefined,
  bucket: FieldFilterBucket,
): boolean {
  if (bucket === 'all') return true;
  if (bucket === 'unstarted') return !record;
  if (!record) return false;
  const errors = validateFieldRecord(record).filter((i) => i.severity === 'error');
  const hasBlockingOrError =
    PRESENCE_STATUS_META[record.presenceStatus].blocksScoring || errors.length > 0;
  return matchesWorkItemStatus(
    {
      reviewStatus: record.reviewStatus,
      presenceStatus: record.presenceStatus,
      hasBlockingOrError,
    },
    bucket,
  );
}

export function collectCaseWorkItems(
  caseDoc: CaseDocument,
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): CaseWorkItem[] {
  const schemaByCode = new Map(MASTER_FIELD_SCHEMA.map((f) => [f.fieldCode, f]));
  const items: CaseWorkItem[] = [];

  for (const r of caseDoc.fieldRecords) {
    const def = schemaByCode.get(r.fieldCode);
    const errors = validateFieldRecord(r).filter((i) => i.severity === 'error');
    const isBlockingPresence = PRESENCE_STATUS_META[r.presenceStatus].blocksScoring;
    const hasBlockingOrError = isBlockingPresence || errors.length > 0;
    const needsAttention =
      r.reviewStatus === 'draft' || r.reviewStatus === 'disputed' || hasBlockingOrError;

    const reasons: string[] = [];
    if (r.reviewStatus === 'disputed') reasons.push('争议中，待裁定');
    else if (r.reviewStatus === 'draft') reasons.push('草稿，待复核');
    if (isBlockingPresence) {
      reasons.push(`阻断状态(${PRESENCE_STATUS_META[r.presenceStatus].label})`);
    }
    if (errors.length > 0) reasons.push(errors.map((e) => e.message).join('；'));

    const valuePreview =
      r.normalizedValues.length > 0
        ? r.normalizedValues.join(' / ')
        : r.rawValue || PRESENCE_STATUS_META[r.presenceStatus].label;

    items.push({
      id: `field:${r.entityId}:${r.fieldCode}:${r.recordId}`,
      itemType: 'field',
      entityId: r.entityId,
      code: r.fieldCode,
      title: def?.fieldName ?? r.fieldCode,
      presenceStatus: r.presenceStatus,
      reviewStatus: r.reviewStatus,
      hasBlockingOrError,
      needsAttention,
      issueSummary:
        reasons.length > 0
          ? reasons.join('；')
          : REVIEW_STATUS_META[r.reviewStatus].label,
      valuePreview,
      notePreview: r.disputeReason || r.adjudicatorNote || '',
      targetTab: 'fields',
      fieldCode: r.fieldCode,
    });
  }

  for (const l of caseDoc.legalConclusions) {
    const errors = validateLegalConclusion(l, {
      entities: caseDoc.entities,
      supplements,
      allLegalConclusions: caseDoc.legalConclusions,
    }).filter((i) => i.severity === 'error');
    const isBlockingPresence = PRESENCE_STATUS_META[l.presenceStatus].blocksScoring;
    const hasBlockingOrError = isBlockingPresence || errors.length > 0;
    const needsAttention =
      l.reviewStatus === 'draft' || l.reviewStatus === 'disputed' || hasBlockingOrError;

    const fieldCode =
      l.category === 'violation'
        ? 'D10.F058'
        : l.category === 'cause'
          ? 'D10.F059'
          : 'D10.F060';
    const catLabel =
      l.category === 'violation'
        ? '认定违法行为'
        : l.category === 'cause'
          ? '认定事故原因'
          : '事故责任划分';

    const reasons: string[] = [];
    if (l.reviewStatus === 'disputed') reasons.push('争议中，待裁定');
    else if (l.reviewStatus === 'draft') reasons.push('草稿，待复核');
    if (isBlockingPresence) {
      reasons.push(`阻断状态(${PRESENCE_STATUS_META[l.presenceStatus].label})`);
    }
    if (errors.length > 0) reasons.push(errors.map((e) => e.message).join('；'));

    items.push({
      id: `legal:${l.id}`,
      itemType: 'legal',
      entityId: l.subjectId || 'ACC',
      code: fieldCode,
      title: `${catLabel} (${l.id})`,
      presenceStatus: l.presenceStatus,
      reviewStatus: l.reviewStatus,
      hasBlockingOrError,
      needsAttention,
      issueSummary:
        reasons.length > 0
          ? reasons.join('；')
          : REVIEW_STATUS_META[l.reviewStatus].label,
      valuePreview: l.conclusionLabel || l.rawText || PRESENCE_STATUS_META[l.presenceStatus].label,
      notePreview: l.disputeReason || l.adjudicatorNote || '',
      targetTab: 'legal',
      legalOrRelId: l.id,
      relationSubTab: 'legal',
    });
  }

  for (const rel of caseDoc.relations) {
    const presenceStatus = rel.presenceStatus || 'present';
    const errors = validateRelation(rel).filter((i) => i.severity === 'error');
    const isBlockingPresence = PRESENCE_STATUS_META[presenceStatus].blocksScoring;
    const hasBlockingOrError = isBlockingPresence || errors.length > 0;
    const needsAttention =
      rel.reviewStatus === 'draft' || rel.reviewStatus === 'disputed' || hasBlockingOrError;

    const reasons: string[] = [];
    if (rel.reviewStatus === 'disputed') reasons.push('争议中，待裁定');
    else if (rel.reviewStatus === 'draft') reasons.push('草稿，待复核');
    if (isBlockingPresence) {
      reasons.push(`阻断状态(${PRESENCE_STATUS_META[presenceStatus].label})`);
    }
    if (errors.length > 0) reasons.push(errors.map((e) => e.message).join('；'));

    items.push({
      id: `relation:${rel.id}`,
      itemType: 'relation',
      entityId: rel.eventId || 'E01',
      code: rel.fieldCode || 'D08.F049',
      title: `顺序 #${rel.stageOrder} 碰撞关系 (${rel.id})`,
      presenceStatus,
      reviewStatus: rel.reviewStatus,
      hasBlockingOrError,
      needsAttention,
      issueSummary:
        reasons.length > 0
          ? reasons.join('；')
          : REVIEW_STATUS_META[rel.reviewStatus].label,
      valuePreview: `${cleanRelationEntityId(rel.sourceId)} → ${rel.relationType || rel.action} → ${cleanRelationEntityId(rel.targetId)}`,
      notePreview: rel.disputeReason || rel.adjudicatorNote || '',
      targetTab: 'legal',
      legalOrRelId: rel.id,
      relationSubTab: 'relations',
    });
  }

  return items;
}

export function filterWorkItems(
  items: CaseWorkItem[],
  filter: {
    status?: WorkItemFilterStatus;
    itemType?: 'all' | 'field' | 'legal' | 'relation';
    entityId?: 'ALL' | string;
    query?: string;
  },
): CaseWorkItem[] {
  const status = filter.status || 'all';
  const itemType = filter.itemType || 'all';
  const entityId = filter.entityId || 'ALL';
  const q = (filter.query || '').trim().toLowerCase();

  return items.filter((item) => {
    if (!matchesWorkItemStatus(item, status)) return false;
    if (itemType !== 'all' && item.itemType !== itemType) return false;
    if (entityId !== 'ALL' && item.entityId !== entityId) return false;
    if (q) {
      const hay = `${item.entityId} ${item.code} ${item.title} ${item.valuePreview} ${item.issueSummary} ${item.notePreview}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function computeEntityProgressMap(
  caseDoc: CaseDocument,
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): Record<string, EntityProgressSummary> {
  const workItems = collectCaseWorkItems(caseDoc, supplements);
  const result: Record<string, EntityProgressSummary> = {};

  for (const entity of caseDoc.entities) {
    const entityItems = workItems.filter((item) => item.entityId === entity.id);
    const applicableDefs = MASTER_FIELD_SCHEMA.filter(
      (def) => !def.isLegalOrRelation && def.applicableKinds.includes(entity.kind),
    );
    const recordedCodes = new Set(
      caseDoc.fieldRecords.filter((r) => r.entityId === entity.id).map((r) => r.fieldCode),
    );
    const applicableUnstartedCount = applicableDefs.filter(
      (def) => !recordedCodes.has(def.fieldCode),
    ).length;

    let draftCount = 0;
    let disputedCount = 0;
    let checkedCount = 0;
    let specialistCount = 0;
    let errorOrBlockingCount = 0;
    let pendingCount = 0;

    for (const item of entityItems) {
      if (item.reviewStatus === 'draft') draftCount += 1;
      else if (item.reviewStatus === 'disputed') disputedCount += 1;
      else if (item.reviewStatus === 'checked') checkedCount += 1;
      else if (item.reviewStatus === 'specialist_review') specialistCount += 1;

      if (item.hasBlockingOrError) errorOrBlockingCount += 1;
      if (item.needsAttention) pendingCount += 1;
    }

    result[entity.id] = {
      entityId: entity.id,
      totalItems: entityItems.length,
      draftCount,
      disputedCount,
      checkedCount,
      specialistCount,
      errorOrBlockingCount,
      pendingCount,
      applicableTotalCount: applicableDefs.length,
      applicableUnstartedCount,
    };
  }

  return result;
}

export function computeEntityWorkbenchStats(
  caseDoc: CaseDocument,
  entityId: string,
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): Record<FieldFilterBucket, number> {
  const entity = caseDoc.entities.find((e) => e.id === entityId);
  const applicableDefs = entity
    ? MASTER_FIELD_SCHEMA.filter(
        (def) => !def.isLegalOrRelation && def.applicableKinds.includes(entity.kind),
      )
    : [];
  const recordedByCode = new Map(
    caseDoc.fieldRecords
      .filter((r) => r.entityId === entityId)
      .map((r) => [r.fieldCode, r]),
  );

  const progress = computeEntityProgressMap(caseDoc, supplements)[entityId];
  const counts: Record<FieldFilterBucket, number> = {
    all:
      (progress?.totalItems ?? 0) +
      applicableDefs.filter((def) => !recordedByCode.has(def.fieldCode)).length,
    unstarted: applicableDefs.filter((def) => !recordedByCode.has(def.fieldCode)).length,
    pending_action: progress?.pendingCount ?? 0,
    draft: progress?.draftCount ?? 0,
    disputed: progress?.disputedCount ?? 0,
    blocking_or_error: progress?.errorOrBlockingCount ?? 0,
    checked: progress?.checkedCount ?? 0,
    specialist_review: progress?.specialistCount ?? 0,
  };

  return counts;
}

export function normalizePdfTextForDisplay(text: string): string {
  if (!text) return '';
  return text
    .replace(
      /([\u4e00-\u9fa5，。；：、“”‘’（）《》【】、\dA-Za-z])\s+(?=[\u4e00-\u9fa5，。；：、“”‘’（）《》【】])/g,
      '$1',
    )
    .replace(
      /([\u4e00-\u9fa5，。；：、“”‘’（）《》【】])\s+(?=[\dA-Za-z])/g,
      '$1',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const SECTION_HEADING_RE =
  /^([一二三四五六七八九十]+[、.．]|【[^】]+】|●|道路交通事故[^：:]*[：:]|当事人[^：:]*[：:]|办案交通警察)/;

export function splitPdfPageIntoParagraphs(pageText: string): string[] {
  if (!pageText || !pageText.trim()) return [];
  const rawLines = pageText.split(/\r?\n/);
  const paragraphs: string[] = [];
  let buffer = '';

  const flush = () => {
    const cleaned = normalizePdfTextForDisplay(buffer);
    if (cleaned) paragraphs.push(cleaned);
    buffer = '';
  };

  for (const rawLine of rawLines) {
    const line = normalizePdfTextForDisplay(rawLine);
    if (!line) {
      flush();
      continue;
    }

    const isHeading =
      SECTION_HEADING_RE.test(line) ||
      (line.length <= 24 && /[：:]$/.test(line)) ||
      /^道路交通事故认定书$/.test(line);

    if (isHeading) {
      // Inline bracket tags like 【事故原因分析】... stay attached to their sentence,
      // while standalone headings flush any prior block first.
      flush();
      buffer = line;
      if (line.length <= 26 && !/[。；]$/.test(line) && !/^【[^】]+】.+/.test(line)) {
        flush();
      }
      continue;
    }

    if (!buffer) {
      buffer = line;
    } else {
      const prevShortSentenceEnd = buffer.length <= 36 && /[。；]$/.test(buffer);
      if (prevShortSentenceEnd) {
        flush();
        buffer = line;
      } else {
        const needsSpace =
          /[A-Za-z0-9]$/.test(buffer) && /^[A-Za-z0-9]/.test(line) ? ' ' : '';
        buffer += needsSpace + line;
      }
    }
  }
  flush();
  return paragraphs;
}

export function findTextMatchRanges(
  text: string,
  quotes: string[],
): Array<{ start: number; end: number }> {
  if (!text || quotes.length === 0) return [];

  const compactChars: string[] = [];
  const compactToOrig: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!/\s/.test(ch)) {
      compactChars.push(ch.toLowerCase());
      compactToOrig.push(i);
    }
  }
  const compactText = compactChars.join('');
  if (!compactText) return [];

  const rawRanges: Array<{ start: number; end: number }> = [];

  for (const rawQuote of quotes) {
    const trimmed = rawQuote.trim();
    if (!trimmed) continue;
    const segments = trimmed
      .split(/\.{3,}|…+/)
      .map((seg) => seg.replace(/\s+/g, '').toLowerCase())
      .filter((seg) => seg.length >= 3);

    const effectiveSegments =
      segments.length > 0
        ? segments
        : [trimmed.replace(/\s+/g, '').toLowerCase()].filter((s) => s.length >= 2);

    for (const seg of effectiveSegments) {
      let fromIdx = 0;
      while (fromIdx < compactText.length) {
        const idx = compactText.indexOf(seg, fromIdx);
        if (idx === -1) break;
        const startOrig = compactToOrig[idx];
        const endOrig = compactToOrig[idx + seg.length - 1] + 1;
        rawRanges.push({ start: startOrig, end: endOrig });
        fromIdx = idx + seg.length;
      }
    }
  }

  if (rawRanges.length === 0) return [];
  rawRanges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [rawRanges[0]];
  for (let i = 1; i < rawRanges.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = rawRanges[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

export function traceLegalEvidenceChain(
  caseDoc: CaseDocument,
  anchorId: string,
): LegalEvidenceChain | null {
  const anchorItem = caseDoc.legalConclusions.find((l) => l.id === anchorId);
  if (!anchorItem) return null;

  const allViolations = caseDoc.legalConclusions.filter((l) => l.category === 'violation');
  const allCauses = caseDoc.legalConclusions.filter((l) => l.category === 'cause');
  const allLiabilities = caseDoc.legalConclusions.filter((l) => l.category === 'liability');

  let violations: LegalConclusionItem[] = [];
  let causes: LegalConclusionItem[] = [];
  let liabilities: LegalConclusionItem[] = [];

  if (anchorItem.category === 'violation') {
    violations = [anchorItem];
    causes = allCauses.filter((c) => (c.linkedViolationIds || []).includes(anchorItem.id));
    const causeIds = new Set(causes.map((c) => c.id));
    liabilities = allLiabilities.filter((l) =>
      (l.linkedCauseIds || []).some((cid) => causeIds.has(cid)),
    );
  } else if (anchorItem.category === 'cause') {
    causes = [anchorItem];
    const vioSet = new Set(anchorItem.linkedViolationIds || []);
    violations = allViolations.filter((v) => vioSet.has(v.id));
    liabilities = allLiabilities.filter((l) =>
      (l.linkedCauseIds || []).includes(anchorItem.id),
    );
  } else {
    liabilities = [anchorItem];
    const causeSet = new Set(anchorItem.linkedCauseIds || []);
    causes = allCauses.filter((c) => causeSet.has(c.id));
    const vioSet = new Set(causes.flatMap((c) => c.linkedViolationIds || []));
    violations = allViolations.filter((v) => vioSet.has(v.id));
  }

  const subjectOrder: string[] = [];
  const pushSubject = (sid: string) => {
    if (sid && !subjectOrder.includes(sid)) subjectOrder.push(sid);
  };
  for (const v of violations) pushSubject(v.subjectId);
  for (const c of causes) pushSubject(c.subjectId);
  for (const l of liabilities) pushSubject(l.subjectId);

  const subjects = caseDoc.entities.filter((e) => subjectOrder.includes(e.id));
  const partyFieldRecords = caseDoc.fieldRecords.filter((r) =>
    subjectOrder.includes(r.entityId),
  );

  const chainEventIds = new Set(
    [...violations, ...causes, ...liabilities].map((x) => x.eventId).filter(Boolean),
  );
  const relatedRelations = caseDoc.relations.filter(
    (rel) =>
      chainEventIds.has(rel.eventId) ||
      subjectOrder.includes(cleanRelationEntityId(rel.sourceId)) ||
      subjectOrder.includes(cleanRelationEntityId(rel.targetId)),
  );

  const evidences: ChainEvidenceEntry[] = [];
  const pushLegalEvidences = (
    item: LegalConclusionItem,
    sourceLabel: string,
  ) => {
    for (const ev of item.evidences) {
      if (!ev.quote.trim()) continue;
      evidences.push({
        id: `${item.id}:${ev.id}`,
        sourceId: item.id,
        sourceKind: item.category,
        sourceLabel,
        subjectId: item.subjectId,
        page: ev.page,
        quote: ev.quote,
      });
    }
  };

  for (const v of violations) {
    pushLegalEvidences(v, `${v.id} · 认定违法`);
  }
  for (const c of causes) {
    pushLegalEvidences(c, `${c.id} · 认定原因`);
  }
  for (const l of liabilities) {
    pushLegalEvidences(l, `${l.id} · 责任划分`);
  }

  const consistencyChecks: ChainConsistencyCheck[] = [];
  const chainNodes = [...violations, ...causes, ...liabilities];

  const missingEvidenceNodes = chainNodes.filter((node) => {
    const rule = PRESENCE_STATUS_META[node.presenceStatus];
    if (!rule.requiresValueAndEvidence) return false;
    const validEvs = node.evidences.filter((e) => e.page >= 1 && e.quote.trim().length > 0);
    return !node.rawText.trim() || validEvs.length === 0;
  });
  if (missingEvidenceNodes.length > 0) {
    consistencyChecks.push({
      code: 'CHAIN_NODE_MISSING_EVIDENCE',
      severity: 'error',
      message: `链路中 ${missingEvidenceNodes.map((n) => n.id).join('、')} 缺少文书原文或有效页码证据`,
    });
  }

  if (anchorItem.category === 'violation') {
    if (anchorItem.presenceStatus === 'explicit_negative') {
      consistencyChecks.push({
        code: 'EXPLICIT_NEGATIVE_VIOLATION',
        severity: 'pass',
        message: '该项为明确无违法记录，按规则不强制要求因果原因关联',
      });
    } else if (anchorItem.presenceStatus === 'present' && causes.length === 0) {
      consistencyChecks.push({
        code: 'VIOLATION_WITHOUT_CAUSE',
        severity: 'warning',
        message: '该违法行为尚未被任何认定原因引用，建议核对文书是否将其作为事故原因',
      });
    } else if (causes.length > 0 && liabilities.length === 0) {
      consistencyChecks.push({
        code: 'CAUSE_WITHOUT_LIABILITY',
        severity: 'warning',
        message: '已关联认定原因，但尚无责任划分引用该原因，建议补全对应责任链',
      });
    }
  }

  for (const c of causes) {
    if (
      (c.causalLinkStatus === 'explicit_linked' || c.causalLinkStatus === 'multiple_mixed') &&
      (!c.linkedViolationIds || c.linkedViolationIds.length === 0)
    ) {
      consistencyChecks.push({
        code: 'CAUSE_MISSING_VIOLATION_LINK',
        severity: 'warning',
        message: `原因 ${c.id} 已标记关联违法，但尚未绑定违法行为记录`,
      });
    }
  }

  for (const l of liabilities) {
    if (
      l.presenceStatus === 'present' &&
      isNoLiability(l) &&
      causes.length === 0
    ) {
      consistencyChecks.push({
        code: 'NO_FAULT_LIABILITY_EXEMPT',
        severity: 'pass',
        message: '该项为“无责任”认定，无需关联致因记录',
      });
    } else if (
      l.presenceStatus === 'present' &&
      !isNoLiability(l) &&
      (!l.linkedCauseIds || l.linkedCauseIds.length === 0 || causes.length === 0)
    ) {
      consistencyChecks.push({
        code: 'LIABILITY_MISSING_CAUSE_LINK',
        severity: 'warning',
        message: `有责认定 ${l.id} 尚未关联认定事故原因依据`,
      });
    }
  }

  if (subjectOrder.length > 1) {
    consistencyChecks.push({
      code: 'MULTI_SUBJECT_CHAIN',
      severity: 'warning',
      message: `当前链路跨越多个主体（${subjectOrder.join(' / ')}），请核对跨主体因果/责任归属是否与文书一致`,
    });
  }

  const hasIssue = consistencyChecks.some(
    (c) => c.severity === 'error' || c.severity === 'warning',
  );
  if (!hasIssue && consistencyChecks.length === 0) {
    consistencyChecks.push({
      code: 'CHAIN_COMPLETE_AND_CONSISTENT',
      severity: 'pass',
      message: '证据链闭环完整：违法 → 原因 → 责任关联严密，且均附带文书原文与页码证据',
    });
  }

  return {
    anchorItem,
    violations,
    causes,
    liabilities,
    subjectIds: subjectOrder,
    subjects,
    partyFieldRecords,
    relatedRelations,
    evidences,
    consistencyChecks,
  };
}

export function extractPdfParagraphMatches(
  pageTexts: Record<number, string>,
  evidences: ChainEvidenceEntry[],
): MatchedPdfParagraph[] {
  const results: MatchedPdfParagraph[] = [];
  const pageNumbers = Object.keys(pageTexts)
    .map((p) => parseInt(p, 10))
    .filter((p) => !Number.isNaN(p))
    .sort((a, b) => a - b);

  for (const page of pageNumbers) {
    const paragraphs = splitPdfPageIntoParagraphs(pageTexts[page] || '');
    const pageEvs = evidences.filter((ev) => ev.page === page);
    paragraphs.forEach((text, paragraphIndex) => {
      const matchedEvidences = pageEvs.filter(
        (ev) => findTextMatchRanges(text, [ev.quote]).length > 0,
      );
      results.push({
        page,
        paragraphIndex,
        text,
        matchedEvidences,
      });
    });
  }
  return results;
}

interface WfxwMatchRule {
  /** Direct violation phrases (checked with negation guard unless already negative-phrased) */
  phrases?: string[];
  /** Phrases that only count when negation guard is skipped (because they already express non-compliance like 未按...) */
  obligationFailures?: string[];
  /** Statutory article clues that map cleanly to this violation */
  articles?: string[];
  /** Co-occurring condition check when single phrase alone is ambiguous */
  pairedCheck?: (
    compactText: string,
    item: LegalConclusionItem,
    subjectEntity?: EntityItem,
  ) => string | null;
}

const NEGATION_BEFORE_RE = /(?:未|无|没有|并未|尚未|不构成|未发现|未见|未曾|不存在|并非|免|已)(?:按规定|经|曾|在)?$/;
const NOT_IN_SPACE_BEFORE_RE = /(?:未在|不在|未沿|未于)$/;
const NEGATED_FAILURE_BEFORE_RE = /(?:并非|不存在|没有|未发现)$/;

function hasPositiveOccurrence(
  compactText: string,
  rawNeedle: string,
  options?: {
    checkNegation?: boolean;
    forbidLeadingChars?: string[];
    forbidBeforeRe?: RegExp;
    forbidAfterRe?: RegExp;
  },
): boolean {
  const needle = rawNeedle.replace(/\s+/g, '').toLowerCase();
  if (!needle) return false;

  const isSelfNegative = /^(?:未|无|没有|不按|不得|非|违|禁|超载|超员|超速)/.test(needle)
    ? !/^超(?:速|载|员)/.test(needle)
    : false;
  const checkNeg = options?.checkNegation ?? !isSelfNegative;

  let fromIdx = 0;
  while (fromIdx <= compactText.length - needle.length) {
    const idx = compactText.indexOf(needle, fromIdx);
    if (idx === -1) return false;
    fromIdx = idx + 1;

    const prevChar = idx > 0 ? compactText[idx - 1] : '';
    if (options?.forbidLeadingChars?.includes(prevChar)) {
      continue;
    }

    const before = compactText.slice(Math.max(0, idx - 8), idx);
    const after = compactText.slice(idx + needle.length, idx + needle.length + 8);

    if (options?.forbidBeforeRe && options.forbidBeforeRe.test(before)) {
      continue;
    }
    if (options?.forbidAfterRe && options.forbidAfterRe.test(after)) {
      continue;
    }

    if (checkNeg) {
      if (NEGATION_BEFORE_RE.test(before)) {
        continue;
      }
    } else if (/^(?:未|无|不)/.test(needle) && NEGATED_FAILURE_BEFORE_RE.test(before)) {
      continue;
    }

    return true;
  }

  return false;
}

function hasAnyPositivePhrase(
  compactText: string,
  phrases: string[],
  options?: {
    checkNegation?: boolean;
    forbidLeadingChars?: string[];
    forbidBeforeRe?: RegExp;
    forbidAfterRe?: RegExp;
  },
): string | null {
  for (const phrase of phrases) {
    if (hasPositiveOccurrence(compactText, phrase, options)) {
      return phrase;
    }
  }
  return null;
}

const WFXW_MATCH_RULES: Record<string, WfxwMatchRule> = {
  未按操作规范安全驾驶: {
    obligationFailures: [
      '未按操作规范安全驾驶',
      '未按照操作规范安全驾驶',
      '未能按照操作规范安全驾驶',
      '未按操作规范驾驶',
      '未按照操作规范驾驶',
      '未按操作规范',
      '未按照操作规范',
      '不按操作规范',
      '违反操作规范',
      '未注意观察',
      '疏于观察',
      '观察不周',
      '未仔细观察',
      '未确保安全',
      '未能确保安全',
      '未保证安全',
      '临危措施不当',
      '操作不当',
      '未安全文明驾驶',
      '未尽安全注意义务',
    ],
    articles: ['第二十二条第一款'],
  },
  行经人行横道未停车让行: {
    obligationFailures: [
      '行经人行横道未停车让行',
      '行经人行横道未减速让行',
      '通过人行横道未停车让行',
      '通过人行横道未减速',
      '遇行人正在通过人行横道未停车让行',
      '未停车让行',
      '未礼让行人',
      '不礼让行人',
      '未避让行人',
      '未避让横过道路的行人',
    ],
    articles: ['第四十七条'],
    pairedCheck: (compactText) => {
      const hasCrosswalk = hasPositiveOccurrence(compactText, '人行横道', {
        checkNegation: false,
        forbidLeadingChars: ['非'],
      });
      if (!hasCrosswalk) return null;
      const failAct = hasAnyPositivePhrase(compactText, [
        '未减速',
        '未停车',
        '未让行',
        '未避让',
        '碰撞行人',
        '撞击行人',
        '撞伤行人',
        '未礼让',
      ]);
      return failAct ? `人行横道+${failAct}` : null;
    },
  },
  开关车门妨碍其他车辆通行: {
    phrases: [
      '开关车门妨碍',
      '开关车门影响',
      '开启车门妨碍',
      '打开车门妨碍',
      '开启左前车门',
      '开启右车门',
      '开车门未注意',
      '开车门撞',
      '开关车门不得妨碍',
    ],
    articles: ['第六十三条第（四）项', '第六十三条第(四)项', '第六十三条第四项'],
  },
  低能见度未开灯降速: {
    obligationFailures: [
      '低能见度未开灯',
      '低能见度气象条件未按规定降速',
      '未按规定开启雾灯',
      '低能见度未降低行驶速度',
      '团雾未减速',
      '团雾未开灯',
      '能见度低未开灯',
      '能见度低未降速',
    ],
    pairedCheck: (compactText) => {
      const env = hasAnyPositivePhrase(compactText, [
        '低能见度',
        '浓雾',
        '团雾',
        '雾天',
        '能见度低于',
        '第八十一条',
      ]);
      if (!env) return null;
      const failAct = hasAnyPositivePhrase(
        compactText,
        ['未开灯', '未按规定开启', '未降低行驶速度', '未减速', '未降速'],
        { checkNegation: false },
      );
      return failAct ? `${env}+${failAct}` : null;
    },
  },
  未保持安全车距: {
    obligationFailures: [
      '未保持安全车距',
      '未保持安全距离',
      '未保持安全间距',
      '未保持安全跟车距离',
      '未保持足以采取紧急制动措施的安全距离',
      '未与前车保持',
      '未能与前车保持',
      '没有与前车保持',
      '未按规定保持车距',
      '跟车距离过近',
      '安全距离不足',
      '安全车距不足',
    ],
    pairedCheck: (compactText) => {
      const context = hasAnyPositivePhrase(compactText, ['第四十三条', '同车道行驶', '追尾']);
      const dist = hasAnyPositivePhrase(
        compactText,
        ['安全距离', '安全车距', '安全间距', '紧急制动措施'],
        { checkNegation: false },
      );
      if (context && dist && !/(?:已保持|保持了)安全/.test(compactText)) {
        return `${context}+${dist}`;
      }
      return null;
    },
  },
  违规连续变更车道: {
    phrases: [
      '违规连续变更车道',
      '连续变更两条',
      '连续变更车道',
      '连续变道',
      '一次连续变更',
    ],
  },
  违法变更车道: {
    phrases: [
      '违法变更车道',
      '违规变更车道',
      '违规变道',
      '强行变道',
      '强行并线',
      '压实线变道',
      '变更车道时影响',
      '变更车道影响',
      '变更车道未让',
      '变道不得影响',
      '变道影响正常行驶',
      '变道未让',
    ],
    articles: ['实施条例第四十四条第二款', '实施条例》第四十四条第二款'],
    pairedCheck: (compactText) => {
      const hasLaneChange = hasAnyPositivePhrase(compactText, ['变更车道', '变道']);
      if (!hasLaneChange) return null;
      const badEffect = hasAnyPositivePhrase(
        compactText,
        ['影响', '妨碍', '未让', '不得', '第四十四条'],
        { checkNegation: false },
      );
      return badEffect ? `${hasLaneChange}+${badEffect}` : null;
    },
  },
  超速行驶: {
    phrases: [
      '超速行驶',
      '超过限速',
      '超过规定时速',
      '超过最高限速',
      '超过限定时速',
      '超速运行',
      '超速违法',
      '超速',
    ],
  },
  违反交通信号灯通行: {
    phrases: [
      '违反交通信号灯',
      '不按交通信号灯',
      '违反信号灯',
      '闯红灯',
      '红灯亮时继续通行',
      '未按交通信号',
      '违反交通信号通行',
      '违反交通信号',
    ],
    pairedCheck: (compactText) => {
      const sig = hasAnyPositivePhrase(compactText, ['交通信号灯', '信号灯', '红灯']);
      if (!sig) return null;
      const act = hasAnyPositivePhrase(compactText, ['违反', '未按', '不按', '闯', '抢行'], {
        checkNegation: false,
      });
      return act ? `${sig}+${act}` : null;
    },
  },
  '违反禁令标志、禁止标线指示': {
    phrases: [
      '违反禁令标志',
      '违反禁止标线',
      '压实线',
      '跨越实线',
      '跨越双黄线',
      '违反标志标线',
      '不按导向标线',
      '无视禁令标志',
    ],
  },
  未按规定让行: {
    obligationFailures: [
      '未按规定让行',
      '未按规定礼让',
      '未让行',
      '未让优先通行',
      '转弯的机动车未让直行',
      '转弯机动车未让直行',
      '转弯未让直行',
      '左转未让直行',
      '右转未让直行',
      '未让直行的车辆',
      '未让直行车辆',
      '支路未让干路',
      '未让右方道路的来车',
      '未让右方道路来车',
      '未让右方来车',
      '进入路口未让',
      '借道通行未让',
      '进出道路未让',
      '会车未让',
      '未靠右让行',
      '未让正常行驶的车辆先行',
      '妨碍直行车辆',
    ],
    pairedCheck: (compactText) => {
      const art = hasAnyPositivePhrase(compactText, ['第五十一条', '第五十二条']);
      if (!art) return null;
      const clue = hasAnyPositivePhrase(compactText, ['让', '转弯', '右方', '先行'], {
        checkNegation: false,
      });
      return clue ? `${art}+${clue}` : null;
    },
  },
  不按规定车道行驶: {
    phrases: [
      '不按规定车道行驶',
      '未按规定车道行驶',
      '不按规定车道',
      '未按规定车道',
      '占用非机动车道',
      '在非机动车道内行驶',
      '未在机动车道内行驶',
      '未在机动车道行驶',
      '占用机动车道',
      '占用应急车道',
      '在应急车道内行驶',
      '不按导向车道',
      '未按导向车道',
      '未靠道路右侧通行',
      '未靠右侧通行',
      '借用对向车道',
      '借道行驶',
    ],
  },
  逆向行驶: {
    phrases: ['逆向行驶', '逆向通行', '驶入对向车道', '逆行'],
    articles: ['第三十五条'],
  },
  违法超车: {
    phrases: [
      '违法超车',
      '违规超车',
      '强行超车',
      '从前车右侧超车',
      '右侧超车',
      '超车时未保持',
      '超车时妨碍',
      '不具备超车条件',
      '禁止超车路段超车',
    ],
    pairedCheck: (compactText) => {
      const overtake = hasPositiveOccurrence(compactText, '超车', { checkNegation: true });
      if (!overtake) return null;
      const fail = hasAnyPositivePhrase(
        compactText,
        ['违规', '违法', '强行', '禁止', '妨碍', '右侧', '未保持', '未确保', '第四十三条'],
        { checkNegation: false },
      );
      return fail ? `超车+${fail}` : null;
    },
  },
  违法掉头: {
    phrases: [
      '违法掉头',
      '违规掉头',
      '掉头时妨碍',
      '掉头妨碍正常行驶',
      '掉头未让',
      '禁止掉头',
      '掉头未确保安全',
      '转弯掉头未确保安全',
    ],
    pairedCheck: (compactText) => {
      if (hasPositiveOccurrence(compactText, '掉头') && hasPositiveOccurrence(compactText, '第四十九条')) {
        return '掉头+第四十九条';
      }
      return null;
    },
  },
  违法倒车: {
    phrases: [
      '违法倒车',
      '违规倒车',
      '倒车未查明车后情况',
      '倒车时未确保安全',
      '倒车未注意',
      '倒车撞',
    ],
    pairedCheck: (compactText) => {
      if (hasPositiveOccurrence(compactText, '倒车') && hasPositiveOccurrence(compactText, '第五十条')) {
        return '倒车+第五十条';
      }
      return null;
    },
  },
  违法停放或临时停车妨碍通行: {
    phrases: [
      '违反规定停放',
      '违法停车',
      '违章停车',
      '违规停放',
      '违规停车',
      '违法停放',
      '临时停车妨碍',
    ],
    pairedCheck: (compactText) => {
      if (hasPositiveOccurrence(compactText, '开关车门', { checkNegation: false })) {
        return null;
      }
      const park = hasAnyPositivePhrase(compactText, ['停放', '临时停车', '停车']);
      if (!park) return null;
      const illegal = hasAnyPositivePhrase(
        compactText,
        ['违反规定', '禁止停车', '妨碍其他车辆和行人', '第五十六条', '第六十三条'],
        { checkNegation: false },
      );
      return illegal ? `${park}+${illegal}` : null;
    },
  },
  '故障停车未按规定设警示/开警示灯': {
    obligationFailures: [
      '未按规定设置警告标志',
      '未设置警告标志',
      '未摆放警示标志',
      '未放置三角警示牌',
      '未开启危险报警闪光灯',
      '未按规定开启危险报警闪光灯',
      '发生故障未按规定',
    ],
  },
  未按规定使用灯光: {
    obligationFailures: [
      '未按规定使用灯光',
      '未按规定开启灯光',
      '未开启前照灯',
      '未开启车灯',
      '未开灯',
      '违规使用远光灯',
      '不按规定使用远光灯',
      '夜间未开启灯光',
      '未按规定开启雾灯',
    ],
    phrases: ['灯光不符合要求', '使用远光灯'],
  },
  饮酒或醉酒后驾驶机动车: {
    phrases: [
      '饮酒后驾驶',
      '酒后驾驶',
      '酒驾',
      '醉酒后驾驶',
      '醉酒驾驶',
      '醉驾',
      '血液中酒精含量',
    ],
  },
  无证或准驾车型不符驾驶: {
    phrases: [
      '未取得机动车驾驶证',
      '无证驾驶',
      '无有效机动车驾驶证',
      '驾驶证被暂扣',
      '驾驶证被吊销',
      '与准驾车型不符',
      '准驾车型不符',
      '准驾不符',
    ],
    pairedCheck: (compactText) => {
      if (
        hasPositiveOccurrence(compactText, '第十九条') &&
        hasAnyPositivePhrase(compactText, ['驾驶证', '准驾'], { checkNegation: false })
      ) {
        return '第十九条+驾驶证';
      }
      return null;
    },
  },
  驾驶安全设施不全或机件不合格车辆: {
    phrases: [
      '安全设施不全',
      '机件不符合技术标准',
      '制动不合格',
      '制动系统不合格',
      '转向不合格',
      '车辆安全技术检验不合格',
      '未按规定进行安全技术检验',
      '逾期未检验',
    ],
    pairedCheck: (compactText) => {
      if (
        hasPositiveOccurrence(compactText, '第二十一条') &&
        hasAnyPositivePhrase(compactText, ['安全设施', '机件', '技术标准'], {
          checkNegation: false,
        })
      ) {
        return '第二十一条+机件安全';
      }
      return null;
    },
  },
  超载或超员行驶: {
    phrases: [
      '超过核定载质量',
      '超过核定载人数',
      '超载',
      '超员',
      '超限运输',
      '载物超宽',
      '载物超高',
      '载物超长',
    ],
  },
  发生交通事故后逃逸: {
    phrases: [
      '发生交通事故后逃逸',
      '交通肇事逃逸',
      '驾车逃逸',
      '逃离事故现场',
      '弃车逃逸',
      '肇事逃逸',
      '逃逸',
    ],
    pairedCheck: (compactText) => {
      if (
        hasPositiveOccurrence(compactText, '第七十条') &&
        hasPositiveOccurrence(compactText, '逃', { checkNegation: false })
      ) {
        return '第七十条+逃逸';
      }
      return null;
    },
  },
  非机动车违反规定通行: {
    phrases: [
      '非机动车未在非机动车道内行驶',
      '电动自行车未在非机动车道',
      '非机动车在机动车道内行驶',
      '非机动车逆行',
      '电动自行车逆行',
      '非机动车违反交通信号',
      '横过机动车道未下车推行',
      '未佩戴安全头盔',
      '非机动车违反规定载人',
      '电动自行车违法载人',
    ],
    pairedCheck: (compactText, _item, subjectEntity) => {
      const subjHint = `${subjectEntity?.roleLabel || ''}${subjectEntity?.subtitle || ''}${subjectEntity?.label || ''}`;
      const isNonMotor =
        /(非机动车|电动自行车|自行车|骑行|电动车)/.test(subjHint) ||
        /(驾驶非机动车|骑行非机动车|骑行电动自行车|驾驶电动自行车|驾驶自行车)/.test(
          compactText,
        );
      if (!isNonMotor) return null;
      const act = hasAnyPositivePhrase(
        compactText,
        [
          '未在非机动车道',
          '机动车道内行驶',
          '逆行',
          '逆向行驶',
          '闯红灯',
          '违反交通信号',
          '未下车推行',
          '违反规定载人',
          '第五十七条',
          '第五十八条',
        ],
        { checkNegation: false },
      );
      return act ? `非机动车+${act}` : null;
    },
  },
  行人违反交通规则通行: {
    phrases: [
      '行人违反交通信号',
      '行人未走人行道',
      '行人未走人行横道',
      '行人不走过街设施',
      '行人横穿',
      '非人行横道横穿',
      '跨越道路隔离设施',
      '翻越护栏',
      '行人横过道路未确认安全',
      '在车行道内行走',
    ],
    pairedCheck: (compactText, _item, subjectEntity) => {
      const subjHint = `${subjectEntity?.roleLabel || ''}${subjectEntity?.subtitle || ''}`;
      if (subjHint && /(驾驶人|车主)/.test(subjHint) && !/行人/.test(subjHint)) {
        return null;
      }
      const hasPed = hasPositiveOccurrence(compactText, '行人', {
        forbidBeforeRe: /(?:未礼让|不礼让|碰撞|撞击|撞伤|其他车辆和)$/,
      });
      if (!hasPed) return null;
      const act = hasAnyPositivePhrase(
        compactText,
        [
          '未走人行道',
          '未走人行横道',
          '未确认安全',
          '违反交通信号',
          '跨越',
          '翻越',
          '车行道内',
          '第六十一条',
          '第六十二条',
          '第六十三条',
        ],
        { checkNegation: false },
      );
      return act ? `行人+${act}` : null;
    },
  },
};

const VIOLATION_AUXILIARY_VOCAB_FIELDS = new Set([
  'D05.F027',
  'D05.F028',
  'D05.F029',
  'D05.F074',
  'D05.F075',
  'D08.F048',
]);

const AUXILIARY_TERM_GUARDS: Record<
  string,
  {
    forbidLeadingChars?: string[];
    forbidBeforeRe?: RegExp;
    forbidAfterRe?: RegExp;
  }
> = {
  机动车道: {
    forbidLeadingChars: ['非'],
    forbidBeforeRe: NOT_IN_SPACE_BEFORE_RE,
  },
  人行横道: {
    forbidLeadingChars: ['非'],
    forbidBeforeRe: NOT_IN_SPACE_BEFORE_RE,
  },
  直行: {
    forbidBeforeRe: /(?:未让|让|避让|非)$/,
    forbidAfterRe: /^(?:的?车辆|的?机动车|的?非机动车|方)/,
  },
  正常行驶: {
    forbidBeforeRe: /(?:影响|妨碍|其他车辆|未|不能|没有)$/,
    forbidAfterRe: /^(?:的?车辆|的?机动车|的?非机动车|车辆)/,
  },
  开启危险报警闪光灯: {
    forbidBeforeRe: /(?:未|未按规定|没有|并未|尚未|不|应|应当)$/,
  },
};

const ENTITY_ALIAS_STOPWORDS = new Set([
  '驾驶人',
  '甲方驾驶人',
  '乙方行人',
  '乙方骑行人',
  '行人',
  '乘客',
  '机动车',
  '小型普通客车',
  '小型轿车',
  '小型客车',
  '电动自行车',
  '电动车',
  '电动三轮车',
  '二轮摩托车',
  '重型货车',
  '货车',
  '轿车',
  '事故',
  '车辆',
  '道路',
  '路段',
  '车行道',
  '人行道',
  '机动车道',
  '非机动车道',
  '路口',
  '交叉路口',
  '无号牌',
  '第一阶段',
  '第二阶段',
  '第三阶段',
  '隐含参与方',
]);

export function buildViolationConsistencyFingerprint(item: LegalConclusionItem): string {
  return [
    item.subjectId.trim(),
    item.eventId.trim(),
    item.presenceStatus,
    item.conclusionLabel.trim(),
    item.rawText.trim(),
    item.lawArticle.trim(),
  ].join('|');
}

function extractEntitySearchAliases(entity: EntityItem): string[] {
  if (entity.kind === 'ACC') return [];
  const candidates: string[] = [];
  const rawLabel = (entity.label || '').trim();
  const stripped = rawLabel.replace(/[（(][^）)]*[）)]/g, ' ').trim();
  if (stripped && !ENTITY_ALIAS_STOPWORDS.has(stripped)) {
    candidates.push(stripped);
  }
  const parts = rawLabel
    .replace(/^(第一阶段|第二阶段|第三阶段)[：:]/, '')
    .split(/[（()）·、/，,：:\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !ENTITY_ALIAS_STOPWORDS.has(s));
  for (const p of parts) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  // Extract core road/location sub-tokens like "八一大道", "阳明路口", "人行横道"
  const roadMatches = rawLabel.match(
    /[\u4e00-\u9fa5A-Za-z0-9]{1,6}(?:大道|东路|西路|南路|北路|高速|路口|立交|路|街)/g,
  );
  if (roadMatches) {
    for (const rm of roadMatches) {
      if (rm.length >= 3 && !ENTITY_ALIAS_STOPWORDS.has(rm) && !candidates.includes(rm)) {
        candidates.push(rm);
      }
    }
  }
  if (entity.kind === 'R' || entity.kind === 'I') {
    const facilityMatches = rawLabel.match(
      /(?:人行横道|非机动车道|机动车道|应急车道|快车道|慢车道|十字路口)/g,
    );
    if (facilityMatches) {
      for (const fm of facilityMatches) {
        if (!candidates.includes(fm)) {
          candidates.push(fm);
        }
      }
    }
  }
  return candidates;
}

export function scanViolationLinkMatches(
  item: LegalConclusionItem,
  entities: EntityItem[],
  supplements: VocabularySupplementItem[] = INITIAL_VOCABULARY_SUPPLEMENTS,
): ViolationLinkScanResult {
  const fingerprint = buildViolationConsistencyFingerprint(item);
  const emptyResult: ViolationLinkScanResult = {
    vocabMatches: [],
    entityMatches: [],
    hasAnyMatch: false,
    hasUnlinkedMatch: false,
    hasSubjectMismatch: false,
    isConfirmed: item.linkConsistencyConfirmed === true,
    needsConfirmationError: false,
    fingerprint,
  };

  if (item.category !== 'violation') return emptyResult;
  if (PRESENCE_STATUS_META[item.presenceStatus].forbidsValue) return emptyResult;

  const hasContent =
    item.rawText.trim().length > 0 ||
    item.conclusionLabel.trim().length > 0 ||
    item.lawArticle.trim().length > 0;
  if (!hasContent) return emptyResult;

  const combinedText = normalizePdfTextForDisplay(
    `${item.conclusionLabel} ${item.rawText} ${item.lawArticle}`,
  );
  const compactText = combinedText.replace(/\s+/g, '').toLowerCase();
  if (!compactText) return emptyResult;

  const subjectEntity = entities.find((e) => e.id === item.subjectId);
  const linkedVocabSet = new Set(item.linkedVocabTerms || []);
  const linkedEntitySet = new Set(item.linkedEntityIds || []);
  const vocabMatches: ViolationVocabMatch[] = [];
  const seenVocabKeys = new Set<string>();

  // Match reference wording for the consistency check independently of the standard conclusion.
  const violationDef = MASTER_FIELD_SCHEMA.find((f) => f.fieldCode === 'D10.F058');
  const d10Supplement = supplements.find((s) => s.fieldCode === 'D10.F058');
  const primaryTerms = Array.from(
    new Set([
      ...VIOLATION_REFERENCE_TERMS,
      ...(d10Supplement?.candidateOptions || []),
    ]),
  );

  for (const term of primaryTerms) {
    if (term === '无违法行为') continue;

    const compactTerm = term.replace(/\s+/g, '').toLowerCase();
    let matchedBy = '';

    if (item.conclusionLabel.trim() === term) {
      matchedBy = term;
    } else if (hasPositiveOccurrence(compactText, compactTerm)) {
      matchedBy = term;
    } else {
      const rule = WFXW_MATCH_RULES[term];
      if (rule) {
        if (!matchedBy && rule.obligationFailures?.length) {
          const hit = hasAnyPositivePhrase(compactText, rule.obligationFailures, {
            checkNegation: false,
          });
          if (hit) matchedBy = hit;
        }
        if (!matchedBy && rule.phrases?.length) {
          const hit = hasAnyPositivePhrase(compactText, rule.phrases, {
            checkNegation: true,
          });
          if (hit) matchedBy = hit;
        }
        if (!matchedBy && rule.pairedCheck) {
          const hit = rule.pairedCheck(compactText, item, subjectEntity);
          if (hit) matchedBy = hit;
        }
        if (!matchedBy && rule.articles?.length && item.presenceStatus === 'present') {
          const artHit = hasAnyPositivePhrase(compactText, rule.articles, {
            forbidBeforeRe: /(?:未违反|不构成违反|没有违反)$/,
          });
          if (artHit) matchedBy = artHit;
        }
      }
    }

    if (matchedBy) {
      const vocabKey = `D10.F058:${term}`;
      if (!seenVocabKeys.has(vocabKey)) {
        seenVocabKeys.add(vocabKey);
        vocabMatches.push({
          vocabKey,
          fieldCode: 'D10.F058',
          fieldName: violationDef?.fieldName || '认定违法行为',
          codeTable: violationDef?.existingCodeTable || 'wfxw',
          standardTerm: term,
          matchedBy,
          isPrimaryStandard: true,
          isLinked:
            item.conclusionLabel.trim() === term || linkedVocabSet.has(vocabKey),
        });
      }
    }
  }

  // Only match 无违法行为 when explicitly negative OR no affirmative D10.F058 violation matched
  if (primaryTerms.includes('无违法行为')) {
    const hasAffirmativeViolation = vocabMatches.some((m) => m.isPrimaryStandard);
    const hasExplicitNoVioPhrase =
      /(?:无违法行为|无违法及过错|无交通违法|未发现违法行为|不构成交通违法)/.test(compactText) &&
      !/(?:并非无违法|不是无违法)/.test(compactText);
    if (
      item.presenceStatus === 'explicit_negative' ||
      (!hasAffirmativeViolation && hasExplicitNoVioPhrase)
    ) {
      const vocabKey = 'D10.F058:无违法行为';
      if (!seenVocabKeys.has(vocabKey)) {
        seenVocabKeys.add(vocabKey);
        vocabMatches.push({
          vocabKey,
          fieldCode: 'D10.F058',
          fieldName: violationDef?.fieldName || '认定违法行为',
          codeTable: violationDef?.existingCodeTable || 'wfxw',
          standardTerm: '无违法行为',
          matchedBy:
            item.presenceStatus === 'explicit_negative' && !hasExplicitNoVioPhrase
              ? '明确否定状态 (explicit_negative)'
              : '无违法行为',
          isPrimaryStandard: true,
          isLinked:
            item.conclusionLabel.trim() === '无违法行为' || linkedVocabSet.has(vocabKey),
        });
      }
    }
  }

  // 2. Scan scoped behavioral/spatial/collision controlled vocabularies (G04 actions/state/space & G07 collision mode)
  const subjectRoleText = `${subjectEntity?.roleLabel || ''} ${subjectEntity?.subtitle || ''}`;
  const isKnownNonPedestrian =
    /(?:驾驶人|车主)/.test(subjectRoleText) && !/行人/.test(subjectRoleText);

  for (const sup of supplements) {
    if (!VIOLATION_AUXILIARY_VOCAB_FIELDS.has(sup.fieldCode)) continue;
    if (sup.fieldCode === 'D05.F029' && isKnownNonPedestrian) {
      // Pedestrian action vocabulary (including 逆行) must not pollute motor-vehicle driver records
      continue;
    }

    const termPool = Array.from(
      new Set([
        ...sup.candidateOptions,
        ...(sup.synonyms
          ? sup.synonyms
              .split(/[、，,/；;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : []),
      ]),
    );

    for (const candidate of sup.candidateOptions) {
      const compactCand = candidate.replace(/\s+/g, '').toLowerCase();
      if (compactCand.length < 2) continue;

      if (
        sup.fieldCode === 'D05.F029' &&
        candidate === '逆行' &&
        /(?:驾驶机动车|驾驶电动|骑行电动|驾驶汽车|轿车|货车|客车)/.test(compactText) &&
        !/行人/.test(compactText)
      ) {
        continue;
      }

      const guard = AUXILIARY_TERM_GUARDS[candidate];
      let matchedBy = '';
      if (hasPositiveOccurrence(compactText, compactCand, guard)) {
        matchedBy = candidate;
      } else {
        const synHit = termPool.find((syn) => {
          const cs = syn.replace(/\s+/g, '').toLowerCase();
          return (
            cs.length >= 3 &&
            cs !== compactCand &&
            candidate.includes(syn.slice(0, 2)) &&
            hasPositiveOccurrence(compactText, cs, guard)
          );
        });
        if (synHit) matchedBy = synHit;
      }

      if (matchedBy) {
        const vocabKey = `${sup.fieldCode}:${candidate}`;
        if (!seenVocabKeys.has(vocabKey)) {
          seenVocabKeys.add(vocabKey);
          vocabMatches.push({
            vocabKey,
            fieldCode: sup.fieldCode,
            fieldName: sup.fieldName,
            codeTable: sup.standardCode,
            standardTerm: candidate,
            matchedBy,
            isPrimaryStandard: false,
            isLinked: linkedVocabSet.has(vocabKey),
          });
        }
      }
    }
  }

  // Always list primary D10.F058 wfxw matches ahead of auxiliary D05/D08 matches
  vocabMatches.sort((a, b) => Number(b.isPrimaryStandard) - Number(a.isPrimaryStandard));

  // 3. Scan current case entity list
  const entityMatches: ViolationEntityMatch[] = [];
  for (const ent of entities) {
    if (ent.kind === 'ACC') continue;
    const aliases = extractEntitySearchAliases(ent);
    const idPattern = new RegExp(`(^|[^A-Za-z0-9])${ent.id}($|[^A-Za-z0-9])`, 'i');
    let matchedAlias = '';
    if (idPattern.test(combinedText)) {
      matchedAlias = ent.id;
    } else {
      const foundAlias = aliases.find((alias) =>
        compactText.includes(alias.replace(/\s+/g, '').toLowerCase()),
      );
      if (foundAlias) matchedAlias = foundAlias;
    }

    if (matchedAlias) {
      const isCurrentSubject = item.subjectId === ent.id;
      const isCurrentEvent = item.eventId === ent.id;
      const isLinked =
        isCurrentSubject || isCurrentEvent || linkedEntitySet.has(ent.id);
      entityMatches.push({
        entityId: ent.id,
        entityKind: ent.kind,
        entityLabel: ent.label,
        matchedAlias,
        isCurrentSubject,
        isCurrentEvent,
        isLinked,
      });
    }
  }

  const hasAnyMatch = vocabMatches.length > 0 || entityMatches.length > 0;
  const hasUnlinkedMatch =
    vocabMatches.some((m) => !m.isLinked) || entityMatches.some((m) => !m.isLinked);
  const matchedParties = entityMatches.filter(
    (m) => m.entityKind === 'P' || m.entityKind === 'O',
  );
  const hasSubjectMismatch =
    matchedParties.length > 0 && !matchedParties.some((m) => m.isCurrentSubject);

  const isConfirmed =
    item.linkConsistencyConfirmed === true &&
    (!item.linkConsistencyFingerprint || item.linkConsistencyFingerprint === fingerprint);
  const needsConfirmationError = hasAnyMatch && !isConfirmed;

  return {
    vocabMatches,
    entityMatches,
    hasAnyMatch,
    hasUnlinkedMatch,
    hasSubjectMismatch,
    isConfirmed,
    needsConfirmationError,
    fingerprint,
  };
}

export function applyViolationVocabLink(
  item: LegalConclusionItem,
  match: ViolationVocabMatch,
): LegalConclusionItem {
  const nextVocab = Array.from(
    new Set([...(item.linkedVocabTerms || []), match.vocabKey]),
  );
  return {
    ...item,
    linkedVocabTerms: nextVocab,
    linkConsistencyConfirmed: false,
    linkConsistencyFingerprint: '',
  };
}

export function applyViolationEntityLink(
  item: LegalConclusionItem,
  match: ViolationEntityMatch,
  mode: 'auto' | 'subject' | 'event' | 'related' = 'auto',
): LegalConclusionItem {
  if (mode === 'subject' && (match.entityKind === 'P' || match.entityKind === 'O')) {
    return {
      ...item,
      subjectId: match.entityId,
      linkConsistencyConfirmed: false,
      linkConsistencyFingerprint: '',
    };
  }
  if ((mode === 'event' || (mode === 'auto' && match.entityKind === 'E')) && match.entityKind === 'E') {
    return {
      ...item,
      eventId: match.entityId,
      linkedEntityIds: Array.from(
        new Set([...(item.linkedEntityIds || []), match.entityId]),
      ),
      linkConsistencyConfirmed: false,
      linkConsistencyFingerprint: '',
    };
  }
  return {
    ...item,
    linkedEntityIds: Array.from(
      new Set([...(item.linkedEntityIds || []), match.entityId]),
    ),
    linkConsistencyConfirmed: false,
    linkConsistencyFingerprint: '',
  };
}

export function applyAllViolationLinks(
  item: LegalConclusionItem,
  scan: ViolationLinkScanResult,
): LegalConclusionItem {
  let next: LegalConclusionItem = {
    ...item,
    linkedVocabTerms: Array.from(
      new Set([
        ...(item.linkedVocabTerms || []),
        ...scan.vocabMatches.map((m) => m.vocabKey),
      ]),
    ),
    linkedEntityIds: [...(item.linkedEntityIds || [])],
    linkConsistencyConfirmed: false,
    linkConsistencyFingerprint: '',
  };

  const matchedParty = scan.entityMatches.find(
    (m) => m.entityKind === 'P' || m.entityKind === 'O',
  );
  if (matchedParty && !next.subjectId) {
    next.subjectId = matchedParty.entityId;
  }

  const matchedEvent = scan.entityMatches.find((m) => m.entityKind === 'E');
  if (matchedEvent && !next.eventId) {
    next.eventId = matchedEvent.entityId;
  }

  const extraEntityIds = scan.entityMatches
    .filter((m) => m.entityId !== next.subjectId && m.entityId !== next.eventId)
    .map((m) => m.entityId);

  next.linkedEntityIds = Array.from(
    new Set([...(next.linkedEntityIds || []), ...extraEntityIds]),
  );

  return next;
}

export function confirmViolationLinkConsistency(
  item: LegalConclusionItem,
): LegalConclusionItem {
  return {
    ...item,
    linkConsistencyConfirmed: true,
    linkConsistencyFingerprint: buildViolationConsistencyFingerprint(item),
  };
}

export interface ControlledVocabOption {
  value: string;
  source: 'preset' | 'supplement' | 'both';
  codeTable?: string;
  standardCode?: string;
  synonymsText?: string;
}

export function buildControlledVocabOptions(
  def: Pick<FieldDefinition, 'presetOptions' | 'existingCodeTable'>,
  supplement?: Pick<VocabularySupplementItem, 'candidateOptions' | 'standardCode' | 'synonyms'>,
): ControlledVocabOption[] {
  const presetSet = new Set(def.presetOptions || []);
  const supplementList = supplement?.candidateOptions || [];
  const supplementSet = new Set(supplementList);
  const seen = new Set<string>();
  const result: ControlledVocabOption[] = [];

  const orderedValues = [...(def.presetOptions || []), ...supplementList];
  for (const raw of orderedValues) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const inPreset = presetSet.has(raw);
    const inSupp = supplementSet.has(raw);
    const source: ControlledVocabOption['source'] =
      inPreset && inSupp ? 'both' : inPreset ? 'preset' : 'supplement';
    result.push({
      value,
      source,
      codeTable: def.existingCodeTable || undefined,
      standardCode: supplement?.standardCode || undefined,
      synonymsText: supplement?.synonyms || undefined,
    });
  }

  return result;
}

export function filterControlledVocabOptions(
  options: ControlledVocabOption[],
  query: string,
): ControlledVocabOption[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return options;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const ranked: Array<{ option: ControlledVocabOption; rank: number; idx: number }> = [];

  options.forEach((option, idx) => {
    const valueLower = option.value.toLowerCase();
    const metaLower = `${option.synonymsText || ''} ${option.standardCode || ''} ${option.codeTable || ''}`.toLowerCase();

    let rank = -1;
    if (valueLower === trimmed) {
      rank = 0;
    } else if (valueLower.startsWith(trimmed)) {
      rank = 1;
    } else if (valueLower.includes(trimmed)) {
      rank = 2;
    } else if (tokens.every((tok) => valueLower.includes(tok))) {
      rank = 3;
    } else if (
      metaLower.includes(trimmed) ||
      tokens.every((tok) => `${valueLower} ${metaLower}`.includes(tok))
    ) {
      rank = 4;
    }

    if (rank >= 0) {
      ranked.push({ option, rank, idx });
    }
  });

  ranked.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return ranked.map((entry) => entry.option);
}

export function stepVocabHighlightIndex(
  currentIndex: number,
  totalCount: number,
  direction: 'next' | 'prev',
): number {
  if (totalCount <= 0) return -1;
  if (direction === 'next') {
    if (currentIndex < 0 || currentIndex >= totalCount - 1) return 0;
    return currentIndex + 1;
  }
  if (currentIndex <= 0 || currentIndex >= totalCount) return totalCount - 1;
  return currentIndex - 1;
}

export interface ScopedLegalCandidateList {
  primaryItems: LegalConclusionItem[];
  otherItems: LegalConclusionItem[];
}

export function getScopedViolationCandidatesForCause(
  causeItem: Pick<LegalConclusionItem, 'subjectId' | 'linkedViolationIds'>,
  allViolations: LegalConclusionItem[],
): ScopedLegalCandidateList {
  const linkedSet = new Set(causeItem.linkedViolationIds || []);
  const sameSubject: LegalConclusionItem[] = [];
  const foreignLinked: LegalConclusionItem[] = [];
  const otherItems: LegalConclusionItem[] = [];

  for (const vio of allViolations) {
    if (vio.subjectId === causeItem.subjectId) {
      sameSubject.push(vio);
    } else if (linkedSet.has(vio.id)) {
      foreignLinked.push(vio);
    } else {
      otherItems.push(vio);
    }
  }

  return {
    primaryItems: [...sameSubject, ...foreignLinked],
    otherItems,
  };
}

export function getScopedCauseCandidatesForLiability(
  liabilityItem: Pick<LegalConclusionItem, 'subjectId' | 'linkedCauseIds'>,
  allCauses: LegalConclusionItem[],
): ScopedLegalCandidateList {
  const linkedSet = new Set(liabilityItem.linkedCauseIds || []);
  const sameSubject: LegalConclusionItem[] = [];
  const foreignLinked: LegalConclusionItem[] = [];
  const otherItems: LegalConclusionItem[] = [];

  for (const cau of allCauses) {
    if (cau.subjectId === liabilityItem.subjectId) {
      sameSubject.push(cau);
    } else if (linkedSet.has(cau.id)) {
      foreignLinked.push(cau);
    } else {
      otherItems.push(cau);
    }
  }

  return {
    primaryItems: [...sameSubject, ...foreignLinked],
    otherItems,
  };
}

type LiabilityScope = Pick<LegalConclusionItem, 'subjectId' | 'eventId'>;

export function hasLiabilityScopeConflict(a: LiabilityScope, b: LiabilityScope): boolean {
  return a.subjectId === b.subjectId && (a.eventId || '') === (b.eventId || '');
}

export function getSubjectLiabilityRecords(
  legalConclusions: LegalConclusionItem[],
  subjectId: string,
): LegalConclusionItem[] {
  if (!subjectId) return [];
  return legalConclusions.filter(
    (l) => l.category === 'liability' && l.subjectId === subjectId,
  );
}

export function pickDefaultLiabilitySubjectId(
  subjects: Pick<EntityItem, 'id'>[],
  legalConclusions: LegalConclusionItem[],
  preferredSubjectId?: string,
): string | null {
  const liabledSet = new Set(
    legalConclusions
      .filter((l) => l.category === 'liability' && l.subjectId)
      .map((l) => l.subjectId),
  );
  if (
    preferredSubjectId &&
    subjects.some((s) => s.id === preferredSubjectId) &&
    !liabledSet.has(preferredSubjectId)
  ) {
    return preferredSubjectId;
  }
  const available = subjects.find((s) => !liabledSet.has(s.id));
  return available ? available.id : null;
}






