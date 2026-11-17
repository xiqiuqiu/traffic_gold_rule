import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Scale,
  Search,
} from 'lucide-react';
import {
  ACCEPTANCE_CHECKLIST_ITEMS,
  INITIAL_VOCABULARY_SUPPLEMENTS,
  PRESENCE_STATUS_META,
} from '../data/schemaCatalog';
import {
  CaseDocument,
  CaseWorkItem,
  UserRole,
  VocabularySupplementItem,
  WorkItemFilterStatus,
} from '../types/gold';
import {
  buildGoldExportPayload,
  buildGoldV02ExportPayload,
  buildReviewMarkdown,
  collectCaseWorkItems,
  computeCaseReadiness,
  computeEntityProgressMap,
  filterWorkItems,
} from '../utils/goldRules';
import { ReviewLifecycleBar } from './ReviewLifecycleBar';

interface AcceptanceExportPanelProps {
  caseDoc: CaseDocument;
  allCases: CaseDocument[];
  userRole: UserRole;
  supplements?: VocabularySupplementItem[];
  statusFilter: WorkItemFilterStatus;
  onStatusFilterChange: (status: WorkItemFilterStatus) => void;
  onJumpToItem: (item: CaseWorkItem) => void;
  onJumpToEntityUnstarted: (entityId: string) => void;
  onQuickTransitionItem: (item: CaseWorkItem, nextStatus: 'checked' | 'specialist_review') => void;
  onToggleChecklistItem: (checkId: string, checked: boolean) => void;
  onToggleMaskPii: (mask: boolean) => void;
  onBatchApproveDrafts: () => void;
}

const ITEM_TYPE_LABEL: Record<CaseWorkItem['itemType'], string> = {
  field: '普通事实',
  legal: '法律结论',
  relation: '碰撞关系',
};

export const AcceptanceExportPanel: React.FC<AcceptanceExportPanelProps> = ({
  caseDoc,
  allCases,
  userRole,
  supplements = INITIAL_VOCABULARY_SUPPLEMENTS,
  statusFilter,
  onStatusFilterChange,
  onJumpToItem,
  onJumpToEntityUnstarted,
  onQuickTransitionItem,
  onToggleChecklistItem,
  onToggleMaskPii,
  onBatchApproveDrafts,
}) => {
  const [copied, setCopied] = useState(false);
  const [exportFormat, setExportFormat] = useState<'v0.2' | 'audit'>('v0.2');
  const [itemTypeFilter, setItemTypeFilter] = useState<'all' | 'field' | 'legal' | 'relation'>('all');
  const [entityFilter, setEntityFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const readiness = useMemo(() => computeCaseReadiness(caseDoc, supplements), [caseDoc, supplements]);
  const allWorkItems = useMemo(() => collectCaseWorkItems(caseDoc, supplements), [caseDoc, supplements]);
  const entityProgressMap = useMemo(() => computeEntityProgressMap(caseDoc, supplements), [caseDoc, supplements]);

  const counts = useMemo(() => {
    let pending = 0;
    let draft = 0;
    let disputed = 0;
    let blockingOrError = 0;
    let checked = 0;
    let specialist = 0;
    for (const item of allWorkItems) {
      if (item.needsAttention) pending += 1;
      if (item.hasBlockingOrError) blockingOrError += 1;
      if (item.reviewStatus === 'draft') draft += 1;
      else if (item.reviewStatus === 'disputed') disputed += 1;
      else if (item.reviewStatus === 'checked') checked += 1;
      else if (item.reviewStatus === 'specialist_review') specialist += 1;
    }
    return {
      total: allWorkItems.length,
      pending,
      draft,
      disputed,
      blockingOrError,
      checked,
      specialist,
    };
  }, [allWorkItems]);

  const totalUnstartedFields = Object.values(entityProgressMap).reduce(
    (acc, p) => acc + p.applicableUnstartedCount,
    0,
  );

  const filteredItems = useMemo(
    () =>
      filterWorkItems(allWorkItems, {
        status: statusFilter,
        itemType: itemTypeFilter,
        entityId: entityFilter,
        query: searchQuery,
      }),
    [allWorkItems, statusFilter, itemTypeFilter, entityFilter, searchQuery],
  );

  const jsonPayload = useMemo(
    () =>
      exportFormat === 'v0.2'
        ? buildGoldV02ExportPayload(caseDoc, caseDoc.maskPiiOnExport)
        : buildGoldExportPayload(caseDoc, caseDoc.maskPiiOnExport),
    [caseDoc, exportFormat],
  );
  const formattedJson = useMemo(() => JSON.stringify(jsonPayload, null, 2), [jsonPayload]);

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    downloadFile(
      formattedJson,
      exportFormat === 'v0.2'
        ? `${caseDoc.caseId.toLowerCase()}_gold_sample_v0.2.json`
        : `${caseDoc.caseId.toLowerCase()}_gold_audit_${caseDoc.annotationVersion}.json`,
      'application/json;charset=utf-8',
    );
  };

  const handleDownloadAllScoredJsonl = () => {
    const lines = allCases
      .filter((c) => computeCaseReadiness(c, supplements).eligibleForScoring)
      .map((c) =>
        JSON.stringify(
          exportFormat === 'v0.2'
            ? buildGoldV02ExportPayload(c, c.maskPiiOnExport)
            : buildGoldExportPayload(c, c.maskPiiOnExport),
        ),
      );
    if (lines.length === 0) return;
    downloadFile(
      lines.join('\n'),
      exportFormat === 'v0.2'
        ? 'gold_eval_dataset_v0.2_eligible.jsonl'
        : 'gold_eval_dataset_audit_eligible.jsonl',
      'application/x-ndjson;charset=utf-8',
    );
  };

  const handleDownloadReviewMd = () => {
    const md = buildReviewMarkdown(caseDoc);
    downloadFile(
      md,
      `${caseDoc.caseId.toLowerCase()}_rules_review.md`,
      'text/markdown;charset=utf-8',
    );
  };

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(formattedJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback ignored if clipboard permission unavailable
    }
  };

  const eligibleCasesCount = allCases.filter(
    (c) => computeCaseReadiness(c, supplements).eligibleForScoring,
  ).length;

  const metricStrip: Array<{
    key: WorkItemFilterStatus;
    label: string;
    value: number;
    toneClass: string;
  }> = [
    {
      key: 'pending_action',
      label: '待处理合计',
      value: counts.pending,
      toneClass: counts.pending > 0 ? 'text-amber-700' : 'text-emerald-700',
    },
    {
      key: 'draft',
      label: '草稿 · 待复核',
      value: counts.draft,
      toneClass: counts.draft > 0 ? 'text-slate-900' : 'text-slate-400',
    },
    {
      key: 'disputed',
      label: '争议中 · 待裁定',
      value: counts.disputed,
      toneClass: counts.disputed > 0 ? 'text-red-700' : 'text-slate-400',
    },
    {
      key: 'blocking_or_error',
      label: '阻断 / 报错',
      value: counts.blockingOrError,
      toneClass: counts.blockingOrError > 0 ? 'text-red-700' : 'text-slate-400',
    },
    {
      key: 'checked',
      label: '已复核',
      value: counts.checked,
      toneClass: 'text-emerald-700',
    },
    {
      key: 'specialist_review',
      label: '专业裁定',
      value: counts.specialist,
      toneClass: 'text-blue-800',
    },
  ];

  const isFullyComplete = readiness.eligibleForScoring;
  const isRecordsCleared = counts.pending === 0 && counts.total > 0;

  return (
    <div className="flex flex-col divide-y divide-slate-200 bg-white">
      {/* Section 1: Unified Case Acceptance & Status Overview */}
      <section className="px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {isFullyComplete ? (
              <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
            ) : (
              <AlertTriangle
                className={`mt-1 h-5 w-5 shrink-0 ${
                  isRecordsCleared ? 'text-slate-500' : 'text-amber-700'
                }`}
                aria-hidden="true"
              />
            )}
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                {isFullyComplete
                  ? '本案已全部处理完毕 · 可正式交付评测'
                  : isRecordsCleared
                    ? '已建记录已全部复核/裁定完成 · 待确认验收清单'
                    : `尚有 ${counts.pending} 项待处理 · 暂未达到交付门禁`}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                共 {counts.total} 条已建记录（已复核 {counts.checked} · 专业裁定{' '}
                {counts.specialist}）
                <span aria-hidden="true"> · </span>
                验收清单 {readiness.checklistCheckedCount}/{readiness.checklistTotalCount}
                {totalUnstartedFields > 0 && (
                  <>
                    <span aria-hidden="true"> · </span>
                    另有{' '}
                    <span className="font-mono-tabular font-semibold text-slate-700">
                      {totalUnstartedFields}
                    </span>{' '}
                    项适用字段未填
                  </>
                )}
              </p>
            </div>
          </div>

          {!isFullyComplete && counts.draft > 0 && (
            <button
              type="button"
              onClick={onBatchApproveDrafts}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              复核通过全部无错草稿 ({counts.draft})
            </button>
          )}
        </div>

        {/* Blocking Reasons as clean muted prose list */}
        {readiness.blockingReasons.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-amber-800">
            {readiness.blockingReasons.map((reason) => (
              <li key={reason}>· {reason}</li>
            ))}
          </ul>
        )}

        {/* Unified 6-Column Typographic Metric Strip (replaces separate bordered stat cards) */}
        <div className="mt-5 grid grid-cols-2 border-y border-slate-200 sm:grid-cols-3 lg:grid-cols-6">
          {metricStrip.map((metric) => {
            const active = statusFilter === metric.key;
            return (
              <button
                key={metric.key}
                type="button"
                onClick={() => onStatusFilterChange(active ? 'all' : metric.key)}
                title={`点击筛选“${metric.label}”记录`}
                className={`flex flex-col items-start border-b-2 px-3.5 py-3 text-left transition-colors ${
                  active
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-transparent hover:bg-slate-50/70'
                }`}
              >
                <span className="text-xs text-slate-500">{metric.label}</span>
                <span
                  className={`font-mono-tabular mt-1 text-2xl font-semibold tracking-tight ${metric.toneClass}`}
                >
                  {metric.value}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Section 2: Per-Entity Completion & Unstarted Fields Matrix */}
      <section className="px-6 py-5">
        <h3 className="mb-3 text-base font-semibold text-slate-900">
          对象完成度与未填缺口
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-3 font-medium">对象</th>
                <th className="px-2 py-2 text-right font-medium">已建记录</th>
                <th className="px-2 py-2 text-right font-medium">未填适用字段</th>
                <th className="px-2 py-2 text-right font-medium">草稿</th>
                <th className="px-2 py-2 text-right font-medium">争议中</th>
                <th className="px-2 py-2 text-right font-medium">已复核</th>
                <th className="px-2 py-2 text-right font-medium">专业裁定</th>
                <th className="py-2 pl-3 text-right font-medium">筛选下钻</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {caseDoc.entities.map((ent) => {
                const p = entityProgressMap[ent.id];
                if (!p) return null;
                const isSelectedFilter = entityFilter === ent.id;
                return (
                  <tr
                    key={ent.id}
                    className={isSelectedFilter ? 'bg-slate-50' : 'hover:bg-slate-50/60'}
                  >
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          {ent.id}
                        </span>
                        <span className="max-w-[160px] truncate text-slate-700">{ent.label}</span>
                      </div>
                    </td>
                    <td className="font-mono-tabular px-2 py-2.5 text-right text-slate-700">
                      {p.totalItems}
                    </td>
                    <td className="font-mono-tabular px-2 py-2.5 text-right">
                      {p.applicableUnstartedCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => onJumpToEntityUnstarted(ent.id)}
                          className="font-medium text-amber-800 underline-offset-2 hover:underline"
                          title={`跳转到 ${ent.id} 查看尚未开始标注的字段`}
                        >
                          {p.applicableUnstartedCount} 项未填 →
                        </button>
                      ) : (
                        <span className="text-slate-300">0</span>
                      )}
                    </td>
                    <td
                      className={`font-mono-tabular px-2 py-2.5 text-right ${
                        p.draftCount > 0 ? 'font-semibold text-amber-800' : 'text-slate-300'
                      }`}
                    >
                      {p.draftCount}
                    </td>
                    <td
                      className={`font-mono-tabular px-2 py-2.5 text-right ${
                        p.disputedCount > 0 ? 'font-semibold text-red-700' : 'text-slate-300'
                      }`}
                    >
                      {p.disputedCount}
                    </td>
                    <td className="font-mono-tabular px-2 py-2.5 text-right text-slate-700">
                      {p.checkedCount}
                    </td>
                    <td className="font-mono-tabular px-2 py-2.5 text-right text-blue-800">
                      {p.specialistCount}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setEntityFilter(isSelectedFilter ? 'ALL' : ent.id);
                          if (!isSelectedFilter && p.pendingCount > 0) {
                            onStatusFilterChange('pending_action');
                          }
                        }}
                        className={`whitespace-nowrap text-xs font-medium underline-offset-2 hover:underline ${
                          isSelectedFilter ? 'text-slate-900 underline' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {isSelectedFilter ? '取消限定' : '仅看本对象'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section 3: Integrated Review Queue & Jump Locator */}
      <section className="px-6 py-5">
        <h3 className="mb-3 text-base font-semibold text-slate-900">
          条目审查与跳转定位
        </h3>

        {/* Underline Filter Tabs + Compact Controls */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-2">
          <div className="flex flex-wrap items-center gap-4">
            {(
              [
                ['all', '全部', counts.total],
                ['pending_action', '待处理', counts.pending],
                ['draft', '草稿', counts.draft],
                ['disputed', '争议中', counts.disputed],
                ['blocking_or_error', '阻断/报错', counts.blockingOrError],
                ['checked', '已复核', counts.checked],
                ['specialist_review', '专业裁定', counts.specialist],
              ] as Array<[WorkItemFilterStatus, string, number]>
            ).map(([key, label, count]) => {
              const active = statusFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onStatusFilterChange(key)}
                  className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 text-xs transition-colors ${
                    active
                      ? 'border-slate-900 font-semibold text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span>{label}</span>
                  <span className="font-mono-tabular text-[11px] opacity-75">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="按记录类型筛选"
              value={itemTypeFilter}
              onChange={(e) =>
                setItemTypeFilter(e.target.value as 'all' | 'field' | 'legal' | 'relation')
              }
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
            >
              <option value="all">全部记录类型</option>
              <option value="field">普通事实 (G01–G06)</option>
              <option value="legal">法律结论 (G08)</option>
              <option value="relation">碰撞关系 (G07)</option>
            </select>

            <select
              aria-label="按归属对象筛选"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
            >
              <option value="ALL">全部对象</option>
              {caseDoc.entities.map((ent) => (
                <option key={ent.id} value={ent.id}>
                  {ent.id} · {ent.label}
                </option>
              ))}
            </select>

            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="搜索队列记录"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜编码、名称或争议原因…"
                className="w-48 rounded border border-slate-300 bg-white py-1 pr-2.5 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium text-slate-900">
              {statusFilter === 'pending_action' && counts.pending === 0
                ? '本案已登记记录已全部复核或裁定完成'
                : '当前筛选条件下没有记录'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {statusFilter === 'pending_action' && counts.pending === 0
                ? totalUnstartedFields > 0
                  ? `尚有 ${totalUnstartedFields} 项适用字段未开始标注，可在上方对象表中点击跳转补齐，或切换“全部”查看已通过记录。`
                  : '可继续核对下方 10 项交付验收清单并导出 Gold JSON。'
                : '请调整状态、类型、对象或搜索关键词后重试。'}
            </p>
            <button
              type="button"
              onClick={() => {
                onStatusFilterChange('all');
                setItemTypeFilter('all');
                setEntityFilter('ALL');
                setSearchQuery('');
              }}
              className="mt-3 text-xs font-medium text-blue-700 underline-offset-2 hover:underline"
            >
              查看全部记录 ({counts.total})
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-2 font-medium">对象 / 类型</th>
                  <th className="px-2 py-2 font-medium">字段或条目</th>
                  <th className="px-2 py-2 font-medium">流转状态</th>
                  <th className="px-2 py-2 font-medium">当前取值 / 摘录</th>
                  <th className="py-2 pl-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.map((item) => {
                  const canQuickApprove =
                    userRole === 'reviewer' &&
                    item.reviewStatus === 'draft' &&
                    !item.hasBlockingOrError;
                  const canQuickAdjudicate =
                    userRole === 'adjudicator' &&
                    (item.reviewStatus === 'disputed' || item.reviewStatus === 'draft') &&
                    !item.hasBlockingOrError;

                  return (
                    <tr key={item.id} className="align-top hover:bg-slate-50/70">
                      <td className="py-2.5 pr-2 whitespace-nowrap">
                        <div className="font-mono-tabular font-semibold text-slate-900">
                          {item.entityId}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {ITEM_TYPE_LABEL[item.itemType]}
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="font-mono-tabular text-[11px] text-slate-500">
                          {item.code}
                        </div>
                        <div className="font-medium text-slate-900">{item.title}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {PRESENCE_STATUS_META[item.presenceStatus].label}
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <ReviewLifecycleBar
                          compact
                          reviewStatus={item.reviewStatus}
                          hasError={item.hasBlockingOrError}
                          disputeReason={
                            item.reviewStatus === 'disputed' ? item.notePreview : undefined
                          }
                          adjudicatorNote={
                            item.reviewStatus === 'specialist_review'
                              ? item.notePreview
                              : undefined
                          }
                        />
                        {item.needsAttention && (
                          <div className="mt-0.5 max-w-[260px] text-[11px] text-slate-500">
                            {item.issueSummary}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        <div
                          className="max-w-[200px] truncate text-slate-800"
                          title={item.valuePreview}
                        >
                          {item.valuePreview}
                        </div>
                      </td>
                      <td className="py-2.5 pl-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-3">
                          {canQuickApprove && (
                            <button
                              type="button"
                              onClick={() => onQuickTransitionItem(item, 'checked')}
                              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                            >
                              <Check className="h-3 w-3" />
                              复核通过
                            </button>
                          )}
                          {canQuickAdjudicate && (
                            <button
                              type="button"
                              onClick={() => onQuickTransitionItem(item, 'specialist_review')}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
                            >
                              <Scale className="h-3 w-3" />
                              裁定通过
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onJumpToItem(item)}
                            className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-800 underline-offset-2 hover:text-blue-700 hover:underline"
                          >
                            定位处理
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 4: 10-Item Acceptance Checklist */}
      <section className="px-6 py-5">
        <h3 className="mb-3 text-base font-semibold text-slate-900">
          交付标准验收清单（{readiness.checklistCheckedCount} /{' '}
          {readiness.checklistTotalCount}）
        </h3>

        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {ACCEPTANCE_CHECKLIST_ITEMS.map((item, idx) => {
            const checked = Boolean(caseDoc.checklist[item.id]);
            return (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-2.5 py-2.5 text-xs hover:bg-slate-50/60"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onToggleChecklistItem(item.id, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-slate-900"
                />
                <span className={checked ? 'text-slate-900' : 'text-slate-700'}>
                  <strong className="font-mono-tabular mr-2 font-medium text-slate-400">
                    {String(idx + 1).padStart(2, '0')}
                  </strong>
                  {item.label}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Section 5: Export Actions & Live JSON Output Preview */}
      <section className="px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">
            标准化人工基准输出
          </h3>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center rounded-md bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setExportFormat('v0.2')}
                className={`whitespace-nowrap rounded px-2.5 py-1 font-medium transition-colors ${
                  exportFormat === 'v0.2'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Gold v0.2 评测格式
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('audit')}
                className={`whitespace-nowrap rounded px-2.5 py-1 font-medium transition-colors ${
                  exportFormat === 'audit'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                完整审计格式
              </button>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={caseDoc.maskPiiOnExport}
                onChange={(e) => onToggleMaskPii(e.target.checked)}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              对外导出自动脱敏敏感标识
            </label>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"
          >
            <Download className="h-3.5 w-3.5" />
            {exportFormat === 'v0.2' ? '下载 Gold v0.2 JSON' : '下载完整审计 JSON'}
          </button>

          <button
            type="button"
            disabled={eligibleCasesCount === 0}
            onClick={handleDownloadAllScoredJsonl}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
          >
            <Download className="h-3.5 w-3.5" />
            导出已过审评测集 JSONL ({eligibleCasesCount} 份)
          </button>

          <button
            type="button"
            onClick={handleDownloadReviewMd}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline"
          >
            <Download className="h-3.5 w-3.5" />
            导出规则复盘报告 (.md)
          </button>

          <button
            type="button"
            onClick={handleCopyJson}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? '已复制 JSON' : '复制 JSON'}
          </button>
        </div>

        <pre
          data-testid="gold-json-preview"
          className="font-mono-tabular max-h-96 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-relaxed text-slate-100"
        >
          {formattedJson}
        </pre>
      </section>
    </div>
  );
};
