import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { INITIAL_VOCABULARY_SUPPLEMENTS } from './src/data/schemaCatalog';
import type { CaseDocument } from './src/types/gold';
import { buildAiSchemaCatalogPayload, mapAiExtractionToCaseDraft } from './src/utils/aiPreanalyze';
import { getActiveModelSummary } from './src/utils/aiSettings';
import { createPlaceholderCaseForTask } from './src/utils/taskCase';
import { mapExtendedRoleToWorkbenchRole } from './src/utils/systemEngine';
import {
  claimPdfTask, completePdfTask, failPdfTask, initPdfQueue, pool, readPdfArtifact, readRunEvidenceLines,
  renewPdfLease, savePdfArtifact, updatePdfProgress, type PdfLease,
} from './src/server/pdfQueue';
import { loadWorkerModelSettings, ModelRequestError, preanalyzePdf } from './src/server/modelService';
import { PermanentPdfError } from './src/server/readPdf';
import { loadRunPages } from './src/server/extractPages';
import { resolveLiabilitySource, type LiabilityLineSet } from './src/server/liabilityEvidence';

const state = Annotation.Root({ stage: Annotation<'queued' | 'text' | 'draft'>() });
const saver = new PostgresSaver(pool, undefined, { schema: 'pdf_graph' });

class LeaseLost extends Error {}
function requireLease(current: boolean) {
  if (!current) throw new LeaseLost('任务已由其他 worker 接手。');
}

function linkLiabilitySources(draft: CaseDocument, lineSet: LiabilityLineSet): CaseDocument {
  return {
    ...draft,
    legalConclusions: draft.legalConclusions.map(item => item.category === 'liability'
      ? { ...item, sourceLocation: resolveLiabilitySource(item, draft.entities, lineSet) }
      : item),
  };
}

async function processLease(lease: PdfLease) {
  const { task } = lease;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void renewPdfLease(lease).then((current) => {
      if (!current) controller.abort(new LeaseLost());
    }).catch(() => controller.abort(new LeaseLost()));
  }, 15_000);

  try {
    const graph = new StateGraph(state)
      .addNode('extract', async () => {
        requireLease(await updatePdfProgress(lease, 'parsing_pdf', '正在校验原件并抽取分页文本', 35));
        await loadRunPages(lease, controller.signal);
        return { stage: 'text' as const };
      })
      .addNode('analyze', async () => {
        if (await readPdfArtifact<CaseDocument>(lease, 'draft')) return { stage: 'draft' as const };
        // An in-flight first-stage run may resume directly at analyze with only the old text cache.
        const pages = await loadRunPages(lease, controller.signal);
        const lines = await readRunEvidenceLines(lease, pages.extractionVersion);
        const settings = await loadWorkerModelSettings(lease.modelConfigVersion);
        const summary = getActiveModelSummary(settings);
        if (!summary.isConfigured || (settings.provider === 'gemini' && (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'MY_GEMINI_API_KEY'))) {
          throw new PermanentPdfError(summary.issueHint || '请先在权限与设置配置有效的大模型，再启动解析。');
        }
        const modelLabel = `${summary.providerLabel} · ${summary.modelName}`;
        requireLease(await updatePdfProgress(lease, 'ai_extracting', '正在调用大模型生成案件草稿', 70, modelLabel));
        const supplements = INITIAL_VOCABULARY_SUPPLEMENTS;
        const payload = await preanalyzePdf({
          caseId: task.caseId, sourceFilename: task.filename, pageCount: pages.pageCount,
          schemaCatalog: buildAiSchemaCatalogPayload(supplements),
        }, settings, lines);
        const { nextCase } = mapAiExtractionToCaseDraft(
          createPlaceholderCaseForTask({ ...task, pageCount: pages.pageCount }),
          payload,
          { supplements, actorLabel: modelLabel, actorRole: mapExtendedRoleToWorkbenchRole(task.createdByRole) },
        );
        const draft = linkLiabilitySources(nextCase, { fileSha256: task.fileSha256, extractionVersion: pages.extractionVersion, lines });
        requireLease(await savePdfArtifact(lease, 'draft', draft));
        return { stage: 'draft' as const };
      })
      .addEdge(START, 'extract').addEdge('extract', 'analyze').addEdge('analyze', END)
      .compile({ checkpointer: saver });

    const config = { configurable: { thread_id: lease.runId }, signal: controller.signal, durability: 'sync' as const };
    const checkpoint = await graph.getState(config);
    if (!checkpoint.createdAt || checkpoint.next.length) {
      await graph.invoke(checkpoint.createdAt ? null : { stage: 'queued' }, config);
    }
    let draft = await readPdfArtifact<CaseDocument>(lease, 'draft');
    if (!draft) throw new Error('任务缺少可交付的案件草稿。');
    // A completed graph checkpoint can carry a draft from before liability locations were recorded.
    if (draft.legalConclusions.some(item => item.category === 'liability' && !item.sourceLocation)) {
      const { extractionVersion } = await loadRunPages(lease, controller.signal);
      const lines = await readRunEvidenceLines(lease, extractionVersion);
      draft = linkLiabilitySources(draft, { fileSha256: task.fileSha256, extractionVersion, lines });
    }
    requireLease(await completePdfTask(lease, draft));
  } catch (error) {
    if (controller.signal.aborted || error instanceof LeaseLost) return;
    const message = error instanceof Error ? error.message : '后台解析异常';
    const permanent = error instanceof PermanentPdfError || (error instanceof ModelRequestError && error.status === 400)
      || /HTTP (400|401|403|404)\b/.test(message);
    await failPdfTask(lease, message, !permanent);
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  const concurrency = Number(process.env.WORKER_MAX_CONCURRENT ?? 2);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('WORKER_MAX_CONCURRENT 需为正整数。');
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  await initPdfQueue();

  // PostgresSaver migrations span multiple connections/statements; serialize simultaneous starts.
  const migration = await pool.connect();
  try {
    await migration.query('BEGIN');
    await migration.query("SELECT pg_advisory_xact_lock(hashtext('traffic_pdf_graph_setup'))");
    await saver.setup();
    await migration.query('COMMIT');
  } catch (error) {
    await migration.query('ROLLBACK');
    throw error;
  } finally {
    migration.release();
  }

  console.info('[pdf-worker] 已就绪');
  while (!stopping) {
    try {
      const lease = await claimPdfTask(concurrency);
      if (lease) await processLease(lease);
      else await delay(1000);
    } catch (error) {
      console.error('[pdf-worker] 队列异常', error instanceof Error ? error.message : '未知错误');
      await delay(3000);
    }
  }
}

main().catch((error) => {
  console.error('[pdf-worker] 启动失败', error instanceof Error ? error.message : '未知错误');
  process.exitCode = 1;
}).finally(() => pool.end());
