import React, { useMemo } from 'react';
import { Check, CheckCircle2, Link2, Sparkles, XCircle } from 'lucide-react';
import {
  EntityItem,
  LegalConclusionItem,
  VocabularySupplementItem,
} from '../types/gold';
import {
  applyAllViolationLinks,
  applyViolationEntityLink,
  applyViolationVocabLink,
  confirmViolationLinkConsistency,
  scanViolationLinkMatches,
} from '../utils/goldRules';

interface ViolationLinkConsistencyBoxProps {
  item: LegalConclusionItem;
  entities: EntityItem[];
  supplements: VocabularySupplementItem[];
  onUpdateItem: (next: LegalConclusionItem, auditNote?: string) => void;
}

export const ViolationLinkConsistencyBox: React.FC<ViolationLinkConsistencyBoxProps> = ({
  item,
  entities,
  supplements,
  onUpdateItem,
}) => {
  const scan = useMemo(
    () => scanViolationLinkMatches(item, entities, supplements),
    [item, entities, supplements],
  );

  if (item.category !== 'violation') return null;

  const linkedEntitiesCount = item.linkedEntityIds?.length || 0;
  const linkedVocabCount = item.linkedVocabTerms?.length || 0;

  if (!scan.hasAnyMatch && linkedEntitiesCount === 0 && linkedVocabCount === 0) {
    return null;
  }

  if (!scan.needsConfirmationError) {
    const linkedSummaryParts: string[] = [];
    if (item.conclusionLabel.trim()) {
      linkedSummaryParts.push(`标准结论：${item.conclusionLabel.trim()}`);
    }
    if (linkedEntitiesCount > 0) {
      linkedSummaryParts.push(`关联实体：${(item.linkedEntityIds || []).join('、')}`);
    }
    if (linkedVocabCount > 0) {
      linkedSummaryParts.push(`词表绑定 ${linkedVocabCount} 项`);
    }

    return (
      <div
        data-testid={`violation-consistency-confirmed-${item.id}`}
        className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900"
      >
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" aria-hidden="true" />
          <span className="font-medium">关联一致性已确认</span>
          {linkedSummaryParts.length > 0 && (
            <span className="text-emerald-800">· {linkedSummaryParts.join(' · ')}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`violation-consistency-error-${item.id}`}
      onClick={(e) => e.stopPropagation()}
      className="mt-2 flex flex-col gap-2.5 rounded-md border border-red-300 bg-red-50/75 p-3 text-xs text-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200/80 pb-2">
        <div className="flex items-center gap-1.5 text-red-800">
          <XCircle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
          <span className="font-semibold">关联一致性待确认</span>
          <span className="text-red-700">
            · 扫描到受控词表 {scan.vocabMatches.length} 项、案件实体 {scan.entityMatches.length} 项匹配
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {scan.hasUnlinkedMatch && (
            <button
              type="button"
              onClick={() =>
                onUpdateItem(
                  applyAllViolationLinks(item, scan),
                  `一键关联违法行为匹配项 ${item.id}`,
                )
              }
              className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
            >
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              一键全部关联
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              onUpdateItem(
                confirmViolationLinkConsistency(item),
                `确认违法行为关联一致性 ${item.id}`,
              )
            }
            className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-700 px-2.5 py-1 font-medium text-white hover:bg-red-800"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            确认关联一致性
          </button>
        </div>
      </div>

      {scan.vocabMatches.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">受控词表匹配项：</span>
          <div className="flex flex-col gap-1">
            {scan.vocabMatches.map((m) => (
              <div
                key={m.vocabKey}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200/80 bg-white px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono-tabular font-semibold text-slate-800">
                    {m.fieldCode}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-medium text-slate-900">{m.standardTerm}</span>
                  <span className="text-slate-500">（命中“{m.matchedBy}”）</span>
                </div>
                {m.isLinked ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    已关联
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateItem(
                        applyViolationVocabLink(item, m),
                        `关联受控词表 ${m.standardTerm}`,
                      )
                    }
                    className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-blue-700 hover:underline"
                  >
                    <Link2 className="h-3 w-3" aria-hidden="true" />
                    {m.isPrimaryStandard ? '一键关联标准结论' : '一键关联词表'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {scan.entityMatches.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">当前案件实体匹配项：</span>
          <div className="flex flex-col gap-1">
            {scan.entityMatches.map((m) => (
              <div
                key={m.entityId}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200/80 bg-white px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    {m.entityId}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-medium text-slate-800">{m.entityLabel}</span>
                  <span className="text-slate-500">（命中“{m.matchedAlias}”）</span>
                </div>

                {m.isCurrentSubject ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    当前归属主体
                  </span>
                ) : m.isCurrentEvent ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    当前阶段事件
                  </span>
                ) : m.isLinked ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    已关联实体
                  </span>
                ) : (
                  <div className="flex items-center gap-2">
                    {(m.entityKind === 'P' || m.entityKind === 'O') && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateItem(
                            applyViolationEntityLink(item, m, 'subject'),
                            `切换违法主体为 ${m.entityId}`,
                          )
                        }
                        className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-blue-700 hover:underline"
                      >
                        设为归属主体
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateItem(
                          applyViolationEntityLink(
                            item,
                            m,
                            m.entityKind === 'E' ? 'event' : 'related',
                          ),
                          `关联实体 ${m.entityId}`,
                        )
                      }
                      className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-blue-700 hover:underline"
                    >
                      <Link2 className="h-3 w-3" aria-hidden="true" />
                      {m.entityKind === 'E' ? '一键关联事件' : '一键关联实体'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
