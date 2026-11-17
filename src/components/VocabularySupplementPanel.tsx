import React, { useState } from 'react';
import { CheckCircle2, Download, Plus, X } from 'lucide-react';
import { VocabularySupplementItem } from '../types/gold';

interface VocabularySupplementPanelProps {
  supplements: VocabularySupplementItem[];
  onUpdateSupplement: (updated: VocabularySupplementItem) => void;
}

export const VocabularySupplementPanel: React.FC<VocabularySupplementPanelProps> = ({
  supplements,
  onUpdateSupplement,
}) => {
  const [filterStatus, setFilterStatus] = useState<'ALL' | '待审核' | '已核定'>('ALL');
  const [newCandidateByCode, setNewCandidateByCode] = useState<Record<string, string>>({});

  const visibleItems = supplements.filter((item) =>
    filterStatus === 'ALL' ? true : item.approvalStatus === filterStatus,
  );

  const approvedCount = supplements.filter((s) => s.approvalStatus === '已核定').length;

  const exportCsv = () => {
    const header = [
      '字段编码',
      '字段名称',
      '适用主体',
      '单多值规则',
      '补充内容类型',
      '标准编码（填写）',
      '标准名称（填写）',
      '候选枚举值',
      '定义与判定标准（填写）',
      '同义词或常见写法（填写）',
      '排除边界或反例（填写）',
      '是否允许多选',
      '审批状态',
      '审核意见',
    ];
    const escapeCell = (val: string) => `"${(val || '').replace(/"/g, '""')}"`;
    const rows = supplements.map((s) =>
      [
        s.fieldCode,
        s.fieldName,
        s.applicableSubject,
        s.singleMultiRule,
        s.supplementType,
        s.standardCode,
        s.standardName,
        s.candidateOptions.join(' | '),
        s.definition,
        s.synonyms,
        s.exclusions,
        s.allowMultiple ? '是' : '否',
        s.approvalStatus,
        s.reviewComment,
      ]
        .map(escapeCell)
        .join(','),
    );
    const csvContent = '\uFEFF' + [header.map(escapeCell).join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Gold_受控词表增补工作表.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          受控词表增补工作表（共 {supplements.length} 项 · 已核定 {approvedCount} 项）
        </h2>

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md bg-slate-100 p-0.5">
            {(['ALL', '待审核', '已核定'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setFilterStatus(st)}
                className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${
                  filterStatus === st
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st === 'ALL' ? '全部' : st}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline"
          >
            <Download className="h-3.5 w-3.5" />
            导出增补词表 CSV
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {visibleItems.map((item) => {
          const draftCandidate = newCandidateByCode[item.fieldCode] || '';
          return (
            <div
              key={item.fieldCode}
              className="rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono-tabular font-semibold text-slate-900">
                      {item.fieldCode}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>适用主体：{item.applicableSubject}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.singleMultiRule}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.supplementType}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.allowMultiple ? '允许多选' : '单选'}</span>
                  </div>
                  <h3 className="mt-1 text-[15px] font-semibold text-slate-900">{item.fieldName}</h3>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateSupplement({
                        ...item,
                        approvalStatus: item.approvalStatus === '已核定' ? '待审核' : '已核定',
                      })
                    }
                    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                      item.approvalStatus === '已核定'
                        ? 'text-emerald-800 hover:bg-emerald-50'
                        : 'text-amber-800 hover:bg-amber-50'
                    }`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {item.approvalStatus === '已核定' ? '已核定（点击退回待审）' : '待审核（点击核定）'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    标准编码
                  </label>
                  <input
                    type="text"
                    value={item.standardCode}
                    onChange={(e) =>
                      onUpdateSupplement({ ...item, standardCode: e.target.value })
                    }
                    className="font-mono-tabular w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    标准名称
                  </label>
                  <input
                    type="text"
                    value={item.standardName}
                    onChange={(e) =>
                      onUpdateSupplement({ ...item, standardName: e.target.value })
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </div>
              </div>

              {/* Candidate Options Editor */}
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-800">
                    候选受控词表枚举项（同步到标注选项）
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {item.candidateOptions.map((opt) => (
                    <span
                      key={opt}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                    >
                      {opt}
                      <button
                        type="button"
                        aria-label={`移除词条 ${opt}`}
                        onClick={() =>
                          onUpdateSupplement({
                            ...item,
                            candidateOptions: item.candidateOptions.filter((c) => c !== opt),
                          })
                        }
                        className="text-slate-400 hover:text-red-700"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    aria-label={`为 ${item.fieldCode} 新增标准词条`}
                    value={draftCandidate}
                    onChange={(e) =>
                      setNewCandidateByCode((prev) => ({
                        ...prev,
                        [item.fieldCode]: e.target.value,
                      }))
                    }
                    placeholder="输入新增候选标准词条…"
                    className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = draftCandidate.trim();
                      if (!val || item.candidateOptions.includes(val)) return;
                      onUpdateSupplement({
                        ...item,
                        candidateOptions: [...item.candidateOptions, val],
                      });
                      setNewCandidateByCode((prev) => ({ ...prev, [item.fieldCode]: '' }));
                    }}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加词条
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    定义与判定标准
                  </label>
                  <textarea
                    rows={2}
                    value={item.definition}
                    onChange={(e) =>
                      onUpdateSupplement({ ...item, definition: e.target.value })
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    同义词或常见写法
                  </label>
                  <textarea
                    rows={2}
                    value={item.synonyms}
                    onChange={(e) =>
                      onUpdateSupplement({ ...item, synonyms: e.target.value })
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    排除边界或反例
                  </label>
                  <textarea
                    rows={2}
                    value={item.exclusions}
                    onChange={(e) =>
                      onUpdateSupplement({ ...item, exclusions: e.target.value })
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div className="mt-2">
                <label className="mb-1 block text-xs font-medium text-slate-700">审核意见</label>
                <input
                  type="text"
                  value={item.reviewComment}
                  onChange={(e) =>
                    onUpdateSupplement({ ...item, reviewComment: e.target.value })
                  }
                  placeholder="规则复盘会审核意见或版本备注…"
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
