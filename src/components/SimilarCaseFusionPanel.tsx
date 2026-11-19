import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  ExternalLink,
  RotateCcw,
  Search,
} from 'lucide-react';
import { CaseDocument, VocabularySupplementItem } from '../types/gold';
import { CaseSimilarityFilter } from '../types/system';
import {
  auditBizIdUniqueness,
  buildCrossSystemFusionPayload,
  collectSimilarityTagCatalog,
  searchSimilarCases,
} from '../utils/systemEngine';

interface SimilarCaseFusionPanelProps {
  cases: CaseDocument[];
  supplements: VocabularySupplementItem[];
  canExportFusion: boolean;
  onOpenCaseDetail: (caseId: string, targetFieldCode?: string) => void;
  onRecordFusionExport: (
    caseId: string,
    bizId: string,
    method: 'copy' | 'download_single' | 'download_batch',
  ) => void;
}

const DEFAULT_FILTER: CaseSimilarityFilter = {
  keyword: '',
  accidentType: '',
  weather: '',
  surface: '',
  lighting: '',
  violation: '',
  liability: '',
  onlyApproved: false,
};

const UNIQUENESS_LABEL_META: Record<
  'unique' | 'missing' | 'invalid' | 'duplicate',
  { label: string; toneClass: string }
> = {
  unique: { label: '主键唯一已校验', toneClass: 'text-emerald-800' },
  missing: { label: '缺失 D01.F001 编号', toneClass: 'text-amber-800' },
  invalid: { label: '编号格式不合规', toneClass: 'text-red-700' },
  duplicate: { label: '业务编号冲突', toneClass: 'text-red-700' },
};

export const SimilarCaseFusionPanel: React.FC<SimilarCaseFusionPanelProps> = ({
  cases,
  supplements,
  canExportFusion,
  onOpenCaseDetail,
  onRecordFusionExport,
}) => {
  const [filter, setFilter] = useState<CaseSimilarityFilter>(DEFAULT_FILTER);
  const [showConflictDetails, setShowConflictDetails] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string>(cases[0]?.caseId || '');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const uniquenessReport = useMemo(() => auditBizIdUniqueness(cases), [cases]);
  const tagCatalog = useMemo(() => collectSimilarityTagCatalog(cases), [cases]);
  const matches = useMemo(
    () => searchSimilarCases(cases, filter, uniquenessReport),
    [cases, filter, uniquenessReport],
  );

  const selectedMatch = useMemo(
    () => matches.find((m) => m.caseDoc.caseId === selectedCaseId) || matches[0] || null,
    [matches, selectedCaseId],
  );

  const fusionPreview = useMemo(() => {
    if (!selectedMatch) return null;
    return buildCrossSystemFusionPayload(selectedMatch.caseDoc, uniquenessReport, supplements);
  }, [selectedMatch, uniquenessReport, supplements]);

  const fusionJsonText = useMemo(
    () => (fusionPreview ? JSON.stringify(fusionPreview, null, 2) : ''),
    [fusionPreview],
  );

  const handleCopyJson = async () => {
    if (!canExportFusion || !fusionPreview || !fusionJsonText) return;
    try {
      await navigator.clipboard.writeText(fusionJsonText);
      setCopiedId(fusionPreview.case_id);
      window.setTimeout(() => setCopiedId(null), 2000);
      onRecordFusionExport(fusionPreview.case_id, fusionPreview.accident_biz_id, 'copy');
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleDownloadSingleFusion = () => {
    if (!canExportFusion || !fusionPreview || !fusionJsonText) return;
    const blob = new Blob([fusionJsonText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fusion_${fusionPreview.accident_biz_id || fusionPreview.case_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    onRecordFusionExport(fusionPreview.case_id, fusionPreview.accident_biz_id, 'download_single');
  };

  const handleDownloadBatchFusion = () => {
    if (!canExportFusion || matches.length === 0) return;
    const bundle = {
      schema_version: 'fusion-bridge-batch-v1.0',
      exported_at: new Date().toISOString(),
      uniqueness_summary: {
        total_cases: uniquenessReport.totalCases,
        valid_unique_count: uniquenessReport.validUniqueCount,
        has_blocking_conflict: uniquenessReport.hasBlockingConflict,
      },
      records: matches.map((m) =>
        buildCrossSystemFusionPayload(m.caseDoc, uniquenessReport, supplements),
      ),
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fusion_batch_${matches.length}cases.json`;
    a.click();
    URL.revokeObjectURL(url);
    onRecordFusionExport(
      `BATCH-${matches.length}`,
      matches.map((m) => m.accidentBizId || m.caseDoc.caseId).join(','),
      'download_batch',
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-5">
      {/* D01.F001 Uniqueness Governance Banner */}
      <section
        aria-label="跨系统唯一主键校验"
        className="rounded-lg border border-slate-200 bg-white p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {uniquenessReport.hasBlockingConflict ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
            )}
            <span className="text-sm font-semibold text-slate-900">
              跨系统融合唯一主键校验（D01.F001 事故业务编号）
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="font-mono-tabular text-slate-700">
              总计 {uniquenessReport.totalCases} 案 · 唯一合规{' '}
              <strong className="text-emerald-800">{uniquenessReport.validUniqueCount}</strong> ·
              缺失{' '}
              <strong className="text-amber-800">
                {uniquenessReport.missingCaseIds.length}
              </strong>{' '}
              · 重复冲突{' '}
              <strong className="text-red-700">
                {uniquenessReport.duplicateGroups.length}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            {uniquenessReport.hasBlockingConflict && (
              <button
                type="button"
                onClick={() => setShowConflictDetails((v) => !v)}
                className="whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {showConflictDetails ? '收起异常案件清单' : '查看缺失与冲突清单'}
              </button>
            )}
            <button
              type="button"
              disabled={!canExportFusion || matches.length === 0}
              onClick={handleDownloadBatchFusion}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              导出当前匹配融合包 ({matches.length})
            </button>
          </div>
        </div>

        {showConflictDetails && uniquenessReport.hasBlockingConflict && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 text-xs md:grid-cols-2">
            {uniquenessReport.missingCaseIds.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50/50 p-3">
                <div className="font-medium text-amber-900">
                  尚未补充 D01.F001 事故业务编号的案件（点击可跳转至详情面板补录）：
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {uniquenessReport.missingCaseIds.map((cid) => (
                    <button
                      key={cid}
                      type="button"
                      onClick={() => onOpenCaseDetail(cid, 'D01.F001')}
                      className="font-mono-tabular inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 font-medium text-amber-900 hover:bg-amber-100"
                    >
                      {cid}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(uniquenessReport.duplicateGroups.length > 0 ||
              uniquenessReport.invalidCaseIds.length > 0) && (
              <div className="rounded border border-red-200 bg-red-50/50 p-3">
                <div className="font-medium text-red-900">重复或格式异常的事故业务编号：</div>
                <ul className="mt-2 space-y-1.5 text-red-800">
                  {uniquenessReport.duplicateGroups.map((g) => (
                    <li key={g.bizId} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-tabular font-semibold">{g.bizId}</span>
                      <span>关联冲突：</span>
                      {g.caseIds.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => onOpenCaseDetail(cid, 'D01.F001')}
                          className="font-mono-tabular underline hover:text-red-950"
                        >
                          {cid}
                        </button>
                      ))}
                    </li>
                  ))}
                  {uniquenessReport.invalidCaseIds.map((cid) => (
                    <li key={cid}>
                      <button
                        type="button"
                        onClick={() => onOpenCaseDetail(cid, 'D01.F001')}
                        className="font-mono-tabular underline hover:text-red-950"
                      >
                        {cid}（编号长度或字符格式不符合规范，去修正）
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Multi-Tag Combination Filter Bar */}
      <section
        aria-label="多标签组合类案检索"
        className="rounded-lg border border-slate-200 bg-white p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">多维度标签组合类案查询</h2>
            <span className="text-xs text-slate-500">
              · 按事故特征、气象路面、违法行为与责任结论交叉检索相似历史案件
            </span>
          </div>
          <button
            type="button"
            onClick={() => setFilter(DEFAULT_FILTER)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            清空组合条件
          </button>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="sim-keyword" className="mb-1 block text-xs font-medium text-slate-700">
              关键词 / 事故业务编号
            </label>
            <input
              id="sim-keyword"
              type="search"
              value={filter.keyword}
              onChange={(e) => setFilter((f) => ({ ...f, keyword: e.target.value }))}
              placeholder="团雾 / 超速 / 业务编号…"
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="sim-type" className="mb-1 block text-xs font-medium text-slate-700">
              事故类型 (D01.F003)
            </label>
            <select
              id="sim-type"
              value={filter.accidentType}
              onChange={(e) => setFilter((f) => ({ ...f, accidentType: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部事故类型</option>
              {tagCatalog.accidentTypes.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="sim-weather" className="mb-1 block text-xs font-medium text-slate-700">
              天气状况 (D07.F041)
            </label>
            <select
              id="sim-weather"
              value={filter.weather}
              onChange={(e) => setFilter((f) => ({ ...f, weather: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部天气条件</option>
              {tagCatalog.weathers.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="sim-surface" className="mb-1 block text-xs font-medium text-slate-700">
              路面状况 (D07.F042)
            </label>
            <select
              id="sim-surface"
              value={filter.surface}
              onChange={(e) => setFilter((f) => ({ ...f, surface: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部路面条件</option>
              {tagCatalog.surfaces.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="sim-lighting" className="mb-1 block text-xs font-medium text-slate-700">
              光照条件 (D07.F044)
            </label>
            <select
              id="sim-lighting"
              value={filter.lighting}
              onChange={(e) => setFilter((f) => ({ ...f, lighting: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部光照条件</option>
              {tagCatalog.lightings.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="sim-violation" className="mb-1 block text-xs font-medium text-slate-700">
              认定违法行为 (D10.F058)
            </label>
            <select
              id="sim-violation"
              value={filter.violation}
              onChange={(e) => setFilter((f) => ({ ...f, violation: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部违法标签</option>
              {tagCatalog.violations.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="sim-liability" className="mb-1 block text-xs font-medium text-slate-700">
              责任划分等级 (D10.F060)
            </label>
            <select
              id="sim-liability"
              value={filter.liability}
              onChange={(e) => setFilter((f) => ({ ...f, liability: e.target.value }))}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">全部责任结论</option>
              {tagCatalog.liabilities.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end pb-1">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={filter.onlyApproved}
                onChange={(e) => setFilter((f) => ({ ...f, onlyApproved: e.target.checked }))}
                className="h-3.5 w-3.5 accent-blue-700"
              />
              <span>仅检索已完成复核/裁定入库案件</span>
            </label>
          </div>
        </div>
      </section>

      {/* Split Results: Matched Case Cards + Standard Cross-System Fusion JSON Preview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: Matched Cases */}
        <section
          aria-label="类案检索结果列表"
          className="flex flex-col gap-3 lg:col-span-6"
        >
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              共检索到 <strong className="font-mono-tabular text-slate-900">{matches.length}</strong>{' '}
              起相似案件
            </span>
            <span>点击条目右侧同步预览跨系统融合标准化数据结构</span>
          </div>

          {matches.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-12 text-center text-xs text-slate-500">
              没有符合当前多标签组合的案件，可点击上方「清空组合条件」放宽检索条件。
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {matches.map((match) => {
                const isSelected = selectedMatch?.caseDoc.caseId === match.caseDoc.caseId;
                const uniqMeta = UNIQUENESS_LABEL_META[match.uniquenessStatus];
                return (
                  <div
                    key={match.caseDoc.caseId}
                    onClick={() => setSelectedCaseId(match.caseDoc.caseId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedCaseId(match.caseDoc.caseId);
                      }
                    }}
                    className={`cursor-pointer rounded-lg border bg-white p-4 transition-colors ${
                      isSelected
                        ? 'border-blue-600 ring-1 ring-blue-600/20'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono-tabular font-semibold text-slate-900">
                            {match.caseDoc.caseId}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-mono-tabular text-slate-700">
                            业务编号：{match.accidentBizId || '未录入'}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className={`font-medium ${uniqMeta.toneClass}`}>{uniqMeta.label}</span>
                        </div>
                        <h3 className="mt-1 text-sm font-semibold text-slate-900">
                          {match.caseDoc.title}
                        </h3>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenCaseDetail(match.caseDoc.caseId);
                        }}
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                      >
                        打开详情工作台
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>

                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-600">
                      {match.caseDoc.scenarioSummary}
                    </p>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-600">
                      <span className="font-medium text-slate-700">特征标签：</span>
                      {match.matchedTags.length > 0 ? (
                        <span>{match.matchedTags.join(' · ')}</span>
                      ) : (
                        <span className="text-slate-400">暂无标准化受控标签</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right: Cross-System Fusion Bridge JSON Preview */}
        <section
          aria-label="跨系统数据融合输出预览"
          className="flex flex-col rounded-lg border border-slate-200 bg-white lg:col-span-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">跨系统数据融合标准包预览</h2>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canExportFusion || !fusionPreview}
                onClick={handleCopyJson}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copiedId === fusionPreview?.case_id ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    复制 JSON
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={!canExportFusion || !fusionPreview}
                onClick={handleDownloadSingleFusion}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                导出单案融合包
              </button>
            </div>
          </div>

          {fusionPreview ? (
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="grid grid-cols-2 gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                <div>
                  <span className="text-slate-500">融合主键 (accident_biz_id)</span>
                  <div className="font-mono-tabular mt-0.5 font-semibold text-slate-900">
                    {fusionPreview.accident_biz_id || '缺失（需回填 D01.F001）'}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500">唯一性与准入校验</span>
                  <div className="mt-0.5 font-medium text-slate-900">
                    {UNIQUENESS_LABEL_META[fusionPreview.uniqueness_status].label} ·{' '}
                    {fusionPreview.readiness_eligible ? '已达入库标准' : '存在未闭环待办'}
                  </div>
                </div>
              </div>

              {!fusionPreview.uniqueness_verified && (
                <div className="flex items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span>
                    该案件的唯一事故业务编号（D01.F001）尚未通过唯一性核验，跨系统融合建议先补齐或解决冲突。
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenCaseDetail(fusionPreview.case_id, 'D01.F001')}
                    className="shrink-0 font-medium underline"
                  >
                    去补录 D01.F001
                  </button>
                </div>
              )}

              <pre className="font-mono-tabular max-h-[540px] flex-1 overflow-auto rounded border border-slate-200 bg-slate-950 p-3.5 text-[11px] leading-relaxed text-slate-100">
                {fusionJsonText}
              </pre>
            </div>
          ) : (
            <div className="px-4 py-12 text-center text-xs text-slate-500">
              请在左侧选择一条检索结果查看标准融合 JSON。
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
