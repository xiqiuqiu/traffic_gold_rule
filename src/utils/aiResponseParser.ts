/**
 * Parse structured JSON from LLM output text:
 * - strips <think>...</think> reasoning blocks emitted by reasoning models
 * - strips Markdown code fences (```json ... ```)
 * - extracts the outermost JSON object if surrounded by prose
 */
export function parseStructuredModelJson(rawText: string): unknown {
  const withoutThink = (rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  const cleaned = withoutThink
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate);
    }
    throw new Error('模型返回内容不是合法的 JSON 结构。');
  }
}

/**
 * Extract incremental text content from an OpenAI SSE `data: ...` line.
 * Returns null for [DONE], comments, or non-JSON keepalive lines.
 */
export function extractOpenAiSseDeltaText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;
  const payloadStr = trimmed.slice(5).trim();
  if (!payloadStr || payloadStr === '[DONE]') return null;

  try {
    const parsed = JSON.parse(payloadStr) as {
      choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
      }>;
    };
    const choice = parsed?.choices?.[0];
    if (!choice) return null;
    const content = choice.delta?.content ?? choice.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (
            part &&
            typeof part === 'object' &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            return (part as { text: string }).text;
          }
          return '';
        })
        .join('');
    }
    return null;
  } catch {
    return null;
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /aborted due to timeout|timed?\s*out|ETIMEDOUT/i.test(err);
  }
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  if (e.code === 'ETIMEDOUT' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT') {
    return true;
  }
  const msg = e.message || '';
  return /aborted due to timeout|timed?\s*out|ETIMEDOUT|HEADERS_TIMEOUT|BODY_TIMEOUT/i.test(msg);
}
