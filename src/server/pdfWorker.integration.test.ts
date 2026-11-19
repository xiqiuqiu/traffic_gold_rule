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
import { makePagePdf } from './fixtures/pagePdf';
import { OCR_ENGINE } from './paddleOcr';

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
}, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'pdf-worker-test-'));
  const adminUrl = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: adminUrl });
  const database = 'worker_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  let worker: ChildProcess | undefined;
  let calls = 0;
  let receivedCase = false;
  let ocrCalls = 0;
  let lastPrompt = '';
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/ocr/lines') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const image = Buffer.concat(chunks);
      ocrCalls++;
      if (ocrCalls === 2) { response.writeHead(503).end(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        engine: OCR_ENGINE, width: image.readUInt32BE(16), height: image.readUInt32BE(20),
        lines: [{ text: ocrCalls === 1 ? '甲全责' : '乙无责', rawBox: [1, 2, 32, 22], confidence: 0.99 }],
      }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    lastPrompt = JSON.parse(text).messages.at(-1).content;
    const splitName = lastPrompt.match(/^\[(\d+:\d+)\] [^\n]*当事人王小\s*\n\[(\d+:\d+)\] 明无责任。/m);
    receivedCase ||= Boolean(splitName);
    calls++;
    if (calls === 1) return; // Simulate a worker crash during a model request.
    if (calls === 2) { response.writeHead(429).end(); return; }
    const payload = {
      entities: [{ id: 'P01', kind: 'P', label: '王小明' }], fieldRecords: [],
      legalConclusions: [{ category: 'liability', subjectId: 'P01', presenceStatus: 'present',
        rawText: '王小明无责任', conclusionLabel: '无责任', evidences: [{
          page: 2, quote: '王小明无责任', lineIds: splitName?.slice(1),
        }] }],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  const startWorker = (env = process.env) => spawn('node', ['--import', 'tsx', 'worker.ts'], {
    env, stdio: ['ignore', 'inherit', 'inherit'],
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
    const location = result.draft.legalConclusions[0].sourceLocation;
    assert.equal(location.status, 'verified');
    assert.deepEqual(location.lines.map((row: { lineId: string }) => row.lineId), result.draft.legalConclusions[0].evidences[0].lineIds);
    assert.equal(result.draft.pdfUrl, task.pdfUrl);

    await t.test('中途 OCR 失败后按原始页恢复，短责任引文进入模型输入', async () => {
      await stopWorker();
      const endpoint = 'http://127.0.0.1:' + address.port + '/v1/ocr/lines';
      const bytes = makePagePdf([
        { content: 'BT /F0 10 Tf 35 175 Td (Native text) Tj ET' },
        { content: '0 g 50 130 90 50 re f' },
        { content: 'q 190 0 0 240 10 20 cm /Im0 Do Q' },
        { content: '' },
      ]);
      const { task: mixed } = await enqueuePdf(bytes, {
        filename: '三类页.pdf', source: 'manual_upload', actorName: '测试', actorRole: 'admin', startImmediately: true,
      });
      const inspect = () => pool.query('SELECT page_number,source FROM pdf_pages WHERE sha256=$1 ORDER BY page_number', [mixed.fileSha256.slice(7)]);
      const env = { ...process.env, PADDLE_OCR_URL: endpoint };
      worker = startWorker(env);
      await until(async () => ocrCalls === 2 &&
        (await pool.query('SELECT status FROM pdf_tasks WHERE id=$1', [mixed.taskId])).rows[0].status === 'queued');
      await stopWorker();
      assert.deepEqual((await inspect()).rows.map(r => r.page_number), [1, 2]);
      assert.equal((await pool.query('SELECT draft FROM pdf_tasks WHERE id=$1', [mixed.taskId])).rows[0].draft, null);
      await pool.query('UPDATE pdf_tasks SET available_at=now() WHERE id=$1', [mixed.taskId]);
      worker = startWorker(env);
      await until(async () => (await pool.query('SELECT status FROM pdf_tasks WHERE id=$1', [mixed.taskId])).rows[0].status === 'pending_review');
      assert.equal(ocrCalls, 3);
      assert.deepEqual((await inspect()).rows.map(r => r.source), ['native', 'ocr', 'ocr', 'blank']);
      assert.match(lastPrompt, /第 2 页 ===\n\[\d+:1\] 甲全责/);
      assert.match(lastPrompt, /第 3 页 ===\n\[\d+:1\] 乙无责/);
      // The model returned the previous document's claim; the current document has no matching source.
      const otherDraft = (await pool.query('SELECT draft FROM pdf_tasks WHERE id=$1', [mixed.taskId])).rows[0].draft;
      assert.equal(otherDraft.legalConclusions[0].sourceLocation.status, 'needs_review');
    });
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
