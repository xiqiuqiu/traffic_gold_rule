import React, { useMemo, useState } from 'react';
import { Download, History, Lock, Search } from 'lucide-react';
import { ExtendedRole, SystemAuditCategory, SystemAuditEvent } from '../types/system';
import { EXTENDED_ROLE_META, filterSystemAuditLogs } from '../utils/systemEngine';

interface AuditTrailPanelProps {
  events: SystemAuditEvent[];
  canViewFullAudit: boolean;
}

const CATEGORY_LABELS: Record<SystemAuditCategory, string> = {
  schedule: '定时调度',
  task_pipeline: '解析流水线',
  annotation: '字段修正',
  review_adjudicate: '复核与裁定',
  fusion_export: '类案融合导出',
  permission: '权限变更',
};

export const AuditTrailPanel: React.FC<AuditTrailPanelProps> = ({
  events,
  canViewFullAudit,
}) => {
  const [category, setCategory] = useState<'ALL' | SystemAuditCategory>('ALL');
  const [role, setRole] = useState<'ALL' | ExtendedRole>('ALL');
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => filterSystemAuditLogs(events, { category, role, query }),
    [events, category, role, query],
  );

  const handleExportAuditJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system_audit_trail_${filtered.length}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!canViewFullAudit) {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] px-6 py-8">
        <div className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-700">
          <Lock className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
          <div>
            <div className="font-semibold text-slate-900">当前身份无权查阅系统全链路审计日志</div>
            <p className="mt-1 text-xs text-slate-500">
              「审计日志与权限管理」权限默认仅对系统管理员与业务裁定人开放，您可在顶部工具栏切换为管理员身份查看。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-5">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">全链路操作审计追溯</h2>
            <span className="font-mono-tabular text-xs text-slate-500">
              · 共 {events.length} 条记录（当前筛选 {filtered.length} 条）
            </span>
          </div>
          <button
            type="button"
            onClick={handleExportAuditJson}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            导出审计台账 JSON
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <select
            aria-label="按审计环节筛选"
            value={category}
            onChange={(e) => setCategory(e.target.value as 'ALL' | SystemAuditCategory)}
            className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
          >
            <option value="ALL">全部操作环节</option>
            {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>

          <select
            aria-label="按操作角色筛选"
            value={role}
            onChange={(e) => setRole(e.target.value as 'ALL' | ExtendedRole)}
            className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
          >
            <option value="ALL">全部操作角色</option>
            {(Object.keys(EXTENDED_ROLE_META) as ExtendedRole[]).map((r) => (
              <option key={r} value={r}>
                {EXTENDED_ROLE_META[r].label}
              </option>
            ))}
          </select>

          <div className="relative flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label="搜索审计记录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜操作动作 / 案件号 / 业务编号 / 操作人…"
              className="w-full rounded border border-slate-300 bg-white py-1.5 pr-2.5 pl-8 text-xs text-slate-900"
            />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-4 py-2.5 font-medium">操作时间</th>
                <th className="px-4 py-2.5 font-medium">业务环节</th>
                <th className="px-4 py-2.5 font-medium">操作人 / 身份</th>
                <th className="px-4 py-2.5 font-medium">动作与目标对象</th>
                <th className="px-4 py-2.5 font-medium">变更详情与依据</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    当前筛选条件下暂无审计事件。
                  </td>
                </tr>
              ) : (
                filtered.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-50/70">
                    <td className="font-mono-tabular whitespace-nowrap px-4 py-2.5 align-top text-[11px] text-slate-600">
                      {new Date(ev.timestamp).toLocaleString('zh-CN')}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 align-top font-medium text-slate-800">
                      {CATEGORY_LABELS[ev.category] || ev.category}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 align-top">
                      <div className="font-medium text-slate-900">{ev.actorName}</div>
                      <div className="text-[11px] text-slate-500">
                        {EXTENDED_ROLE_META[ev.actorRole]?.label || ev.actorRole}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-medium text-slate-900">{ev.action}</div>
                      <div className="font-mono-tabular mt-0.5 text-[11px] text-slate-600">
                        {ev.targetRef}
                        {ev.accidentBizId ? ` · 业务编号 ${ev.accidentBizId}` : ''}
                      </div>
                    </td>
                    <td className="max-w-md px-4 py-2.5 align-top text-slate-700">
                      <div>{ev.detail}</div>
                      {(ev.beforeValue || ev.afterValue) && (
                        <div className="font-mono-tabular mt-1 text-[11px] text-slate-500">
                          {ev.beforeValue ? `变更前：${ev.beforeValue} ` : ''}
                          {ev.afterValue ? `→ 变更后：${ev.afterValue}` : ''}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
