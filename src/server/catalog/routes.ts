import express from 'express';
import { loadSystemState, appendSystemAuditEvent } from '../systemStore';
import type { UserIdentityProfile } from '../../types/system';
import type { PromoteTarget, ReviewStatus } from '../../types/catalog';
import { getObservationTasks } from './workbench';
import {
  currentFieldOptions,
  addAlias,
  addCode,
  CodebookError,
  createExtensionTag,
  expandQuery,
  listEnumFields,
  listExtensionTags,
  listGroups,
  listReadings,
  pageCodes,
  putQueryGroup,
  removeAlias,
  removeCode,
  removeExtensionTag,
  removeQueryGroup,
  renameCode,
  updateExtensionTag,
} from './codebook';
import { listObservations, promoteObservation, reviewObservation } from './tagLedger';

function codebookFailure(res: express.Response, err: unknown): void {
  if (err instanceof CodebookError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(err);
  const message = err instanceof Error && err.message ? err.message : '标签库操作失败';
  res.status(500).json({ error: message });
}

function bodyText(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function queryText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bodyStrings(body: unknown, key: string): string[] {
  if (!body || typeof body !== 'object') return [];
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function bodyWeight(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'weight')) return undefined;
  const value = (body as Record<string, unknown>).weight;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

function bodyTarget(body: unknown): PromoteTarget {
  if (!body || typeof body !== 'object') throw new CodebookError('归入目标无效');
  const target = (body as Record<string, unknown>).target;
  if (!target || typeof target !== 'object') throw new CodebookError('归入目标无效');
  const row = target as Record<string, unknown>;
  const dmz = typeof row.dmz === 'string' ? row.dmz : '';
  const label = typeof row.label === 'string' ? row.label : '';
  const extCode = typeof row.extCode === 'string' ? row.extCode : '';
  if (row.kind === 'alias') return { kind: 'alias', dmz };
  if (row.kind === 'link_standard') return { kind: 'link_standard', dmz };
  if (row.kind === 'new_extension') return { kind: 'new_extension', label };
  if (row.kind === 'existing_extension') return { kind: 'existing_extension', extCode };
  throw new CodebookError('归入目标无效');
}

async function recordCodebookUpdate(actor: UserIdentityProfile, summary: string) {
  await appendSystemAuditEvent({
    category: 'review_adjudicate', action: '维护标签库', detail: summary,
    actorName: actor.name, actorRole: actor.role, targetRef: '标签库',
  });
}

export function catalogRouter() {
  const app = express.Router();
  app.use(['/codebook', '/codebook-expand', '/tag-observations', '/extension-tags', '/catalog-options'], async (req, res, next) => {
    try {
      const state = await loadSystemState();
      const actor = state.identities.find(user => user.id === req.header('x-user-id'));
      const role = actor && state.rolePermissions[actor.role];
      if (!actor || !role?.['task:view'] ||
          (req.method !== 'GET' && !role['case:adjudicate'])) {
        res.status(403).json({ error: '当前用户没有标签库操作权限' });
        return;
      }
      res.locals.actor = actor;
      next();
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/catalog-options', (_req, res) => {
    try { res.json(currentFieldOptions()); } catch (err) { codebookFailure(res, err); }
  });

  app.get('/codebook', async (req, res) => {
    try {
      res.json(listGroups());
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/codebook/:authority', async (req, res) => {
    try {
      const authority = req.params.authority;
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const offset = Number(req.query.offset ?? 0);
      const limit = Number(req.query.limit ?? 40);
      res.json({ authority, ...pageCodes(authority, query, offset, limit) });
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.post('/codebook/:authority/codes', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const row = addCode(authority, bodyText(req.body, 'dmz'), bodyText(req.body, 'label'));
      await recordCodebookUpdate(
        actor,
        `新增代码表 ${authority.trim()} 的代码 ${row.dmz}，名称为${row.label}`,
      );
      res.status(201).json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.patch('/codebook/:authority/codes/:dmz', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const row = renameCode(authority, req.params.dmz, bodyText(req.body, 'label'));
      await recordCodebookUpdate(
        actor,
        `将代码表 ${authority.trim()} 的代码 ${row.dmz} 名称改为${row.label}`,
      );
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.delete('/codebook/:authority/codes/:dmz', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const row = removeCode(authority, req.params.dmz);
      await recordCodebookUpdate(
        actor,
        `删除代码表 ${authority.trim()} 的代码 ${row.dmz}，名称为${row.label}`,
      );
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/codebook/:authority/readings', async (req, res) => {
    try {
      res.json(listReadings(req.params.authority));
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.post('/codebook/:authority/aliases', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const row = addAlias(authority, bodyText(req.body, 'phrase'), bodyText(req.body, 'dmz'));
      await recordCodebookUpdate(actor, `为代码表 ${authority.trim()} 的代码 ${row.dmz} 增加同义读法「${row.phrase}」`);
      res.status(201).json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.delete('/codebook/:authority/aliases', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const phrase = bodyText(req.body, 'phrase') || queryText(req.query.phrase);
      const row = removeAlias(authority, phrase);
      await recordCodebookUpdate(actor, `删除代码表 ${authority.trim()} 的同义读法「${row.phrase}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.put('/codebook/:authority/groups', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const row = putQueryGroup(authority, bodyText(req.body, 'name'), bodyStrings(req.body, 'members'));
      await recordCodebookUpdate(actor, `保存代码表 ${authority.trim()} 的查询分组「${row.name}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.delete('/codebook/:authority/groups', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const authority = req.params.authority;
      const name = bodyText(req.body, 'name') || queryText(req.query.name);
      const row = removeQueryGroup(authority, name);
      await recordCodebookUpdate(actor, `删除代码表 ${authority.trim()} 的查询分组「${row.name}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/codebook-expand', async (req, res) => {
    try {
      res.json(expandQuery(queryText(req.query.field), queryText(req.query.q)));
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/tag-observations', async (req, res) => {
    try {
      const status = queryText(req.query.status);
      const tasks = await getObservationTasks();
      res.json(
        listObservations(tasks, {
          fieldCode: queryText(req.query.field),
          status: status === 'confirmed' || status === 'rejected' || status === 'pending' ? status : 'all',
          q: queryText(req.query.q),
        }),
      );
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.put('/tag-observations/review', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const status = bodyText(req.body, 'status');
      if (status !== 'confirmed' && status !== 'rejected' && status !== 'pending') {
        throw new CodebookError('评估状态无效');
      }
      const tasks = await getObservationTasks();
      const row = reviewObservation(
        tasks,
        {
          fieldCode: bodyText(req.body, 'fieldCode'),
          textKey: bodyText(req.body, 'textKey'),
          status: status as ReviewStatus,
          weight: bodyWeight(req.body),
        },
        { id: actor.id, name: actor.name },
      );
      await recordCodebookUpdate(
        actor,
        row.status === 'confirmed'
          ? `确认表外说法「${row.rawText}」准确，权重 ${row.weight}`
          : row.status === 'rejected'
            ? `将表外说法「${row.rawText}」标为不准`
            : `将表外说法「${row.rawText}」改回待评估`,
      );
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.post('/tag-observations/promote', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const tasks = await getObservationTasks();
      const row = promoteObservation(
        tasks,
        {
          fieldCode: bodyText(req.body, 'fieldCode'),
          textKey: bodyText(req.body, 'textKey'),
          target: bodyTarget(req.body),
        },
      );
      await recordCodebookUpdate(actor, `归入表外说法「${row.rawText}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.get('/extension-tags', async (req, res) => {
    try {
      const field = queryText(req.query.field);
      res.json({
        tags: listExtensionTags(field || undefined),
        fields: listEnumFields(),
      });
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.post('/extension-tags', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const row = createExtensionTag(
        bodyText(req.body, 'fieldCode'),
        bodyText(req.body, 'label'),
        bodyStrings(req.body, 'aliases'),
      );
      await recordCodebookUpdate(actor, `新增扩充标签 ${row.extCode}「${row.label}」`);
      res.status(201).json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.patch('/extension-tags/:extCode', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const patch: { label?: string; aliases?: string[] } = {};
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'label')) patch.label = bodyText(req.body, 'label');
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'aliases')) {
        patch.aliases = bodyStrings(req.body, 'aliases');
      }
      const row = updateExtensionTag(req.params.extCode, patch);
      await recordCodebookUpdate(actor, `更新扩充标签 ${row.extCode}「${row.label}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  app.delete('/extension-tags/:extCode', async (req, res) => {
    const actor: UserIdentityProfile = res.locals.actor;
    try {
      const row = removeExtensionTag(req.params.extCode);
      await recordCodebookUpdate(actor, `删除扩充标签 ${row.extCode}「${row.label}」`);
      res.json(row);
    } catch (err) {
      codebookFailure(res, err);
    }
  });

  return app;
}
