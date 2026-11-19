import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  AiModelOption,
  AiProviderSettings,
  DEFAULT_AI_PROVIDER_SETTINGS,
  filterModelOptions,
  getActiveModelSummary,
  normalizeOpenAiBaseUrl,
  pickPreferredModel,
  validateOpenAiBaseUrl,
} from '../utils/aiSettings';

import type { ExtendedRole } from '../types/system';

interface ModelSettingsPanelProps {
  settings: AiProviderSettings;
  ready: boolean;
  canManage: boolean;
  actorRole: ExtendedRole;
  hasServerKey: boolean;
  onSaveSettings: (next: AiProviderSettings) => Promise<void>;
  onJumpToPreanalyze: () => void;
}

const ENDPOINT_EXAMPLES: Array<{ label: string; url: string }> = [
  { label: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { label: '硅基流动 SiliconFlow', url: 'https://api.siliconflow.cn/v1' },
  { label: '本地 Ollama', url: 'http://127.0.0.1:11434/v1' },
];

export const ModelSettingsPanel: React.FC<ModelSettingsPanelProps> = ({
  settings: savedSettings,
  ready,
  canManage,
  actorRole,
  hasServerKey,
  onSaveSettings,
  onJumpToPreanalyze,
}) => {
  const [settings, onChangeSettings] = useState(savedSettings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const hasChanges = settings !== savedSettings;
  useEffect(() => { onChangeSettings(savedSettings); }, [savedSettings]);

  const [showApiKey, setShowApiKey] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');

  // Track latest settings via ref to avoid stale closures during async probes or debounced timers
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const lastProbedSigRef = useRef<string>('');
  const probeInFlightSigRef = useRef<string>('');

  const summary = useMemo(() => getActiveModelSummary(settings), [settings]);

  const filteredModels = useMemo(
    () => filterModelOptions(settings.openai.availableModels, modelSearch),
    [settings.openai.availableModels, modelSearch],
  );

  const runProbeModels = async (opts?: {
    baseUrl?: string;
    apiKey?: string;
    reason?: 'auto' | 'manual';
  }) => {
    const current = settingsRef.current;
    const rawBaseUrl = opts?.baseUrl ?? current.openai.baseUrl;
    const apiKey = opts?.apiKey ?? current.openai.apiKey;
    const normalizedBase = normalizeOpenAiBaseUrl(rawBaseUrl);
    const urlError = validateOpenAiBaseUrl(normalizedBase);

    if (urlError) {
      if (opts?.reason !== 'auto') {
        setProbeError(urlError);
        setProbeNotice(null);
      }
      return;
    }

    const sig = `${normalizedBase}::${apiKey.trim()}`;
    if (opts?.reason === 'auto' && (sig === lastProbedSigRef.current || sig === probeInFlightSigRef.current)) {
      return;
    }

    probeInFlightSigRef.current = sig;
    setProbing(true);
    setProbeError(null);
    setProbeNotice(null);

    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: normalizedBase,
          actorRole,
          apiKey: apiKey.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : `探测模型失败（HTTP ${res.status}）`,
        );
      }

      const models = Array.isArray(data?.models) ? (data.models as AiModelOption[]) : [];
      const resolvedBaseUrl =
        typeof data?.resolvedBaseUrl === 'string' && data.resolvedBaseUrl
          ? data.resolvedBaseUrl
          : normalizedBase;

      const latest = settingsRef.current;
      if (latest.provider !== current.provider || normalizeOpenAiBaseUrl(latest.openai.baseUrl) !== normalizedBase || latest.openai.apiKey !== current.openai.apiKey) return;
      const nextSelected = pickPreferredModel(models, latest.openai.selectedModel);
      const probedAt = new Date().toISOString();

      lastProbedSigRef.current = `${resolvedBaseUrl}::${apiKey.trim()}`;

      onChangeSettings({
        ...latest,
        provider: 'openai_compatible',
        openai: {
          ...latest.openai,
          baseUrl: resolvedBaseUrl,
          apiKey,
          availableModels: models,
          selectedModel: nextSelected,
          lastProbedAt: probedAt,
        },
      });
      setProbeNotice(`已自动探测并加载 ${models.length} 个可用模型`);
    } catch (err) {
      lastProbedSigRef.current = sig;
      setProbeError(err instanceof Error ? err.message : '探测可用模型失败，请检查接口地址与密钥');
    } finally {
      probeInFlightSigRef.current = '';
      setProbing(false);
    }
  };

  // Auto-probe shortly after both a valid Base URL and API Key/Token are provided
  useEffect(() => {
    if (!canManage || settings.provider !== 'openai_compatible') return;
    const normalizedBase = normalizeOpenAiBaseUrl(settings.openai.baseUrl);
    if (validateOpenAiBaseUrl(normalizedBase) !== null) return;
    const trimmedKey = settings.openai.apiKey.trim();
    if (trimmedKey.length < 4) return;

    const sig = `${normalizedBase}::${trimmedKey}`;
    if (sig === lastProbedSigRef.current || sig === probeInFlightSigRef.current) return;

    const timer = window.setTimeout(() => {
      void runProbeModels({ baseUrl: normalizedBase, apiKey: trimmedKey, reason: 'auto' });
    }, 800);

    return () => window.clearTimeout(timer);
  }, [canManage, settings.provider, settings.openai.baseUrl, settings.openai.apiKey]);

  const handleFieldBlurAutoProbe = () => {
    if (!canManage || settings.provider !== 'openai_compatible') return;
    const normalizedBase = normalizeOpenAiBaseUrl(settings.openai.baseUrl);
    if (validateOpenAiBaseUrl(normalizedBase) !== null) return;
    const trimmedKey = settings.openai.apiKey.trim();
    if (!trimmedKey) return;
    void runProbeModels({ baseUrl: normalizedBase, apiKey: trimmedKey, reason: 'auto' });
  };

  const handleResetOpenAiConfig = () => {
    lastProbedSigRef.current = '';
    setProbeError(null);
    setProbeNotice(null);
    setModelSearch('');
    onChangeSettings({
      ...settings,
      provider: 'gemini',
      openai: { ...DEFAULT_AI_PROVIDER_SETTINGS.openai },
    });
  };

  return (
    <fieldset disabled={!ready || !canManage || saving} className="flex min-w-0 flex-col gap-5 p-5">
      {/* Header & Current Active Status */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-slate-900">AI 模型与接口设置</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span>{hasChanges ? '待保存' : '当前生效'}：{summary.providerLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular font-medium text-slate-900">
                {summary.modelName}
              </span>
              <span aria-hidden="true">·</span>
              <span className={summary.isConfigured ? 'text-emerald-700' : 'text-amber-700'}>
                {summary.isConfigured ? '已就绪' : '待完善配置'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!hasChanges || !summary.isConfigured || probing}
              onClick={async () => {
                setSaving(true);
                setSaveError('');
                try {
                  await onSaveSettings(settings);
                } catch (err) {
                  setSaveError(err instanceof Error ? err.message : '保存模型配置失败。');
                } finally {
                  setSaving(false);
                }
              }}
              className="rounded-md bg-blue-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:bg-slate-300"
            >
              {saving ? '保存中…' : '保存后台配置'}
            </button>
            <button
              type="button"
              disabled={hasChanges}
              onClick={onJumpToPreanalyze}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-700 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-800"
            >
              前往工作台预分析
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
        {!canManage && <p className="mt-2 text-xs text-slate-600">当前身份可查看后台模型配置，修改配置需有权限与设置管理权限。</p>}
        {saveError && <p role="alert" className="mt-2 text-xs text-red-700">{saveError}</p>}
        {!ready && <p role="status" className="mt-2 text-xs text-slate-600">正在读取服务器配置，若连接失败请刷新重试。</p>}

        {/* Provider Switch */}
        <div className="mt-5 border-t border-slate-100 pt-4">
          <span className="block text-xs font-medium text-slate-700">调用引擎</span>
          <div
            role="radiogroup"
            aria-label="选择 AI 模型调用引擎"
            className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={settings.provider === 'openai_compatible'}
              onClick={() =>
                onChangeSettings({
                  ...settings,
                  provider: 'openai_compatible',
                })
              }
              className={`flex flex-col items-start rounded-md border p-3.5 text-left transition-colors ${
                settings.provider === 'openai_compatible'
                  ? 'border-blue-700 bg-blue-50/40'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">OpenAI 兼容接口</span>
                {settings.provider === 'openai_compatible' && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
                )}
              </div>
              <span className="mt-1 text-xs text-slate-600">
                自定义接口地址与 Token，自动探测并选择可用模型
              </span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={settings.provider === 'gemini'}
              onClick={() =>
                onChangeSettings({
                  ...settings,
                  provider: 'gemini',
                })
              }
              className={`flex flex-col items-start rounded-md border p-3.5 text-left transition-colors ${
                settings.provider === 'gemini'
                  ? 'border-blue-700 bg-blue-50/40'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">系统内置 Gemini</span>
                {settings.provider === 'gemini' && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
                )}
              </div>
              <span className="mt-1 text-xs text-slate-600">
                使用服务端环境变量密钥（gemini-4-hydrogen），支持直接识读扫描件 PDF
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* OpenAI-Compatible Endpoint Configuration */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">OpenAI 兼容接口连接与模型探测</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              保存后，手动上传和定时扫盘使用同一套后台模型配置。
            </p>
          </div>

          <button
            type="button"
            onClick={handleResetOpenAiConfig}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            清空配置
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4">
          {/* Base URL */}
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="openai-base-url" className="text-xs font-medium text-slate-800">
                接口地址（Base URL）
              </label>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400">快捷填入：</span>
                {ENDPOINT_EXAMPLES.map((preset) => (
                  <button
                    key={preset.url}
                    type="button"
                    onClick={() => {
                      onChangeSettings({
                        ...settings,
                        provider: 'openai_compatible',
                        openai: {
                          ...settings.openai,
                          baseUrl: preset.url,
                          apiKey: '',
                          availableModels: [],
                          selectedModel: '',
                          lastProbedAt: undefined,
                        },
                      });
                      setProbeError(null);
                    }}
                    className="whitespace-nowrap text-blue-700 hover:underline"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              id="openai-base-url"
              type="url"
              value={settings.openai.baseUrl}
              onChange={(e) => {
                onChangeSettings({
                  ...settings,
                  provider: 'openai_compatible',
                  openai: {
                    ...settings.openai,
                    baseUrl: e.target.value,
                    apiKey: '',
                    availableModels: [],
                    selectedModel: '',
                    lastProbedAt: undefined,
                  },
                });
                setProbeError(null);
              }}
              onBlur={handleFieldBlurAutoProbe}
              placeholder="例如：https://api.openai.com/v1 或 http://127.0.0.1:11434/v1"
              className="font-mono-tabular w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none"
            />
          </div>

          {/* API Key / Token */}
          <div>
            <label htmlFor="openai-api-key" className="mb-1.5 block text-xs font-medium text-slate-800">
              访问令牌（API Key / Token）
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  id="openai-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="off"
                  value={settings.openai.apiKey}
                  onChange={(e) => {
                    onChangeSettings({
                      ...settings,
                      provider: 'openai_compatible',
                      openai: {
                        ...settings.openai,
                        apiKey: e.target.value,
                      },
                    });
                    setProbeError(null);
                  }}
                  onBlur={handleFieldBlurAutoProbe}
                  placeholder={hasServerKey && normalizeOpenAiBaseUrl(settings.openai.baseUrl) === normalizeOpenAiBaseUrl(savedSettings.openai.baseUrl)
                    ? '已保存令牌，留空沿用或输入新令牌替换'
                    : '输入访问 Token（无需认证的本地接口可留空）'}
                  className="font-mono-tabular w-full rounded-md border border-slate-300 bg-white py-2 pr-10 pl-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label={showApiKey ? '隐藏访问令牌' : '显示访问令牌'}
                  onClick={() => setShowApiKey((v) => !v)}
                  className="absolute inset-y-0 right-1.5 flex items-center px-1.5 text-slate-500 hover:text-slate-800"
                >
                  {showApiKey ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>

              <button
                type="button"
                onClick={() => void runProbeModels({ reason: 'manual' })}
                disabled={probing}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-slate-900 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {probing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    正在探测模型…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    探测可用模型
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Probe Feedback */}
        {probeError && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{probeError}</span>
          </div>
        )}

        {probeNotice && !probeError && (
          <div
            role="status"
            className="mt-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
          >
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{probeNotice}</span>
          </div>
        )}

        {/* Probed Models Selection */}
        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-900">可用模型列表</span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span className="font-mono-tabular text-slate-600">
                {settings.openai.availableModels.length > 0
                  ? `已获取 ${settings.openai.availableModels.length} 个模型`
                  : '尚未探测到模型'}
              </span>
              {settings.openai.lastProbedAt && (
                <>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono-tabular text-slate-500">
                    更新于 {new Date(settings.openai.lastProbedAt).toLocaleTimeString()}
                  </span>
                </>
              )}
            </div>

            {settings.openai.availableModels.length > 5 && (
              <div className="relative w-56">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  aria-label="筛选探测到的模型"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="搜索模型名称…"
                  className="w-full rounded border border-slate-300 bg-white py-1 pr-2.5 pl-8 text-xs text-slate-900 focus:border-blue-700 focus:outline-none"
                />
              </div>
            )}
          </div>

          {probing && settings.openai.availableModels.length === 0 ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3.5 py-6 text-xs text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin text-blue-700" aria-hidden="true" />
              <span>正在连接接口并获取可用模型列表…</span>
            </div>
          ) : settings.openai.availableModels.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-xs text-slate-600">
              填写上方接口地址与 Token 后将自动探测可用模型，也可点击“探测可用模型”立即获取。
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {/* Native select for quick accessible switching */}
              <div>
                <label htmlFor="openai-model-select" className="mb-1 block text-xs font-medium text-slate-700">
                  已选定调用模型
                </label>
                <select
                  id="openai-model-select"
                  value={settings.openai.selectedModel}
                  onChange={(e) =>
                    onChangeSettings({
                      ...settings,
                      provider: 'openai_compatible',
                      openai: {
                        ...settings.openai,
                        selectedModel: e.target.value,
                      },
                    })
                  }
                  className="font-mono-tabular w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-blue-700 focus:outline-none"
                >
                  {!settings.openai.availableModels.some(
                    (m) => m.id === settings.openai.selectedModel,
                  ) &&
                    settings.openai.selectedModel && (
                      <option value={settings.openai.selectedModel}>
                        {settings.openai.selectedModel}（手动指定）
                      </option>
                    )}
                  {settings.openai.availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.ownedBy ? ` · ${m.ownedBy}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Scannable interactive model list */}
              <div
                aria-label="选择已探测的模型"
                className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 bg-white"
              >
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-slate-500">
                    未找到匹配“{modelSearch}”的模型
                  </div>
                ) : (
                  filteredModels.map((model) => {
                    const isSelected = settings.openai.selectedModel === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() =>
                          onChangeSettings({
                            ...settings,
                            provider: 'openai_compatible',
                            openai: {
                              ...settings.openai,
                              selectedModel: model.id,
                            },
                          })
                        }
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-blue-50/70 text-blue-900'
                            : 'text-slate-800 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-mono-tabular truncate font-medium">
                            {model.id}
                          </span>
                          {model.ownedBy && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                ·
                              </span>
                              <span className="truncate text-slate-500">{model.ownedBy}</span>
                            </>
                          )}
                        </div>
                        <span
                          className={`shrink-0 whitespace-nowrap font-medium ${
                            isSelected ? 'text-blue-700' : 'text-slate-400'
                          }`}
                        >
                          {isSelected ? '当前使用' : '选择'}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Manual override input fallback */}
          <div className="mt-4">
            <label
              htmlFor="openai-manual-model"
              className="mb-1 block text-xs font-medium text-slate-700"
            >
              手动指定模型 ID（当部分接口不开放 /models 探测时可直接填写）
            </label>
            <input
              id="openai-manual-model"
              type="text"
              value={settings.openai.selectedModel}
              onChange={(e) =>
                onChangeSettings({
                  ...settings,
                  provider: 'openai_compatible',
                  openai: {
                    ...settings.openai,
                    selectedModel: e.target.value,
                  },
                })
              }
              placeholder="例如：gpt-4o-mini / deepseek-chat / qwen-plus"
              className="font-mono-tabular w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none"
            />
          </div>
        </div>
      </section>
    </fieldset>
  );
};
