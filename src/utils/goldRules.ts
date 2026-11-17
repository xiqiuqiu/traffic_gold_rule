import {
  ACCEPTANCE_CHECKLIST_ITEMS,
  ENTITY_KIND_META,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
  REVIEW_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  CaseWorkItem,
  EntityItem,
  EntityKind,
  EntityProgressSummary,
  EventRelationItem,
  EvidenceItem,
  FieldFilterBucket,
  FieldRecord,
  LegalConclusionItem,
  PresenceStatus,
  ReadinessSummary,
  ReviewStatus,
  ValidationIssue,
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

export function validateLegalConclusion(item: LegalConclusionItem): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const statusRule = PRESENCE_STATUS_META[item.presenceStatus];

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
    item.conclusionLabel.trim() !== '无责任' &&
    (!item.linkedCauseIds || item.linkedCauseIds.length === 0)
  ) {
    issues.push({
      code: 'MISSING_LINKED_CAUSE',
      severity: 'warning',
      message: '有责结论建议关联或补录对应的认定事故原因记录',
    });
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

export function computeCaseReadiness(caseDoc: CaseDocument): ReadinessSummary {
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
    const issues = validateLegalConclusion(l);
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
          id: l.id,
          subject_id: l.subjectId,
          event_id: l.eventId || null,
          presence_status: l.presenceStatus,
          law_article: l.lawArticle || null,
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
        subject_id: l.subjectId,
        presence: l.presenceStatus,
      };
      if (l.conclusionLabel) {
        record.candidate_value = l.conclusionLabel;
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

export function collectCaseWorkItems(caseDoc: CaseDocument): CaseWorkItem[] {
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
    const errors = validateLegalConclusion(l).filter((i) => i.severity === 'error');
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
): Record<string, EntityProgressSummary> {
  const workItems = collectCaseWorkItems(caseDoc);
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

  const progress = computeEntityProgressMap(caseDoc)[entityId];
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


