import React, { useState } from 'react';
import { AlertCircle, ArrowRight, Check, Link2, Plus, Trash2, XCircle } from 'lucide-react';
import { PRESENCE_STATUS_META, REVIEW_STATUS_META } from '../data/schemaCatalog';
import {
  CaseDocument,
  EventRelationItem,
  LegalCategory,
  LegalConclusionItem,
  PresenceStatus,
  UserRole,
} from '../types/gold';
import { validateLegalConclusion, validateRelation } from '../utils/goldRules';

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
}) => {
  const [subTab, setSubTab] = useState<'legal' | 'relations'>('legal');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | LegalCategory>('ALL');

  const subjects = caseDoc.entities.filter((e) => e.kind === 'P' || e.kind === 'O');
  const events = caseDoc.entities.filter((e) => e.kind === 'E');
  const allTargets = caseDoc.entities;

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
      eventId: events[0]?.id || 'E01',
      stageOrder: nextOrder,
      sourceId: caseDoc.entities.find((e) => e.kind === 'V')?.id || 'P01',
      action: '撞击',
      targetId: caseDoc.entities.filter((e) => e.kind === 'V' || e.kind === 'P')[1]?.id || 'R01',
      collisionMode: '追尾碰撞',
      directionNote: '',
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

  const filteredLegal = caseDoc.legalConclusions.filter(
    (item) => categoryFilter === 'ALL' || item.category === categoryFilter,
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
          <div className="flex flex-wrap items-center gap-1.5">
            {(['violation', 'cause', 'liability'] as LegalCategory[]).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => handleAddLegal(cat)}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
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
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
          >
            <Plus className="h-3.5 w-3.5" />
            新增碰撞 / 事件关系
          </button>
        )}
      </div>

      {/* Legal Conclusions List */}
      {subTab === 'legal' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">类别筛选：</span>
            {(['ALL', 'violation', 'cause', 'liability'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`whitespace-nowrap rounded px-2.5 py-1 font-medium ${
                  categoryFilter === cat
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {cat === 'ALL' ? '全部' : CATEGORY_LABELS[cat].title}
              </button>
            ))}
          </div>

          {filteredLegal.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              当前暂无该类别的法律结论记录，请点击右上角按钮新增。
            </div>
          )}

          {filteredLegal.map((item) => {
            const catMeta = CATEGORY_LABELS[item.category];
            const reviewMeta = REVIEW_STATUS_META[item.reviewStatus];
            const issues = validateLegalConclusion(item);
            const focused = activeTargetId === item.id;

            return (
              <div
                key={item.id}
                onClick={() => onFocusTarget(item.id, `${catMeta.title} (${item.id})`)}
                className={`rounded-lg border bg-white p-4 ${
                  focused ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-200'
                }`}
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
                    <span
                      className={`text-xs font-semibold ${
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

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                            : '如：未保持安全车距 / 违规连续变道'
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                </div>

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
                    文书原文结论
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
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-blue-700 bg-white px-2 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:border-slate-200 disabled:text-slate-400"
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
                        className="font-mono-tabular shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-blue-800"
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
                      <div className="flex items-center gap-1.5">
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
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-red-700 bg-white px-2.5 py-1 text-xs font-medium text-red-700"
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
              </div>
            );
          })}
        </div>
      )}

      {/* Event Relations List */}
      {subTab === 'relations' && (
        <div className="flex flex-col gap-3">
          {caseDoc.relations.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              当前尚未建立事件顺序与碰撞关系，请点击右上角「新增碰撞 / 事件关系」。
            </div>
          )}

          {caseDoc.relations
            .slice()
            .sort((a, b) => a.stageOrder - b.stageOrder)
            .map((rel) => {
              const reviewMeta = REVIEW_STATUS_META[rel.reviewStatus];
              const issues = validateRelation(rel);
              const focused = activeTargetId === rel.id;

              return (
                <div
                  key={rel.id}
                  onClick={() => onFocusTarget(rel.id, `事件关系 (${rel.id})`)}
                  className={`rounded-lg border bg-white p-4 ${
                    focused ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-200'
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
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
                      <span
                        className={`font-semibold ${
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

                  {/* Directed Relation Row */}
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
                        施动主体 (Source)
                      </label>
                      <select
                        value={rel.sourceId}
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
                    <div className="sm:col-span-3">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        动作 (不可对调方向)
                      </label>
                      <div className="flex items-center gap-1">
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <input
                          type="text"
                          value={rel.action}
                          onChange={(e) => onSaveRelationItem({ ...rel, action: e.target.value })}
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                        />
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </div>
                    </div>
                    <div className="sm:col-span-4">
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        受动客体 (Target)
                      </label>
                      <input
                        type="text"
                        value={rel.targetId}
                        onChange={(e) => onSaveRelationItem({ ...rel, targetId: e.target.value })}
                        placeholder="如 V02 / P02 / R01（西侧护栏）"
                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
                      />
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        碰撞方式 (D08.F048)
                      </label>
                      <input
                        type="text"
                        value={rel.collisionMode}
                        onChange={(e) =>
                          onSaveRelationItem({ ...rel, collisionMode: e.target.value })
                        }
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
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-blue-700 bg-white px-2 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:border-slate-200 disabled:text-slate-400"
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
                          className="font-mono-tabular shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-blue-800"
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
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-2.5">
                      {userRole === 'reviewer' ? (
                        <>
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
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-red-700 bg-white px-2.5 py-1 text-xs font-medium text-red-700"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            争议中
                          </button>
                        </>
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
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};
