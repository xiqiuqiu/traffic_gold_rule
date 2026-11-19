import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SEED_CASES } from '../data/seedCases';
import {
  AnalysisTask,
  BatchScheduleConfig,
  RolePermissionMatrix,
  SystemAuditEvent,
  UserIdentityProfile,
} from '../types/system';
import {
  DEFAULT_IDENTITIES,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_SCHEDULE_CONFIG,
  buildInitialSystemAuditEvents,
  buildSeedTasksFromCases,
} from '../utils/systemEngine';

export interface PersistedSystemState {
  scheduleConfig: BatchScheduleConfig;
  tasks: AnalysisTask[];
  auditLogs: SystemAuditEvent[];
  rolePermissions: RolePermissionMatrix;
  identities: UserIdentityProfile[];
}

const DATA_DIR = path.resolve(process.cwd(), '.local-data');
const STATE_FILE = path.join(DATA_DIR, 'system-state.json');

let stateCache: PersistedSystemState | null = null;

function createInitialSystemState(): PersistedSystemState {
  return {
    scheduleConfig: { ...DEFAULT_SCHEDULE_CONFIG },
    tasks: buildSeedTasksFromCases(SEED_CASES),
    auditLogs: buildInitialSystemAuditEvents(SEED_CASES),
    rolePermissions: structuredClone(DEFAULT_ROLE_PERMISSIONS),
    identities: structuredClone(DEFAULT_IDENTITIES),
  };
}

export async function loadSystemState(): Promise<PersistedSystemState> {
  if (stateCache) return stateCache;
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedSystemState>;
    const fallback = createInitialSystemState();
    stateCache = {
      scheduleConfig: parsed.scheduleConfig || fallback.scheduleConfig,
      tasks: Array.isArray(parsed.tasks) && parsed.tasks.length > 0 ? parsed.tasks : fallback.tasks,
      auditLogs:
        Array.isArray(parsed.auditLogs) && parsed.auditLogs.length > 0
          ? parsed.auditLogs
          : fallback.auditLogs,
      rolePermissions: parsed.rolePermissions || fallback.rolePermissions,
      identities:
        Array.isArray(parsed.identities) && parsed.identities.length > 0
          ? parsed.identities
          : fallback.identities,
    };
    return stateCache;
  } catch {
    const initial = createInitialSystemState();
    await saveSystemState(initial);
    return initial;
  }
}

export async function saveSystemState(next: PersistedSystemState): Promise<PersistedSystemState> {
  stateCache = next;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[systemStore] Failed to persist local JSON state:', err);
  }
  return next;
}

export async function appendSystemAuditEvent(
  event: Omit<SystemAuditEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string },
): Promise<SystemAuditEvent> {
  const state = await loadSystemState();
  const fullEvent: SystemAuditEvent = {
    id: event.id || `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: event.timestamp || new Date().toISOString(),
    category: event.category,
    actorRole: event.actorRole,
    actorName: event.actorName,
    action: event.action,
    targetRef: event.targetRef,
    accidentBizId: event.accidentBizId,
    detail: event.detail,
    beforeValue: event.beforeValue,
    afterValue: event.afterValue,
  };
  await saveSystemState({
    ...state,
    auditLogs: [fullEvent, ...state.auditLogs].slice(0, 500),
  });
  return fullEvent;
}

export function resolveSafeScanDirectory(rawDir: string): string {
  const trimmed = rawDir.trim() || './public/assets/aistudio';
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

export interface DirectoryScanResult {
  directory: string;
  scannedFileCount: number;
  skippedExistingCount: number;
  createdTasks: AnalysisTask[];
  batchId: string;
  scannedAt: string;
}

function matchesGlobPattern(filename: string, pattern: string): boolean {
  const clean = pattern.trim() || '*.pdf';
  if (clean === '*.pdf' || clean === '*') {
    return /\.pdf$/i.test(filename);
  }
  const escaped = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(filename);
}

export async function scanServerDirectoryForTasks(options?: {
  directory?: string;
  filePattern?: string;
  actorName?: string;
  autoRunAi?: boolean;
  forceRequeue?: boolean;
}): Promise<DirectoryScanResult> {
  const state = await loadSystemState();
  const targetDir = resolveSafeScanDirectory(
    options?.directory || state.scheduleConfig.scanDirectory,
  );
  const pattern = options?.filePattern || state.scheduleConfig.filePattern || '*.pdf';
  const autoRunAi = options?.autoRunAi ?? state.scheduleConfig.autoRunAi;

  const stat = await fs.stat(targetDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`服务器扫描目录不存在或不可访问：${targetDir}`);
  }

  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const matchingFiles = entries
    .filter((entry) => entry.isFile() && matchesGlobPattern(entry.name, pattern))
    .sort((a, b) => a.name.localeCompare(b.name));

  const existingHashes = new Set(state.tasks.map((t) => t.fileSha256));
  const existingNames = new Set(state.tasks.map((t) => t.filename));
  const batchId = `BATCH-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const nowIso = new Date().toISOString();

  const createdTasks: AnalysisTask[] = [];
  let skippedExistingCount = 0;

  for (const fileEntry of matchingFiles) {
    const absPath = path.join(targetDir, fileEntry.name);
    const fileStat = await fs.stat(absPath);
    const buf = await fs.readFile(absPath);
    const shaFull = crypto.createHash('sha256').update(buf).digest('hex');
    const shaShort = `sha256:${shaFull.slice(0, 16)}`;

    if (!options?.forceRequeue && (existingHashes.has(shaShort) || existingNames.has(fileEntry.name))) {
      skippedExistingCount += 1;
      continue;
    }

    const taskId = `TASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const newCaseId = `CASE-BATCH-${String(state.tasks.length + createdTasks.length + 1).padStart(2, '0')}`;
    const task: AnalysisTask = {
      taskId,
      batchId,
      source: 'scheduled_batch',
      status: autoRunAi ? 'queued' : 'idle',
      progress: autoRunAi ? 10 : 0,
      stageLabel: autoRunAi ? '已扫盘入队，等待执行 PDF 与大模型解析' : '已扫盘入库（待命，需人工点击开始）',
      caseId: newCaseId,
      accidentBizId: '',
      filename: fileEntry.name,
      filePath: absPath,
      pdfUrl: `/api/system/pdf?path=${encodeURIComponent(absPath)}`,
      fileSha256: shaShort,
      fileSizeBytes: fileStat.size,
      pageCount: 1,
      modelLabel: '待执行',
      createdAt: nowIso,
      updatedAt: nowIso,
      createdByRole: 'admin',
      createdByName: options?.actorName || '定时批量调度器',
    };
    createdTasks.push(task);
    existingHashes.add(shaShort);
    existingNames.add(fileEntry.name);
  }

  const summary =
    createdTasks.length > 0
      ? `扫描 ${targetDir}：发现 ${matchingFiles.length} 份 PDF，新增 ${createdTasks.length} 条任务（跳过已入库 ${skippedExistingCount} 份）`
      : `扫描 ${targetDir}：发现 ${matchingFiles.length} 份 PDF，全部 ${skippedExistingCount} 份均已入库，无新增任务`;

  const nextSchedule: BatchScheduleConfig = {
    ...state.scheduleConfig,
    scanDirectory: options?.directory || state.scheduleConfig.scanDirectory,
    filePattern: pattern,
    lastRunAt: nowIso,
    lastRunSummary: summary,
  };

  const auditEvent: SystemAuditEvent = {
    id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: nowIso,
    category: 'schedule',
    actorRole: 'admin',
    actorName: options?.actorName || '定时批量调度器',
    action: '执行服务器目录批量扫描',
    targetRef: targetDir,
    detail: summary,
  };

  await saveSystemState({
    ...state,
    scheduleConfig: nextSchedule,
    tasks: [...createdTasks, ...state.tasks],
    auditLogs: [auditEvent, ...state.auditLogs].slice(0, 500),
  });

  return {
    directory: targetDir,
    scannedFileCount: matchingFiles.length,
    skippedExistingCount,
    createdTasks,
    batchId,
    scannedAt: nowIso,
  };
}
