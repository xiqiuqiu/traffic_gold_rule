import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { enqueuePdf, pool, MAX_PDF_BYTES, PdfInputError } from './pdfQueue';
import { getModelConfigVersion } from './modelSettings';
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

const DATA_DIR = path.resolve(process.env.SYSTEM_DATA_DIR || '.local-data');
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
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : fallback.tasks,
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const initial = createInitialSystemState();
    await saveSystemState(initial);
    return initial;
  }
}

let writingState = Promise.resolve();
export async function saveSystemState(next: PersistedSystemState): Promise<PersistedSystemState> {
  stateCache = next;
  const write = writingState.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporary = STATE_FILE + '.' + crypto.randomUUID();
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temporary, STATE_FILE);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
  writingState = write.catch(() => { if (stateCache === next) stateCache = null; });
  await write;
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
  fileErrors: { filename: string; reason: string }[];
  createdTasks: AnalysisTask[];
  batchId: string;
  scannedAt: string;
}

function matchesGlobPattern(filename: string, pattern: string): boolean {
  const clean = pattern.trim() || '*.pdf';
  if (clean === '*.pdf' || clean === '*') {
    return /\.pdf$/i.test(filename);
  }
  const escaped = clean.replace(/[?.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
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
    .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name) && matchesGlobPattern(entry.name, pattern))
    .sort((a, b) => a.name.localeCompare(b.name));

  const batchId = 'BATCH-' + crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const version = await getModelConfigVersion();
  const createdTasks: AnalysisTask[] = [];
  const fileErrors: DirectoryScanResult['fileErrors'] = [];
  let skippedExistingCount = 0;

  for (const entry of matchingFiles) {
    const filePath = path.join(targetDir, entry.name);
    try {
      const bytes = await readScanFile(filePath);
      const { task, created } = await enqueuePdf(bytes, {
        source: 'scheduled_batch', filename: entry.name, filePath, batchId,
        actorRole: 'admin', actorName: options?.actorName || '定时批量调度器',
        startImmediately: autoRunAi, forceRequeue: options?.forceRequeue, modelConfigVersion: version,
      });
      if (created) createdTasks.push(task);
      else skippedExistingCount++;
    } catch (err) {
      // A single bad input must not block its siblings. Storage/database failures leave the batch due.
      if (!(err instanceof ScanInputError || err instanceof PdfInputError)) throw err;
      fileErrors.push({ filename: entry.name, reason: err instanceof Error ? err.message : '读取失败' });
    }
  }

  const summary = `扫描 ${targetDir}：发现 ${matchingFiles.length} 份 PDF，新增 ${createdTasks.length} 条任务，跳过已入库 ${skippedExistingCount} 份` +
    (fileErrors.length ? `，失败 ${fileErrors.length} 份（${fileErrors[0].filename}：${fileErrors[0].reason}）` : '');
  const latest = await loadSystemState();
  const nextSchedule = { ...latest.scheduleConfig, lastRunAt: nowIso, lastRunSummary: summary };

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
    ...latest,
    scheduleConfig: nextSchedule,
    auditLogs: [auditEvent, ...latest.auditLogs].slice(0, 500),
  });

  return {
    directory: targetDir,
    scannedFileCount: matchingFiles.length,
    skippedExistingCount,
    fileErrors,
    createdTasks,
    batchId,
    scannedAt: nowIso,
  };
}


class ScanInputError extends Error {}

// Producers should write a temporary name and rename the finished PDF into the scan directory.
export async function readScanFile(filePath: string) {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((err: Error) => { throw new ScanInputError(err.message); });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > MAX_PDF_BYTES) throw new ScanInputError('仅支持 64 MiB 以内的 PDF 文件');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.size !== BigInt(bytes.length) || before.size !== after.size)
      throw new ScanInputError('文件写入中，等待下次扫盘');
    return bytes;
  } finally {
    await file.close();
  }
}

function dailyScanKey(now: Date, schedule: BatchScheduleConfig) {
  return JSON.stringify([now.getFullYear(), now.getMonth() + 1, now.getDate(),
    schedule.dailyTime, schedule.scanDirectory, schedule.filePattern]);
}

export async function initScanSchedule() {
  const { scheduleConfig } = await loadSystemState();
  await pool.query('CREATE TABLE IF NOT EXISTS pdf_schedule_runs (schedule_key text PRIMARY KEY)');
  // On the first upgrade, honor today's already completed legacy scan before enabling catch-up.
  const previous = scheduleConfig.lastRunAt && new Date(scheduleConfig.lastRunAt);
  if (previous && previous.toDateString() === new Date().toDateString() &&
      previous.toTimeString().slice(0, 5) >= scheduleConfig.dailyTime && scheduleConfig.enabled) {
    await pool.query(`INSERT INTO pdf_schedule_runs(schedule_key) SELECT $1
      WHERE NOT EXISTS (SELECT 1 FROM pdf_schedule_runs) ON CONFLICT DO NOTHING`, [dailyScanKey(previous, scheduleConfig)]);
  }
}

export async function runDueScan(now = new Date()) {
  const { scheduleConfig } = await loadSystemState();
  const hhmm = now.toTimeString().slice(0, 5);
  if (!scheduleConfig.enabled || hhmm < scheduleConfig.dailyTime) return;
  const client = await pool.connect();
  // Session lock keeps concurrent ticks out while allowing each file its own short transaction.
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('workbench_daily_scan')) AS acquired");
    if (!rows[0].acquired) return;
    const key = dailyScanKey(now, scheduleConfig);
    if ((await client.query('SELECT 1 FROM pdf_schedule_runs WHERE schedule_key=$1', [key])).rowCount) return;
    await scanServerDirectoryForTasks({ actorName: '每日定时调度器' });
    await client.query('INSERT INTO pdf_schedule_runs(schedule_key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('workbench_daily_scan'))"); }
    finally { client.release(); }
  }
}
