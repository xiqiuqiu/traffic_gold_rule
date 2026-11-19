import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { SEED_CASES } from '../data/seedCases';

const testDatabaseUrl = process.env.PDF_QUEUE_TEST_DATABASE_URL;

test('原件去重、待命、领取与故障恢复共用 PostgreSQL 的任务状态', { skip: !testDatabaseUrl }, async (t) => {
  const schema = 'pdf_queue_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: testDatabaseUrl });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-queue-test-'));
  await admin.query('CREATE SCHEMA ' + schema);
  t.after(async () => {
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const url = new URL(testDatabaseUrl!);
  url.searchParams.set('options', '-c search_path=' + schema);
  const previousDatabase = process.env.DATABASE_URL;
  const previousDirectory = process.env.PDF_STORAGE_DIR;
  t.after(() => {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousDirectory === undefined) delete process.env.PDF_STORAGE_DIR;
    else process.env.PDF_STORAGE_DIR = previousDirectory;
  });
  process.env.DATABASE_URL = url.href;
  process.env.PDF_STORAGE_DIR = directory;
  const queue = await import('./pdfQueue');
  t.after(() => queue.pool.end());
  await Promise.all([queue.initPdfQueue(), queue.initPdfQueue()]);
  const options = { filename: '事故.pdf', source: 'scheduled_batch', startImmediately: false,
    actorName: '调度器', actorRole: 'admin', filePath: '/scan/事故.pdf', modelConfigVersion: 'v1' } as const;
  const bytes = Buffer.from('%PDF-1.7\nfixture A\n%%EOF\n');

  await assert.rejects(queue.enqueuePdf(Buffer.from('partial file'), options), /PDF/);
  await assert.rejects(queue.enqueuePdf(Buffer.alloc(queue.MAX_PDF_BYTES + 1), options), /64 MiB/);
  const intake = await Promise.all(Array.from({ length: 6 }, () => queue.enqueuePdf(bytes, options)));
  assert.equal(intake.filter((row) => row.created).length, 1);
  const staged = intake[0].task;
  assert.equal(staged.status, 'idle');
  assert.deepEqual(await fs.readFile((await queue.getOriginalPath(staged.fileSha256.slice(7)))!), bytes);
  assert.equal(await queue.claimPdfTask(), null);
  assert.equal((await queue.enqueuePdf(bytes, { ...options, filename: '别名.pdf', filePath: '/scan/别名.pdf' })).created, false);
  const duplicate = await queue.enqueuePdf(bytes, { ...options, source: 'manual_upload', startImmediately: true, filePath: undefined });
  assert.equal(duplicate.task.taskId, staged.taskId);
  assert.equal(duplicate.task.status, 'queued');
  const v2 = await queue.enqueuePdf(Buffer.from('%PDF-1.7\nfixture B\n%%EOF'), options);
  assert.equal(v2.created, true);
  assert.notEqual(staged.fileSha256, v2.task.fileSha256);
  assert.equal((await queue.pool.query('SELECT count(*)::int AS n FROM pdf_sources')).rows[0].n, 4);

  const leases = (await Promise.all([queue.claimPdfTask(), queue.claimPdfTask()])).filter((lease) => lease !== null);
  assert.equal(leases.length, 1);
  const first = leases[0]!;
  assert.equal(first.modelConfigVersion, 'v1');
  assert.equal(await queue.savePdfArtifact(first, 'text', '保存的文本'), true);
  await queue.pool.query("UPDATE pdf_tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [staged.taskId]);
  const recovered = (await queue.claimPdfTask())!;
  assert.equal(recovered.runId, first.runId);
  assert.equal(recovered.generation, first.generation + 1);
  assert.equal(await queue.readPdfArtifact(recovered, 'text'), '保存的文本');
  assert.equal(await queue.renewPdfLease(first), false);
  assert.equal(await queue.savePdfArtifact(first, 'draft', {}), false);
  assert.equal(await queue.failPdfTask(first, '旧 worker', false), false);

  const draft = { ...SEED_CASES[0], caseId: staged.caseId };
  assert.equal(await queue.completePdfTask(first, draft), false);
  assert.equal(await queue.renewPdfLease(recovered), true);
  assert.equal(await queue.updatePdfProgress(recovered, 'ai_extracting', '模型读取中', 60, 'test'), true);
  assert.equal(await queue.completePdfTask(recovered, draft), true);
  assert.deepEqual(await queue.getPdfDraft(staged.taskId), JSON.parse(JSON.stringify(draft)));
  assert.equal((await queue.startPdfTask(staged.taskId))?.status, 'pending_review');

  await queue.startPdfTask(v2.task.taskId);
  const failed = (await queue.claimPdfTask())!;
  assert.equal(await queue.failPdfTask(failed, '服务超时', true), true);
  assert.equal(await queue.claimPdfTask(), null);
  await queue.pool.query('UPDATE pdf_tasks SET available_at=now() WHERE id=$1', [failed.task.taskId]);
  const retried = (await queue.claimPdfTask())!;
  assert.equal(failed.runId, retried.runId);
  assert.equal(await queue.failPdfTask(retried, '材料无效', false), true);
  await queue.startPdfTask(failed.task.taskId, 'v2');
  const explicit = (await queue.claimPdfTask())!;
  assert.notEqual(explicit.runId, failed.runId);
  assert.equal(explicit.modelConfigVersion, 'v2');
  await assert.rejects(queue.deletePdfTask(explicit.task.taskId), /处理中/);
  assert.equal(await queue.failPdfTask(explicit, '停止', false), true);
  assert.equal(await queue.deletePdfTask(explicit.task.taskId), true);
  assert.equal(await queue.renewPdfLease(explicit), false);

  const forced = { ...options, forceRequeue: true, batchId: 'batch-2', startImmediately: true };
  const fresh = await queue.enqueuePdf(bytes, forced);
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.task.caseId, staged.caseId);
  assert.equal((await queue.enqueuePdf(bytes, forced)).created, false);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lease = (await queue.claimPdfTask())!;
    assert.equal(lease.task.taskId, fresh.task.taskId);
    await queue.pool.query("UPDATE pdf_tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.task.taskId]);
  }
  assert.equal(await queue.claimPdfTask(), null);
  assert.equal((await queue.getPdfTask(fresh.task.taskId))?.status, 'failed');

  // An exact timestamp tie exercises the second sort key; the cursor outlives deletion.
  await queue.pool.query("UPDATE pdf_tasks SET created_at='2026-11-20 01:02:03.456789+00'");
  const all = await queue.listPdfTasks();
  const head = await queue.listPdfTasks({ limit: 1 });
  assert.equal(head.tasks[0].taskId, all.tasks[0].taskId);
  await queue.deletePdfTask(head.tasks[0].taskId);
  const rest = await queue.listPdfTasks({ before: head.nextCursor!, limit: 1 });
  assert.deepEqual(rest.tasks, all.tasks.slice(1));
  assert.equal(rest.nextCursor, null);
  await assert.rejects(queue.listPdfTasks({ before: 'bad' }), RangeError);
  await assert.rejects(queue.listPdfTasks({ limit: 201 }), RangeError);

  await t.test('模型版本锁定，迁移幂等，接口更换后不复用原令牌', async () => {
    const settings = await import('./modelSettings');
    await settings.initModelSettings();
    const input = { provider: 'openai_compatible', openai: {
      baseUrl: 'http://127.0.0.1:3111/v1', apiKey: 'fixture-token', selectedModel: 'a', availableModels: [],
    } };
    const first = await settings.saveModelSettings(input, true);
    assert.equal(first.hasApiKey, true);
    assert.equal(first.settings?.openai.apiKey, '');
    const version = await settings.getModelConfigVersion();
    const duplicate = await settings.saveModelSettings({ ...input, openai: { ...input.openai, selectedModel: 'b' } }, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.settings?.openai.selectedModel, 'a');
    await settings.saveModelSettings({ ...input, openai: { ...input.openai, apiKey: '', selectedModel: 'b' } }, false);
    assert.equal((await settings.loadWorkerModelSettings()).openai.apiKey, 'fixture-token');
    await settings.saveModelSettings({ ...input, openai: { ...input.openai, baseUrl: 'http://127.0.0.1:3222/v1', apiKey: '' } }, false);
    assert.equal((await settings.getPublicSettings()).hasApiKey, false);
    assert.equal((await settings.loadWorkerModelSettings(version)).openai.selectedModel, 'a');
  });

  await t.test('定时扫盘和上传共享原件，坏文件不阻断整批', async () => {
    const previousStateDir = process.env.SYSTEM_DATA_DIR;
    process.env.SYSTEM_DATA_DIR = path.join(directory, 'state');
    try {
      const store = await import('./systemStore');
      const settings = await import('./modelSettings');
      await settings.initModelSettings();
      const inbox = path.join(directory, 'inbox');
      await fs.mkdir(inbox);
      const doc = Buffer.from('%PDF-1.7\nschedule test\n%%EOF');
      await fs.writeFile(path.join(inbox, 'A.pdf'), doc);
      await fs.writeFile(path.join(inbox, 'B.pdf'), 'incomplete');
      const initial = await store.loadSystemState();
      await store.saveSystemState({ ...initial, scheduleConfig: { ...initial.scheduleConfig,
        enabled: true, autoRunAi: false, scanDirectory: inbox, dailyTime: '00:00' } });
      await store.initScanSchedule();
      const day = new Date(2026, 10, 19, 10);
      await Promise.all([store.runDueScan(day), store.runDueScan(day)]);
      assert.equal((await queue.pool.query('SELECT count(*)::int n FROM pdf_schedule_runs')).rows[0].n, 1);
      const scan = await store.scanServerDirectoryForTasks();
      assert.equal(scan.skippedExistingCount, 1);
      assert.equal(scan.fileErrors[0].filename, 'B.pdf');
      const upload = await queue.enqueuePdf(doc, { ...options, source: 'manual_upload', filename: 'other.pdf' });
      assert.equal(upload.created, false);
      assert.equal(upload.task.status, 'idle');
      assert.equal(upload.task.source, 'scheduled_batch');
      await fs.writeFile(path.join(inbox, 'A.pdf'), Buffer.from('%PDF-1.7\nupdated scan\n%%EOF'));
      assert.equal((await store.scanServerDirectoryForTasks()).createdTasks.length, 1);
    } finally {
      if (previousStateDir === undefined) delete process.env.SYSTEM_DATA_DIR;
      else process.env.SYSTEM_DATA_DIR = previousStateDir;
    }
  });
});
