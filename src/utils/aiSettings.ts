export type AiProviderType = 'gemini' | 'openai_compatible';

export interface AiModelOption {
  id: string;
  ownedBy?: string;
  created?: number;
}

export interface OpenAiCompatibleSettings {
  baseUrl: string;
  apiKey: string;
  selectedModel: string;
  availableModels: AiModelOption[];
  lastProbedAt?: string;
}

export interface AiProviderSettings {
  provider: AiProviderType;
  openai: OpenAiCompatibleSettings;
}

export const AI_SETTINGS_STORAGE_KEY = 'gold_workbench_ai_settings_v1';

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  provider: 'gemini',
  openai: {
    baseUrl: '',
    apiKey: '',
    selectedModel: '',
    availableModels: [],
    lastProbedAt: undefined,
  },
};

/**
 * Normalize an OpenAI-compatible Base URL:
 * - trims whitespace
 * - strips trailing slashes
 * - strips accidental `/chat/completions`, `/completions`, or `/models` suffixes
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
  let url = (raw || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/completions$/i, '');
  url = url.replace(/\/models$/i, '');
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Validate a normalized or raw OpenAI-compatible Base URL.
 * Returns null if valid, otherwise a user-facing Chinese error message.
 */
export function validateOpenAiBaseUrl(raw: string): string | null {
  const normalized = normalizeOpenAiBaseUrl(raw);
  if (!normalized) {
    return '请填写 OpenAI 兼容接口地址（Base URL）。';
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '接口地址必须以 http:// 或 https:// 开头。';
    }
    if (!parsed.hostname) {
      return '接口地址缺少有效的主机名。';
    }
    return null;
  } catch {
    return '接口地址格式无效，请输入完整的 URL（例如 https://api.openai.com/v1）。';
  }
}

/**
 * Parse `/v1/models` responses from OpenAI and common OpenAI-compatible gateways
 * (supports `{ data: [...] }`, `{ models: [...] }`, or top-level array `[...]`).
 */
export function parseOpenAiModelsPayload(payload: unknown): AiModelOption[] {
  let rawList: unknown[] = [];
  if (Array.isArray(payload)) {
    rawList = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      rawList = obj.data;
    } else if (Array.isArray(obj.models)) {
      rawList = obj.models;
    }
  }

  const seen = new Set<string>();
  const parsed: AiModelOption[] = [];

  for (const item of rawList) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        parsed.push({ id });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawId =
      typeof rec.id === 'string'
        ? rec.id
        : typeof rec.name === 'string'
          ? rec.name
          : typeof rec.model === 'string'
            ? rec.model
            : '';
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const ownedBy =
      typeof rec.owned_by === 'string' && rec.owned_by.trim()
        ? rec.owned_by.trim()
        : typeof rec.ownedBy === 'string' && rec.ownedBy.trim()
          ? rec.ownedBy.trim()
          : undefined;
    const created =
      typeof rec.created === 'number' && Number.isFinite(rec.created) ? rec.created : undefined;

    parsed.push({ id, ownedBy, created });
  }

  return parsed.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Choose which model ID should remain active after probing a list of available models.
 */
export function pickPreferredModel(
  models: AiModelOption[],
  currentSelected: string,
): string {
  const trimmedCurrent = (currentSelected || '').trim();
  if (trimmedCurrent && models.some((m) => m.id === trimmedCurrent)) {
    return trimmedCurrent;
  }
  return models[0]?.id || trimmedCurrent;
}

export function filterModelOptions(
  models: AiModelOption[],
  query: string,
): AiModelOption[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      (m.ownedBy && m.ownedBy.toLowerCase().includes(q)),
  );
}

export function getActiveModelSummary(settings: AiProviderSettings): {
  providerLabel: string;
  modelName: string;
  isConfigured: boolean;
  issueHint?: string;
} {
  if (settings.provider === 'gemini') {
    return {
      providerLabel: '系统内置 Gemini',
      modelName: 'gemini-4-hydrogen',
      isConfigured: true,
    };
  }
  const baseErr = validateOpenAiBaseUrl(settings.openai.baseUrl);
  const model = settings.openai.selectedModel.trim();
  if (baseErr) {
    return {
      providerLabel: 'OpenAI 兼容接口',
      modelName: model || '未选择模型',
      isConfigured: false,
      issueHint: baseErr,
    };
  }
  if (!model) {
    return {
      providerLabel: 'OpenAI 兼容接口',
      modelName: '未选择模型',
      isConfigured: false,
      issueHint: '请先在“模型设置”中探测并选择要使用的模型。',
    };
  }
  return {
    providerLabel: 'OpenAI 兼容接口',
    modelName: model,
    isConfigured: true,
  };
}

export function loadAiProviderSettings(): AiProviderSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_AI_PROVIDER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AiProviderSettings>;
    const provider: AiProviderType =
      parsed.provider === 'openai_compatible' ? 'openai_compatible' : 'gemini';
    const openaiRaw = (parsed.openai || {}) as Partial<OpenAiCompatibleSettings>;
    const availableModels = Array.isArray(openaiRaw.availableModels)
      ? parseOpenAiModelsPayload(openaiRaw.availableModels)
      : [];
    return {
      provider,
      openai: {
        baseUrl: typeof openaiRaw.baseUrl === 'string' ? openaiRaw.baseUrl : '',
        apiKey: typeof openaiRaw.apiKey === 'string' ? openaiRaw.apiKey : '',
        selectedModel:
          typeof openaiRaw.selectedModel === 'string' ? openaiRaw.selectedModel : '',
        availableModels,
        lastProbedAt:
          typeof openaiRaw.lastProbedAt === 'string' ? openaiRaw.lastProbedAt : undefined,
      },
    };
  } catch {
    return DEFAULT_AI_PROVIDER_SETTINGS;
  }
}
