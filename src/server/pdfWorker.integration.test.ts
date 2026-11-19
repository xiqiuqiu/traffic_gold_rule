import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';

async function until(check: () => Promise<unknown>) {
  const started = Date.now();
  while (!await check()) {
    if (Date.now() - started > 30_000) throw new Error('等待后台状态超时');
    await delay(100);
  }
}

// Run with PDF_WORKER_DB_TEST=1 and a DATABASE_URL allowed to create a temporary database.
test('worker restarts from the text checkpoint and retries a transient model failure', {
  skip: process.env.PDF_WORKER_DB_TEST !== '1',
}, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'pdf-worker-test-'));
  const adminUrl = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: adminUrl });
  const database = 'worker_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  let worker: ChildProcess | undefined;
  let calls = 0;
  let receivedCase = false;
  const model = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    receivedCase ||= text.includes('王小明无责任');
    calls++;
    if (calls === 1) return; // Simulate a worker crash during a model request.
    if (calls === 2) { response.writeHead(429).end(); return; }
    const payload = {
      entities: [{ id: 'P01', kind: 'P', label: '王小明' }], fieldRecords: [],
      legalConclusions: [{ category: 'liability', subjectId: 'P01', presenceStatus: 'present',
        rawText: '王小明无责任', conclusionLabel: '无责任', evidences: [{ page: 2, quote: '王小明无责任' }] }],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  const startWorker = () => spawn('node', ['--import', 'tsx', 'worker.ts'], {
    env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  async function stopWorker() {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
  }

  let db: Pool | undefined;
  const oldStorage = process.env.PDF_STORAGE_DIR;
  try {
    await admin.query('CREATE DATABASE ' + database);
    process.env.DATABASE_URL = url.href;
    process.env.PDF_STORAGE_DIR = storage;
    const { initPdfQueue, pool, enqueuePdf } = await import('./pdfQueue');
    db = pool;
    const { initModelSettings, saveModelSettings } = await import('./modelSettings');
    await initPdfQueue();
    await initModelSettings();
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    assert(address && typeof address !== 'string');
    await saveModelSettings({ provider: 'openai_compatible', openai: {
      baseUrl: 'http://127.0.0.1:' + address.port + '/v1', selectedModel: 'test',
      apiKey: '', availableModels: [],
    } }, false);
    const filename = 'accident_report_08_dooring_collision_ecc07031.pdf';
    const { task } = await enqueuePdf(await readFile(join('public/assets/aistudio', filename)), {
      filename, source: 'manual_upload', actorName: '测试', actorRole: 'admin', startImmediately: true,
    });
    worker = startWorker();
    await until(async () => calls === 1);
    await stopWorker();
    const before = (await pool.query('SELECT run_id FROM pdf_tasks WHERE id=$1', [task.taskId])).rows[0];
    const artifactCount = async () => (await pool.query(
      'SELECT count(*)::int AS n FROM pdf_run_artifacts WHERE run_id=$1 AND kind=$2', [before.run_id, 'text'],
    )).rows[0].n;
    assert.equal(await artifactCount(), 1);
    await pool.query("UPDATE pdf_tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [task.taskId]);
    worker = startWorker();
    await until(async () => (await pool.query("SELECT status FROM pdf_tasks WHERE id=$1", [task.taskId])).rows[0].status === 'queued');
    await pool.query('UPDATE pdf_tasks SET available_at=now() WHERE id=$1', [task.taskId]);
    await until(async () => (await pool.query("SELECT status FROM pdf_tasks WHERE id=$1", [task.taskId])).rows[0].status === 'pending_review');
    const result = (await pool.query('SELECT run_id,attempts,draft FROM pdf_tasks WHERE id=$1', [task.taskId])).rows[0];
    assert.equal(result.run_id, before.run_id);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
    assert(receivedCase);
    assert.equal(await artifactCount(), 1);
    assert.equal(result.draft.legalConclusions[0].evidences[0].page, 2);
    assert.equal(result.draft.legalConclusions[0].evidences[0].quote, '王小明无责任');
    assert.equal(result.draft.pdfUrl, task.pdfUrl);
  } finally {
    await stopWorker();
    model.closeAllConnections();
    model.close();
    await db?.end();
    process.env.DATABASE_URL = adminUrl;
    if (oldStorage) process.env.PDF_STORAGE_DIR = oldStorage;
    else delete process.env.PDF_STORAGE_DIR;
    await admin.query('DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)');
    await admin.end();
    await rm(storage, { recursive: true, force: true });
  }
});
