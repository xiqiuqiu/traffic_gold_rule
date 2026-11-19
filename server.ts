import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  normalizeOpenAiBaseUrl,
  parseOpenAiModelsPayload,
  validateOpenAiBaseUrl,
} from './src/utils/aiSettings';
import {
  extractOpenAiSseDeltaText,
  isTimeoutError,
  parseStructuredModelJson,
} from './src/utils/aiResponseParser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

interface SchemaDescriptorInput {
  fieldCode: string;
  fieldName: string;
  groupCode: string;
  applicableKinds: string[];
  valueType: string;
  allowMultiple: boolean;
  isLegalOrRelation: boolean;
  options: string[];
  synonyms: string;
  definition: string;
}

interface ProviderConfigInput {
  provider?: 'gemini' | 'openai_compatible';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

interface PreanalyzeRequestBody {
  caseId?: string;
  sourceFilename?: string;
  pageCount?: number;
  pageTexts?: Record<string, string>;
  pdfBase64?: string;
  schemaCatalog?: SchemaDescriptorInput[];
  providerConfig?: ProviderConfigInput;
}

function createGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildSystemInstruction(): string {
  return [
    '你是一名严谨的道路交通事故认定书结构化信息抽取助手，负责为人工校验工作台生成高质量、严格可溯源的初稿。',
    '核心原则：',
    '1. 忠实于文书原文，严禁凭空补推断或修改法律否定词；',
    '2. 先识别文书中的所有对象实体：ACC（整起事故，固定编号 ACC）、P01+（参与方/驾驶人/行人/乘客）、V01+（涉事车辆）、E01+（阶段碰撞事件）、R01+（事发道路）、I01+（交叉路口）、O01+（交警大队或单位组织）；',
    '3. 为每个适用实体提取 G01–G06 普通事实字段到 fieldRecords 数组：',
    '   - 严格使用给定的 fieldCode，且 entityId 的类型必须匹配字段的 applicableKinds；',
    '   - presenceStatus 仅限：present（有记载）、explicit_negative（明确否定，如“未超速”“无伤亡”）、not_mentioned（未提及）、not_applicable（不适用）、unreadable（无法辨认）、source_conflict（来源冲突）、needs_review（待判断）；',
    '   - 若某字段文书中未提到，可以省略或标为 not_mentioned（此时 rawValue 必须为空字符串，normalizedValues 必须为空数组）；',
    '   - 若 presenceStatus 为 present 或 explicit_negative，必须保留原文 rawValue，并给出至少 1 条准确的页码 page（从 1 开始）与最短原文摘录 quote；',
    '   - normalizedValues 必须尽量对齐字段给定的受控词表 options（单选字段最多 1 个元素，多选字段可多个元素）；',
    '4. 如文书包含违法行为、事故形成原因及责任划分，可同步提取至 legalConclusions 数组（category 为 violation / cause / liability）。',
  ].join('\n');
}

const PREANALYZE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: '一句话概括本起事故文书的核心事实与已提取实体概览。',
    },
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: {
            type: Type.STRING,
            description: '对象编号：ACC、P01、P02、V01、E01、R01、I01、O01 等。',
          },
          kind: {
            type: Type.STRING,
            description: '对象类别：ACC | P | V | E | R | I | O',
          },
          label: {
            type: Type.STRING,
            description: '主体名称或简明标识（如姓名、号牌、路名、事故概括）。',
          },
          subtitle: {
            type: Type.STRING,
            description: '补充身份、车型或角色描述。',
          },
          roleLabel: {
            type: Type.STRING,
            description: '交通角色标签（如机动车驾驶人、行人、小型普通客车）。',
          },
        },
        required: ['id', 'kind', 'label'],
      },
    },
    fieldRecords: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          entityId: {
            type: Type.STRING,
            description: '归属对象编号，必须与 entities 中的 id 对应。',
          },
          fieldCode: {
            type: Type.STRING,
            description: '字段编码，如 D01.F001、D07.F041 等。',
          },
          presenceStatus: {
            type: Type.STRING,
            description:
              'present | explicit_negative | not_mentioned | not_applicable | unreadable | source_conflict | needs_review',
          },
          rawValue: {
            type: Type.STRING,
            description: '保留文书原文表达；未提及/不适用时留空。',
          },
          normalizedValues: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '对齐受控词表或标准化取值后的结果数组。',
          },
          evidences: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                page: { type: Type.INTEGER },
                quote: { type: Type.STRING },
              },
              required: ['page', 'quote'],
            },
          },
        },
        required: ['entityId', 'fieldCode', 'presenceStatus', 'rawValue', 'normalizedValues', 'evidences'],
      },
    },
    legalConclusions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: {
            type: Type.STRING,
            description: 'violation | cause | liability',
          },
          subjectId: {
            type: Type.STRING,
            description: '责任或违法主体编号（P01+ 或 O01+）。',
          },
          eventId: {
            type: Type.STRING,
            description: '关联事件编号（E01+，无则空字符串）。',
          },
          presenceStatus: {
            type: Type.STRING,
          },
          rawText: {
            type: Type.STRING,
          },
          lawArticle: {
            type: Type.STRING,
          },
          conclusionLabel: {
            type: Type.STRING,
          },
          evidences: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                page: { type: Type.INTEGER },
                quote: { type: Type.STRING },
              },
              required: ['page', 'quote'],
            },
          },
        },
        required: ['category', 'subjectId', 'presenceStatus', 'rawText', 'conclusionLabel', 'evidences'],
      },
    },
  },
  required: ['summary', 'entities', 'fieldRecords'],
};

function parseGeminiJson(rawText: string) {
  return parseStructuredModelJson(rawText);
}

function buildOpenAiJsonOutputInstruction(): string {
  return [
    buildSystemInstruction(),
    '',
    '【强制 JSON 输出格式要求】',
    '请严格只输出一个合法 JSON 对象（不要输出任何 Markdown 代码块围栏或额外说明），包含以下字段：',
    '- summary: string（一句话概括核心事实与实体概览）',
    '- entities: Array<{ id: string, kind: "ACC"|"P"|"V"|"E"|"R"|"I"|"O", label: string, subtitle?: string, roleLabel?: string }>',
    '- fieldRecords: Array<{ entityId: string, fieldCode: string, presenceStatus: string, rawValue: string, normalizedValues: string[], evidences: Array<{ page: number, quote: string }> }>',
    '- legalConclusions?: Array<{ category: "violation"|"cause"|"liability", subjectId: string, eventId?: string, presenceStatus: string, rawText: string, lawArticle?: string, conclusionLabel: string, evidences: Array<{ page: number, quote: string }> }>',
  ].join('\n');
}

function buildOpenAiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const token = apiKey.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function extractOpenAiMessageText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function probeOpenAiModels(baseUrlInput: string, apiKey: string) {
  const normalized = normalizeOpenAiBaseUrl(baseUrlInput);
  const candidates = /\/v\d+(beta)?$/i.test(normalized)
    ? [normalized]
    : [normalized, `${normalized}/v1`];

  let lastStatus = 0;
  let lastErrorText = '';
  let resolvedBaseUrl = normalized;

  for (let i = 0; i < candidates.length; i += 1) {
    const base = candidates[i];
    const target = `${base}/models`;
    const res = await fetch(target, {
      method: 'GET',
      headers: buildOpenAiHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const json = await res.json();
      const models = parseOpenAiModelsPayload(json);
      resolvedBaseUrl = base;
      return { models, resolvedBaseUrl };
    }

    lastStatus = res.status;
    lastErrorText = await res.text().catch(() => '');
    if (res.status === 404 && i < candidates.length - 1) {
      continue;
    }
    break;
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(`API Key / Token 鉴权失败（HTTP ${lastStatus}），请检查密钥是否有效。`);
  }
  if (lastStatus === 404) {
    throw new Error('接口地址未找到 /models 端点（HTTP 404），请确认 Base URL 是否包含正确路径（如 /v1）。');
  }
  const detail = lastErrorText.slice(0, 180).trim();
  throw new Error(
    `探测模型失败（HTTP ${lastStatus || 'ERR'}）${detail ? `：${detail}` : ''}`,
  );
}

async function readOpenAiResponseContent(
  res: Response,
  onActivity: () => void,
): Promise<string> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream') || !res.body) {
    const payload = await res.json();
    onActivity();
    return extractOpenAiMessageText(payload);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const piece = extractOpenAiSseDeltaText(line);
      if (piece) {
        accumulated += piece;
      }
      newlineIdx = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const piece = extractOpenAiSseDeltaText(buffer);
    if (piece) {
      accumulated += piece;
    } else if (!accumulated && buffer.trim().startsWith('{')) {
      // Handle gateways returning raw JSON despite text/event-stream or missing content-type
      try {
        const fallbackJson = JSON.parse(buffer.trim());
        const extracted = extractOpenAiMessageText(fallbackJson);
        if (extracted) return extracted;
      } catch {
        // Ignore partial non-JSON trailing line
      }
    }
  }

  return accumulated;
}

async function callOpenAiPreanalyze(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptText: string;
}) {
  const normalized = normalizeOpenAiBaseUrl(params.baseUrl);
  const baseCandidates = /\/v\d+(beta)?$/i.test(normalized)
    ? [normalized]
    : [normalized, `${normalized}/v1`];

  const requestBodyBase = {
    model: params.model.trim(),
    temperature: 0.1,
    messages: [
      { role: 'system', content: buildOpenAiJsonOutputInstruction() },
      { role: 'user', content: params.promptText },
    ],
  };

  const controller = new AbortController();
  const IDLE_TIMEOUT_MS = 120_000;
  const TOTAL_TIMEOUT_MS = 240_000;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(new Error('The operation was aborted due to timeout'));
    }, IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => {
    controller.abort(new Error('The operation was aborted due to timeout'));
  }, TOTAL_TIMEOUT_MS);

  resetIdleTimer();

  try {
    for (let i = 0; i < baseCandidates.length; i += 1) {
      const endpoint = `${baseCandidates[i]}/chat/completions`;
      let useStream = true;
      let useJsonFormat = true;

      const sendRequest = (stream: boolean, jsonFormat: boolean) => {
        const payload: Record<string, unknown> = {
          ...requestBodyBase,
          stream,
        };
        if (jsonFormat) {
          payload.response_format = { type: 'json_object' };
        }
        return fetch(endpoint, {
          method: 'POST',
          headers: buildOpenAiHeaders(params.apiKey),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      };

      let res = await sendRequest(useStream, useJsonFormat);
      resetIdleTimer();

      if (res.status === 400 || res.status === 501) {
        const errBody = await res.text().catch(() => '');
        if (/stream/i.test(errBody)) {
          useStream = false;
        }
        if (/response_format|json_object/i.test(errBody)) {
          useJsonFormat = false;
        }
        if (!useStream || !useJsonFormat) {
          res = await sendRequest(useStream, useJsonFormat);
          resetIdleTimer();
        } else {
          throw new Error(`OpenAI 兼容接口请求参数错误（HTTP ${res.status}）：${errBody.slice(0, 200)}`);
        }
      }

      if (res.status === 404 && i < baseCandidates.length - 1) {
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          throw new Error(`OpenAI 兼容接口鉴权失败（HTTP ${res.status}），请核对模型设置中的 Token / Key。`);
        }
        if (res.status === 429) {
          throw new Error('OpenAI 兼容接口触发限流或配额不足（HTTP 429），请稍后重试。');
        }
        throw new Error(
          `OpenAI 兼容接口返回错误（HTTP ${res.status}）${errText ? `：${errText.slice(0, 200)}` : ''}`,
        );
      }

      const contentText = await readOpenAiResponseContent(res, resetIdleTimer);
      if (!contentText.trim()) {
        throw new Error('所选 OpenAI 兼容模型未返回文本内容，请检查模型能力或稍后重试。');
      }
      return parseGeminiJson(contentText);
    }

    throw new Error('无法连接到 OpenAI 兼容接口的 /chat/completions 端点，请检查 Base URL。');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

async function callGeminiWithRetry(
  ai: GoogleGenAI,
  contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'],
) {
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction: buildSystemInstruction(),
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: PREANALYZE_RESPONSE_SCHEMA,
          abortSignal: AbortSignal.timeout(120_000),
        },
      });
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /429|500|503|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg);
      if (attempt < maxAttempts && isTransient) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
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

      const result = await probeOpenAiModels(baseUrl, apiKey);
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
      const body = (req.body || {}) as PreanalyzeRequestBody;
      const providerConfig = body.providerConfig;
      const useOpenAi = providerConfig?.provider === 'openai_compatible';

      const pageTexts = body.pageTexts || {};
      const sortedPages = Object.keys(pageTexts)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && n >= 1)
        .sort((a, b) => a - b);

      const formattedPageBlocks = sortedPages
        .map((p) => `=== 第 ${p} 页 ===\n${(pageTexts[String(p)] || '').trim()}`)
        .filter((block) => block.length > 20)
        .join('\n\n');

      const hasTextContent = formattedPageBlocks.replace(/\s+/g, '').length >= 30;
      const hasPdfBinary = typeof body.pdfBase64 === 'string' && body.pdfBase64.length > 20;

      if (!hasTextContent && !hasPdfBinary) {
        res.status(400).json({
          error: '当前 PDF 尚未读取到可解析内容，请确认 PDF 已加载完成或重新上传后重试。',
        });
        return;
      }

      const schemaSummary = Array.isArray(body.schemaCatalog)
        ? [
            ...body.schemaCatalog
              .filter((f) => !f.isLegalOrRelation)
              .map((f) => {
                const opts = f.options?.length ? ` | 选项:[${f.options.join(',')}]` : '';
                const syns = f.synonyms ? ` | 参考:${f.synonyms.slice(0, 60)}` : '';
                return `- ${f.fieldCode}(${f.fieldName},适用:${f.applicableKinds.join('/')},${f.allowMultiple ? '多选' : '单选'})${opts}${syns}`;
              }),
            ...body.schemaCatalog
              .filter((f) => f.groupCode === 'G08' && f.options?.length)
              .map(
                (f) =>
                  `- [legalConclusions ${f.fieldCode}·${f.fieldName}] 推荐标准结论:[${f.options.join(',')}]`,
              ),
          ].join('\n')
        : '';

      const promptText = [
        `样本文件: ${body.sourceFilename || body.caseId || '未命名PDF'}（共 ${body.pageCount || sortedPages.length || 1} 页）`,
        '',
        '【目标字段定义与受控词表】',
        schemaSummary || '请按道路交通事故认定书标准字段体系（G01-G06）提取对象与字段记录。',
        '',
        hasTextContent
          ? `【PDF 分页提取文本】\n${formattedPageBlocks}`
          : '【说明】本 PDF 为扫描件或无内嵌文本层，请直接阅读随附 PDF 原件提取每页文本与页码证据。',
      ].join('\n');

      if (useOpenAi) {
        const baseUrl = providerConfig?.baseUrl || '';
        const apiKey = providerConfig?.apiKey || '';
        const model = (providerConfig?.model || '').trim();
        const urlError = validateOpenAiBaseUrl(baseUrl);
        if (urlError) {
          res.status(400).json({ error: urlError });
          return;
        }
        if (!model) {
          res.status(400).json({ error: '请先在“模型设置”中选择要调用的模型。' });
          return;
        }
        if (!hasTextContent) {
          res.status(400).json({
            error: '当前 PDF 无内嵌文本层（疑似纯扫描件）。OpenAI 兼容文本接口仅支持提取含文本层的 PDF，或切换为内置 Gemini 多模态读取。',
          });
          return;
        }

        const parsed = await callOpenAiPreanalyze({
          baseUrl,
          apiKey,
          model,
          promptText,
        });
        res.json(parsed);
        return;
      }

      const ai = createGeminiClient();
      if (!ai) {
        res.status(500).json({
          error: '未配置有效的 GEMINI_API_KEY，请在 Settings > Secrets 中设置，或前往“模型设置”切换为 OpenAI 兼容接口。',
        });
        return;
      }

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      if (hasPdfBinary && (!hasTextContent || (body.pdfBase64?.length || 0) < 12 * 1024 * 1024)) {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: body.pdfBase64!,
          },
        });
      }
      parts.push({ text: promptText });

      const response = await callGeminiWithRetry(ai, { parts });
      const rawJson = (response.text ?? '').trim();
      if (!rawJson) {
        res.status(502).json({ error: 'Gemini 未返回结构化提取结果，请稍后重试。' });
        return;
      }

      const parsed = parseGeminiJson(rawJson);
      res.json(parsed);
    } catch (err) {
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

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gold workbench server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
