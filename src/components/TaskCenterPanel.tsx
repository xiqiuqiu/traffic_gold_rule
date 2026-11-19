import { WorkbenchPage } from './WorkbenchPage';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FolderSearch,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  AnalysisTask,
  BatchScheduleConfig,
  TaskSource,
  TaskStatus,
} from '../types/system';
import {
  TASK_STATUS_META,
  computeTaskSummaryStats,
  filterAnalysisTasks,
} from '../utils/systemEngine';

interface TaskCenterPanelProps {
  tasks: AnalysisTask[];
  pageNumber: number;
  hasOlder: boolean;
  loadingPage: boolean;
  taskListError: string;
  onOlder: () => void;
  onNewer: () => void;
  scheduleConfig: BatchScheduleConfig;
  canManageSchedule: boolean;
  canUploadAndRun: boolean;
  canEditCase: boolean;
  scanningDirectory: boolean;
  lastScanMessage: string | null;
  lastScanError: string | null;
  onSaveSchedule: (next: Partial<BatchScheduleConfig>) => Promise<void>;
  onTriggerDirectoryScan: (forceRequeue: boolean) => Promise<void>;
  onRunTaskPipeline: (taskId: string) => Promise<void>;
  onOpenCaseDetail: (caseId: string) => void;
  onDeleteTask: (taskId: string) => Promise<void>;
}

const SOURCE_LABELS: Record<TaskSource, string> = {
  scheduled_batch: '定时批量',
  manual_upload: '手动上传',
  seed_archive: '基线样本',
};

export const TaskCenterPanel: React.FC<TaskCenterPanelProps> = ({
  tasks,
  pageNumber,
  hasOlder,
  loadingPage,
  taskListError,
  onOlder,
  onNewer,
  scheduleConfig,
  canManageSchedule,
  canUploadAndRun,
  canEditCase,
  scanningDirectory,
  lastScanMessage,
  lastScanError,
  onSaveSchedule,
  onTriggerDirectoryScan,
  onRunTaskPipeline,
  onOpenCaseDetail,
  onDeleteTask,
}) => {
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'running' | TaskStatus>('ALL');
  const [sourceFilter, setSourceFilter] = useState<'ALL' | TaskSource>('ALL');
  const [query, setQuery] = useState('');
  const [scheduleExpanded, setScheduleExpanded] = useState(true);
  const [draftDir, setDraftDir] = useState(scheduleConfig.scanDirectory);
  const [draftTime, setDraftTime] = useState(scheduleConfig.dailyTime);
  const [draftPattern, setDraftPattern] = useState(scheduleConfig.filePattern);
  const [draftEnabled, setDraftEnabled] = useState(scheduleConfig.enabled);
  const [draftAutoRunAi, setDraftAutoRunAi] = useState(scheduleConfig.autoRunAi);
  const [savingSchedule, setSavingSchedule] = useState(false);

  useEffect(() => {
    setDraftDir(scheduleConfig.scanDirectory);
    setDraftTime(scheduleConfig.dailyTime);
    setDraftPattern(scheduleConfig.filePattern);
    setDraftEnabled(scheduleConfig.enabled);
    setDraftAutoRunAi(scheduleConfig.autoRunAi);
  }, [scheduleConfig]);

  const stats = useMemo(() => computeTaskSummaryStats(tasks), [tasks]);
  const filteredTasks = useMemo(
    () =>
      filterAnalysisTasks(tasks, {
        status: statusFilter,
        source: sourceFilter,
        query,
      }),
    [tasks, statusFilter, sourceFilter, query],
  );

  const handleSaveScheduleClick = async () => {
    if (!canManageSchedule) return;
    setSavingSchedule(true);
    try {
      await onSaveSchedule({
        scanDirectory: draftDir,
        dailyTime: draftTime,
        filePattern: draftPattern,
        enabled: draftEnabled,
        autoRunAi: draftAutoRunAi,
      });
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <WorkbenchPage>
      {taskListError && <p role="alert" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{taskListError}，正在重新连接任务队列。</p>}
      {/* Summary KPI Strip */}
      <section
        aria-label="任务执行概览统计"
        className="grid grid-cols-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-5 sm:divide-x sm:divide-y-0"
      >
        {[
          { label: '全部任务', value: stats.total, hint: '批量与手动合计', key: 'ALL' as const },
          { label: '正在执行', value: stats.running, hint: 'PDF 解析 / 大模型处理中', key: 'running' as const },
          { label: '等待人工审核', value: stats.pendingReview, hint: '已生成初稿待校对', key: 'pending_review' as const },
          { label: '已成功入库', value: stats.approved, hint: '复核/裁定完成可融合', key: 'approved' as const },
          { label: '执行失败', value: stats.failed, hint: '可排查报错并重试', key: 'failed' as const },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setStatusFilter(item.key)}
            className={`flex flex-col items-start gap-1 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 ${
              statusFilter === item.key ? 'bg-slate-50/90' : ''
            }`}
          >
            <span className="text-xs font-medium text-slate-500">{item.label}</span>
            <span className="font-mono-tabular text-2xl font-semibold text-slate-900">
              {item.value}
            </span>
            <span className="text-[11px] text-slate-500">{item.hint}</span>
          </button>
        ))}
      </section>

      <section
        aria-label="定时批量任务调度配置"
        className="rounded-lg border border-slate-200 bg-white p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              定时批量扫盘任务（服务器目录）
            </h2>
            <span className="text-xs text-slate-500">
              · {scheduleConfig.enabled ? `每日 ${scheduleConfig.dailyTime} 自动扫描` : '定时调度已暂停'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setScheduleExpanded((v) => !v)}
              className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              {scheduleExpanded ? '收起策略' : '展开策略'}
            </button>
            <button
              type="button"
              disabled={!canManageSchedule || scanningDirectory}
              onClick={() => onTriggerDirectoryScan(false)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {scanningDirectory ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              立即扫描新增并入队
            </button>
          </div>
        </div>

        {scheduleExpanded && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-6">
                <label
                  htmlFor="schedule-dir-input"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  服务器 PDF 文件目录地址
                </label>
                <input
                  id="schedule-dir-input"
                  type="text"
                  value={draftDir}
                  disabled={!canManageSchedule}
                  onChange={(e) => setDraftDir(e.target.value)}
                  placeholder="./public/assets/aistudio"
                  className="font-mono-tabular w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 disabled:bg-slate-100"
                />
              </div>
              <div className="sm:col-span-3">
                <label
                  htmlFor="schedule-time-input"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  每日定时执行时间
                </label>
                <input
                  id="schedule-time-input"
                  type="time"
                  value={draftTime}
                  disabled={!canManageSchedule}
                  onChange={(e) => setDraftTime(e.target.value)}
                  className="font-mono-tabular w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 disabled:bg-slate-100"
                />
              </div>
              <div className="sm:col-span-3">
                <label
                  htmlFor="schedule-pattern-input"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  文件匹配规则
                </label>
                <input
                  id="schedule-pattern-input"
                  type="text"
                  value={draftPattern}
                  disabled={!canManageSchedule}
                  onChange={(e) => setDraftPattern(e.target.value)}
                  placeholder="*.pdf"
                  className="font-mono-tabular w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 disabled:bg-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={draftEnabled}
                    disabled={!canManageSchedule}
                    onChange={(e) => setDraftEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-700"
                  />
                  <span>启用每日定时扫盘</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={draftAutoRunAi}
                    disabled={!canManageSchedule}
                    onChange={(e) => setDraftAutoRunAi(e.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-700"
                  />
                  <span>扫盘后自动启动 PDF 与大模型解析</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canManageSchedule || scanningDirectory}
                  onClick={() => onTriggerDirectoryScan(true)}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  强制重扫目录演示批次
                </button>
                <button
                  type="button"
                  disabled={!canManageSchedule || savingSchedule}
                  onClick={handleSaveScheduleClick}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {savingSchedule ? '保存中…' : '保存调度配置'}
                </button>
              </div>
            </div>

            {!canManageSchedule && (
              <p className="text-xs text-amber-800">
                当前身份无「定时批量调度配置」权限，配置项已锁定只读。如需调整请切换为系统管理员或前往权限矩阵授权。
              </p>
            )}

            {(lastScanMessage || lastScanError || scheduleConfig.lastRunSummary) && (
              <div
                className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                  lastScanError
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}
              >
                {lastScanError ? (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <span>{lastScanError || lastScanMessage || scheduleConfig.lastRunSummary}</span>
                  {scheduleConfig.lastRunAt && !lastScanError && (
                    <span className="font-mono-tabular ml-2 text-[11px] text-slate-500">
                      最近调度：{new Date(scheduleConfig.lastRunAt).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Task Queue Table */}
      <section
        aria-label="解析任务执行列表"
        className="rounded-lg border border-slate-200 bg-white"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-0.5 text-xs">
            {(
              [
                ['ALL', `全部 (${stats.total})`],
                ['running', `进行中 (${stats.running})`],
                ['pending_review', `待人工审核 (${stats.pendingReview})`],
                ['approved', `已成功入库 (${stats.approved})`],
                ['failed', `失败 (${stats.failed})`],
                ['idle', `待命 (${stats.idle})`],
              ] as Array<['ALL' | 'running' | TaskStatus, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`whitespace-nowrap rounded px-2.5 py-1 font-medium transition-colors ${
                  statusFilter === key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="按任务来源筛选"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as 'ALL' | TaskSource)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="ALL">全部任务来源</option>
              <option value="scheduled_batch">定时批量扫盘</option>
              <option value="manual_upload">手动上传单案</option>
            </select>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="搜索任务编号、文件名或事故业务编号"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜文件名 / 事故业务编号…"
                className="w-56 rounded border border-slate-300 bg-white py-1.5 pr-2.5 pl-8 text-xs text-slate-900"
              />
            </div>
          </div>
        </div>

        {(hasOlder || pageNumber > 1) && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
            <span>第 {pageNumber} 页 · 统计、筛选和搜索均基于本页任务</span>
            <div className="flex gap-3">
              <button type="button" disabled={loadingPage || pageNumber === 1} onClick={onNewer} className="text-blue-700 disabled:text-slate-400">较新任务</button>
              <button type="button" disabled={loadingPage || !hasOlder} onClick={onOlder} className="text-blue-700 disabled:text-slate-400">较早任务</button>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-4 py-2.5 font-medium">任务 / 来源</th>
                <th className="px-4 py-2.5 font-medium">PDF 材料文件</th>
                <th className="px-4 py-2.5 font-medium">事故业务编号 (D01.F001)</th>
                <th className="px-4 py-2.5 font-medium">执行进度与阶段</th>
                <th className="px-4 py-2.5 font-medium">当前状态</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    当前筛选条件下暂无任务记录；可点击上方「立即扫描新增并入队」或「手动上传单案任务」。
                  </td>
                </tr>
              ) : (
                filteredTasks.map((task) => {
                  const statusMeta = TASK_STATUS_META[task.status];
                  const canStartOrRetry =
                    canUploadAndRun &&
                    (task.status === 'idle' || task.status === 'failed' || (task.status === 'queued' && !task.taskId.startsWith('PDF-')));
                  return (
                    <tr key={task.taskId} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 align-top">
                        <div className="font-mono-tabular font-semibold text-slate-900">
                          {task.caseId}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {SOURCE_LABELS[task.source]} · {task.createdByName}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="max-w-[260px] truncate font-medium text-slate-900" title={task.filename}>
                          {task.filename}
                        </div>
                        <div className="font-mono-tabular mt-0.5 text-[11px] text-slate-500">
                          {task.pageCount > 0 ? `${task.pageCount} 页` : '页数待解析'} · {task.modelLabel}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        {task.accidentBizId ? (
                          <span className="font-mono-tabular font-medium text-slate-900">
                            {task.accidentBizId}
                          </span>
                        ) : (
                          <span className="text-slate-400">待提取 / 未录入</span>
                        )}
                      </td>
                      <td className="min-w-[210px] px-4 py-3 align-top">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-slate-700" title={task.stageLabel}>
                            {task.stageLabel}
                          </span>
                          <span className="font-mono-tabular shrink-0 font-medium text-slate-700">
                            {task.progress}%
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full transition-all ${
                              task.status === 'failed'
                                ? 'bg-red-600'
                                : task.status === 'approved'
                                  ? 'bg-emerald-600'
                                  : task.status === 'pending_review'
                                    ? 'bg-amber-600'
                                    : 'bg-blue-700'
                            }`}
                            style={{ width: `${Math.max(4, Math.min(100, task.progress))}%` }}
                          />
                        </div>
                        {task.errorMessage && (
                          <p className="mt-1 text-[11px] text-red-700">{task.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium ${statusMeta.toneClass}`}>
                          {statusMeta.isRunning && (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          )}
                          {statusMeta.label}
                        </span>
                        {task.extractedFieldsCount !== undefined && task.extractedFieldsCount > 0 && (
                          <div className="font-mono-tabular mt-0.5 text-[11px] text-slate-500">
                            已提取 {task.extractedFieldsCount} 项
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right align-top">
                        <div className="inline-flex items-center justify-end gap-2">
                          {canStartOrRetry && (
                            <button
                              type="button"
                              onClick={() => onRunTaskPipeline(task.taskId)}
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-blue-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-800"
                            >
                              <Play className="h-3 w-3" aria-hidden="true" />
                              {task.status === 'failed' ? '重试解析' : '开始解析'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onOpenCaseDetail(task.caseId)}
                            className="whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                          >
                            {canEditCase ? '进入分析详情' : '查看详情'}
                          </button>
                          {canUploadAndRun && !(task.taskId.startsWith('PDF-') && (task.status === 'parsing_pdf' || task.status === 'ai_extracting')) && (
                            <button
                              type="button"
                              aria-label={`删除任务 ${task.taskId}`}
                              onClick={() => onDeleteTask(task.taskId)}
                              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </WorkbenchPage>
  );
};
