import React from 'react';
import { X } from 'lucide-react';
import { PRESENCE_STATUS_META, REVIEW_STATUS_META } from '../data/schemaCatalog';
import { PresenceStatus, ReviewStatus } from '../types/gold';

interface ManualDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const ManualDrawer: React.FC<ManualDrawerProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      role="dialog"
      aria-modal="true"
      aria-label="人工 Gold 标注手册速查"
    >
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">人工 Gold 标注手册 · 速查规范</h2>
            <p className="text-xs text-slate-500">
              第一原则：只依据材料和已核定业务事实标注，第一标注人不得照抄模型结果。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭手册"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5 text-xs leading-relaxed text-slate-700">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">一、七种状态判断标准</h3>
            <div className="overflow-hidden rounded-md border border-slate-200">
              <table className="w-full border-collapse text-left">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">状态</th>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">判断标准</th>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">填写要求</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(PRESENCE_STATUS_META) as PresenceStatus[]).map((key) => {
                    const meta = PRESENCE_STATUS_META[key];
                    return (
                      <tr key={key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {meta.label}{' '}
                          <span className="font-mono-tabular block text-[11px] text-slate-400">
                            {key}
                          </span>
                        </td>
                        <td className="px-3 py-2">{meta.shortRule}</td>
                        <td className="px-3 py-2">{meta.requirement}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 font-medium text-red-700">
              沉默不等于否定：材料没写车速只能标“未提及”，只有明确写明“未超速”才能标“明确否定”。
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">二、六项证据标准</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                ['页码准确', '从材料第 1 页起算，不按扫描件内部页眉编号猜测。'],
                ['摘录最短', '只摘录支持本条记录的最短必要句子或短语，不复制整页。'],
                ['语义直接', '证据必须直接支持该事实，不能用相邻内容代替。'],
                ['主体明确', '多人多车材料中，摘录要能确认内容属于哪个对象。'],
                ['一条一证', '一段证据支持多个不同结论时，分别核对后引用。'],
                ['保留原意', '不得删去否定词、条件、时间或责任限定语。'],
              ].map(([title, desc]) => (
                <div key={title} className="rounded border border-slate-200 bg-slate-50 p-2.5">
                  <strong className="block text-slate-900">{title}</strong>
                  <span className="text-slate-600">{desc}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">三、复核与裁定状态流转</h3>
            <div className="overflow-hidden rounded-md border border-slate-200">
              <table className="w-full border-collapse text-left">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">工作状态</th>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">适用情形</th>
                    <th className="border-b border-slate-200 px-3 py-2 font-medium">进入评分</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(REVIEW_STATUS_META) as ReviewStatus[]).map((key) => {
                    const meta = REVIEW_STATUS_META[key];
                    return (
                      <tr key={key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {meta.label} <span className="font-mono-tabular text-slate-400">({key})</span>
                        </td>
                        <td className="px-3 py-2">{meta.description}</td>
                        <td className="px-3 py-2 font-medium">
                          {meta.eligibleForScoring ? '是' : '否'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
