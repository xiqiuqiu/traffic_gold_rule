import 'dotenv/config';
import { catalogRouter } from './src/server/catalog/routes';
import fs from 'node:fs/promises';
import express from 'express';
import path from 'node:path';
import { PdfInputError, initPdfQueue, listPdfTasks, startPdfTask, deletePdfTask, enqueuePdf, recentPdfAuditEvents, getOriginalPath, getPdfTask, getPdfDraft, getPdfPageTexts, getPdfSourceLines, MAX_PDF_BYTES } from './src/server/pdfQueue';
import { EXTENDED_ROLE_META } from './src/utils/systemEngine';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { normalizeOpenAiBaseUrl, validateOpenAiBaseUrl } from './src/utils/aiSettings';
import { isTimeoutError } from './src/utils/aiResponseParser';
import { ModelRequestError, preanalyzePdf, probeOpenAiModels } from './src/server/modelService';
import { initModelSettings, loadWorkerModelSettings, getModelConfigVersion, getPublicSettings, saveModelSettings } from './src/server/modelSettings';
import {
  appendSystemAuditEvent,
  loadSystemState,
  resolveSafeScanDirectory, readScanFile, runDueScan, initScanSchedule,
  saveSystemState,
  scanServerDirectoryForTasks,
} from './src/server/systemStore';
import {
  AnalysisTask,
  BatchScheduleConfig,
  ExtendedRole,
  RolePermissionMatrix,
  SystemAuditEvent,
} from './src/types/system';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

async function mergedAuditEvents(legacy: SystemAuditEvent[]) {
  return [...await recentPdfAuditEvents(), ...legacy]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 500);
}

async function startServer() {
  await initPdfQueue();
  await initModelSettings();
  await initScanSchedule();
  const app = express();
  const httpServer = createServer(app);
  app.use(express.json({ limit: '30mb' }));

  app.use('/api', catalogRouter());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/system/bootstrap', async (_req, res) => {
    try {
      const state = await loadSystemState();
      const page = await listPdfTasks();
      res.json({ ...state, auditLogs: await mergedAuditEvents(state.auditLogs), nextCursor: page.nextCursor, tasks: [...page.tasks, ...state.tasks] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '加载系统状态失败' });
    }
  });

  app.put('/api/system/schedule', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        scheduleConfig?: Partial<BatchScheduleConfig>;
        actorName?: string;
        actorRole?: ExtendedRole;
      };
      const state = await loadSystemState();
      const nextSchedule: BatchScheduleConfig = {
        ...state.scheduleConfig,
        ...(body.scheduleConfig || {}),
        scanDirectory:
          (body.scheduleConfig?.scanDirectory ?? state.scheduleConfig.scanDirectory).trim() ||
          './public/assets/aistudio',
        filePattern:
          (body.scheduleConfig?.filePattern ?? state.scheduleConfig.filePattern).trim() || '*.pdf',
      };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(nextSchedule.dailyTime) ||
          typeof nextSchedule.enabled !== 'boolean' || typeof nextSchedule.autoRunAi !== 'boolean') {
        res.status(400).json({ error: '调度时间须为 HH:MM，并指定是否启用及自动执行。' });
        return;
      }
      const auditEvent: SystemAuditEvent = {
        id: `AUD-${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        category: 'schedule',
        actorRole: body.actorRole || 'admin',
        actorName: body.actorName || '系统管理员',
        action: '更新定时批量扫描配置',
        targetRef: nextSchedule.scanDirectory,
        detail: `每日 ${nextSchedule.dailyTime} · ${nextSchedule.enabled ? '已启用' : '已暂停'} · ${
          nextSchedule.autoRunAi ? '自动执行大模型提取' : '仅入库待命'
        }`,
      };
      const saved = await saveSystemState({
        ...state,
        scheduleConfig: nextSchedule,
        auditLogs: [auditEvent, ...state.auditLogs].slice(0, 500),
      });
      res.json({ scheduleConfig: saved.scheduleConfig, auditEvent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存调度配置失败' });
    }
  });

  app.post('/api/system/schedule/scan', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        directory?: string;
        filePattern?: string;
        autoRunAi?: boolean;
        forceRequeue?: boolean;
        actorName?: string;
      };
      const result = await scanServerDirectoryForTasks({
        directory: body.directory,
        filePattern: body.filePattern,
        autoRunAi: body.autoRunAi,
        forceRequeue: body.forceRequeue,
        actorName: body.actorName || '系统管理员',
      });
      const updated = await loadSystemState();
      const page = await listPdfTasks();
      res.json({
        ...result,
        createdTaskCount: result.createdTasks.length,
        createdTasks: result.createdTasks.slice(0, 100),
        nextCursor: page.nextCursor,
        scheduleConfig: updated.scheduleConfig,
        tasks: [...page.tasks, ...updated.tasks],
        auditLogs: await mergedAuditEvents(updated.auditLogs),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '扫描服务器目录失败' });
    }
  });

  app.get('/api/system/pdf', async (req, res) => {
    try {
      const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath) {
        res.status(400).json({ error: '缺少文件 path 参数' });
        return;
      }
      const state = await loadSystemState();
      const allowedDirs = [
        resolveSafeScanDirectory(state.scheduleConfig.scanDirectory),
        resolveSafeScanDirectory('./public/assets/aistudio'),
      ];
      const targetPath = await fs.realpath(path.resolve(rawPath));
      const isAllowed = allowedDirs.some(
        (dir) => targetPath === dir || targetPath.startsWith(dir + path.sep),
      );
      if (!isAllowed || !/\.pdf$/i.test(targetPath)) {
        res.status(403).json({ error: '仅允许读取已配置扫描目录内的 PDF 文件' });
        return;
      }
      const buf = await fs.readFile(targetPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(buf);
    } catch {
      res.status(404).json({ error: '未找到对应的服务器 PDF 文件' });
    }
  });

  app.get('/api/system/tasks', async (req, res) => {
    try {
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const page = await listPdfTasks({ before });
      const legacy = before ? [] : (await loadSystemState()).tasks;
      res.json({ tasks: [...page.tasks, ...legacy], nextCursor: page.nextCursor });
    } catch (err) {
      res.status(err instanceof RangeError ? 400 : 503).json({ error: '无法查询任务队列' });
    }
  });

  app.get('/api/system/tasks/:taskId', async (req, res) => {
    try {
      const task = await getPdfTask(req.params.taskId);
      if (!task) { res.status(404).json({ error: '未找到任务' }); return; }
      res.json({ task });
    } catch { res.status(503).json({ error: '无法读取任务' }); }
  });

  app.post('/api/system/tasks/upload', express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES }), async (req, res) => {
    const { filename, startImmediately, actorName, actorRole } = req.query;
    if (!Buffer.isBuffer(req.body) || typeof filename !== 'string' || filename.length > 255 ||
        !['true', 'false'].includes(String(startImmediately)) || typeof actorRole !== 'string' ||
        !Object.hasOwn(EXTENDED_ROLE_META, actorRole) || typeof actorName !== 'string' || !actorName.trim()) {
      res.status(400).json({ error: '缺少有效 PDF、操作者或执行方式' });
      return;
    }
    try {
      const result = await enqueuePdf(req.body, {
        filename, source: 'manual_upload', startImmediately: startImmediately === 'true',
        actorName, actorRole: actorRole as ExtendedRole, modelConfigVersion: await getModelConfigVersion(),
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      res.status(err instanceof PdfInputError ? 400 : 503).json({ error: err instanceof Error ? err.message : '原件入库失败' });
    }
  });

  app.get('/api/system/originals/:hash', async (req, res) => {
    try {
      const original = await getOriginalPath(req.params.hash);
      if (!original) { res.status(404).end(); return; }
      res.set('Cache-Control', 'private, no-cache').type('application/pdf').sendFile(original, { dotfiles: 'allow' });
    } catch {
      res.status(503).json({ error: '无法读取原件' });
    }
  });

  app.post('/api/system/tasks/:taskId/start', async (req, res) => {
    try {
      const id = req.params.taskId;
      const version = await getModelConfigVersion();
      if (id.startsWith('PDF-')) {
        const task = await startPdfTask(id, version);
        if (!task) { res.status(404).json({ error: '未找到任务' }); return; }
        res.json({ task });
        return;
      }
      const state = await loadSystemState();
      const old = state.tasks.find(t => t.taskId === id);
      if (!old) { res.status(404).json({ error: '未找到任务' }); return; }
      if (!old.filePath) { res.status(409).json({ error: '此历史任务缺少持久化原件，请重新上传 PDF。' }); return; }
      const source = await fs.realpath(old.filePath);
      const dirs = [resolveSafeScanDirectory(state.scheduleConfig.scanDirectory), path.resolve('public/assets/aistudio')];
      if (!dirs.some(d => source.startsWith(d + path.sep)) || !/\.pdf$/i.test(source)) {
        res.status(409).json({ error: '历史文件已不在扫描目录内，请重新上传 PDF。' }); return;
      }
      const { task } = await enqueuePdf(await readScanFile(source), {
        source: old.source === 'manual_upload' ? 'manual_upload' : 'scheduled_batch',
        filename: old.filename, filePath: source, actorRole: old.createdByRole,
        actorName: old.createdByName, startImmediately: true, modelConfigVersion: version,
      });
      res.json({ task: await startPdfTask(task.taskId, version) });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : '请重新上传 PDF 原件。' });
    }
  });

  app.get('/api/system/tasks/:taskId/draft', async (req, res) => {
    try {
      const draft = await getPdfDraft(req.params.taskId);
      if (!draft) { res.status(404).json({ error: '草稿尚不可用' }); return; }
      res.json({ draft });
    } catch { res.status(503).json({ error: '无法读取草稿' }); }
  });

  app.get('/api/system/tasks/:taskId/page-texts', async (req, res) => {
    try {
      const source = await getPdfPageTexts(req.params.taskId);
      if (!source) { res.status(404).json({ error: '该次解析没有保存逐页文本。' }); return; }
      res.json(source);
    } catch { res.status(503).json({ error: '无法读取该次解析的逐页文本。' }); }
  });

  app.get('/api/system/tasks/:taskId/source-lines', async (req, res) => {
    try {
      const source = await getPdfSourceLines(req.params.taskId);
      if (!source) { res.status(404).json({ error: '该次解析没有保存原文行。' }); return; }
      res.json(source);
    } catch { res.status(503).json({ error: '无法读取该次解析的原文行。' }); }
  });

  app.patch('/api/system/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const patch = (req.body || {}) as Partial<AnalysisTask>;
      const state = await loadSystemState();
      const idx = state.tasks.findIndex((t) => t.taskId === taskId);
      if (idx === -1) {
        res.status(404).json({ error: '未找到指定任务' });
        return;
      }
      const updatedTask: AnalysisTask = {
        ...state.tasks[idx],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const nextTasks = state.tasks.map((t, i) => (i === idx ? updatedTask : t));
      await saveSystemState({ ...state, tasks: nextTasks });
      res.json({ task: updatedTask });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新任务状态失败' });
    }
  });

  app.delete('/api/system/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      if (taskId.startsWith('PDF-')) {
        res.json({ ok: await deletePdfTask(taskId) });
        return;
      }
      const state = await loadSystemState();
      const existing = state.tasks.find((t) => t.taskId === taskId);
      const nextTasks = state.tasks.filter((t) => t.taskId !== taskId);
      if (existing) {
        await saveSystemState({ ...state, tasks: nextTasks });
        await appendSystemAuditEvent({
          category: 'task_pipeline',
          actorRole: 'admin',
          actorName: typeof req.query.actorName === 'string' ? req.query.actorName : '操作员',
          action: '移除分析任务记录',
          targetRef: existing.caseId,
          accidentBizId: existing.accidentBizId || undefined,
          detail: `删除任务 ${existing.taskId}（${existing.filename}）`,
        });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : '删除任务失败' });
    }
  });

  app.post('/api/system/audit', async (req, res) => {
    try {
      const body = (req.body || {}) as Partial<SystemAuditEvent>;
      if (!body.action || !body.targetRef) {
        res.status(400).json({ error: '缺少 action 或 targetRef' });
        return;
      }
      const created = await appendSystemAuditEvent({
        category: body.category || 'annotation',
        actorRole: body.actorRole || 'annotator',
        actorName: body.actorName || '系统用户',
        action: body.action,
        targetRef: body.targetRef,
        accidentBizId: body.accidentBizId,
        detail: body.detail || '',
        beforeValue: body.beforeValue,
        afterValue: body.afterValue,
      });
      res.json({ auditEvent: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '写入审计日志失败' });
    }
  });

  app.put('/api/system/permissions', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        rolePermissions?: RolePermissionMatrix;
        actorName?: string;
        actorRole?: ExtendedRole;
        changeSummary?: string;
      };
      if (!body.rolePermissions) {
        res.status(400).json({ error: '缺少 rolePermissions 参数' });
        return;
      }
      const state = await loadSystemState();
      const auditEvent: SystemAuditEvent = {
        id: `AUD-${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        category: 'permission',
        actorRole: body.actorRole || 'admin',
        actorName: body.actorName || '系统管理员',
        action: '更新角色权限矩阵',
        targetRef: 'RBAC-MATRIX',
        detail: body.changeSummary || '调整系统角色功能操作权限矩阵配置',
      };
      const saved = await saveSystemState({
        ...state,
        rolePermissions: body.rolePermissions,
        auditLogs: [auditEvent, ...state.auditLogs].slice(0, 500),
      });
      res.json({ rolePermissions: saved.rolePermissions, auditEvent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新权限配置失败' });
    }
  });

  app.get('/api/ai/settings', async (_req, res) => {
    try { res.json(await getPublicSettings()); }
    catch { res.status(503).json({ error: '无法加载服务端模型设置' }); }
  });
  app.put('/api/ai/settings', async (req, res) => {
    try {
      const { rolePermissions } = await loadSystemState();
      if (!rolePermissions[req.body?.actorRole as ExtendedRole]?.['system:audit_permissions']) {
        res.status(403).json({ error: '当前身份没有管理模型配置的权限' }); return;
      }
      res.json(await saveModelSettings(req.body?.settings, req.body?.initializeOnly === true));
    }
    catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '无法保存模型设置' });
    }
  });

  app.post('/api/ai/models', async (req, res) => {
    try {
      const body = (req.body || {}) as { baseUrl?: string; apiKey?: string };
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';

      const urlError = validateOpenAiBaseUrl(baseUrl);
      if (urlError) {
        res.status(400).json({ error: urlError });
        return;
      }

      const saved = await loadWorkerModelSettings();
      const role = req.body?.actorRole as ExtendedRole | undefined;
      const allowed = role && (await loadSystemState()).rolePermissions[role]?.['system:audit_permissions'];
      if (role && !allowed) { res.status(403).json({ error: '当前身份没有探测模型的权限' }); return; }
      const sameEndpoint = allowed && normalizeOpenAiBaseUrl(baseUrl) === saved.openai.baseUrl;
      const result = await probeOpenAiModels(baseUrl, apiKey || (sameEndpoint ? saved.openai.apiKey : ''));
      if (result.models.length === 0) {
        res.status(404).json({
          error: '接口已连通，但未返回任何可用模型列表，可检查 Token 权限或手动指定模型名称。',
          resolvedBaseUrl: result.resolvedBaseUrl,
        });
        return;
      }

      res.json(result);
    } catch (err) {
      if (isTimeoutError(err)) {
        res.status(504).json({
          error: '探测模型列表超时，请检查目标接口地址是否可达或网络是否连通。',
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({
        error: msg.includes('fetch failed') || msg.includes('ECONNREFUSED')
          ? '无法连接目标 API 地址，请检查地址是否正确以及服务是否可访问。'
          : msg,
      });
    }
  });

  app.post('/api/ai/preanalyze', async (req, res) => {
    try {
      const body = req.body || {};
      const settings = await loadWorkerModelSettings();
      // Older workbench clients can send an explicit provider for a single request.
      const override = body.providerConfig;
      if (override) {
        settings.provider = override.provider === 'openai_compatible' ? 'openai_compatible' : 'gemini';
        settings.openai = { ...settings.openai, baseUrl: override.baseUrl || '', apiKey: override.apiKey || '', selectedModel: override.model || '' };
      }
      res.json(await preanalyzePdf(body, settings));
    } catch (err) {
      if (err instanceof ModelRequestError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (isTimeoutError(err)) {
        console.warn('[/api/ai/preanalyze] upstream timeout');
        res.status(504).json({
          error: '模型响应超时，请稍后重试；若文书较长或选用了慢速推理模型，建议在“模型设置”中切换响应更快的模型。',
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[/api/ai/preanalyze] error:', msg);
      if (/403|PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(msg)) {
        res.status(403).json({
          error: 'GEMINI_API_KEY 无效或权限不足，请在 Settings > Secrets 中检查配置，或在“模型设置”中使用 OpenAI 兼容接口。',
          details: msg,
        });
        return;
      }
      if (/429|RESOURCE_EXHAUSTED/i.test(msg)) {
        res.status(429).json({
          error: 'API 调用配额暂满，请稍后再试或检查配额设置。',
          details: msg,
        });
        return;
      }
      res.status(500).json({
        error: `AI 预分析失败：${msg}`,
      });
    }
  });

  const handleBodyError: express.ErrorRequestHandler = (error, _req, res, next) => {
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: '请求内容超过大小限制，单份 PDF 原件上限为 64 MiB。' });
      return;
    }
    next(error);
  };
  app.use(handleBodyError);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, ws: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const tick = () => runDueScan().catch(err => console.error('[schedule]', err.message));
  const scheduleTimer = setInterval(tick, 60_000);
  void tick();
  scheduleTimer.unref?.();

  httpServer.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`Gold workbench server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
