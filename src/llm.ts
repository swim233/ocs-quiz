import type { Env } from './index';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 单次 LLM 请求的默认超时 (可用 LLM_TIMEOUT_MS 覆盖)。
 * Workers 对 HTTP 请求没有墙钟时长上限, 等待 fetch 也不计入 CPU 时间;
 * 实际约束是 OCS 的「搜题最大耗时」(高级设置, 默认 120s, 范围 10-180s; 4.11.8 之前固定 30s)。
 * 超时属于网络错误, 不会触发降级重试。
 */
const DEFAULT_TIMEOUT_MS = 30000;

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

/** 调用方随请求携带的 LLM 配置 (BYOK), 服务端不提供兜底值 */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 可选的思考强度, 原样透传为 reasoning_effort (如 DeepSeek: none/low/high/max,
   * OpenAI: minimal/low/medium/high); 不填则不发送, 使用服务商默认强度
   */
  thinkEffort?: string;
}

const REQUIRED_FIELDS = ['apiKey', 'baseUrl', 'model'] as const;

/** 校验 BYOK 配置: 三项均必填, 缺失时一次列出全部缺失字段 */
export function resolveLlmConfig(input: Partial<LlmConfig>): LlmConfig {
  const missing = REQUIRED_FIELDS.filter((k) => !input[k]);
  if (missing.length) {
    throw new Error(`缺少 ${missing.join(', ')}: 请在请求中携带这些字段`);
  }
  const { apiKey, baseUrl, model, thinkEffort } = input as LlmConfig;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model, thinkEffort };
}

/**
 * 调用 OpenAI 兼容 chat/completions。
 *
 * 兼容性降级(遇 400/422/404 自动推进):
 * - 含图片: 1. json 约束 + 图片  -> 2. 无 json 约束 + 图片  -> 3. json 约束 + 无图  -> 4. 均不带
 * - 无图片: 1. json 约束  -> 2. 无 json 约束
 * 覆盖: 不支持 response_format 的 API、不支持视觉输入的模型。
 * 认证错误(401/403)与网络/超时错误直接抛出, 不做无谓重试。
 */
export async function callLlm(env: Env, messages: ChatMessage[], config: Partial<LlmConfig>): Promise<LlmResult> {
  const resolved = resolveLlmConfig(config);
  const temperature = parseFloat(env.LLM_TEMPERATURE || '0') || 0;
  const timeoutMs = parseInt(env.LLM_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;

  const hasImages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
  const textOnly: Strategy[] = [
    { json: true, vision: false },
    { json: false, vision: false }
  ];
  const strategies: Strategy[] = hasImages
    ? [{ json: true, vision: true }, { json: false, vision: true }, ...textOnly]
    : textOnly;

  const started = Date.now();
  let attempts = 0;
  let lastError: Error | null = null;
  for (const strategy of strategies) {
    try {
      attempts++;
      const { content, usage } = await requestCompletion(resolved, temperature, messages, strategy, timeoutMs);
      return { content, model: resolved.model, latencyMs: Date.now() - started, attempts, usage };
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
  { baseUrl, model, apiKey, thinkEffort }: LlmConfig,
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
  if (thinkEffort) body.reasoning_effort = thinkEffort;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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