import React, { useMemo, useState } from 'react';
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
  REVIEW_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  EntityItem,
  EventRelationItem,
  FieldDefinition,
  FieldRecord,
  GroupCode,
  LegalCategory,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
  VocabularySupplementItem,
} from '../types/gold';
import { deriveTimeBucket, validateFieldRecord } from '../utils/goldRules';

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
}) => {
  const [groupFilter, setGroupFilter] = useState<'ALL' | GroupCode>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);

  const supplementByCode = useMemo(
    () => new Map(supplements.map((s) => [s.fieldCode, s])),
    [supplements],
  );

  // Ordinary fact fields applicable to the currently selected entity (G01–G06 only; G07/G08 are managed cleanly without duplication)
  const applicableFields = useMemo(() => {
    return MASTER_FIELD_SCHEMA.filter((def) => {
      if (def.isLegalOrRelation) return false;
      if (!def.applicableKinds.includes(selectedEntity.kind)) return false;
      if (groupFilter !== 'ALL' && def.groupCode !== groupFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = `${def.fieldCode} ${def.fieldName} ${def.existingCodeTable} ${def.statusNote}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (onlyUnreviewed) {
        const existing = caseDoc.fieldRecords.find(
          (r) => r.entityId === selectedEntity.id && r.fieldCode === def.fieldCode,
        );
        if (!existing || existing.reviewStatus === 'checked' || existing.reviewStatus === 'specialist_review') {
          return false;
        }
      }
      return true;
    });
  }, [selectedEntity, groupFilter, searchQuery, onlyUnreviewed, caseDoc.fieldRecords]);

  const recordByFieldCode = useMemo(() => {
    const map = new Map<string, FieldRecord>();
    for (const r of caseDoc.fieldRecords) {
      if (r.entityId === selectedEntity.id) {
        map.set(r.fieldCode, r);
      }
    }
    return map;
  }, [caseDoc.fieldRecords, selectedEntity.id]);

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
      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
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
              className="w-56 rounded-md border border-slate-300 bg-slate-50 py-1.5 pr-2.5 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
          </div>

          <label className="sr-only" htmlFor="group-filter-select">
            按组别筛选字段
          </label>
          <select
            id="group-filter-select"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as 'ALL' | GroupCode)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
          >
            <option value="ALL">全部普通事实字段组</option>
            {(['G01', 'G02', 'G03', 'G04', 'G05', 'G06'] as GroupCode[]).map((code) => (
              <option key={code} value={code}>
                {GROUP_META[code]}
              </option>
            ))}
          </select>

          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={onlyUnreviewed}
              onChange={(e) => setOnlyUnreviewed(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 accent-blue-700"
            />
            仅看草稿/争议项
          </label>
        </div>

        <div className="text-xs text-slate-500">
          当前主体：<strong className="font-mono-tabular text-slate-900">{selectedEntity.id}</strong>{' '}
          <span aria-hidden="true">·</span> {selectedEntity.label}{' '}
          <span aria-hidden="true">·</span> 适用普通字段 {applicableFields.length} 项
        </div>
      </div>

      {/* Empty State for non-legal/non-event entities */}
      {applicableFields.length === 0 &&
        selectedEntity.kind !== 'P' &&
        selectedEntity.kind !== 'O' &&
        selectedEntity.kind !== 'E' && (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
            <p className="text-sm font-medium text-slate-800">没有匹配的适用字段</p>
            <p className="mt-1 text-xs text-slate-500">
              请清除筛选条件，或在上方步骤 2 选择其他对象（如 ACC、P01、V01、R01）。
            </p>
            <button
              type="button"
              onClick={() => {
                setGroupFilter('ALL');
                setSearchQuery('');
                setOnlyUnreviewed(false);
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
          const reviewMeta = record ? REVIEW_STATUS_META[record.reviewStatus] : null;

          return (
            <div
              key={recordKey}
              onClick={() => onFocusRecord(selectedEntity.id, def.fieldCode)}
              className={`rounded-lg border bg-white p-4 transition-colors ${
                isFocused
                  ? 'border-blue-600 ring-1 ring-blue-600/20'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
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
                  <h3 className="mt-1 text-sm font-semibold text-slate-900">
                    {def.fieldName}
                    {def.isSensitivePii && (
                      <span className="ml-2 text-xs font-normal text-amber-700">
                        （含敏感标识，对外导出自动脱敏）
                      </span>
                    )}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">{def.statusNote}</p>
                </div>

                {/* Review Status Indicator + Quick Clear */}
                <div className="flex items-center gap-2">
                  {reviewMeta ? (
                    <span
                      className={`whitespace-nowrap text-xs font-semibold ${
                        reviewMeta.tone === 'good'
                          ? 'text-emerald-700'
                          : reviewMeta.tone === 'stop'
                            ? 'text-red-700'
                            : reviewMeta.tone === 'accent'
                              ? 'text-blue-700'
                              : 'text-slate-600'
                      }`}
                    >
                      工作状态：{reviewMeta.label}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">未开始标注</span>
                  )}

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
                  <span className="font-medium text-slate-700">步骤 4 · 记录状态（7选1）</span>
                  {presenceRule && (
                    <span
                      className={
                        presenceRule.tone === 'good'
                          ? 'text-emerald-700'
                          : presenceRule.tone === 'warn'
                            ? 'text-amber-700'
                            : 'text-red-700'
                      }
                    >
                      {presenceRule.requirement}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
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
                        className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                          active
                            ? meta.tone === 'good'
                              ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
                              : meta.tone === 'warn'
                                ? 'border-amber-600 bg-amber-50 text-amber-900'
                                : 'border-red-700 bg-red-50 text-red-900'
                            : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white'
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
                        步骤 5 · 证据摘录（页码 + 最短支持原文）
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!selectedPdfQuote?.quote.trim()}
                          onClick={() => handleBindSelectedQuote(def, record)}
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-blue-700 bg-white px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
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
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <Plus className="h-3 w-3" />
                          手动添加一条
                        </button>
                      </div>
                    </div>

                    {record.evidences.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        暂无证据。请在左侧 PDF 划选支持原文后点击“引用左侧选区”，或手动添加。
                      </p>
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
                              className="shrink-0 whitespace-nowrap rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-50"
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
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                    {userRole === 'annotator' && (
                      <p className="text-xs text-slate-500">
                        第一标注人编辑后默认保持“草稿”状态，须由第二复核人核对或业务裁定后才进入评分。
                      </p>
                    )}

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
                        <div className="flex items-center gap-1.5">
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
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-red-700 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
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

                    {/* Show existing dispute / adjudicator notes to all roles */}
                    {userRole === 'annotator' && (record.disputeReason || record.adjudicatorNote) && (
                      <div className="w-full rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                        {record.disputeReason && <p>复核争议：{record.disputeReason}</p>}
                        {record.adjudicatorNote && <p>裁定说明：{record.adjudicatorNote}</p>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Synced Per-Participant / Per-Organization Legal Conclusions (P01+, O01+) */}
      {(selectedEntity.kind === 'P' || selectedEntity.kind === 'O') && (
        <section
          aria-label={`${selectedEntity.id} 法律结论同步区`}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {selectedEntity.id} · {selectedEntity.label} 的违法行为、认定原因与责任划分
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                此区与顶部「法律与关系」页签实时同步（单源存储、绝不重复填报）；同一参与方可按不同事实或事件阶段新增多条违法与原因。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
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
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                >
                  <Plus className="h-3 w-3" />
                  新增{label}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const subjectLegalItems = caseDoc.legalConclusions.filter(
              (l) => l.subjectId === selectedEntity.id,
            );
            const events = caseDoc.entities.filter((e) => e.kind === 'E');
            if (subjectLegalItems.length === 0) {
              return (
                <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                  {selectedEntity.id} 尚未登记违法行为、认定原因或责任划分；如无违法/无责任，也建议点击右上角新增一条明确记录。
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
                  const revMeta = REVIEW_STATUS_META[item.reviewStatus];
                  const isItemFocused = activeLegalOrRelId === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() =>
                        onFocusLegalOrRel(item.id, `${selectedEntity.id} · ${catTitle}`)
                      }
                      className={`rounded-md border p-3 ${
                        isItemFocused
                          ? 'border-blue-600 bg-blue-50/20'
                          : 'border-slate-200 bg-slate-50/50'
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono-tabular font-semibold text-slate-900">
                            {item.id}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-blue-800">{catTitle}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-slate-600">工作状态：{revMeta.label}</span>
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

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                            结论标签 / 等级
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
                          文书原文结论
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
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-blue-700 bg-white px-2 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:border-slate-200 disabled:text-slate-400"
                        >
                          <Link2 className="h-3 w-3" />
                          引用左侧选区
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </section>
      )}

      {/* Synced Event Relations & Stage Legal Summary (E01+) */}
      {selectedEntity.kind === 'E' && (
        <section
          aria-label={`${selectedEntity.id} 事件碰撞关系同步区`}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {selectedEntity.id} · {selectedEntity.label}（事件顺序、碰撞方式与主客体关系）
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                事件对象 E 专门承载碰撞主客体关系（D08.F047/048/049）并作为多阶段原因/责任的阶段锚点，无需在此重复填参与人的认定原因。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const nextOrder = caseDoc.relations.length + 1;
                  const newRel: EventRelationItem = {
                    id: `REL-${Date.now().toString(36)}`,
                    eventId: selectedEntity.id,
                    stageOrder: nextOrder,
                    sourceId: caseDoc.entities.find((e) => e.kind === 'V')?.id || 'P01',
                    action: '撞击',
                    targetId:
                      caseDoc.entities.filter((e) => e.kind === 'V' || e.kind === 'P')[1]?.id ||
                      'R01',
                    collisionMode: '追尾碰撞',
                    directionNote: '',
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
                  onFocusLegalOrRel(newRel.id, `${selectedEntity.id} · 碰撞关系 (${newRel.id})`);
                }}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
              >
                <Plus className="h-3.5 w-3.5" />
                新增本事件碰撞关系
              </button>
              <button
                type="button"
                onClick={onOpenLegalTab}
                className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                前往「法律与关系」完整视图
              </button>
            </div>
          </div>

          {(() => {
            const eventRelations = caseDoc.relations
              .filter((r) => r.eventId === selectedEntity.id)
              .sort((a, b) => a.stageOrder - b.stageOrder);
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
                  eventRelations.map((rel) => (
                    <div
                      key={rel.id}
                      onClick={() =>
                        onFocusLegalOrRel(rel.id, `${selectedEntity.id} · 碰撞关系 (${rel.id})`)
                      }
                      className={`rounded-md border p-3 text-xs ${
                        activeLegalOrRelId === rel.id
                          ? 'border-blue-600 bg-blue-50/20'
                          : 'border-slate-200 bg-slate-50/50'
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          顺序 #{rel.stageOrder} · {rel.id}
                        </span>
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
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <input
                          type="text"
                          aria-label="施动主体"
                          value={rel.sourceId}
                          onChange={(e) =>
                            onSaveRelationItem({ ...rel, sourceId: e.target.value })
                          }
                          placeholder="施动主体 (如 V01)"
                          className="rounded border border-slate-300 bg-white px-2 py-1"
                        />
                        <input
                          type="text"
                          aria-label="动作"
                          value={rel.action}
                          onChange={(e) =>
                            onSaveRelationItem({ ...rel, action: e.target.value })
                          }
                          placeholder="动作 (如 追尾撞击)"
                          className="rounded border border-slate-300 bg-white px-2 py-1"
                        />
                        <input
                          type="text"
                          aria-label="受动客体"
                          value={rel.targetId}
                          onChange={(e) =>
                            onSaveRelationItem({ ...rel, targetId: e.target.value })
                          }
                          placeholder="受动客体 (如 V02)"
                          className="rounded border border-slate-300 bg-white px-2 py-1"
                        />
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          type="text"
                          aria-label="碰撞方式"
                          value={rel.collisionMode}
                          onChange={(e) =>
                            onSaveRelationItem({ ...rel, collisionMode: e.target.value })
                          }
                          placeholder="碰撞方式 (D08.F048)"
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
                    </div>
                  ))
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
