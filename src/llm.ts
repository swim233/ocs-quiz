import type { Env } from './index';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 单次搜题请求的默认总时限 (可用 LLM_TIMEOUT_MS 覆盖), 由所有候选的所有尝试共享:
 * 每次尝试只能用剩余时间, 用完即停止, 剩余候选不再尝试。只有一个候选时等同于单次调用的超时。
 * Workers 对 HTTP 请求没有墙钟时长上限, 等待 fetch 也不计入 CPU 时间;
 * 实际约束是 OCS 的「搜题最大耗时」(高级设置, 默认 120s, 范围 10-180s; 4.11.8 之前固定 30s)。
 * 取略低于 120s 的 110s: 超时由 Worker 先返回 msg, OCS 面板才能显示原因, 而不是「题库连接失败」。
 * 超时属于网络错误, 不会触发兼容性降级; 某次尝试超时意味着总时限已用完, 后续候选也不再尝试。
 */
const DEFAULT_TIMEOUT_MS = 110000;

export function llmTimeoutMs(env: Env): number {
  const ms = parseInt(env.LLM_TIMEOUT_MS || '', 10);
  return ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

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

/** 一个候选: 校验后的完整 LLM 配置 (BYOK), 服务端不提供兜底值 */
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

/** 请求体中与 LLM 配置相关的字段, 类型未经校验 */
export interface LlmConfigInput {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  thinkEffort?: unknown;
  /** 备用候选: [{ baseUrl, keys: [{ apiKey, model, thinkEffort? }] }] */
  providers?: unknown;
}

const FLAT_FIELDS = ['apiKey', 'baseUrl', 'model'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, '');

/** 读取字符串字段: 未填写 (undefined / null) 视为空串; 填了非字符串时记一条问题并返回 null */
function readString(value: unknown, path: string, problems: string[]): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  problems.push(`${path} 必须是字符串`);
  return null;
}

/**
 * 按尝试顺序列出候选: 平铺字段 (填了才算) 在前, 其后是 providers 按数组顺序、组内按 keys 顺序。
 * 严格校验: 任何一处写错都整体报错, 一次列出全部问题, 避免备用配置写错到降级时才发现。
 * - 未填写 (undefined / null / 空串) 与填错类型分开报告
 * - 平铺字段全空时跳过, 只填一部分时报错; providers 为空数组视为未填写
 * - baseUrl 去掉末尾 / 后比较; providers 内不可重复, 平铺字段的 baseUrl 可以与其中一组相同
 * - providers 中 key 的 thinkEffort 只取自身, 不继承平铺字段
 */
export function resolveCandidates(input: LlmConfigInput): LlmConfig[] {
  const problems: string[] = [];
  const candidates: LlmConfig[] = [];
  const { providers } = input;
  const hasProviders = Array.isArray(providers) && providers.length > 0;

  const flat = {
    apiKey: readString(input.apiKey, 'apiKey', problems),
    baseUrl: readString(input.baseUrl, 'baseUrl', problems),
    model: readString(input.model, 'model', problems)
  };
  const flatEffort = readString(input.thinkEffort, 'thinkEffort', problems)?.trim() ?? '';
  if (FLAT_FIELDS.some((k) => flat[k]) || flatEffort) {
    const missing = FLAT_FIELDS.filter((k) => flat[k] === '');
    if (missing.length) {
      // 没有 providers 时沿用引入 providers 之前的文案
      problems.push(
        hasProviders
          ? `平铺字段只填了一部分, 缺少 ${missing.join(', ')}: 请填全, 或全部留空只用 providers`
          : `缺少 ${missing.join(', ')}: 请在请求中携带这些字段`
      );
    } else if (flat.apiKey && flat.baseUrl && flat.model) {
      const baseUrl = normalizeBaseUrl(flat.baseUrl);
      if (!baseUrl) problems.push('baseUrl 无效');
      else candidates.push({ apiKey: flat.apiKey, baseUrl, model: flat.model, thinkEffort: flatEffort || undefined });
    }
  }

  if (providers !== undefined && providers !== null && !Array.isArray(providers)) {
    problems.push('providers 必须是数组');
  } else if (Array.isArray(providers)) {
    const seen = new Map<string, number>();
    providers.forEach((provider: unknown, i) => {
      const at = `providers[${i}]`;
      if (!isObject(provider)) {
        problems.push(`${at} 必须是对象`);
        return;
      }
      let baseUrl = readString(provider.baseUrl, `${at}.baseUrl`, problems);
      if (baseUrl === '') {
        problems.push(`${at} 缺少 baseUrl`);
      } else if (baseUrl !== null) {
        baseUrl = normalizeBaseUrl(baseUrl);
        const first = seen.get(baseUrl);
        if (!baseUrl) problems.push(`${at}.baseUrl 无效`);
        else if (first !== undefined) problems.push(`${at}.baseUrl 与 providers[${first}] 重复`);
        else seen.set(baseUrl, i);
      }
      const { keys } = provider;
      if (!Array.isArray(keys) || keys.length === 0) {
        problems.push(`${at}.keys 必须是非空数组`);
        return;
      }
      keys.forEach((key: unknown, j) => {
        const kat = `${at}.keys[${j}]`;
        if (!isObject(key)) {
          problems.push(`${kat} 必须是对象`);
          return;
        }
        const apiKey = readString(key.apiKey, `${kat}.apiKey`, problems);
        const model = readString(key.model, `${kat}.model`, problems);
        const thinkEffort = readString(key.thinkEffort, `${kat}.thinkEffort`, problems);
        const missing = [apiKey === '' && 'apiKey', model === '' && 'model'].filter(Boolean);
        if (missing.length) problems.push(`${kat} 缺少 ${missing.join(', ')}`);
        if (!apiKey || !model || thinkEffort === null || !baseUrl) return;
        candidates.push({ apiKey, baseUrl, model, thinkEffort: thinkEffort.trim() || undefined });
      });
    });
  }

  if (problems.length) throw new Error(problems.join('; '));
  if (!candidates.length) throw new Error(`缺少 ${FLAT_FIELDS.join(', ')}: 请在请求中携带这些字段`);
  return candidates;
}

/** 一次失败的尝试 (写入日志 fallbacks 与失败汇总), 不含 apiKey */
export interface FailedAttempt {
  /** 候选序号, 按尝试顺序从 1 开始 */
  index: number;
  baseUrl: string;
  model: string;
  thinkEffort: string;
  error: string;
  latencyMs: number;
}

export type FailoverOutcome =
  | { ok: true; result: LlmResult; candidate: LlmConfig; index: number; fallbacks: FailedAttempt[] }
  | { ok: false; failed: FailedAttempt[] };

/**
 * 按顺序尝试候选, 当前候选报错 (任何错误, 含 401/429/5xx/超时/内容为空) 才换下一个。
 * 所有尝试共享总时限 deadline, 用完即停止; 模型正常返回但答案为空不属于报错, 由调用方处理。
 */
export async function callWithFailover(
  env: Env,
  messages: ChatMessage[],
  candidates: LlmConfig[],
  deadline: number
): Promise<FailoverOutcome> {
  const failed: FailedAttempt[] = [];
  for (const [i, candidate] of candidates.entries()) {
    if (Date.now() >= deadline) break;
    const started = Date.now();
    try {
      const result = await callLlm(env, messages, candidate, deadline);
      return { ok: true, result, candidate, index: i + 1, fallbacks: failed };
    } catch (err) {
      failed.push({
        index: i + 1,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        thinkEffort: candidate.thinkEffort || '',
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started
      });
    }
  }
  return { ok: false, failed };
}

/**
 * 调用 OpenAI 兼容 chat/completions。
 *
 * 兼容性降级(遇 401/403 以外的任何 HTTP 错误都会推进到下一个策略):
 * - 含图片: 1. json 约束 + 图片  -> 2. 无 json 约束 + 图片  -> 3. json 约束 + 无图  -> 4. 均不带
 * - 无图片: 1. json 约束  -> 2. 无 json 约束
 * 覆盖: 不支持 response_format 的 API (通常返回 400/422/404)、不支持视觉输入的模型。
 * 429/5xx 同样会推进, 相当于换策略多重试一次, 全部策略失败后才轮到下一个候选。
 * 认证错误(401/403)与网络/超时等无状态码的错误直接抛出, 不做无谓重试。
 * 每次尝试的超时为距 deadline 的剩余时间。
 */
export async function callLlm(env: Env, messages: ChatMessage[], config: LlmConfig, deadline: number): Promise<LlmResult> {
  const temperature = parseFloat(env.LLM_TEMPERATURE || '0') || 0;

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
    // AbortSignal.timeout 不接受负数; 兼容性降级途中用完总时限时带上一次的错误原因
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`总时限 LLM_TIMEOUT_MS 已用完${lastError ? `, 上一次错误: ${lastError.message}` : ''}`);
    }
    try {
      attempts++;
      const { content, usage } = await requestCompletion(config, temperature, messages, strategy, remaining);
      return { content, model: config.model, latencyMs: Date.now() - started, attempts, usage };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const status = (err as { status?: number }).status;
      // 认证失败或网络/超时: 重试无意义; 兼容性降级途中超时时带上前一次的错误, 避免真实原因被超时覆盖
      if (status === 401 || status === 403 || status === undefined) {
        throw lastError && status === undefined ? new Error(`${error.message}; 此前: ${lastError.message}`) : error;
      }
      lastError = error;
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