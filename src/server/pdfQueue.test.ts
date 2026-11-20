import { canonicalLegalDraft } from '../utils/legalCatalog';
import { currentFieldOptions } from './catalog/codebook';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { accidentTitle } from '../utils/accidentTitle';
import { SEED_CASES } from '../data/seedCases';
import type { PdfPageEvidence } from './pageEvidence';

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
  const extractionVersion = 'inspector-test+paddle-test';
  const page: PdfPageEvidence = { pageNumber: 2, width: 600, height: 800, rotation: 90,
    source: 'ocr', reason: '扫描页', text: '王小\n明无责任', engine: 'paddle-test', renderWidth: 1200, renderHeight: 1600,
    lines: [
      { text: '王小', bbox: [0.1,0.1,0.6,0.15], rawBox: [120,160,720,240], confidence: 0.989 },
      { text: '明无责任', bbox: [0.1,0.2,0.6,0.25], rawBox: [120,320,720,400], confidence: 0.977 },
    ] };
  await t.test('页与行原子保存，按来源文件与版本复用不可变的原始页', async () => {
    const invalid: PdfPageEvidence = { ...page, lines: [{ ...page.lines[0], bbox: [1,0,0,1] }] };
    await assert.rejects(queue.savePageEvidence(first, extractionVersion, invalid), /check constraint/);
    assert.equal(await queue.readCachedPageText(first, extractionVersion, 2), null);
    assert.equal(await queue.savePageEvidence(first, extractionVersion, page), page.text);
    assert.equal(await queue.savePageEvidence(first, extractionVersion, { ...page, text: '后到的结果' }), page.text);
    assert.equal(await queue.readCachedPageText(first, 'another-engine', 2), null);
    assert.equal(await queue.readCachedPageText(first, extractionVersion, 1), null);
    const stored = await queue.pool.query(`SELECT p.page_number,l.line_number,l.line_text,l.bbox,l.raw_box,l.confidence
      FROM pdf_pages p JOIN pdf_page_lines l ON l.page_id=p.id WHERE p.created_by_run=$1 ORDER BY l.line_number`, [first.runId]);
    assert.deepEqual(stored.rows.map(row => [row.page_number,row.line_number,row.line_text,row.bbox,row.raw_box,row.confidence]),
      page.lines.map((line, index) => [2,index+1,line.text,line.bbox,line.rawBox,line.confidence]));
    const blank: PdfPageEvidence = { ...page, pageNumber: 1, source: 'blank', text: '', lines: [] };
    assert.equal(await queue.savePageEvidence(first, extractionVersion, blank), '');
    assert.equal(await queue.readCachedPageText(first, extractionVersion, 1), '');
  });
  await t.test('OCR 并发槽支持取消等待，并在识别失败时释放', async () => {
    const signal = new AbortController().signal;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstRequest = queue.withOcrSlot(signal, async () => { entered(); await gate; });
    try {
      await ready;
      await assert.rejects(queue.withOcrSlot(AbortSignal.timeout(50), async () => assert.fail('不应取得忙碌槽')), {name:'AbortError'});
    } finally {
      release();
      await firstRequest;
    }
    await assert.rejects(queue.withOcrSlot(signal, async () => { throw new Error('OCR failed'); }), /OCR failed/);
    assert.equal(await queue.withOcrSlot(signal, async () => 'ok'), 'ok');
  });
  await queue.pool.query("UPDATE pdf_tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [staged.taskId]);
  const recovered = (await queue.claimPdfTask())!;
  assert.equal(recovered.runId, first.runId);
  assert.equal(recovered.generation, first.generation + 1);
  assert.equal(await queue.readPdfArtifact(recovered, 'text'), '保存的文本');
  assert.equal(await queue.savePageEvidence(first, extractionVersion, { ...page, pageNumber: 3 }), null);
  assert.equal(await queue.readCachedPageText(recovered, extractionVersion, 2), page.text);
  assert.equal(await queue.getPdfPageTexts(staged.taskId), null);
  const migrated = { extractionVersion, pageTexts: { 1: '', 2: page.text } };
  assert.equal(await queue.savePdfArtifact(first, 'text', migrated), false);
  assert.equal(await queue.savePdfArtifact(recovered, 'text', migrated), true);
  assert.equal(await queue.savePdfArtifact(recovered, 'text', { extractionVersion: 'unexpected' }), true);
  assert.deepEqual(await queue.readPdfArtifact(recovered, 'text'), migrated);
  assert.deepEqual(await queue.getPdfPageTexts(staged.taskId), { fileSha256: staged.fileSha256, pageTexts: migrated.pageTexts });
  assert.equal(await queue.getPdfPageTexts(v2.task.taskId), null);
  const lineSet = await queue.getPdfSourceLines(staged.taskId);
  assert.equal(lineSet?.extractionVersion, extractionVersion);
  assert.equal(lineSet?.fileSha256, staged.fileSha256);
  assert.deepEqual(lineSet.lines.map(l => [l.page, l.lineNumber, l.text, l.bbox]),
    page.lines.map((l, i) => [2, i + 1, l.text, l.bbox]));
  assert.deepEqual(lineSet.lines, await queue.readRunEvidenceLines(recovered, extractionVersion));
  assert.deepEqual(await queue.readRunEvidenceLines(recovered, 'wrong-version'), []);
  assert.equal(await queue.getPdfSourceLines(v2.task.taskId), null);
  assert.equal(await queue.renewPdfLease(first), false);
  assert.equal(await queue.savePdfArtifact(first, 'draft', {}), false);
  assert.equal(await queue.failPdfTask(first, '旧 worker', false), false);

  const draft = { ...SEED_CASES[0], caseId: staged.caseId };
  assert.equal(await queue.completePdfTask(first, draft), false);
  assert.equal(await queue.renewPdfLease(recovered), true);
  assert.equal(await queue.updatePdfProgress(recovered, 'ai_extracting', '模型读取中', 60, 'test'), true);
  assert.equal(await queue.completePdfTask(recovered, draft), true);
  assert.deepEqual(await queue.getPdfDraft(staged.taskId), JSON.parse(JSON.stringify(canonicalLegalDraft(draft, currentFieldOptions()))));
  await t.test('完成后列表即可读取事故标题，旧任务从已存草稿补齐', async () => {
    const title = accidentTitle(draft);
    const listTitle = async () => (await queue.listPdfTasks()).tasks.find(task => task.taskId === staged.taskId)?.title;
    assert.equal(await listTitle(), title);
    await queue.pool.query("UPDATE pdf_tasks SET task=task-'title' WHERE id=$1", [staged.taskId]);
    await queue.initPdfQueue();
    assert.equal(await listTitle(), title);
  });
  await t.test('已有草稿按本次解析的行补定位，保留人工确认和历史快照', async () => {
    const item = { ...draft.legalConclusions.find(l => l.category === 'liability')!,
      subjectId: 'P01', eventId: '', conclusionLabel: '无责任', rawText: '王小明无责任',
      reviewStatus: 'checked' as const, evidences: [{ id: 'EV-1', page: 2, quote: '王小明无责任' }] };
    const legacy: typeof draft = { ...draft, fileSha256: staged.fileSha256, entities: [{ id:'P01', kind:'P', label:'王小明' }],
      legalConclusions: [item] };
    await queue.pool.query('UPDATE pdf_tasks SET draft=$2 WHERE id=$1', [staged.taskId, legacy]);
    const served = (await queue.getPdfDraft(staged.taskId))!.legalConclusions[0];
    assert.equal(served.reviewStatus, 'checked');
    assert.equal(served.sourceLocation?.status, 'verified');
    if (served.sourceLocation?.status === 'verified')
      assert.deepEqual(served.sourceLocation.lines.map(l => l.lineNumber), [1, 2]);
    const stored = await queue.pool.query('SELECT draft FROM pdf_tasks WHERE id=$1', [staged.taskId]);
    assert.deepEqual(stored.rows[0].draft, JSON.parse(JSON.stringify(canonicalLegalDraft(legacy, currentFieldOptions()))));
  });
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
