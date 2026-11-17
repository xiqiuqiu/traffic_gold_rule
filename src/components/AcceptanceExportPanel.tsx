import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileCode2,
  ShieldCheck,
} from 'lucide-react';
import { ACCEPTANCE_CHECKLIST_ITEMS } from '../data/schemaCatalog';
import { CaseDocument } from '../types/gold';
import {
  buildGoldExportPayload,
  buildReviewMarkdown,
  computeCaseReadiness,
} from '../utils/goldRules';

interface AcceptanceExportPanelProps {
  caseDoc: CaseDocument;
  allCases: CaseDocument[];
  onToggleChecklistItem: (checkId: string, checked: boolean) => void;
  onToggleMaskPii: (mask: boolean) => void;
  onBatchApproveDrafts: () => void;
}

export const AcceptanceExportPanel: React.FC<AcceptanceExportPanelProps> = ({
  caseDoc,
  allCases,
  onToggleChecklistItem,
  onToggleMaskPii,
  onBatchApproveDrafts,
}) => {
  const [copied, setCopied] = useState(false);
  const readiness = useMemo(() => computeCaseReadiness(caseDoc), [caseDoc]);

  const jsonPayload = useMemo(
    () => buildGoldExportPayload(caseDoc, caseDoc.maskPiiOnExport),
    [caseDoc],
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
      `${caseDoc.caseId.toLowerCase()}_gold_${caseDoc.annotationVersion}.json`,
      'application/json;charset=utf-8',
    );
  };

  const handleDownloadAllScoredJsonl = () => {
    const lines = allCases
      .filter((c) => computeCaseReadiness(c).eligibleForScoring)
      .map((c) => JSON.stringify(buildGoldExportPayload(c, c.maskPiiOnExport)));
    if (lines.length === 0) return;
    downloadFile(
      lines.join('\n'),
      'gold_eval_dataset_eligible.jsonl',
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
    (c) => computeCaseReadiness(c).eligibleForScoring,
  ).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Scoring Gate Summary */}
      <div
        className={`rounded-lg border p-4 ${
          readiness.eligibleForScoring
            ? 'border-emerald-300 bg-emerald-50/70'
            : 'border-amber-300 bg-amber-50/70'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {readiness.eligibleForScoring ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            )}
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {readiness.eligibleForScoring
                  ? '通过交付门禁 · 本案可进入正式评测评分'
                  : '未通过交付门禁 · 暂不可进入正式评分'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-700">
                只有清单全部完成，且所有进入评分的记录状态均为“已复核”或“专业裁定”，才算正式 Gold 基准答案。
              </p>
            </div>
          </div>

          {!readiness.eligibleForScoring && readiness.statusCounts.draft > 0 && (
            <button
              type="button"
              onClick={onBatchApproveDrafts}
              className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              第二人一键复核全部无错草稿 ({readiness.statusCounts.draft})
            </button>
          )}
        </div>

        {/* Status Metrics Grid */}
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-200/80 pt-3 sm:grid-cols-6">
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">已复核</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-emerald-700">
              {readiness.statusCounts.checked}
            </div>
          </div>
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">专业裁定</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-blue-700">
              {readiness.statusCounts.specialist_review}
            </div>
          </div>
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">草稿</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-slate-800">
              {readiness.statusCounts.draft}
            </div>
          </div>
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">争议中</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-red-700">
              {readiness.statusCounts.disputed}
            </div>
          </div>
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">阻断状态</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-amber-700">
              {readiness.blockingPresenceCount}
            </div>
          </div>
          <div className="rounded bg-white/80 px-2.5 py-2">
            <div className="text-xs text-slate-500">校验错误</div>
            <div className="font-mono-tabular mt-0.5 text-base font-semibold text-red-700">
              {readiness.validationErrors}
            </div>
          </div>
        </div>

        {readiness.blockingReasons.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-950">
            {readiness.blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      {/* 10-Item Acceptance Checklist */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              步骤 8 · 10 项交付标准验收清单 ({readiness.checklistCheckedCount} /{' '}
              {readiness.checklistTotalCount})
            </h3>
            <p className="text-xs text-slate-500">
              供第一标注人自检与第二复核人交付验收逐项核对确认。
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {ACCEPTANCE_CHECKLIST_ITEMS.map((item, idx) => {
            const checked = Boolean(caseDoc.checklist[item.id]);
            return (
              <label
                key={item.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                  checked
                    ? 'border-emerald-200 bg-emerald-50/50 text-slate-900'
                    : 'border-slate-200 bg-slate-50/50 text-slate-700 hover:bg-white'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onToggleChecklistItem(item.id, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-emerald-700"
                />
                <span>
                  <strong className="font-mono-tabular mr-1.5 text-slate-500">
                    {String(idx + 1).padStart(2, '0')}.
                  </strong>
                  {item.label}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Export Actions & Live JSON Output Preview */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <FileCode2 className="h-4 w-4 text-blue-700" aria-hidden="true" />
              标准化人工基准输出（Gold JSON / JSONL / 规则复盘单）
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              每份材料生成一份独立机读基准 JSON，直接对接自动化评测系统。
            </p>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800">
            <ShieldCheck className="h-4 w-4 text-blue-700" aria-hidden="true" />
            <input
              type="checkbox"
              checked={caseDoc.maskPiiOnExport}
              onChange={(e) => onToggleMaskPii(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-700"
            />
            对外评测副本自动脱敏身份证/护照/电话
          </label>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-800"
          >
            <Download className="h-3.5 w-3.5" />
            下载本案 Gold JSON
          </button>

          <button
            type="button"
            disabled={eligibleCasesCount === 0}
            onClick={handleDownloadAllScoredJsonl}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            导出已过审评测集 JSONL ({eligibleCasesCount} 份)
          </button>

          <button
            type="button"
            onClick={handleDownloadReviewMd}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            导出规则复盘报告 (.md)
          </button>

          <button
            type="button"
            onClick={handleCopyJson}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? '已复制 JSON' : '复制 JSON'}
          </button>
        </div>

        <pre
          data-testid="gold-json-preview"
          className="font-mono-tabular max-h-96 overflow-auto rounded-md border border-slate-200 bg-slate-950 p-4 text-xs leading-relaxed text-slate-100"
        >
          {formattedJson}
        </pre>
      </div>
    </div>
  );
};
