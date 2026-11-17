import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Link2, Plus, Trash2, XCircle } from 'lucide-react';
import { PRESENCE_STATUS_META } from '../data/schemaCatalog';
import {
  CaseDocument,
  CausalLinkStatus,
  EventRelationItem,
  LegalCategory,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
  WorkItemFilterStatus,
} from '../types/gold';
import {
  cleanRelationEntityId,
  matchesWorkItemStatus,
  validateLegalConclusion,
  validateRelation,
} from '../utils/goldRules';
import { ReviewLifecycleBar, getCardStatusBorderClass } from './ReviewLifecycleBar';

interface LegalRelationsPanelProps {
  caseDoc: CaseDocument;
  userRole: UserRole;
  selectedPdfQuote: { page: number; quote: string } | null;
  activeTargetId: string | null;
  onFocusTarget: (id: string, label: string) => void;
  onJumpToPage: (page: number) => void;
  onSaveLegalItem: (item: LegalConclusionItem, auditNote?: string) => void;
  onDeleteLegalItem: (id: string) => void;
  onSaveRelationItem: (item: EventRelationItem, auditNote?: string) => void;
  onDeleteRelationItem: (id: string) => void;
  externalFocusRequest?: { subTab: 'legal' | 'relations'; nonce: number } | null;
}

const CATEGORY_LABELS: Record<LegalCategory, { title: string; fieldCode: string; hint: string }> = {
  violation: {
    title: '认定违法行为',
    fieldCode: 'D10.F058',
    hint: '每项违法单独记录，挂在文书指明的参与方或组织上；一人可有多项违法。',
  },
  cause: {
    title: '认定事故原因',
    fieldCode: 'D10.F059',
    hint: '只记录文书明确认定的原因。违法与原因同时出现不代表自动因果，严禁补推断。',
  },
  liability: {
    title: '事故责任划分',
    fieldCode: 'D10.F060',
    hint: '每个责任主体一条；文书写明“无责任”时同样属于有明确记载的责任结果。',
  },
};

const CAUSAL_LINK_OPTIONS: Array<{ value: CausalLinkStatus; label: string }> = [
  { value: 'unspecified', label: '未明确 (unspecified)' },
  { value: 'explicit_linked', label: '明确关联违法 (explicit_linked)' },
  { value: 'explicit_unlinked', label: '明确无直接因果 (explicit_unlinked)' },
  { value: 'multiple_mixed', label: '多因混合 (multiple_mixed)' },
];

const RELATION_FIELD_CODES = [
  { code: 'D08.F049', label: 'D08.F049 · 主客体碰撞关系' },
  { code: 'D08.F048', label: 'D08.F048 · 碰撞方式' },
  { code: 'D08.F047', label: 'D08.F047 · 事件阶段顺序' },
];

export const LegalRelationsPanel: React.FC<LegalRelationsPanelProps> = ({
  caseDoc,
  userRole,
  selectedPdfQuote,
  activeTargetId,
  onFocusTarget,
  onJumpToPage,
  onSaveLegalItem,
  onDeleteLegalItem,
  onSaveRelationItem,
  onDeleteRelationItem,
  externalFocusRequest,
}) => {
  const [subTab, setSubTab] = useState<'legal' | 'relations'>('legal');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | LegalCategory>('ALL');
  const [statusFilter, setStatusFilter] = useState<WorkItemFilterStatus>('all');

  useEffect(() => {
    if (externalFocusRequest) {
      setSubTab(externalFocusRequest.subTab);
      setCategoryFilter('ALL');
      setStatusFilter('all');
    }
  }, [externalFocusRequest]);

  useEffect(() => {
    if (!activeTargetId) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-focus-id="${CSS.escape(activeTargetId)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeTargetId, subTab]);

  const subjects = caseDoc.entities.filter((e) => e.kind === 'P' || e.kind === 'O');
  const events = caseDoc.entities.filter((e) => e.kind === 'E');
  const allTargets = caseDoc.entities;

  const violationRecords = caseDoc.legalConclusions.filter((l) => l.category === 'violation');
  const causeRecords = caseDoc.legalConclusions.filter((l) => l.category === 'cause');

  const handleAddLegal = (category: LegalCategory) => {
    const newItem: LegalConclusionItem = {
      id: `${category === 'violation' ? 'VIO' : category === 'cause' ? 'CAU' : 'LIA'}-${Date.now().toString(36)}`,
      category,
      subjectId: subjects[0]?.id || 'P01',
      eventId: events[0]?.id || '',
      presenceStatus: 'present',
      rawText: '',
      lawArticle: '',
      conclusionLabel: category === 'liability' ? '全部责任' : '',
      ...(category !== 'liability'
        ? { causalLinkStatus: 'unspecified' as CausalLinkStatus, linkedViolationIds: [] }
        : { linkedCauseIds: [] }),
      evidences: selectedPdfQuote
        ? [{ id: `EV-${Date.now().toString(36)}`, page: selectedPdfQuote.page, quote: selectedPdfQuote.quote }]
        : [],
      reviewStatus: 'draft',
      disputeReason: '',
      adjudicatorNote: '',
    };
    onSaveLegalItem(newItem);
    onFocusTarget(newItem.id, `${CATEGORY_LABELS[category].title} (${newItem.id})`);
  };

  const handleAddRelation = () => {
    const nextOrder = caseDoc.relations.length + 1;
    const newRel: EventRelationItem = {
      id: `REL-${Date.now().toString(36)}`,
      fieldCode: 'D08.F049',
      eventId: events[0]?.id || 'E01',
      stageOrder: nextOrder,
      sourceId: caseDoc.entities.find((e) => e.kind === 'V')?.id || 'P01',
      action: '撞击',
      relationType: '追尾碰撞',
      targetId: caseDoc.entities.filter((e) => e.kind === 'V' || e.kind === 'P')[1]?.id || 'R01',
      collisionMode: '追尾碰撞',
      directionNote: '',
      presenceStatus: 'present',
      evidences: selectedPdfQuote
        ? [{ id: `EV-${Date.now().toString(36)}`, page: selectedPdfQuote.page, quote: selectedPdfQuote.quote }]
        : [],
      reviewStatus: 'draft',
      disputeReason: '',
      adjudicatorNote: '',
    };
    onSaveRelationItem(newRel);
    onFocusTarget(newRel.id, `事件关系 (${newRel.id})`);
  };

  const categoryFilteredLegal = useMemo(
    () =>
      caseDoc.legalConclusions.filter(
        (item) => categoryFilter === 'ALL' || item.category === categoryFilter,
      ),
    [caseDoc.legalConclusions, categoryFilter],
  );

  const legalStatusCounts = useMemo(() => {
    const counts: Record<WorkItemFilterStatus, number> = {
      all: categoryFilteredLegal.length,
      pending_action: 0,
      draft: 0,
      disputed: 0,
      blocking_or_error: 0,
      checked: 0,
      specialist_review: 0,
    };
    for (const item of categoryFilteredLegal) {
      const hasBlockingOrError =
        PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
        validateLegalConclusion(item).some((i) => i.severity === 'error');
      const arg = {
        reviewStatus: item.reviewStatus,
        presenceStatus: item.presenceStatus,
        hasBlockingOrError,
      };
      if (matchesWorkItemStatus(arg, 'pending_action')) counts.pending_action += 1;
      if (matchesWorkItemStatus(arg, 'draft')) counts.draft += 1;
      if (matchesWorkItemStatus(arg, 'disputed')) counts.disputed += 1;
      if (matchesWorkItemStatus(arg, 'blocking_or_error')) counts.blocking_or_error += 1;
      if (matchesWorkItemStatus(arg, 'checked')) counts.checked += 1;
      if (matchesWorkItemStatus(arg, 'specialist_review')) counts.specialist_review += 1;
    }
    return counts;
  }, [categoryFilteredLegal]);

  const filteredLegal = useMemo(
    () =>
      categoryFilteredLegal.filter((item) => {
        const hasBlockingOrError =
          PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
          validateLegalConclusion(item).some((i) => i.severity === 'error');
        return matchesWorkItemStatus(
          {
            reviewStatus: item.reviewStatus,
            presenceStatus: item.presenceStatus,
            hasBlockingOrError,
          },
          statusFilter,
        );
      }),
    [categoryFilteredLegal, statusFilter],
  );

  const relationStatusCounts = useMemo(() => {
    const counts: Record<WorkItemFilterStatus, number> = {
      all: caseDoc.relations.length,
      pending_action: 0,
      draft: 0,
      disputed: 0,
      blocking_or_error: 0,
      checked: 0,
      specialist_review: 0,
    };
    for (const rel of caseDoc.relations) {
      const presence = rel.presenceStatus || 'present';
      const hasBlockingOrError =
        PRESENCE_STATUS_META[presence].blocksScoring ||
        validateRelation(rel).some((i) => i.severity === 'error');
      const arg = {
        reviewStatus: rel.reviewStatus,
        presenceStatus: presence,
        hasBlockingOrError,
      };
      if (matchesWorkItemStatus(arg, 'pending_action')) counts.pending_action += 1;
      if (matchesWorkItemStatus(arg, 'draft')) counts.draft += 1;
      if (matchesWorkItemStatus(arg, 'disputed')) counts.disputed += 1;
      if (matchesWorkItemStatus(arg, 'blocking_or_error')) counts.blocking_or_error += 1;
      if (matchesWorkItemStatus(arg, 'checked')) counts.checked += 1;
      if (matchesWorkItemStatus(arg, 'specialist_review')) counts.specialist_review += 1;
    }
    return counts;
  }, [caseDoc.relations]);

  const filteredRelations = useMemo(
    () =>
      caseDoc.relations
        .filter((rel) => {
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
            statusFilter,
          );
        })
        .slice()
        .sort((a, b) => a.stageOrder - b.stageOrder),
    [caseDoc.relations, statusFilter],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Legal Independence Rule Banner */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-amber-950">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <div>
            <p className="font-semibold">步骤 6 · 法律结论与事件关系独立记录原则（禁止补推断）</p>
            <p className="mt-0.5 text-amber-900">
              违法、原因、责任不得混入普通事实；碰撞主客体方向与事件阶段顺序（如多车多阶段追尾）不得随意对调；没有文书明确依据的因果不得自行补充。
            </p>
          </div>
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setSubTab('legal')}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === 'legal' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            违法 / 原因 / 责任 ({caseDoc.legalConclusions.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('relations')}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === 'relations' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            事件顺序与碰撞关系 ({caseDoc.relations.length})
          </button>
        </div>

        {subTab === 'legal' ? (
          <div className="flex flex-wrap items-center gap-3">
            {(['violation', 'cause', 'liability'] as LegalCategory[]).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => handleAddLegal(cat)}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200/70 hover:text-slate-900"
              >
                <Plus className="h-3.5 w-3.5" />
                新增{CATEGORY_LABELS[cat].title.replace('认定', '').replace('划分', '')}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleAddRelation}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            新增碰撞 / 事件关系
          </button>
        )}
      </div>

      {/* Legal Conclusions List */}
      {subTab === 'legal' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-4 pt-3 pb-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-slate-500">类别筛选：</span>
              <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                {(['ALL', 'violation', 'cause', 'liability'] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(cat)}
                    className={`whitespace-nowrap rounded px-2.5 py-1 font-medium transition-colors ${
                      categoryFilter === cat
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {cat === 'ALL' ? '全部' : CATEGORY_LABELS[cat].title}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-2 text-xs">
              <span className="pb-1.5 text-slate-500">状态查询：</span>
              {(
                [
                  ['all', '全部'],
                  ['pending_action', '待处理'],
                  ['draft', '草稿'],
                  ['disputed', '争议中'],
                  ['blocking_or_error', '阻断/报错'],
                  ['checked', '已复核'],
                  ['specialist_review', '专业裁定'],
                ] as Array<[WorkItemFilterStatus, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                  className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 transition-colors ${
                    statusFilter === key
                      ? 'border-slate-900 font-semibold text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  <span>{label}</span>
                  <span className="font-mono-tabular text-[11px] opacity-75">
                    ({legalStatusCounts[key]})
                  </span>
                </button>
              ))}
            </div>
          </div>

          {filteredLegal.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              当前筛选下暂无法律结论记录；可切换上方状态或点击右上角按钮新增。
            </div>
          )}

          {filteredLegal.map((item) => {
            const catMeta = CATEGORY_LABELS[item.category];
            const issues = validateLegalConclusion(item);
            const hasError =
              PRESENCE_STATUS_META[item.presenceStatus].blocksScoring ||
              issues.some((i) => i.severity === 'error');
            const focused = activeTargetId === item.id;

            return (
              <div
                key={item.id}
                data-focus-id={item.id}
                onClick={() => onFocusTarget(item.id, `${catMeta.title} (${item.id})`)}
                className={`rounded-lg border p-4 transition-colors ${getCardStatusBorderClass(
                  item.reviewStatus,
                  hasError,
                  focused,
                )}`}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono-tabular font-semibold text-slate-900">{item.id}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-blue-800">{catMeta.title}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular text-slate-500">{catMeta.fieldCode}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ReviewLifecycleBar
                      reviewStatus={item.reviewStatus}
                      hasError={hasError}
                    />
                    <button
                      type="button"
                      aria-label={`删除 ${item.id}`}
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

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      归属主体 (P/O)
                    </label>
                    <select
                      value={item.subjectId}
                      onChange={(e) => onSaveLegalItem({ ...item, subjectId: e.target.value })}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
                    >
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id} · {s.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      对应阶段事件 (E)
                    </label>
                    <select
                      value={item.eventId}
                      onChange={(e) => onSaveLegalItem({ ...item, eventId: e.target.value })}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
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
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
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
                            : '如：未保持安全车距 / 违规连续变道'
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                </div>

                {/* v0.2 Causal Link & Responsibility-Cause Link Controls */}
                {item.category !== 'liability' ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-slate-50/70 p-2.5 sm:grid-cols-12">
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
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                      >
                        {CAUSAL_LINK_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-7">
                      <span className="mb-1 block text-xs font-medium text-slate-700">
                        关联违法记录 (linked_violation_record_ids)
                      </span>
                      {item.category === 'violation' ? (
                        <p className="text-xs text-slate-500">
                          本条为违法行为记录，可在「认定事故原因 (D10.F059)」中勾选关联。
                        </p>
                      ) : violationRecords.length === 0 ? (
                        <p className="text-xs text-slate-500">暂无可关联的违法行为记录</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {violationRecords.map((vio) => {
                            const linked = (item.linkedViolationIds || []).includes(vio.id);
                            return (
                              <label
                                key={vio.id}
                                className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                  linked
                                    ? 'border-blue-600 bg-blue-50 text-blue-900'
                                    : 'border-slate-200 bg-white text-slate-700'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={linked}
                                  onChange={(e) => {
                                    const current = item.linkedViolationIds || [];
                                    const next = e.target.checked
                                      ? [...current, vio.id]
                                      : current.filter((x) => x !== vio.id);
                                    onSaveLegalItem({ ...item, linkedViolationIds: next });
                                  }}
                                  className="h-3 w-3 accent-blue-700"
                                />
                                <span className="font-mono-tabular">{vio.id}</span>
                                <span className="max-w-[140px] truncate">
                                  ({vio.subjectId} · {vio.conclusionLabel || '未填'})
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-md border border-slate-200 bg-slate-50/70 p-2.5">
                    <span className="mb-1 block text-xs font-medium text-slate-700">
                      责任依据的认定原因 (linked_cause_record_ids)
                    </span>
                    {causeRecords.length === 0 ? (
                      <p className="text-xs text-slate-500">暂无可关联的认定事故原因记录</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {causeRecords.map((cau) => {
                          const linked = (item.linkedCauseIds || []).includes(cau.id);
                          return (
                            <label
                              key={cau.id}
                              className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                                linked
                                  ? 'border-blue-600 bg-blue-50 text-blue-900'
                                  : 'border-slate-200 bg-white text-slate-700'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={linked}
                                onChange={(e) => {
                                  const current = item.linkedCauseIds || [];
                                  const next = e.target.checked
                                    ? [...current, cau.id]
                                    : current.filter((x) => x !== cau.id);
                                  onSaveLegalItem({ ...item, linkedCauseIds: next });
                                }}
                                className="h-3 w-3 accent-blue-700"
                              />
                              <span className="font-mono-tabular">{cau.id}</span>
                              <span className="max-w-[160px] truncate">
                                ({cau.subjectId} · {cau.conclusionLabel || '未填'})
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {item.category !== 'cause' && (
                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      援引法律条款原文
                    </label>
                    <input
                      type="text"
                      value={item.lawArticle}
                      onChange={(e) => onSaveLegalItem({ ...item, lawArticle: e.target.value })}
                      placeholder="如：《中华人民共和国道路交通安全法》第四十三条第一款"
                      className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                )}

                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    文书原文结论 (raw_value)
                  </label>
                  <textarea
                    rows={2}
                    value={item.rawText}
                    onChange={(e) => onSaveLegalItem({ ...item, rawText: e.target.value })}
                    placeholder="按文书表达完整摘记，不得改变否定词或责任限定语…"
                    className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </div>

                {/* Evidence Box */}
                <div className="mt-3 rounded border border-slate-200 bg-slate-50/60 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">支持证据（页码 + 最短摘录）</span>
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
                  {item.evidences.map((ev) => (
                    <div key={ev.id} className="mt-1 flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => onJumpToPage(ev.page)}
                        className="font-mono-tabular shrink-0 font-medium text-blue-700 hover:underline"
                      >
                        p.{ev.page}
                      </button>
                      <input
                        type="text"
                        value={ev.quote}
                        onChange={(e) =>
                          onSaveLegalItem({
                            ...item,
                            evidences: item.evidences.map((x) =>
                              x.id === ev.id ? { ...x, quote: e.target.value } : x,
                            ),
                          })
                        }
                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
                      />
                      <button
                        type="button"
                        aria-label="删除证据"
                        onClick={() =>
                          onSaveLegalItem({
                            ...item,
                            evidences: item.evidences.filter((x) => x.id !== ev.id),
                          })
                        }
                        className="p-1 text-slate-400 hover:text-red-700"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {item.evidences.length === 0 && (
                    <p className="text-xs text-slate-500">请划选左侧文书证据后引用。</p>
                  )}
                </div>

                {issues.length > 0 && (
                  <p className="mt-2 text-xs text-red-700">{issues.map((i) => i.message).join('；')}</p>
                )}

                {/* Role actions */}
                {userRole !== 'annotator' && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                    <input
                      type="text"
                      value={userRole === 'reviewer' ? item.disputeReason : item.adjudicatorNote}
                      onChange={(e) =>
                        onSaveLegalItem(
                          userRole === 'reviewer'
                            ? { ...item, disputeReason: e.target.value }
                            : { ...item, adjudicatorNote: e.target.value },
                        )
                      }
                      placeholder={
                        userRole === 'reviewer' ? '记录复核分歧原因…' : '记录业务裁定理由…'
                      }
                      className="min-w-[220px] flex-1 rounded border border-slate-300 px-2.5 py-1 text-xs"
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
                          <Check className="h-3.5 w-3.5" />
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
                          <XCircle className="h-3.5 w-3.5" />
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
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                      >
                        <Check className="h-3.5 w-3.5" />
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
      )}

      {/* Event Relations List */}
      {subTab === 'relations' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 pt-3 pb-1.5 text-xs">
            <span className="pb-1.5 text-slate-500">状态查询：</span>
            {(
              [
                ['all', '全部'],
                ['pending_action', '待处理'],
                ['draft', '草稿'],
                ['disputed', '争议中'],
                ['blocking_or_error', '阻断/报错'],
                ['checked', '已复核'],
                ['specialist_review', '专业裁定'],
              ] as Array<[WorkItemFilterStatus, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 pb-1.5 transition-colors ${
                  statusFilter === key
                    ? 'border-slate-900 font-semibold text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                <span>{label}</span>
                <span className="font-mono-tabular text-[11px] opacity-75">
                  ({relationStatusCounts[key]})
                </span>
              </button>
            ))}
          </div>

          {filteredRelations.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              当前筛选下暂无事件顺序与碰撞关系记录，可切换上方状态或点击右上角「新增碰撞 / 事件关系」。
            </div>
          )}

          {filteredRelations.map((rel) => {
              const issues = validateRelation(rel);
              const hasError =
                PRESENCE_STATUS_META[rel.presenceStatus || 'present'].blocksScoring ||
                issues.some((i) => i.severity === 'error');
              const focused = activeTargetId === rel.id;

              return (
                <div
                  key={rel.id}
                  data-focus-id={rel.id}
                  onClick={() => onFocusTarget(rel.id, `事件关系 (${rel.id})`)}
                  className={`rounded-lg border p-4 transition-colors ${getCardStatusBorderClass(
                    rel.reviewStatus,
                    hasError,
                    focused,
                  )}`}
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono-tabular font-semibold text-slate-900">
                        顺序 #{rel.stageOrder}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular text-blue-800">{rel.eventId}</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500">{rel.id}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ReviewLifecycleBar
                        reviewStatus={rel.reviewStatus}
                        hasError={hasError}
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

                  {/* Directed Relation Row (v0.2 Graph Triple) */}
                  <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        字段编码 (field_code)
                      </label>
                      <select
                        value={rel.fieldCode || 'D08.F049'}
                        onChange={(e) => onSaveRelationItem({ ...rel, fieldCode: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {RELATION_FIELD_CODES.map((fc) => (
                          <option key={fc.code} value={fc.code}>
                            {fc.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        存在性状态 (presence)
                      </label>
                      <select
                        value={rel.presenceStatus || 'present'}
                        onChange={(e) =>
                          onSaveRelationItem({
                            ...rel,
                            presenceStatus: e.target.value as PresenceStatus,
                          })
                        }
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
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
                        所属阶段事件 (event_id)
                      </label>
                      <select
                        value={rel.eventId}
                        onChange={(e) => onSaveRelationItem({ ...rel, eventId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {events.map((ev) => (
                          <option key={ev.id} value={ev.id}>
                            {ev.id} · {ev.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        阶段顺序
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={rel.stageOrder}
                        onChange={(e) =>
                          onSaveRelationItem({
                            ...rel,
                            stageOrder: Math.max(1, parseInt(e.target.value, 10) || 1),
                          })
                        }
                        className="font-mono-tabular w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        施动主体 (subject_id)
                      </label>
                      <select
                        value={cleanRelationEntityId(rel.sourceId)}
                        onChange={(e) => onSaveRelationItem({ ...rel, sourceId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {allTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.id} · {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-4">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        标准关系类型 (relation_type)
                      </label>
                      <div className="flex items-center gap-1">
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <input
                          type="text"
                          value={rel.relationType ?? rel.collisionMode ?? rel.action}
                          onChange={(e) =>
                            onSaveRelationItem({
                              ...rel,
                              relationType: e.target.value,
                              collisionMode: e.target.value,
                            })
                          }
                          placeholder="如：撞击路侧固定设施 / 追尾碰撞"
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                        />
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </div>
                    </div>
                    <div className="sm:col-span-3">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        受动客体 (object_id)
                      </label>
                      <select
                        value={cleanRelationEntityId(rel.targetId)}
                        onChange={(e) => onSaveRelationItem({ ...rel, targetId: e.target.value })}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      >
                        {allTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.id} · {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        碰撞动作原文
                      </label>
                      <input
                        type="text"
                        value={rel.action}
                        onChange={(e) => onSaveRelationItem({ ...rel, action: e.target.value })}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        事件与方向说明
                      </label>
                      <input
                        type="text"
                        value={rel.directionNote}
                        onChange={(e) =>
                          onSaveRelationItem({ ...rel, directionNote: e.target.value })
                        }
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  </div>

                  <div className="mt-3 rounded border border-slate-200 bg-slate-50/60 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700">事件关系证据</span>
                      <button
                        type="button"
                        disabled={!selectedPdfQuote?.quote.trim()}
                        onClick={() => {
                          if (!selectedPdfQuote?.quote.trim()) return;
                          onSaveRelationItem({
                            ...rel,
                            evidences: [
                              ...rel.evidences,
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
                    {rel.evidences.map((ev) => (
                      <div key={ev.id} className="mt-1 flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => onJumpToPage(ev.page)}
                          className="font-mono-tabular shrink-0 font-medium text-blue-700 hover:underline"
                        >
                          p.{ev.page}
                        </button>
                        <input
                          type="text"
                          value={ev.quote}
                          onChange={(e) =>
                            onSaveRelationItem({
                              ...rel,
                              evidences: rel.evidences.map((x) =>
                                x.id === ev.id ? { ...x, quote: e.target.value } : x,
                              ),
                            })
                          }
                          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
                        />
                        <button
                          type="button"
                          aria-label="删除证据"
                          onClick={() =>
                            onSaveRelationItem({
                              ...rel,
                              evidences: rel.evidences.filter((x) => x.id !== ev.id),
                            })
                          }
                          className="p-1 text-slate-400 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {issues.length > 0 && (
                    <p className="mt-2 text-xs text-red-700">
                      {issues.map((i) => i.message).join('；')}
                    </p>
                  )}

                  {userRole !== 'annotator' && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
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
                          userRole === 'reviewer' ? '记录复核分歧原因…' : '记录业务裁定理由…'
                        }
                        className="min-w-[220px] flex-1 rounded border border-slate-300 px-2.5 py-1 text-xs"
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
                            <Check className="h-3.5 w-3.5" />
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
                            <XCircle className="h-3.5 w-3.5" />
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
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
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
            })}
        </div>
      )}
    </div>
  );
};
