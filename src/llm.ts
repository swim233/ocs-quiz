import type { Env } from './index';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Workers 免费版单请求墙钟上限 30s, 单次 LLM 尝试不超过 25s, 给降级重试留余量 */
const WALL_BUDGET_MS = 25000;

export function buildSystemPrompt(): string {
  return [
    '你是在线课程答题助手。根据题目、选项与图片, 给出正确答案。',
    '必须只输出一个 JSON 对象, 禁止输出任何其他文字、解释或代码块:',
    '{"answers": ["答案1", "答案2"], "reason": "一句话理由"}',
    '',
    '答案规则:',
    '1. 单选(single): answers 只含 1 个元素, 输出选项字母, 如 "A"。',
    '2. 多选(multiple): answers 含所有正确选项的字母, 按字母序, 如 ["A","C","D"]。',
    '3. 判断(judgement): answers 含 1 个元素, 输出 "对" 或 "错"; 若选项带明确字母(如 A.对 B.错), 优先输出字母。',
    '4. 填空(completion): answers 每个元素对应一个空, 多个空作为数组的多个元素, 不要在答案内部使用任何分隔符。',
    '5. 题目类型未知(unknown)时: 根据选项数量自行判断单选/多选/判断, 按对应规则输出。',
    '6. 题目信息不足无法作答时, 输出 {"answers": [], "reason": "原因"}。',
    '7. 图片题必须结合图片内容作答。'
  ].join('\n');
}

export function buildUserContent(
  title: string,
  options: string,
  type: string,
  images: string[],
  visionEnabled: boolean
): string | ContentPart[] {
  const text = [
    `题目类型: ${type || 'unknown'}`,
    title ? `题目: ${title}` : '',
    options ? `选项:\n${options}` : '',
    images.length ? `题目/选项中包含以下图片:\n${images.map((u) => `- ${u}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  if (!visionEnabled || images.length === 0) return text;
  return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))];
}

export interface LlmResult {
  content: string;
  model: string;
  latencyMs: number;
  attempts: number;
  usage: LlmUsage;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

interface Strategy {
  json: boolean;
  vision: boolean;
}

/**
 * 调用 OpenAI 兼容 chat/completions。
 *
 * 兼容性降级(遇 400/422/404 自动推进):
 * 1. json 约束 + 图片  -> 2. 无 json 约束 + 图片  -> 3. json 约束 + 无图  -> 4. 均不带
 * 覆盖: 不支持 response_format 的 API、不支持视觉输入的模型。
 * 认证错误(401/403)与网络/超时错误直接抛出, 不做无谓重试。
 */
export interface LlmOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** 解析最终 LLM 配置: 请求携带值 > 环境变量 > 内置默认值 */
export function resolveLlmConfig(env: Env, override: LlmOverride = {}): Required<LlmOverride> {
  const baseUrl = (override.baseUrl || env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = override.model || env.LLM_MODEL || 'gpt-4o-mini';
  const apiKey = override.apiKey || env.LLM_API_KEY || '';
  if (!apiKey) {
    throw new Error('缺少 apiKey: 请在请求中携带 apiKey 字段, 或配置环境变量 LLM_API_KEY');
  }
  return { apiKey, baseUrl, model };
}

export async function callLlm(env: Env, messages: ChatMessage[], override: LlmOverride = {}): Promise<LlmResult> {
  const { baseUrl: base, model, apiKey } = resolveLlmConfig(env, override);
  const temperature = parseFloat(env.LLM_TEMPERATURE || '0') || 0;
  const timeoutMs = Math.min(parseInt(env.LLM_TIMEOUT_MS || '30000', 10) || 30000, WALL_BUDGET_MS);

  const hasImages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
  const strategies: Strategy[] = [
    { json: true, vision: hasImages },
    { json: false, vision: hasImages },
    { json: true, vision: false },
    { json: false, vision: false }
  ];

  const started = Date.now();
  let attempts = 0;
  let lastError: Error | null = null;
  for (const strategy of strategies) {
    try {
      attempts++;
      const { content, usage } = await requestCompletion(base, model, apiKey, temperature, messages, strategy, timeoutMs);
      return { content, model, latencyMs: Date.now() - started, attempts, usage };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = (err as { status?: number }).status;
      // 认证失败或网络/超时: 重试无意义
      if (status === 401 || status === 403 || status === undefined) throw lastError;
    }
  }
  throw lastError ?? new Error('LLM 调用失败');
}

async function requestCompletion(
  base: string,
  model: string,
  apiKey: string | undefined,
  temperature: number,
  messages: ChatMessage[],
  strategy: Strategy,
  timeoutMs: number
): Promise<{ content: string; usage: LlmUsage }> {
  const body: Record<string, unknown> = {
    model,
    temperature,
    messages: messages.map((m) => ({
      ...m,
      content:
        typeof m.content === 'string' || strategy.vision
          ? m.content
          : m.content.filter((p) => p.type !== 'image_url').map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    }))
  };
  if (strategy.json) body.response_format = { type: 'json_object' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LLM API ${res.status}: ${detail.slice(0, 300)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown };
      prompt_cache_hit_tokens?: unknown;
    };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM 返回内容为空');
  }
  return {
    content,
    usage: {
      promptTokens: Number(data.usage?.prompt_tokens) || 0,
      completionTokens: Number(data.usage?.completion_tokens) || 0,
      // OpenAI 兼容: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens
      cachedTokens:
        Number(data.usage?.prompt_tokens_details?.cached_tokens) ||
        Number(data.usage?.prompt_cache_hit_tokens) ||
        0
    }
  };
}