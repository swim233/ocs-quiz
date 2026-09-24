import { authorize, clientIp, handleOptions, json } from './http';
import { extractImageUrls } from './images';
import {
  buildSystemPrompt,
  buildUserContent,
  callWithFailover,
  llmTimeoutMs,
  resolveCandidates,
  type ChatMessage,
  type FailedAttempt,
  type LlmConfig
} from './llm';
import { logSearch, queryLogs, type SearchLog } from './log';
import { buildAnswerTags, buildOcsConfig, TOKEN_PLACEHOLDER } from './ocs-config';
import { lettersToOptionTexts, parseLlmAnswer } from './parse';

export interface Env {
  LLM_TEMPERATURE?: string;
  LLM_TIMEOUT_MS?: string;
  VISION_ENABLED?: string;
  LOG_ENABLED?: string;
  /** 搜题请求 (/api/search) 与 /ocs-config.json 的鉴权 token */
  AUTH_TOKEN?: string;
  /** 日志页 (/api/logs) 的鉴权 token, 与 AUTH_TOKEN 相互独立 */
  WEBUI_TOKEN?: string;
  DB?: D1Database;
  /** Workers Static Assets 绑定 (React 前端) */
  ASSETS?: Fetcher;
}

interface SearchBody {
  title?: unknown;
  options?: unknown;
  type?: unknown;
  /** 请求方携带的 LLM 配置 (BYOK, 三项必填); apiKey 不会写入日志 */
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  /** 可选的思考强度, 透传为 reasoning_effort; 不填使用服务商默认强度 */
  thinkEffort?: unknown;
  /** 可选的备用候选, 平铺字段失败后按顺序尝试 (见 resolveCandidates) */
  providers?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return handleOptions();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return json({ ok: true });
    }
    if (path === '/ocs-config.json') {
      // token 缺失或错误时返回占位符而非 401, 避免该公开接口被用来探测 token
      const token = env.AUTH_TOKEN && !authorize(request, env.AUTH_TOKEN, url) ? TOKEN_PLACEHOLDER : env.AUTH_TOKEN;
      return json(
        buildOcsConfig(url.origin, {
          token,
          apiKey: url.searchParams.get('apiKey') || undefined,
          baseUrl: url.searchParams.get('baseUrl') || undefined,
          model: url.searchParams.get('model') || undefined,
          thinkEffort: url.searchParams.get('thinkEffort') || undefined
        })
      );
    }
    if (path === '/api/search' && request.method === 'POST') {
      return handleSearch(request, env);
    }
    if (path === '/api/logs' && request.method === 'GET') {
      // 日志含题目与请求方 IP: 未配置 WEBUI_TOKEN 时拒绝访问, 而不是像 AUTH_TOKEN 那样放行
      if (!env.WEBUI_TOKEN) {
        return json({ code: 1, msg: '服务端未配置 WEBUI_TOKEN, 请执行 wrangler secret put WEBUI_TOKEN' }, 403);
      }
      if (!authorize(request, env.WEBUI_TOKEN)) return json({ code: 1, msg: '未授权' }, 401);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      // timeoutMs 供日志页判断耗时是否接近超时上限
      return json({ code: 0, data: await queryLogs(env, limit), timeoutMs: llmTimeoutMs(env) });
    }
    if (path === '/logs') {
      // 旧的服务端渲染日志页已由 React 前端 (/) 取代, 保留跳转兼容旧书签
      return Response.redirect(new URL('/', url).toString(), 302);
    }
    // 其余路径交给静态资源 (React 前端), 未命中则 404
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ code: 1, msg: 'Not Found' }, 404);
  }
};

/**
 * OCS 只把 HTTP 200 视为成功, 其余状态码一律显示「题库连接失败」且不展示 msg。
 * 因此仅鉴权失败(401)与非 JSON 请求体(400)使用错误状态码;
 * 题目为空、LLM 失败、无法作答等业务错误返回 200 + code:1, 由 handler 把 msg 显示在 OCS 面板。
 */
async function handleSearch(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  const log = (entry: Omit<SearchLog, 'ip'>) => logSearch(env, { ...entry, ip });

  if (!authorize(request, env.AUTH_TOKEN)) {
    await log({
      questionType: 'unknown',
      title: '',
      options: '',
      images: 0,
      model: '',
      answers: '',
      reason: '',
      latencyMs: 0,
      status: 'unauthorized',
      error: '未授权: 缺少或错误的 Bearer token',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      thinkEffort: '',
      baseUrl: '',
      fallbacks: []
    });
    return json({ code: 1, msg: '未授权' }, 401);
  }

  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    await log({
      questionType: 'unknown',
      title: '',
      options: '',
      images: 0,
      model: '',
      answers: '',
      reason: '',
      latencyMs: 0,
      status: 'error',
      error: '请求体必须是 JSON',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      thinkEffort: '',
      baseUrl: '',
      fallbacks: []
    });
    return json({ code: 1, msg: '请求体必须是 JSON' }, 400);
  }

  const title = typeof body.title === 'string' ? body.title.slice(0, 3000) : '';
  const options = typeof body.options === 'string' ? body.options.slice(0, 6000) : '';
  const type = typeof body.type === 'string' && body.type ? body.type : 'unknown';
  const thinkEffort = typeof body.thinkEffort === 'string' ? body.thinkEffort.trim() : '';
  if (!title.trim() && !options.trim()) {
    await log({
      questionType: type,
      title,
      options,
      images: 0,
      model: '',
      answers: '',
      reason: '',
      latencyMs: 0,
      status: 'error',
      error: '题目为空',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      thinkEffort,
      baseUrl: '',
      fallbacks: []
    });
    return json({ code: 1, msg: '题目为空' });
  }

  const images = extractImageUrls(title, options);
  const visionEnabled = env.VISION_ENABLED !== 'false';
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserContent(title, options, type, images, visionEnabled) }
  ];
  const logBase = { questionType: type, title, options, images: images.length };

  let candidates: LlmConfig[];
  try {
    candidates = resolveCandidates(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({
      ...logBase,
      model: typeof body.model === 'string' ? body.model : '',
      answers: '',
      reason: '',
      latencyMs: 0,
      status: 'error',
      error: message,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      thinkEffort,
      baseUrl: '',
      fallbacks: []
    });
    // 校验问题需要一次列全, 不截断
    return json({ code: 1, msg: `答题失败: ${message}` });
  }

  // 总耗时从第一次尝试开始计, 与总时限 LLM_TIMEOUT_MS 对应
  const started = Date.now();
  const outcome = await callWithFailover(env, messages, candidates, started + llmTimeoutMs(env));
  const latencyMs = Date.now() - started;

  if (!outcome.ok) {
    // 日志主字段记录最后一次尝试, 更早的失败记入 fallbacks
    const last = outcome.failed[outcome.failed.length - 1];
    await log({
      ...logBase,
      model: last?.model ?? '',
      answers: '',
      reason: '',
      latencyMs,
      status: 'error',
      error: last?.error ?? '',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      thinkEffort: last?.thinkEffort ?? '',
      baseUrl: last?.baseUrl ?? '',
      fallbacks: outcome.failed.slice(0, -1)
    });
    return json({ code: 1, msg: `答题失败: ${describeFailure(outcome.failed, candidates.length)}` });
  }

  const { result, candidate, index, fallbacks } = outcome;
  const parsed = parseLlmAnswer(result.content, type);
  const reason = parsed.reason;
  // 选择/判断题的字母答案换成选项原文, OCS 才能稳定匹配 (见 lettersToOptionTexts)
  const answers = type === 'completion' ? parsed.answers : lettersToOptionTexts(parsed.answers, options);
  // 模型正常返回但答案为空不换候选: 换模型多半同样答不出, 只会多等一轮
  const status = answers.length > 0 ? 'ok' : 'no_answer';
  await log({
    ...logBase,
    model: candidate.model,
    answers: JSON.stringify({ answers, reason }),
    reason,
    latencyMs,
    status,
    error: '',
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cachedTokens: result.usage.cachedTokens,
    thinkEffort: candidate.thinkEffort || '',
    baseUrl: candidate.baseUrl,
    fallbacks
  });
  if (status === 'no_answer') {
    return json({ code: 1, msg: `无法作答: ${reason || '模型未给出答案'}` });
  }
  return json({
    code: 0,
    data: {
      question: title,
      answers,
      reason,
      model: candidate.model,
      latency_ms: latencyMs,
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        cached_tokens: result.usage.cachedTokens
      },
      tags: buildAnswerTags(candidate, index, fallbacks)
    }
  });
}

/**
 * 全部候选失败时显示在 OCS 面板的原因。只有一个候选时与引入 providers 之前一致;
 * 多个候选逐个列出简短错误, 总时限用完导致后面的候选未尝试时一并说明。
 */
function describeFailure(failed: FailedAttempt[], total: number): string {
  if (total === 1 && failed.length === 1) return failed[0].error.slice(0, 300);
  const list = failed.map((f) => `#${f.index} ${f.model}: ${f.error.slice(0, 100)}`).join('; ');
  if (failed.length === total) return `全部 ${total} 个候选均失败: ${list}`;
  return `已尝试的 ${failed.length} 个候选均失败, 其余 ${total - failed.length} 个因总时限 LLM_TIMEOUT_MS 用完未尝试: ${list}`;
}
