import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Calculator,
  Link2,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  GROUP_META,
  MASTER_FIELD_SCHEMA,
  PRESENCE_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  CausalLinkStatus,
  EntityItem,
  EventRelationItem,
  FieldDefinition,
  FieldFilterBucket,
  FieldRecord,
  GroupCode,
  LegalCategory,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
  VocabularySupplementItem,
} from '../types/gold';
import {
  cleanRelationEntityId,
  computeEntityWorkbenchStats,
  deriveTimeBucket,
  matchesFieldRecordBucket,
  matchesWorkItemStatus,
  sortLegalConclusionsByChain,
  validateFieldRecord,
  validateLegalConclusion,
  validateRelation,
} from '../utils/goldRules';
import { ReviewLifecycleBar, getCardStatusBorderClass } from './ReviewLifecycleBar';

interface FieldAnnotationPanelProps {
  caseDoc: CaseDocument;
  selectedEntity: EntityItem;
  userRole: UserRole;
  supplements: VocabularySupplementItem[];
  activeRecordKey: string | null;
  activeLegalOrRelId: string | null;
  onFocusRecord: (entityId: string, fieldCode: string) => void;
  onFocusLegalOrRel: (id: string, label: string) => void;
  selectedPdfQuote: { page: number; quote: string } | null;
  onJumpToPage: (page: number) => void;
  onUpsertFieldRecord: (record: FieldRecord, auditNote?: string) => void;
  onDeleteFieldRecord: (recordId: string) => void;
  onSaveLegalItem: (item: LegalConclusionItem, auditNote?: string) => void;
  onDeleteLegalItem: (id: string) => void;
  onSaveRelationItem: (item: EventRelationItem, auditNote?: string) => void;
  onDeleteRelationItem: (id: string) => void;
  onOpenLegalTab: () => void;
  externalBucketRequest?: { bucket: FieldFilterBucket; nonce: number } | null;
}

const PRESENCE_OPTIONS: PresenceStatus[] = [
  'present',
  'explicit_negative',
  'not_mentioned',
  'not_applicable',
  'unreadable',
  'source_conflict',
  'needs_review',
];

export const FieldAnnotationPanel: React.FC<FieldAnnotationPanelProps> = ({
  caseDoc,
  selectedEntity,
  userRole,
  supplements,
  activeRecordKey,
  activeLegalOrRelId,
  onFocusRecord,
  onFocusLegalOrRel,
  selectedPdfQuote,
  onJumpToPage,
  onUpsertFieldRecord,
  onDeleteFieldRecord,
  onSaveLegalItem,
  onDeleteLegalItem,
  onSaveRelationItem,
  onDeleteRelationItem,
  onOpenLegalTab,
  externalBucketRequest,
}) => {
  const [groupFilter, setGroupFilter] = useState<'ALL' | GroupCode>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusBucket, setStatusBucket] = useState<FieldFilterBucket>('all');

  useEffect(() => {
    if (externalBucketRequest) {
      setStatusBucket(externalBucketRequest.bucket);
      setGroupFilter('ALL');
      setSearchQuery('');
    }
  }, [externalBucketRequest]);

  useEffect(() => {
    const focusTarget = activeLegalOrRelId || activeRecordKey;
    if (!focusTarget) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-focus-id="${CSS.escape(focusTarget)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeRecordKey, activeLegalOrRelId, selectedEntity.id]);

  const supplementByCode = useMemo(
    () => new Map(supplements.map((s) => [s.fieldCode, s])),
    [supplements],
  );

  const recordByFieldCode = useMemo(() => {
    const map = new Map<string, FieldRecord>();
    for (const r of caseDoc.fieldRecords) {
      if (r.entityId === selectedEntity.id) {
        map.set(r.fieldCode, r);
      }
    }
    return map;
  }, [caseDoc.fieldRecords, selectedEntity.id]);

  // All ordinary G01–G06 fields applicable to the current entity
  const entityApplicableDefs = useMemo(
    () =>
      MASTER_FIELD_SCHEMA.filter(
        (def) => !def.isLegalOrRelation && def.applicableKinds.includes(selectedEntity.kind),
      ),
    [selectedEntity.kind],
  );

  const bucketCounts = useMemo(
    () => computeEntityWorkbenchStats(caseDoc, selectedEntity.id),
    [caseDoc, selectedEntity.id],
  );

  // Filtered ordinary fact fields for display
  const applicableFields = useMemo(() => {
    return entityApplicableDefs.filter((def) => {
      if (groupFilter !== 'ALL' && def.groupCode !== groupFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = `${def.fieldCode} ${def.fieldName} ${def.existingCodeTable} ${def.statusNote}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const existing = recordByFieldCode.get(def.fieldCode);
      if (!matchesFieldRecordBucket(existing, statusBucket)) {
        return false;
      }
      return true;
    });
  }, [entityApplicableDefs, groupFilter, searchQuery, statusBucket, recordByFieldCode]);

  const filteredSubjectLegalItems = useMemo(() => {
    if (selectedEntity.kind !== 'P' && selectedEntity.kind !== 'O') return [];
    if (groupFilter !== 'ALL' || statusBucket === 'unstarted') return [];
    const q = searchQuery.trim().toLowerCase();
    const matched = caseDoc.legalConclusions.filter((item) => {
      if (item.subjectId !== selectedEntity.id) return false;
      if (q) {
        const hay = `${item.id} ${item.conclusionLabel} ${item.rawText} ${item.lawArticle}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const hasBlockingOrError =
        PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
        validateLegalConclusion(item).some((i) => i.severity === 'error');
      return matchesWorkItemStatus(
        {
          reviewStatus: item.reviewStatus,
          presenceStatus: item.presenceStatus,
          hasBlockingOrError,
        },
        statusBucket,
      );
    });
    return sortLegalConclusionsByChain(matched);
  }, [caseDoc.legalConclusions, selectedEntity.id, selectedEntity.kind, groupFilter, statusBucket, searchQuery]);

  const filteredEventRelations = useMemo(() => {
    if (selectedEntity.kind !== 'E') return [];
    if (groupFilter !== 'ALL' || statusBucket === 'unstarted') return [];
    const q = searchQuery.trim().toLowerCase();
    return caseDoc.relations
      .filter((rel) => {
        if (rel.eventId !== selectedEntity.id) return false;
        if (q) {
          const hay = `${rel.id} ${rel.fieldCode || 'D08.F049'} ${rel.sourceId} ${rel.targetId} ${rel.action} ${rel.relationType || ''} ${rel.collisionMode || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        const presence = rel.presenceStatus || 'present';
        const hasBlockingOrError =
          PRESENCE_STATUS_META[presence].blocksScoring ||
          validateRelation(rel).some((i) => i.severity === 'error');
        return matchesWorkItemStatus(
          {
            reviewStatus: rel.reviewStatus,
            presenceStatus: presence,
            hasBlockingOrError,
          },
          statusBucket,
        );
      })
      .sort((a, b) => a.stageOrder - b.stageOrder);
  }, [caseDoc.relations, selectedEntity.id, selectedEntity.kind, groupFilter, statusBucket, searchQuery]);

  const visibleEntityItemsCount =
    applicableFields.length + filteredSubjectLegalItems.length + filteredEventRelations.length;

  // Grab accident datetime raw value for D02.F007 derivation helper
  const accidentDatetimeRecord = caseDoc.fieldRecords.find(
    (r) => r.entityId === 'ACC' && r.fieldCode === 'D02.F006',
  );

  const createEmptyRecord = (def: FieldDefinition, presence: PresenceStatus = 'present'): FieldRecord => ({
    recordId: `FR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    entityId: selectedEntity.id,
    fieldCode: def.fieldCode,
    presenceStatus: presence,
    rawValue: '',
    normalizedValues: [],
    evidences: [],
    reviewStatus: 'draft',
    disputeReason: '',
    adjudicatorNote: '',
    updatedByRole: userRole,
    updatedAt: new Date().toISOString(),
  });

  const handlePresenceChange = (def: FieldDefinition, existing: FieldRecord | undefined, nextStatus: PresenceStatus) => {
    const base = existing ? { ...existing } : createEmptyRecord(def, nextStatus);
    const rule = PRESENCE_STATUS_META[nextStatus];
    base.presenceStatus = nextStatus;
    if (rule.forbidsValue) {
      base.rawValue = '';
      base.normalizedValues = [];
    }
    if (userRole === 'annotator') {
      base.reviewStatus = 'draft';
    }
    base.updatedByRole = userRole;
    base.updatedAt = new Date().toISOString();
    onFocusRecord(selectedEntity.id, def.fieldCode);
    onUpsertFieldRecord(base);
  };

  const handleValueUpdate = (
    def: FieldDefinition,
    existing: FieldRecord | undefined,
    patch: Partial<FieldRecord>,
    auditNote?: string,
  ) => {
    const base = existing ? { ...existing } : createEmptyRecord(def, 'present');
    const updated: FieldRecord = {
      ...base,
      ...patch,
      updatedByRole: userRole,
      updatedAt: new Date().toISOString(),
    };
    if (userRole === 'annotator' && patch.reviewStatus === undefined) {
      updated.reviewStatus = 'draft';
    }
    onUpsertFieldRecord(updated, auditNote);
  };

  const handleBindSelectedQuote = (def: FieldDefinition, existing: FieldRecord | undefined) => {
    if (!selectedPdfQuote || !selectedPdfQuote.quote.trim()) return;
    const base = existing ? { ...existing } : createEmptyRecord(def, 'present');
    const duplicate = base.evidences.some(
      (ev) => ev.page === selectedPdfQuote.page && ev.quote === selectedPdfQuote.quote.trim(),
    );
    if (duplicate) return;
    const nextEvidences = [
      ...base.evidences,
      {
        id: `EV-${Date.now().toString(36)}`,
        page: selectedPdfQuote.page,
        quote: selectedPdfQuote.quote.trim(),
      },
    ];
    handleValueUpdate(def, existing, { evidences: nextEvidences });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Filter, Status Classification & Search Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="搜索字段编码或名称"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索字段编码、名称或码表…"
                className="w-52 rounded border border-slate-300 bg-white py-1 pr-2.5 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              />
            </div>

            <label className="sr-only" htmlFor="group-filter-select">
              按组别筛选字段
            </label>
            <select
              id="group-filter-select"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value as 'ALL' | GroupCode)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800"
            >
              <option value="ALL">全部普通事实字段组</option>
              {(['G01', 'G02', 'G03', 'G04', 'G05', 'G06'] as GroupCode[]).map((code) => (
                <option key={code} value={code}>
                  {GROUP_META[code]}
                </option>
              ))}
            </select>
          </div>

          <span className="text-xs text-slate-500">
            当前主体：<strong className="font-mono-tabular text-slate-900">{selectedEntity.id}</strong>{' '}
            <span aria-hidden="true">·</span> {selectedEntity.label}{' '}
            <span aria-hidden="true">·</span> 本主体 {visibleEntityItemsCount}/{bucketCounts.all} 项
          </span>
        </div>

        {/* Clean Underline Workflow Status Filter Tabs */}
        <div
          aria-label="按流转完成状态筛选"
          className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-2"
        >
          {(
            [
              ['all', '全部'],
              ['pending_action', '待处理'],
              ['unstarted', '未开始标注'],
              ['draft', '草稿'],
              ['disputed', '争议中'],
              ['blocking_or_error', '阻断/报错'],
              ['checked', '已复核'],
              ['specialist_review', '专业裁定'],
            ] as Array<[FieldFilterBucket, string]>
          ).map(([key, label]) => {
            const count = bucketCounts[key];
            const isSelected = statusBucket === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatusBucket(key)}
                className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 text-xs transition-colors ${
                  isSelected
                    ? 'border-slate-900 font-semibold text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                <span>{label}</span>
                <span className="font-mono-tabular text-[11px] opacity-75">({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Empty State */}
      {visibleEntityItemsCount === 0 &&
        (statusBucket !== 'all' ||
          groupFilter !== 'ALL' ||
          searchQuery.trim().length > 0 ||
          (selectedEntity.kind !== 'P' &&
            selectedEntity.kind !== 'O' &&
            selectedEntity.kind !== 'E')) && (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
            <p className="text-sm font-medium text-slate-800">没有匹配的适用记录</p>
            <button
              type="button"
              onClick={() => {
                setGroupFilter('ALL');
                setSearchQuery('');
                setStatusBucket('all');
              }}
              className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              重置筛选
            </button>
          </div>
        )}

      {/* Field Rows */}
      <div className="flex flex-col gap-3">
        {applicableFields.map((def) => {
          const record = recordByFieldCode.get(def.fieldCode);
          const supplement = supplementByCode.get(def.fieldCode);
          const mergedOptions = Array.from(
            new Set([...(def.presetOptions || []), ...(supplement?.candidateOptions || [])]),
          );
          const recordKey = `${selectedEntity.id}:${def.fieldCode}`;
          const isFocused = activeRecordKey === recordKey;
          const presence = record?.presenceStatus;
          const presenceRule = presence ? PRESENCE_STATUS_META[presence] : null;
          const issues = record ? validateFieldRecord(record) : [];
          const hasError =
            Boolean(presenceRule?.blocksScoring) ||
            issues.some((i) => i.severity === 'error');

          return (
            <div
              key={recordKey}
              data-focus-id={recordKey}
              onClick={() => onFocusRecord(selectedEntity.id, def.fieldCode)}
              className={`rounded-lg border p-4 transition-colors ${getCardStatusBorderClass(
                record?.reviewStatus,
                hasError,
                isFocused,
              )} ${!record ? 'bg-white' : ''}`}
            >
              {/* Field Header */}
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono-tabular font-semibold text-slate-800">
                      {def.fieldCode}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{def.groupName}</span>
                    <span aria-hidden="true">·</span>
                    <span>{def.valueType}</span>
                    {def.existingCodeTable && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono-tabular text-slate-600">
                          码表 {def.existingCodeTable}
                        </span>
                      </>
                    )}
                    {supplement && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-700">
                          增补词表 ({supplement.approvalStatus})
                        </span>
                      </>
                    )}
                  </div>
                  <h3
                    className="mt-1 text-[15px] font-semibold text-slate-900"
                    title={def.statusNote}
                  >
                    {def.fieldName}
                    {def.isSensitivePii && (
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        （导出脱敏）
                      </span>
                    )}
                  </h3>
                </div>

                {/* Review Lifecycle Stepper + Quick Clear */}
                <div className="flex items-start gap-2">
                  <ReviewLifecycleBar
                    reviewStatus={record?.reviewStatus}
                    hasError={hasError}
                  />

                  {record && (
                    <button
                      type="button"
                      aria-label={`移除 ${def.fieldCode} ${def.fieldName} 记录`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteFieldRecord(record.recordId);
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Step 4: Seven Presence Status Selector */}
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700">记录状态</span>
                  {presenceRule && (presenceRule.forbidsValue || presenceRule.blocksScoring) && (
                    <span
                      className={
                        presenceRule.tone === 'warn' ? 'text-amber-700' : 'text-red-700'
                      }
                    >
                      {presenceRule.requirement}
                    </span>
                  )}
                </div>
                <div className="inline-flex flex-wrap gap-0.5 rounded-md bg-slate-100 p-0.5">
                  {PRESENCE_OPTIONS.map((statusKey) => {
                    const meta = PRESENCE_STATUS_META[statusKey];
                    const active = presence === statusKey;
                    return (
                      <button
                        key={statusKey}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePresenceChange(def, record, statusKey);
                        }}
                        className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                          active
                            ? meta.tone === 'stop'
                              ? 'bg-white text-red-700 shadow-xs'
                              : meta.tone === 'warn'
                                ? 'bg-white text-amber-800 shadow-xs'
                                : 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Step 5: Values & Evidence (only shown once a status is chosen) */}
              {record && (
                <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3">
                  {def.isLegalOrRelation && (
                    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
                      提示：此字段属于法律结论或碰撞关系，建议优先在顶部「法律与关系」独立面板按主体与事件分条登记。
                    </div>
                  )}

                  {!presenceRule?.forbidsValue && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {/* Raw Value */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <label
                            htmlFor={`raw-${recordKey}`}
                            className="text-xs font-medium text-slate-700"
                          >
                            原文值（保留文书表达）
                          </label>
                          {def.fieldCode === 'D02.F007' && accidentDatetimeRecord?.rawValue && (
                            <button
                              type="button"
                              onClick={() => {
                                const derived = deriveTimeBucket(accidentDatetimeRecord.rawValue);
                                if (derived) {
                                  handleValueUpdate(def, record, {
                                    rawValue: accidentDatetimeRecord.rawValue,
                                    normalizedValues: [derived],
                                  });
                                }
                              }}
                              className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:text-blue-900"
                            >
                              <Calculator className="h-3 w-3" />
                              按事故时间计算时段
                            </button>
                          )}
                        </div>
                        <input
                          id={`raw-${recordKey}`}
                          type="text"
                          value={record.rawValue}
                          onChange={(e) =>
                            handleValueUpdate(def, record, { rawValue: e.target.value })
                          }
                          placeholder="按材料原文填写，勿自行改写法律含义"
                          className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                        />
                      </div>

                      {/* Controlled Vocabulary / Normalized Value */}
                      <div>
                        <label
                          htmlFor={`norm-${recordKey}`}
                          className="mb-1 block text-xs font-medium text-slate-700"
                        >
                          人工确认标准值{def.allowMultiple ? '（支持多选）' : '（单选/输入）'}
                        </label>
                        {mergedOptions.length > 0 ? (
                          def.allowMultiple ? (
                            <div className="flex flex-wrap gap-1.5 rounded-md border border-slate-200 bg-slate-50 p-2">
                              {mergedOptions.map((opt) => {
                                const checked = record.normalizedValues.includes(opt);
                                return (
                                  <label
                                    key={opt}
                                    className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                      checked
                                        ? 'border-blue-600 bg-blue-50 text-blue-900'
                                        : 'border-slate-200 bg-white text-slate-700'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) => {
                                        const next = e.target.checked
                                          ? [...record.normalizedValues, opt]
                                          : record.normalizedValues.filter((v) => v !== opt);
                                        handleValueUpdate(def, record, { normalizedValues: next });
                                      }}
                                      className="h-3 w-3 accent-blue-700"
                                    />
                                    {opt}
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <select
                              id={`norm-${recordKey}`}
                              value={record.normalizedValues[0] || ''}
                              onChange={(e) =>
                                handleValueUpdate(def, record, {
                                  normalizedValues: e.target.value ? [e.target.value] : [],
                                })
                              }
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                            >
                              <option value="">-- 请选择标准词表取值 --</option>
                              {mergedOptions.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          )
                        ) : (
                          <input
                            id={`norm-${recordKey}`}
                            type="text"
                            value={record.normalizedValues.join('；')}
                            onChange={(e) =>
                              handleValueUpdate(def, record, {
                                normalizedValues: e.target.value
                                  ? e.target.value.split(/[；;]/).map((s) => s.trim()).filter(Boolean)
                                  : [],
                              })
                            }
                            placeholder="填入人工确认的标准值（可用分号分隔）"
                            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Evidence Binding List */}
                  <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700">
                        证据摘录
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={!selectedPdfQuote?.quote.trim()}
                          onClick={() => handleBindSelectedQuote(def, record)}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
                        >
                          <Link2 className="h-3 w-3" />
                          引用左侧选区
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleValueUpdate(def, record, {
                              evidences: [
                                ...record.evidences,
                                { id: `EV-${Date.now().toString(36)}`, page: 1, quote: '' },
                              ],
                            })
                          }
                          className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-600 hover:text-slate-900 hover:underline"
                        >
                          <Plus className="h-3 w-3" />
                          手动添加一条
                        </button>
                      </div>
                    </div>

                    {record.evidences.length === 0 ? (
                      <p className="text-xs text-slate-400">暂无证据</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {record.evidences.map((ev, idx) => (
                          <div key={ev.id} className="flex items-center gap-2">
                            <span className="text-xs text-slate-500">第</span>
                            <input
                              type="number"
                              min={1}
                              max={Math.max(1, caseDoc.pageCount)}
                              aria-label={`第 ${idx + 1} 条证据页码`}
                              value={ev.page}
                              onChange={(e) => {
                                const pageNum = Math.max(1, parseInt(e.target.value, 10) || 1);
                                const nextEvs = record.evidences.map((item) =>
                                  item.id === ev.id ? { ...item, page: pageNum } : item,
                                );
                                handleValueUpdate(def, record, { evidences: nextEvs });
                              }}
                              className="font-mono-tabular w-14 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                            />
                            <span className="text-xs text-slate-500">页</span>
                            <button
                              type="button"
                              title={`跳转到第 ${ev.page} 页`}
                              aria-label={`定位到第 ${ev.page} 页`}
                              onClick={() => onJumpToPage(ev.page)}
                              className="shrink-0 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                            >
                              定位
                            </button>
                            <input
                              type="text"
                              aria-label={`第 ${idx + 1} 条证据原文`}
                              value={ev.quote}
                              onChange={(e) => {
                                const nextEvs = record.evidences.map((item) =>
                                  item.id === ev.id ? { ...item, quote: e.target.value } : item,
                                );
                                handleValueUpdate(def, record, { evidences: nextEvs });
                              }}
                              placeholder="粘贴最短支持原文（勿复制整页）"
                              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900"
                            />
                            <button
                              type="button"
                              aria-label="删除证据"
                              onClick={() => {
                                const nextEvs = record.evidences.filter((item) => item.id !== ev.id);
                                handleValueUpdate(def, record, { evidences: nextEvs });
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Validation Warnings */}
                  {issues.length > 0 && (
                    <div className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                      {issues.map((iss) => (
                        <div key={iss.code} className="flex items-center gap-1.5 text-xs text-red-800">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{iss.message}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Role-Based Review & Adjudication Controls */}
                  {(userRole !== 'annotator' || record.disputeReason || record.adjudicatorNote) && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">

                    {userRole === 'reviewer' && (
                      <div className="flex w-full flex-wrap items-center justify-between gap-2">
                        <input
                          type="text"
                          aria-label="复核分歧说明"
                          value={record.disputeReason}
                          onChange={(e) =>
                            handleValueUpdate(def, record, {
                              disputeReason: e.target.value,
                              reviewStatus: record.reviewStatus,
                            })
                          }
                          placeholder="若有分歧，请填写争议原因（主体/值/证据不一致）…"
                          className="min-w-[240px] flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900"
                        />
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              handleValueUpdate(
                                def,
                                record,
                                { reviewStatus: 'checked', disputeReason: '' },
                                `复核通过 ${selectedEntity.id}.${def.fieldCode}`,
                              )
                            }
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                          >
                            <Check className="h-3.5 w-3.5" />
                            核对一致 (已复核)
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleValueUpdate(
                                def,
                                record,
                                { reviewStatus: 'disputed' },
                                `发起争议 ${selectedEntity.id}.${def.fieldCode}`,
                              )
                            }
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            标记争议
                          </button>
                        </div>
                      </div>
                    )}

                    {userRole === 'adjudicator' && (
                      <div className="flex w-full flex-wrap items-center justify-between gap-2">
                        <input
                          type="text"
                          aria-label="业务裁定理由"
                          value={record.adjudicatorNote}
                          onChange={(e) =>
                            handleValueUpdate(def, record, {
                              adjudicatorNote: e.target.value,
                              reviewStatus: record.reviewStatus,
                            })
                          }
                          placeholder="填写业务裁定结论与依据说明…"
                          className="min-w-[240px] flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            handleValueUpdate(
                              def,
                              record,
                              { reviewStatus: 'specialist_review' },
                              `完成专业裁定 ${selectedEntity.id}.${def.fieldCode}`,
                            )
                          }
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white hover:bg-blue-800"
                        >
                          <Check className="h-3.5 w-3.5" />
                          完成专业裁定
                        </button>
                      </div>
                    )}

                    {userRole === 'annotator' && (record.disputeReason || record.adjudicatorNote) && (
                      <div className="w-full rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                        {record.disputeReason && <p>复核争议：{record.disputeReason}</p>}
                        {record.adjudicatorNote && <p>裁定说明：{record.adjudicatorNote}</p>}
                      </div>
                    )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Synced Per-Participant / Per-Organization Legal Conclusions (P01+, O01+) */}
      {(selectedEntity.kind === 'P' || selectedEntity.kind === 'O') &&
        groupFilter === 'ALL' &&
        statusBucket !== 'unstarted' &&
        (filteredSubjectLegalItems.length > 0 || (statusBucket === 'all' && !searchQuery.trim())) && (
        <section
          aria-label={`${selectedEntity.id} 法律结论同步区`}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {selectedEntity.id} · {selectedEntity.label} · 违法、原因与责任
              </h3>
              {(() => {
                const subjItems = caseDoc.legalConclusions.filter(
                  (l) => l.subjectId === selectedEntity.id,
                );
                const vioCount = subjItems.filter((l) => l.category === 'violation').length;
                const cauCount = subjItems.filter((l) => l.category === 'cause').length;
                const liaCount = subjItems.filter((l) => l.category === 'liability').length;
                return (
                  <span className="font-mono-tabular text-xs text-slate-500">
                    违法 {vioCount} → 原因 {cauCount} → 责任 {liaCount}
                  </span>
                );
              })()}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {(
                [
                  ['violation', '违法行为', 'D10.F058'],
                  ['cause', '认定原因', 'D10.F059'],
                  ['liability', '责任划分', 'D10.F060'],
                ] as Array<[LegalCategory, string, string]>
              ).map(([cat, label]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    const events = caseDoc.entities.filter((e) => e.kind === 'E');
                    const newItem: LegalConclusionItem = {
                      id: `${cat === 'violation' ? 'VIO' : cat === 'cause' ? 'CAU' : 'LIA'}-${Date.now().toString(36)}`,
                      category: cat,
                      subjectId: selectedEntity.id,
                      eventId: events[0]?.id || '',
                      presenceStatus: 'present',
                      rawText: '',
                      lawArticle: '',
                      conclusionLabel: cat === 'liability' ? '全部责任' : '',
                      ...(cat !== 'liability'
                        ? { causalLinkStatus: 'unspecified' as CausalLinkStatus, linkedViolationIds: [] }
                        : { linkedCauseIds: [] }),
                      evidences: selectedPdfQuote
                        ? [
                            {
                              id: `EV-${Date.now().toString(36)}`,
                              page: selectedPdfQuote.page,
                              quote: selectedPdfQuote.quote,
                            },
                          ]
                        : [],
                      reviewStatus: 'draft',
                      disputeReason: '',
                      adjudicatorNote: '',
                    };
                    onSaveLegalItem(newItem);
                    onFocusLegalOrRel(newItem.id, `${selectedEntity.id} · ${label}`);
                  }}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                >
                  <Plus className="h-3 w-3" />
                  新增{label}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const subjectLegalItems = filteredSubjectLegalItems;
            const events = caseDoc.entities.filter((e) => e.kind === 'E');
            const allViolations = caseDoc.legalConclusions.filter((l) => l.category === 'violation');
            const allCauses = caseDoc.legalConclusions.filter((l) => l.category === 'cause');
            if (subjectLegalItems.length === 0) {
              return (
                <p className="py-4 text-center text-xs text-slate-400">
                  暂无违法、原因或责任记录
                </p>
              );
            }
            return (
              <div className="flex flex-col gap-3">
                {subjectLegalItems.map((item) => {
                  const catTitle =
                    item.category === 'violation'
                      ? '认定违法 (D10.F058)'
                      : item.category === 'cause'
                        ? '认定原因 (D10.F059)'
                        : '责任划分 (D10.F060)';
                  const legalIssues = validateLegalConclusion(item);
                  const legalHasErr =
                    PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
                    legalIssues.some((i) => i.severity === 'error');
                  const isItemFocused = activeLegalOrRelId === item.id;
                  const prioritizedViolations = [...allViolations].sort((a, b) => {
                    const aSame = a.subjectId === item.subjectId ? 0 : 1;
                    const bSame = b.subjectId === item.subjectId ? 0 : 1;
                    return aSame - bSame;
                  });
                  const prioritizedCauses = [...allCauses].sort((a, b) => {
                    const aSame = a.subjectId === item.subjectId ? 0 : 1;
                    const bSame = b.subjectId === item.subjectId ? 0 : 1;
                    return aSame - bSame;
                  });
                  const referencingCauses =
                    item.category === 'violation'
                      ? allCauses.filter((c) => (c.linkedViolationIds || []).includes(item.id))
                      : [];
                  const handleCreateLinkedViolation = () => {
                    const newVioId = `VIO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
                    const newVio: LegalConclusionItem = {
                      id: newVioId,
                      category: 'violation',
                      subjectId: item.subjectId,
                      eventId: item.eventId || events[0]?.id || '',
                      presenceStatus: 'present',
                      rawText: '',
                      lawArticle: '',
                      conclusionLabel: '',
                      causalLinkStatus: 'explicit_linked',
                      linkedViolationIds: [],
                      evidences: selectedPdfQuote
                        ? [
                            {
                              id: `EV-${Date.now().toString(36)}`,
                              page: selectedPdfQuote.page,
                              quote: selectedPdfQuote.quote,
                            },
                          ]
                        : [],
                      reviewStatus: 'draft',
                      disputeReason: '',
                      adjudicatorNote: '',
                    };
                    onSaveLegalItem(newVio, `补录并关联违法行为 ${newVioId}`);
                    const nextLinked = Array.from(
                      new Set([...(item.linkedViolationIds || []), newVioId]),
                    );
                    const nextCausalStatus: CausalLinkStatus =
                      !item.causalLinkStatus || item.causalLinkStatus === 'unspecified'
                        ? 'explicit_linked'
                        : item.causalLinkStatus;
                    onSaveLegalItem({
                      ...item,
                      causalLinkStatus: nextCausalStatus,
                      linkedViolationIds: nextLinked,
                    });
                    onFocusLegalOrRel(newVioId, `${item.subjectId} · 认定违法 (D10.F058)`);
                  };
                  const handleCreateLinkedCause = (fromViolation?: LegalConclusionItem) => {
                    const newCauId = `CAU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
                    const newCau: LegalConclusionItem = {
                      id: newCauId,
                      category: 'cause',
                      subjectId: item.subjectId,
                      eventId: item.eventId || events[0]?.id || '',
                      presenceStatus: 'present',
                      rawText: '',
                      lawArticle: '',
                      conclusionLabel: '',
                      causalLinkStatus: fromViolation ? 'explicit_linked' : 'unspecified',
                      linkedViolationIds: fromViolation ? [fromViolation.id] : [],
                      evidences: selectedPdfQuote
                        ? [
                            {
                              id: `EV-${Date.now().toString(36)}`,
                              page: selectedPdfQuote.page,
                              quote: selectedPdfQuote.quote,
                            },
                          ]
                        : [],
                      reviewStatus: 'draft',
                      disputeReason: '',
                      adjudicatorNote: '',
                    };
                    onSaveLegalItem(newCau, `补录并关联认定原因 ${newCauId}`);
                    if (item.category === 'liability') {
                      onSaveLegalItem({
                        ...item,
                        linkedCauseIds: Array.from(
                          new Set([...(item.linkedCauseIds || []), newCauId]),
                        ),
                      });
                    }
                    onFocusLegalOrRel(newCauId, `${item.subjectId} · 认定原因 (D10.F059)`);
                  };
                  return (
                    <div
                      key={item.id}
                      data-focus-id={item.id}
                      onClick={() =>
                        onFocusLegalOrRel(item.id, `${selectedEntity.id} · ${catTitle}`)
                      }
                      className={`rounded-md border p-3 transition-colors ${getCardStatusBorderClass(
                        item.reviewStatus,
                        legalHasErr,
                        isItemFocused,
                      )}`}
                    >
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono-tabular font-semibold text-slate-900">
                            {item.id}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-blue-800">{catTitle}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <ReviewLifecycleBar
                            reviewStatus={item.reviewStatus}
                            hasError={legalHasErr}
                          />
                          <button
                            type="button"
                            aria-label={`删除法律结论 ${item.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteLegalItem(item.id);
                            }}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-700">
                            关联阶段事件 (E)
                          </label>
                          <select
                            value={item.eventId}
                            onChange={(e) =>
                              onSaveLegalItem({ ...item, eventId: e.target.value })
                            }
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          >
                            <option value="">整起事故 (ACC)</option>
                            {events.map((ev) => (
                              <option key={ev.id} value={ev.id}>
                                {ev.id} · {ev.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-700">
                            存在性状态 (presence)
                          </label>
                          <select
                            value={item.presenceStatus}
                            onChange={(e) =>
                              onSaveLegalItem({
                                ...item,
                                presenceStatus: e.target.value as PresenceStatus,
                              })
                            }
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          >
                            {(Object.keys(PRESENCE_STATUS_META) as PresenceStatus[]).map((st) => (
                              <option key={st} value={st}>
                                {PRESENCE_STATUS_META[st].label} ({st})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-700">
                            标准结论 (candidate_value)
                          </label>
                          <input
                            type="text"
                            value={item.conclusionLabel}
                            onChange={(e) =>
                              onSaveLegalItem({ ...item, conclusionLabel: e.target.value })
                            }
                            placeholder={
                              item.category === 'liability'
                                ? '全部责任 / 主要责任 / 次要责任 / 无责任'
                                : item.category === 'cause'
                                  ? '根本原因 / 全部原因 / 主要原因 / 次要原因'
                                  : '如：未保持安全车距 / 违规变道'
                            }
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                        </div>
                      </div>

                      {item.category !== 'liability' ? (
                        <div className="mt-2 grid grid-cols-1 gap-2 rounded border border-slate-200 bg-white p-2 sm:grid-cols-12">
                          <div className="sm:col-span-5">
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                              因果关联状态 (causal_link_status)
                            </label>
                            <select
                              value={item.causalLinkStatus || 'unspecified'}
                              onChange={(e) =>
                                onSaveLegalItem({
                                  ...item,
                                  causalLinkStatus: e.target.value as CausalLinkStatus,
                                })
                              }
                              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                            >
                              <option value="unspecified">未明确 (unspecified)</option>
                              <option value="explicit_linked">明确关联违法 (explicit_linked)</option>
                              <option value="explicit_unlinked">明确无直接因果 (explicit_unlinked)</option>
                              <option value="multiple_mixed">多因混合 (multiple_mixed)</option>
                            </select>
                          </div>
                          {item.category === 'violation' && (
                            <div className="sm:col-span-7">
                              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-medium text-slate-700">
                                  被认定原因引用
                                </span>
                                {item.presenceStatus === 'present' && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCreateLinkedCause(item);
                                    }}
                                    className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                                  >
                                    <Plus className="h-3 w-3" />
                                    基于此违法补录原因
                                  </button>
                                )}
                              </div>
                              {referencingCauses.length === 0 ? (
                                <span className="text-xs text-slate-400">
                                  {item.presenceStatus === 'explicit_negative'
                                    ? '明确无违法，不产生因果引用'
                                    : '尚未被认定原因记录引用'}
                                </span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {referencingCauses.map((cau) => (
                                    <button
                                      key={cau.id}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onFocusLegalOrRel(
                                          cau.id,
                                          `${cau.subjectId} · 认定原因 (D10.F059)`,
                                        );
                                      }}
                                      className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs text-blue-900 hover:bg-blue-100"
                                    >
                                      <span className="font-mono-tabular">{cau.id}</span>
                                      <span>({cau.conclusionLabel || '已关联'})</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {item.category === 'cause' && (
                            <div className="sm:col-span-7">
                              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-medium text-slate-700">
                                  关联违法记录 (linked_violation_record_ids)
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCreateLinkedViolation();
                                  }}
                                  className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                                >
                                  <Plus className="h-3 w-3" />
                                  补录违法行为并关联
                                </button>
                              </div>
                              {prioritizedViolations.length === 0 ? (
                                <span className="text-xs text-slate-400">
                                  暂无可勾选违法记录，请点击右上「补录违法行为并关联」
                                </span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {prioritizedViolations.map((vio) => {
                                    const checked = (item.linkedViolationIds || []).includes(vio.id);
                                    return (
                                      <label
                                        key={vio.id}
                                        className={`inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                                          checked
                                            ? 'border-blue-600 bg-blue-50 text-blue-900'
                                            : 'border-slate-200 bg-slate-50 text-slate-700'
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(e) => {
                                            const curr = item.linkedViolationIds || [];
                                            const next = e.target.checked
                                              ? [...curr, vio.id]
                                              : curr.filter((x) => x !== vio.id);
                                            const nextCausalStatus: CausalLinkStatus =
                                              e.target.checked &&
                                              (!item.causalLinkStatus ||
                                                item.causalLinkStatus === 'unspecified')
                                                ? 'explicit_linked'
                                                : item.causalLinkStatus || 'unspecified';
                                            onSaveLegalItem({
                                              ...item,
                                              causalLinkStatus: nextCausalStatus,
                                              linkedViolationIds: next,
                                            });
                                          }}
                                          className="h-3 w-3 accent-blue-700"
                                        />
                                        <span className="font-mono-tabular">{vio.id}</span>
                                        <span className="max-w-[140px] truncate">
                                          ({vio.subjectId}
                                          {vio.conclusionLabel ? ` · ${vio.conclusionLabel}` : ''})
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="mt-2 rounded border border-slate-200 bg-white p-2">
                          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-700">
                              责任依据的认定原因 (linked_cause_record_ids)
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCreateLinkedCause();
                              }}
                              className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline"
                            >
                              <Plus className="h-3 w-3" />
                              补录认定原因并关联
                            </button>
                          </div>
                          {prioritizedCauses.length === 0 ? (
                            <span className="text-xs text-slate-400">
                              暂无认定原因记录，若文书认定有责可点击右上「补录认定原因并关联」
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {prioritizedCauses.map((cau) => {
                                const checked = (item.linkedCauseIds || []).includes(cau.id);
                                return (
                                  <label
                                    key={cau.id}
                                    className={`inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                                      checked
                                        ? 'border-blue-600 bg-blue-50 text-blue-900'
                                        : 'border-slate-200 bg-slate-50 text-slate-700'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) => {
                                        const curr = item.linkedCauseIds || [];
                                        const next = e.target.checked
                                          ? [...curr, cau.id]
                                          : curr.filter((x) => x !== cau.id);
                                        onSaveLegalItem({ ...item, linkedCauseIds: next });
                                      }}
                                      className="h-3 w-3 accent-blue-700"
                                    />
                                    <span className="font-mono-tabular">{cau.id}</span>
                                    <span className="max-w-[160px] truncate">
                                      ({cau.subjectId}
                                      {cau.conclusionLabel ? ` · ${cau.conclusionLabel}` : ''})
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {item.category !== 'cause' && (
                        <div className="mt-2">
                          <label className="mb-1 block text-xs font-medium text-slate-700">
                            援引法律条款原文
                          </label>
                          <input
                            type="text"
                            value={item.lawArticle}
                            onChange={(e) =>
                              onSaveLegalItem({ ...item, lawArticle: e.target.value })
                            }
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                        </div>
                      )}

                      <div className="mt-2">
                        <label className="mb-1 block text-xs font-medium text-slate-700">
                          文书原文结论 (raw_value)
                        </label>
                        <textarea
                          rows={2}
                          value={item.rawText}
                          onChange={(e) =>
                            onSaveLegalItem({ ...item, rawText: e.target.value })
                          }
                          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        />
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.evidences.map((ev) => (
                            <span
                              key={ev.id}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-slate-700"
                            >
                              <button
                                type="button"
                                onClick={() => onJumpToPage(ev.page)}
                                className="font-mono-tabular font-medium text-blue-800"
                              >
                                p.{ev.page}
                              </button>
                              <span className="max-w-[220px] truncate">{ev.quote}</span>
                              <button
                                type="button"
                                aria-label="删除证据"
                                onClick={() =>
                                  onSaveLegalItem({
                                    ...item,
                                    evidences: item.evidences.filter((x) => x.id !== ev.id),
                                  })
                                }
                                className="text-slate-400 hover:text-red-700"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                        <button
                          type="button"
                          disabled={!selectedPdfQuote?.quote.trim()}
                          onClick={() => {
                            if (!selectedPdfQuote?.quote.trim()) return;
                            onSaveLegalItem({
                              ...item,
                              evidences: [
                                ...item.evidences,
                                {
                                  id: `EV-${Date.now().toString(36)}`,
                                  page: selectedPdfQuote.page,
                                  quote: selectedPdfQuote.quote.trim(),
                                },
                              ],
                            });
                          }}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                        >
                          <Link2 className="h-3 w-3" />
                          引用左侧选区
                        </button>
                      </div>

                      {legalIssues.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1">
                          {legalIssues.map((iss) => (
                            <div
                              key={iss.code}
                              className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs ${
                                iss.severity === 'error'
                                  ? 'border-red-200 bg-red-50 text-red-800'
                                  : 'border-amber-200 bg-amber-50 text-amber-900'
                              }`}
                            >
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span>{iss.message}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {userRole !== 'annotator' && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2">
                          <input
                            type="text"
                            aria-label={
                              userRole === 'reviewer' ? '法律结论复核分歧说明' : '法律结论裁定理由'
                            }
                            value={
                              userRole === 'reviewer' ? item.disputeReason : item.adjudicatorNote
                            }
                            onChange={(e) =>
                              onSaveLegalItem(
                                userRole === 'reviewer'
                                  ? { ...item, disputeReason: e.target.value }
                                  : { ...item, adjudicatorNote: e.target.value },
                              )
                            }
                            placeholder={
                              userRole === 'reviewer'
                                ? '若有分歧请填写争议原因…'
                                : '填写业务裁定结论与依据说明…'
                            }
                            className="min-w-[200px] flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                          {userRole === 'reviewer' ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  onSaveLegalItem(
                                    { ...item, reviewStatus: 'checked', disputeReason: '' },
                                    `复核通过法律结论 ${item.id}`,
                                  )
                                }
                                className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white"
                              >
                                <Check className="h-3 w-3" />
                                已复核
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onSaveLegalItem(
                                    { ...item, reviewStatus: 'disputed' },
                                    `标记争议法律结论 ${item.id}`,
                                  )
                                }
                                className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                              >
                                <XCircle className="h-3 w-3" />
                                争议中
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                onSaveLegalItem(
                                  { ...item, reviewStatus: 'specialist_review' },
                                  `完成裁定法律结论 ${item.id}`,
                                )
                              }
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-2.5 py-1 text-xs font-medium text-white"
                            >
                              <Check className="h-3 w-3" />
                              完成专业裁定
                            </button>
                          )}
                        </div>
                      )}
                      {userRole === 'annotator' && (item.disputeReason || item.adjudicatorNote) && (
                        <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                          {item.disputeReason && <p>复核争议：{item.disputeReason}</p>}
                          {item.adjudicatorNote && <p>裁定说明：{item.adjudicatorNote}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </section>
      )}

      {/* Synced Event Relations & Stage Legal Summary (E01+) */}
      {selectedEntity.kind === 'E' &&
        groupFilter === 'ALL' &&
        statusBucket !== 'unstarted' &&
        (filteredEventRelations.length > 0 || (statusBucket === 'all' && !searchQuery.trim())) && (
        <section
          aria-label={`${selectedEntity.id} 事件碰撞关系同步区`}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              {selectedEntity.id} · {selectedEntity.label} · 碰撞关系
            </h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const nextOrder = caseDoc.relations.length + 1;
                  const newRel: EventRelationItem = {
                    id: `REL-${Date.now().toString(36)}`,
                    fieldCode: 'D08.F049',
                    eventId: selectedEntity.id,
                    stageOrder: nextOrder,
                    sourceId: caseDoc.entities.find((e) => e.kind === 'V')?.id || 'P01',
                    action: '撞击',
                    relationType: '追尾碰撞',
                    targetId:
                      caseDoc.entities.filter((e) => e.kind === 'V' || e.kind === 'P')[1]?.id ||
                      'R01',
                    collisionMode: '追尾碰撞',
                    directionNote: '',
                    presenceStatus: 'present',
                    evidences: selectedPdfQuote
                      ? [
                          {
                            id: `EV-${Date.now().toString(36)}`,
                            page: selectedPdfQuote.page,
                            quote: selectedPdfQuote.quote,
                          },
                        ]
                      : [],
                    reviewStatus: 'draft',
                    disputeReason: '',
                    adjudicatorNote: '',
                  };
                  onSaveRelationItem(newRel);
                  onFocusLegalOrRel(newRel.id, `${selectedEntity.id} · 碰撞关系`);
                }}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                <Plus className="h-3.5 w-3.5" />
                新增本事件碰撞关系
              </button>
              <button
                type="button"
                onClick={onOpenLegalTab}
                className="whitespace-nowrap text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
              >
                前往「法律与关系」完整视图 →
              </button>
            </div>
          </div>

          {(() => {
            const eventRelations = filteredEventRelations;
            const linkedLegal = caseDoc.legalConclusions.filter(
              (l) => l.eventId === selectedEntity.id,
            );

            return (
              <div className="flex flex-col gap-3">
                {eventRelations.length === 0 ? (
                  <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                    本事件尚未登记碰撞主客体关系，请点击右上角「新增本事件碰撞关系」。
                  </p>
                ) : (
                  eventRelations.map((rel) => {
                    const relHasErr =
                      PRESENCE_STATUS_META[rel.presenceStatus || 'present'].blocksScoring ||
                      validateRelation(rel).some((i) => i.severity === 'error');
                    return (
                      <div
                        key={rel.id}
                        data-focus-id={rel.id}
                        onClick={() =>
                          onFocusLegalOrRel(rel.id, `${selectedEntity.id} · 碰撞关系`)
                        }
                        className={`rounded-md border p-3 text-xs transition-colors ${getCardStatusBorderClass(
                          rel.reviewStatus,
                          relHasErr,
                          activeLegalOrRelId === rel.id,
                        )}`}
                      >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono-tabular font-semibold text-slate-900">
                            顺序 #{rel.stageOrder} · {rel.fieldCode || 'D08.F049'} · {rel.id}
                          </span>
                          <div className="flex items-center gap-2">
                            <ReviewLifecycleBar
                              reviewStatus={rel.reviewStatus}
                              hasError={relHasErr}
                            />
                            <button
                              type="button"
                              aria-label={`删除关系 ${rel.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteRelationItem(rel.id);
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <select
                            aria-label="字段编码"
                            value={rel.fieldCode || 'D08.F049'}
                            onChange={(e) =>
                              onSaveRelationItem({ ...rel, fieldCode: e.target.value })
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          >
                            <option value="D08.F049">D08.F049 · 主客体碰撞关系</option>
                            <option value="D08.F048">D08.F048 · 碰撞方式</option>
                            <option value="D08.F047">D08.F047 · 事件阶段顺序</option>
                          </select>
                          <select
                            aria-label="存在性状态"
                            value={rel.presenceStatus || 'present'}
                            onChange={(e) =>
                              onSaveRelationItem({
                                ...rel,
                                presenceStatus: e.target.value as PresenceStatus,
                              })
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          >
                            {(Object.keys(PRESENCE_STATUS_META) as PresenceStatus[]).map((st) => (
                              <option key={st} value={st}>
                                {PRESENCE_STATUS_META[st].label} ({st})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <select
                            aria-label="施动主体"
                            value={cleanRelationEntityId(rel.sourceId)}
                            onChange={(e) =>
                              onSaveRelationItem({ ...rel, sourceId: e.target.value })
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          >
                            {caseDoc.entities.map((ent) => (
                              <option key={ent.id} value={ent.id}>
                                施动：{ent.id} · {ent.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            aria-label="标准关系类型"
                            value={rel.relationType ?? rel.collisionMode ?? rel.action}
                            onChange={(e) =>
                              onSaveRelationItem({
                                ...rel,
                                relationType: e.target.value,
                                collisionMode: e.target.value,
                              })
                            }
                            placeholder="关系类型 (如 撞击路侧固定设施)"
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          />
                          <select
                            aria-label="受动客体"
                            value={cleanRelationEntityId(rel.targetId)}
                            onChange={(e) =>
                              onSaveRelationItem({ ...rel, targetId: e.target.value })
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          >
                            {caseDoc.entities.map((ent) => (
                              <option key={ent.id} value={ent.id}>
                                客体：{ent.id} · {ent.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <input
                            type="text"
                            aria-label="碰撞动作原文"
                            value={rel.action}
                            onChange={(e) =>
                              onSaveRelationItem({ ...rel, action: e.target.value })
                            }
                            placeholder="碰撞动作原文 (如 失控偏离撞击)"
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          />
                          <input
                            type="text"
                            aria-label="方向说明"
                            value={rel.directionNote}
                            onChange={(e) =>
                              onSaveRelationItem({ ...rel, directionNote: e.target.value })
                            }
                            placeholder="方向与经过说明"
                            className="rounded border border-slate-300 bg-white px-2 py-1"
                          />
                        </div>

                        {userRole !== 'annotator' && (
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2">
                            <input
                              type="text"
                              aria-label={
                                userRole === 'reviewer' ? '碰撞关系复核分歧说明' : '碰撞关系裁定理由'
                              }
                              value={
                                userRole === 'reviewer' ? rel.disputeReason : rel.adjudicatorNote
                              }
                              onChange={(e) =>
                                onSaveRelationItem(
                                  userRole === 'reviewer'
                                    ? { ...rel, disputeReason: e.target.value }
                                    : { ...rel, adjudicatorNote: e.target.value },
                                )
                              }
                              placeholder={
                                userRole === 'reviewer'
                                  ? '若有分歧请填写争议原因…'
                                  : '填写业务裁定结论与依据说明…'
                              }
                              className="min-w-[200px] flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                            />
                            {userRole === 'reviewer' ? (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    onSaveRelationItem(
                                      { ...rel, reviewStatus: 'checked', disputeReason: '' },
                                      `复核通过事件关系 ${rel.id}`,
                                    )
                                  }
                                  className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white"
                                >
                                  <Check className="h-3 w-3" />
                                  已复核
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onSaveRelationItem(
                                      { ...rel, reviewStatus: 'disputed' },
                                      `标记争议事件关系 ${rel.id}`,
                                    )
                                  }
                                  className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                                >
                                  <XCircle className="h-3 w-3" />
                                  争议中
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  onSaveRelationItem(
                                    { ...rel, reviewStatus: 'specialist_review' },
                                    `完成裁定事件关系 ${rel.id}`,
                                  )
                                }
                                className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-2.5 py-1 text-xs font-medium text-white"
                              >
                                <Check className="h-3 w-3" />
                                完成专业裁定
                              </button>
                            )}
                          </div>
                        )}
                        {userRole === 'annotator' && (rel.disputeReason || rel.adjudicatorNote) && (
                          <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                            {rel.disputeReason && <p>复核争议：{rel.disputeReason}</p>}
                            {rel.adjudicatorNote && <p>裁定说明：{rel.adjudicatorNote}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}

                {linkedLegal.length > 0 && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-1.5 text-xs font-medium text-slate-700">
                      已关联到 {selectedEntity.id} 的参与方违法/原因/责任摘要（共 {linkedLegal.length} 条）
                    </div>
                    <ul className="space-y-1 text-xs text-slate-600">
                      {linkedLegal.map((l) => {
                        const fallbackCat =
                          l.category === 'violation'
                            ? '认定违法（待填）'
                            : l.category === 'cause'
                              ? '认定原因（待填）'
                              : '责任划分（待填）';
                        return (
                          <li key={l.id}>
                            <span className="font-mono-tabular font-semibold text-slate-800">
                              {l.subjectId}
                            </span>{' '}
                            <span aria-hidden="true">·</span> {l.conclusionLabel || fallbackCat}{' '}
                            <span aria-hidden="true">·</span> {l.rawText || '暂无原文结论'}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </section>
      )}
    </div>
  );
};
