import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PdfPageEvidence } from './pageEvidence';
import { Pool, type PoolClient } from 'pg';
import type { CaseDocument } from '../types/gold';
import type { AnalysisTask, ExtendedRole, SystemAuditEvent } from '../types/system';
import { extractAccidentBizId } from '../utils/systemEngine';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
pool.on('error', (error) => console.error('[pdf-queue] 空闲数据库连接断开', error.message));

export class PdfInputError extends Error {}
export const MAX_PDF_BYTES = 64 * 1024 * 1024;
const maxAttempts = 3;
const leaseInterval = "interval '60 seconds'";
const originalDir = path.resolve(process.env.PDF_STORAGE_DIR || '.local-data/pdf-originals');

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initPdfQueue() {
  await fs.mkdir(originalDir, { recursive: true, mode: 0o700 });
  await transaction(async (client) => {
    // Express and the worker can start together. Serialize even the first schema creation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('traffic_gold_pdf_schema'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pdf_originals (
        sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        byte_size bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS pdf_tasks (
        id text PRIMARY KEY,
        sha256 text NOT NULL REFERENCES pdf_originals,
        task jsonb NOT NULL,
        status text GENERATED ALWAYS AS (task->>'status') STORED,
        created_at timestamptz NOT NULL DEFAULT now(),
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        generation int NOT NULL DEFAULT 0,
        attempts int NOT NULL DEFAULT 0,
        run_id uuid NOT NULL UNIQUE,
        model_config_version text,
        draft jsonb
      );
      CREATE INDEX IF NOT EXISTS pdf_tasks_recent ON pdf_tasks (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS pdf_tasks_document ON pdf_tasks (sha256, created_at);
      CREATE INDEX IF NOT EXISTS pdf_tasks_queued ON pdf_tasks (available_at, created_at) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS pdf_tasks_active ON pdf_tasks (lease_until) WHERE lease_until IS NOT NULL;
      CREATE TABLE IF NOT EXISTS pdf_sources (
        sha256 text NOT NULL REFERENCES pdf_originals,
        source text NOT NULL,
        filename text NOT NULL,
        location text NOT NULL,
        actor text NOT NULL,
        first_batch text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (sha256, source, location, actor)
      );
      CREATE TABLE IF NOT EXISTS pdf_run_artifacts (
        task_id text NOT NULL REFERENCES pdf_tasks ON DELETE CASCADE,
        run_id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN ('text','draft')),
        body jsonb NOT NULL,
        PRIMARY KEY (run_id, kind)
      );
      CREATE TABLE IF NOT EXISTS pdf_pages (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        sha256 text NOT NULL REFERENCES pdf_originals,
        extraction_version text NOT NULL,
        page_number integer NOT NULL CHECK (page_number >= 1),
        width double precision NOT NULL CHECK (width > 0 AND width < 'Infinity'),
        height double precision NOT NULL CHECK (height > 0 AND height < 'Infinity'),
        rotation integer NOT NULL CHECK (rotation IN (0,90,180,270)),
        source text NOT NULL CHECK (source IN ('native','ocr','blank')),
        reason text, engine text NOT NULL,
        render_width integer CHECK (render_width > 0), render_height integer CHECK (render_height > 0),
        page_text text NOT NULL, created_by_run uuid NOT NULL,
        UNIQUE (sha256, extraction_version, page_number),
        CHECK (source <> 'ocr' OR (render_width IS NOT NULL AND render_height IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS pdf_page_lines (
        page_id bigint NOT NULL REFERENCES pdf_pages ON DELETE CASCADE,
        line_number integer NOT NULL CHECK (line_number >= 1),
        line_text text NOT NULL CHECK (length(line_text) > 0),
        bbox double precision[] NOT NULL, raw_box double precision[] NOT NULL,
        confidence double precision CHECK (confidence BETWEEN 0 AND 1),
        PRIMARY KEY (page_id, line_number),
        CHECK (cardinality(bbox)=4 AND array_position(bbox,NULL) IS NULL AND
          bbox[1]>=0 AND bbox[2]>=0 AND bbox[3]<=1 AND bbox[4]<=1 AND bbox[1]<bbox[3] AND bbox[2]<bbox[4]),
        CHECK (cardinality(raw_box)=4 AND array_position(raw_box,NULL) IS NULL AND
          raw_box[1]<raw_box[3] AND raw_box[2]<raw_box[4])
      );
      CREATE TABLE IF NOT EXISTS pdf_task_events (
        task_id text NOT NULL REFERENCES pdf_tasks ON DELETE CASCADE,
        event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS pdf_task_events_task ON pdf_task_events (task_id);
      CREATE INDEX IF NOT EXISTS pdf_task_events_time ON pdf_task_events (created_at DESC);
      CREATE INDEX IF NOT EXISTS pdf_run_artifacts_task ON pdf_run_artifacts (task_id);
    `);
  });
}

function originalPath(hash: string) {
  return path.join(originalDir, hash + '.pdf');
}

export async function getOriginalPath(hash: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const found = await pool.query('SELECT 1 FROM pdf_originals WHERE sha256=$1', [hash]);
  return found.rowCount ? originalPath(hash) : null;
}

async function persistOriginal(bytes: Buffer, hash: string) {
  const destination = originalPath(hash);
  const stat = await fs.stat(destination).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (stat) {
    if (!stat.isFile() || stat.size !== bytes.length) throw new Error('原件卷中文件异常，请检查已归档的 PDF');
    return;
  }
  const temporary = path.join(originalDir, randomUUID() + '.tmp');
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // link publishes an immutable file atomically, including across separate ingest processes.
    await fs.link(temporary, destination).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const directory = await fs.open(originalDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.unlink(temporary);
  }
}

interface IngestOptions {
  filename: string;
  source: 'scheduled_batch' | 'manual_upload';
  startImmediately: boolean;
  actorName: string;
  actorRole: ExtendedRole;
  batchId?: string;
  filePath?: string;
  forceRequeue?: boolean;
  modelConfigVersion?: string;
}

export async function enqueuePdf(bytes: Buffer, options: IngestOptions): Promise<{ task: AnalysisTask; created: boolean }> {
  if (bytes.length > MAX_PDF_BYTES) throw new PdfInputError('PDF 原件超过 64 MiB 上限');
  const filename = path.basename(options.filename).trim();
  if (!filename || !bytes.subarray(0, 1024).includes('%PDF-')) {
    throw new PdfInputError('请提供带 PDF 文件头的原件');
  }
  if (!bytes.subarray(-2048).includes('%%EOF')) throw new PdfInputError('PDF 原件缺少结束标记，可能尚未写入完整');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await persistOriginal(bytes, hash);

  return transaction(async (client) => {
    await client.query('INSERT INTO pdf_originals (sha256, byte_size) VALUES ($1,$2) ON CONFLICT DO NOTHING', [hash, bytes.length]);
    // Protect the lookup + insert from concurrent scans/uploads of the same bytes.
    await client.query('SELECT sha256 FROM pdf_originals WHERE sha256=$1 FOR UPDATE', [hash]);
    await client.query(`
      INSERT INTO pdf_sources (sha256,source,filename,location,actor,first_batch)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING
    `, [hash, options.source, filename, options.filePath || filename, options.actorName, options.batchId]);
    const existing = await client.query<{task: AnalysisTask}>(`
      SELECT task FROM pdf_tasks WHERE sha256=$1 AND (NOT $2::boolean OR task->>'batchId'=$3)
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE
    `, [hash, !!options.forceRequeue, options.batchId || null]);
    if (existing.rows.length) {
      let task = existing.rows[0].task;
      if (task.status === 'idle' && options.source === 'manual_upload' && options.startImmediately) {
        task = (await queueExisting(client, task.taskId, options.modelConfigVersion))!;
      }
      return { task, created: false };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const task: AnalysisTask = {
      taskId: 'PDF-' + id, caseId: 'CASE-' + id, filename, source: options.source,
      status: options.startImmediately ? 'queued' : 'idle', progress: 0,
      stageLabel: options.startImmediately ? '已入队，等待后台解析' : '原件已保存，等待开始解析',
      batchId: options.batchId, filePath: options.filePath,
      fileSha256: 'sha256:' + hash, fileSizeBytes: bytes.length, pdfUrl: '/api/system/originals/' + hash,
      pageCount: 0, accidentBizId: '', modelLabel: '待执行',
      createdByRole: options.actorRole, createdByName: options.actorName, createdAt: now, updatedAt: now,
    };
    await client.query('INSERT INTO pdf_tasks (id,sha256,task,run_id,model_config_version) VALUES ($1,$2,$3,$4,$5)',
      [task.taskId, hash, task, randomUUID(), options.modelConfigVersion]);
    await client.query('INSERT INTO pdf_task_events (task_id,event) VALUES ($1,$2)', [task.taskId, task.status]);
    return { task, created: true };
  });
}

export async function listPdfTasks({ before, limit = 100 }: { before?: string; limit?: number } = {}): Promise<{
  tasks: AnalysisTask[];
  nextCursor: string | null;
}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('每页任务数应在 1～200 之间');
  const args: Array<string | number> = [limit + 1];
  if (before !== undefined) {
    // A self-contained timestamp + ID cursor still works after the preceding task is deleted.
    const match = before.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_(PDF-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    if (!match) throw new RangeError('任务分页游标无效');
    const date = new Date(match[1]);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== match[1].slice(0, 23) + 'Z') {
      throw new RangeError('任务分页时间无效');
    }
    args.push(match[1], match[2]);
  }
  const result = await pool.query(`
    SELECT task, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '_' || id AS cursor
    FROM pdf_tasks ${before === undefined ? '' : 'WHERE (created_at,id) < ($2::timestamptz,$3)'}
    ORDER BY created_at DESC,id DESC LIMIT $1
  `, args);
  const rows = result.rows.slice(0, limit);
  return {
    tasks: rows.map((row) => row.task),
    nextCursor: result.rows.length > limit ? rows[limit - 1].cursor : null,
  };
}

export async function recentPdfAuditEvents(): Promise<SystemAuditEvent[]> {
  const result = await pool.query(`
    SELECT e.task_id, e.event, e.created_at, t.task FROM pdf_task_events e
    JOIN pdf_tasks t ON t.id=e.task_id ORDER BY e.created_at DESC LIMIT 500`);
  const labels: Record<string,string> = {
    idle: '保存 PDF 原件，登记待命任务', queued: 'PDF 解析入队', retry: '后台解析等待重试',
    failed: '后台解析失败', pending_review: '后台解析完成，草稿待复核',
  };
  return result.rows.map(row => {
    const task: AnalysisTask = row.task;
    const timestamp = row.created_at.toISOString();
    const worker = ['pending_review','failed','retry'].includes(row.event);
    return {
      id: [row.task_id, row.event, timestamp].join('/'), timestamp, category: 'task_pipeline',
      actorName: worker ? '后台解析 worker' : task.createdByName,
      actorRole: worker ? 'admin' : task.createdByRole,
      action: labels[row.event] || row.event, targetRef: task.caseId, detail: task.filename,
    };
  });
}

export async function getPdfTask(id: string): Promise<AnalysisTask | null> {
  const result = await pool.query('SELECT task FROM pdf_tasks WHERE id=$1', [id]);
  return result.rows[0]?.task ?? null;
}

export async function getPdfDraft(id: string): Promise<CaseDocument | null> {
  const result = await pool.query('SELECT draft FROM pdf_tasks WHERE id=$1', [id]);
  return result.rows[0]?.draft ?? null;
}

async function queueExisting(client: PoolClient, id: string, version?: string): Promise<AnalysisTask | null> {
  const result = await client.query(`
    UPDATE pdf_tasks SET task=(task - 'errorMessage' - 'finishedAt' - 'startedAt' - 'durationMs')
      || jsonb_build_object('status','queued','progress',0,'stageLabel','已入队，等待后台解析','updatedAt',now()),
      run_id=$2, attempts=0, available_at=now(), model_config_version=coalesce($3, model_config_version)
    WHERE id=$1 AND status IN ('idle','failed') RETURNING task
  `, [id, randomUUID(), version]);
  if (result.rowCount) {
    await client.query("INSERT INTO pdf_task_events (task_id,event) VALUES ($1,'queued')", [id]);
    return result.rows[0].task;
  }
  const current = await client.query('SELECT task FROM pdf_tasks WHERE id=$1', [id]);
  return current.rows[0]?.task ?? null;
}

export function startPdfTask(id: string, version?: string) {
  return transaction((client) => queueExisting(client, id, version));
}

export async function deletePdfTask(id: string): Promise<boolean> {
  return transaction(async (client) => {
    const current = await client.query('SELECT status FROM pdf_tasks WHERE id=$1 FOR UPDATE', [id]);
    if (!current.rowCount) return false;
    if (['parsing_pdf', 'ai_extracting'].includes(current.rows[0].status)) {
      throw new Error('任务正在处理中，请在结束后移除');
    }
    await client.query('DELETE FROM pdf_tasks WHERE id=$1', [id]);
    return true;
  });
}

export interface PdfLease {
  task: AnalysisTask;
  generation: number;
  runId: string;
  originalPath: string;
  modelConfigVersion?: string;
}

export async function claimPdfTask(maxConcurrent = 1): Promise<PdfLease | null> {
  return transaction(async (client) => {
    // Only the short admission transaction is serialized. Work runs outside this lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('traffic_gold_pdf_claim'))");
    await client.query(`
      WITH expired AS (UPDATE pdf_tasks SET lease_until=NULL, task=task || jsonb_build_object('status','failed','progress',100,
        'stageLabel','后台解析中断','errorMessage','后台任务租约多次到期，请检查 worker 后重试','finishedAt',now(),'updatedAt',now())
      WHERE lease_until <= now() AND attempts >= $1 RETURNING id)
      INSERT INTO pdf_task_events(task_id,event) SELECT id,'failed' FROM expired
    `, [maxAttempts]);
    const claimed = await client.query(`
      WITH candidate AS (
        SELECT id FROM pdf_tasks WHERE ((status='queued' AND available_at <= now()) OR lease_until <= now())
          AND (SELECT count(*) FROM pdf_tasks WHERE lease_until > now()) < $1
        ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE pdf_tasks q SET lease_until=now() + ${leaseInterval}, attempts=attempts+1, generation=generation+1,
        task=(task - 'errorMessage') || jsonb_build_object('status','parsing_pdf','progress',10,
          'startedAt',coalesce(task->'startedAt',to_jsonb(now())),'updatedAt',now(),'stageLabel','后台正在读取 PDF 原件')
      FROM candidate WHERE q.id=candidate.id RETURNING task,generation,run_id,sha256,model_config_version
    `, [Math.max(1, Math.floor(maxConcurrent))]);
    const row = claimed.rows[0];
    return row ? {
      task: row.task, generation: row.generation, runId: row.run_id,
      originalPath: originalPath(row.sha256), modelConfigVersion: row.model_config_version ?? undefined,
    } : null;
  });
}

const ownedLease = 'id=$1 AND generation=$2 AND lease_until > clock_timestamp()';
function leaseArgs(lease: PdfLease) {
  return [lease.task.taskId, lease.generation];
}

export async function renewPdfLease(lease: PdfLease): Promise<boolean> {
  const result = await pool.query(`UPDATE pdf_tasks SET lease_until=now() + ${leaseInterval} WHERE ${ownedLease}`, leaseArgs(lease));
  return result.rowCount === 1;
}

export async function updatePdfProgress(lease: PdfLease, stage: 'parsing_pdf' | 'ai_extracting', label: string, progress: number, modelLabel?: string): Promise<boolean> {
  const patch = { status: stage, stageLabel: label, progress, modelLabel };
  const result = await pool.query(`UPDATE pdf_tasks SET task=task || $3::jsonb || jsonb_build_object('updatedAt',now())
    WHERE ${ownedLease}`, [...leaseArgs(lease), patch]);
  return result.rowCount === 1;
}

// Each page is an immutable cache entry. A run's text artifact pins its extractionVersion.
export async function readCachedPageText(lease: PdfLease, version: string, pageNumber: number): Promise<string | null> {
  const cached = await pool.query('SELECT page_text FROM pdf_pages WHERE sha256=$1 AND extraction_version=$2 AND page_number=$3',
    [lease.task.fileSha256.slice(7), version, pageNumber]);
  return cached.rows[0]?.page_text ?? null;
}

export async function savePageEvidence(lease: PdfLease, version: string, page: PdfPageEvidence): Promise<string | null> {
  if (page.source === 'blank' ? page.text.trim() || page.lines.length : !page.text.trim() || !page.lines.length)
    throw new Error(`第 ${page.pageNumber} 页内容与文字行不完整`);
  if (page.source === 'ocr' && (!page.engine || page.lines.some(line => !line.rawBox || line.confidence == null)))
    throw new Error(`第 ${page.pageNumber} 页缺少 OCR 引擎、原始坐标或置信度`);

  return transaction(async client => {
    const owned = await client.query(`SELECT sha256 FROM pdf_tasks WHERE ${ownedLease} AND run_id=$3 FOR UPDATE`,
      [...leaseArgs(lease), lease.runId]);
    if (!owned.rowCount) return null;
    const key = [owned.rows[0].sha256, version, page.pageNumber];
    const inserted = await client.query(`
      INSERT INTO pdf_pages(sha256,extraction_version,page_number,width,height,rotation,source,reason,
        engine,render_width,render_height,page_text,created_by_run)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (sha256,extraction_version,page_number) DO NOTHING RETURNING id`,
    [...key, page.width, page.height, page.rotation, page.source, page.reason, page.engine ?? 'pdf-inspector',
      page.renderWidth, page.renderHeight, page.text, lease.runId]);
    if (!inserted.rowCount) {
      const persisted = await client.query('SELECT page_text FROM pdf_pages WHERE sha256=$1 AND extraction_version=$2 AND page_number=$3', key);
      return persisted.rows[0].page_text as string;
    }
    if (page.lines.length) {
      const lines = page.lines.map((line, index) => {
        const [x1,y1,x2,y2] = line.bbox;
        return {
          ...line, line_number: index + 1,
          raw_box: line.rawBox ?? [x1 * page.width, y1 * page.height, x2 * page.width, y2 * page.height],
        };
      });
      await client.query(`INSERT INTO pdf_page_lines(page_id,line_number,line_text,bbox,raw_box,confidence)
        SELECT $1,line_number,text,bbox,raw_box,confidence FROM jsonb_to_recordset($2::jsonb) AS
          line(line_number int,text text,bbox double precision[],raw_box double precision[],confidence double precision)`,
        [inserted.rows[0].id, JSON.stringify(lines)]);
    }
    return page.text;
  });
}

// A session lock spans the OCR request without holding a transaction or blocking lease heartbeats.
export async function withOcrSlot<T>(signal: AbortSignal, work: (slotSignal: AbortSignal) => Promise<T>): Promise<T> {
  while (true) {
    signal.throwIfAborted();
    const client = await pool.connect();
    const disconnected = new AbortController();
    const onDisconnect = (error: Error) => disconnected.abort(error);
    client.on('error', onDisconnect);
    let locked = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtext('traffic_gold_paddle_ocr')) AS locked");
      locked = result.rows[0].locked;
      if (locked) {
        const slotSignal = AbortSignal.any([signal, disconnected.signal]);
        slotSignal.throwIfAborted();
        return await work(slotSignal);
      }
    } finally {
      try {
        if (locked && !disconnected.signal.aborted) {
          await client.query("SELECT pg_advisory_unlock(hashtext('traffic_gold_paddle_ocr'))");
        }
      } catch (error) {
        disconnected.abort(error);
        throw error;
      } finally {
        client.removeListener('error', onDisconnect);
        client.release(disconnected.signal.aborted);
      }
    }
    await delay(500, undefined, { signal });
  }
}

type ArtifactKind = 'text' | 'draft';

export async function savePdfArtifact(lease: PdfLease, kind: ArtifactKind, data: unknown): Promise<boolean> {
  const result = await pool.query(`
    WITH owned AS (SELECT id,run_id FROM pdf_tasks WHERE ${ownedLease} FOR UPDATE),
    saved AS (INSERT INTO pdf_run_artifacts (task_id,run_id,kind,body)
      SELECT id,run_id,$3,$4::jsonb FROM owned
      ON CONFLICT (run_id,kind) DO UPDATE SET body=excluded.body
      WHERE excluded.kind='text' AND excluded.body ? 'extractionVersion' AND NOT (pdf_run_artifacts.body ? 'extractionVersion'))
    SELECT id FROM owned
  `, [...leaseArgs(lease), kind, JSON.stringify(data)]);
  return result.rowCount === 1;
}

export async function readPdfArtifact<T>(lease: PdfLease, kind: ArtifactKind): Promise<T | null> {
  const result = await pool.query('SELECT body FROM pdf_run_artifacts WHERE run_id=$1 AND kind=$2', [lease.runId, kind]);
  return result.rows[0]?.body ?? null;
}

export async function completePdfTask(lease: PdfLease, draft: CaseDocument): Promise<boolean> {
  if (draft.caseId !== lease.task.caseId) throw new Error('草稿案件与当前任务不一致');
  const count = draft.fieldRecords.length + draft.legalConclusions.length;
  const patch = { status: 'pending_review', progress: 100, stageLabel: `提取 ${count} 项结构化草稿，等待人工审核`,
    accidentBizId: extractAccidentBizId(draft), pageCount: draft.pageCount, extractedFieldsCount: count };
  return transaction(async (client) => {
    const result = await client.query(`UPDATE pdf_tasks SET lease_until=NULL,draft=$3,
      task=(task - 'errorMessage') || $4::jsonb || jsonb_build_object('finishedAt',now(),'updatedAt',now(),
        'durationMs',round(extract(epoch FROM (now() - (task->>'startedAt')::timestamptz))*1000))
      WHERE ${ownedLease}`, [...leaseArgs(lease), draft, patch]);
    if (result.rowCount) await client.query("INSERT INTO pdf_task_events (task_id,event) VALUES ($1,'pending_review')", [lease.task.taskId]);
    return result.rowCount === 1;
  });
}

export async function failPdfTask(lease: PdfLease, message: string, retryable: boolean): Promise<boolean> {
  const result = await pool.query(`
    WITH updated AS (UPDATE pdf_tasks SET lease_until=NULL, available_at=now() + attempts*interval '10 seconds',
      task=task || jsonb_build_object('errorMessage',$3::text,'updatedAt',now()) ||
        CASE WHEN $4 AND attempts < $5 THEN jsonb_build_object('status','queued','progress',0,'stageLabel','暂时失败，等待后台重试')
        ELSE jsonb_build_object('status','failed','progress',100,'stageLabel','后台解析失败','finishedAt',now()) END
    WHERE ${ownedLease} RETURNING id,status)
    INSERT INTO pdf_task_events(task_id,event) SELECT id,CASE status WHEN 'queued' THEN 'retry' ELSE status END FROM updated
  `, [...leaseArgs(lease), message, retryable, maxAttempts]);
  return result.rowCount === 1;
}
