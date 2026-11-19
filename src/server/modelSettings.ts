import { z } from 'zod';
import {
  DEFAULT_AI_PROVIDER_SETTINGS, normalizeOpenAiBaseUrl, validateOpenAiBaseUrl,
  type AiProviderSettings,
} from '../utils/aiSettings';
import { pool } from './pdfQueue';

const settingsInput = z.object({
  provider: z.enum(['gemini', 'openai_compatible']),
  openai: z.object({
    baseUrl: z.string().max(2048),
    apiKey: z.string().max(8192),
    selectedModel: z.string().max(512),
    availableModels: z.array(z.object({
      id: z.string().max(512), ownedBy: z.string().optional(), created: z.number().optional(),
    })).max(5000),
    lastProbedAt: z.string().max(64).optional(),
  }),
});

export async function initModelSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_model_secrets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, token text NOT NULL);
    CREATE TABLE IF NOT EXISTS pdf_model_configs (
      version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      settings jsonb NOT NULL, secret_id bigint REFERENCES pdf_model_secrets
    )`);
}

type ConfigRow = { version: string; settings: AiProviderSettings; secret_id: string | null };
const latest = 'SELECT version, settings, secret_id FROM pdf_model_configs ORDER BY version DESC LIMIT 1';
const publicConfig = (row?: ConfigRow) => ({ settings: row?.settings ?? null, hasApiKey: !!row?.secret_id });

export async function getPublicSettings() {
  return publicConfig((await pool.query<ConfigRow>(latest)).rows[0]);
}

export async function getModelConfigVersion(): Promise<string> {
  const result = await pool.query('SELECT max(version) AS version FROM pdf_model_configs');
  return result.rows[0].version || '0';
}

export async function loadWorkerModelSettings(version?: string): Promise<AiProviderSettings> {
  if (version === '0') return structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
  const { rows } = await pool.query(
    `SELECT settings, token FROM pdf_model_configs c LEFT JOIN pdf_model_secrets s ON s.id = c.secret_id
      ${version ? 'WHERE c.version = $1' : 'ORDER BY version DESC LIMIT 1'}`, version ? [version] : [],
  );
  if (!rows.length) {
    if (version) throw new Error('找不到此任务的模型配置版本。');
    return structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
  }
  const settings: AiProviderSettings = rows[0].settings;
  settings.openai.apiKey = rows[0].token || '';
  return settings;
}

export async function saveModelSettings(input: unknown, initializeOnly: boolean) {
  const settings = settingsInput.parse(input);
  const endpoint = normalizeOpenAiBaseUrl(settings.openai.baseUrl);
  if (endpoint) {
    if (validateOpenAiBaseUrl(endpoint)) throw new Error('模型接口地址无效。');
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) throw new Error('请将密钥填入 Token 栏，接口地址仅包含路径。');
  }
  settings.openai.baseUrl = endpoint;
  const token = settings.openai.apiKey.trim();
  settings.openai.apiKey = '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two browser migrations must not both initialize or reuse a key for a changed endpoint.
    await client.query('LOCK TABLE pdf_model_configs IN SHARE ROW EXCLUSIVE MODE');
    const previous = (await client.query<ConfigRow>(latest)).rows[0];
    if (previous && initializeOnly) {
      await client.query('COMMIT');
      return { ...publicConfig(previous), created: false };
    }
    let secretId = previous?.settings.openai.baseUrl === endpoint ? previous.secret_id : null;
    if (token) {
      const saved = await client.query('INSERT INTO pdf_model_secrets(token) VALUES ($1) RETURNING id', [token]);
      secretId = saved.rows[0].id;
    }
    const result = await client.query<ConfigRow>(
      'INSERT INTO pdf_model_configs(settings, secret_id) VALUES ($1, $2) RETURNING *', [settings, secretId],
    );
    await client.query('COMMIT');
    return { ...publicConfig(result.rows[0]), created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
