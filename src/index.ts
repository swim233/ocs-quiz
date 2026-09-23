import { authorize, handleOptions, json } from './http';
import { extractImageUrls } from './images';
import { buildSystemPrompt, buildUserContent, callLlm, type ChatMessage } from './llm';
import { logSearch, queryLogs } from './log';
import { buildOcsConfig, TOKEN_PLACEHOLDER } from './ocs-config';
import { lettersToOptionTexts, parseLlmAnswer } from './parse';

export interface Env {
  LLM_TEMPERATURE?: string;
  LLM_TIMEOUT_MS?: string;
  VISION_ENABLED?: string;
  LOG_ENABLED?: string;
  AUTH_TOKEN?: string;
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
      if (!authorize(request, env.AUTH_TOKEN)) return json({ code: 1, msg: '未授权' }, 401);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      return json({ code: 0, data: await queryLogs(env, limit) });
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
  if (!authorize(request, env.AUTH_TOKEN)) {
    await logSearch(env, {
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
      cachedTokens: 0
    });
    return json({ code: 1, msg: '未授权' }, 401);
  }

  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    await logSearch(env, {
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
      cachedTokens: 0
    });
    return json({ code: 1, msg: '请求体必须是 JSON' }, 400);
  }

  const title = typeof body.title === 'string' ? body.title.slice(0, 3000) : '';
  const options = typeof body.options === 'string' ? body.options.slice(0, 6000) : '';
  const type = typeof body.type === 'string' && body.type ? body.type : 'unknown';
  if (!title.trim() && !options.trim()) {
    await logSearch(env, {
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
      cachedTokens: 0
    });
    return json({ code: 1, msg: '题目为空' });
  }

  const images = extractImageUrls(title, options);
  const visionEnabled = env.VISION_ENABLED !== 'false';
  const llmConfig = {
    apiKey: typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : undefined,
    baseUrl: typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : undefined,
    model: typeof body.model === 'string' && body.model ? body.model : undefined,
    thinkEffort: typeof body.thinkEffort === 'string' && body.thinkEffort.trim() ? body.thinkEffort.trim() : undefined
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserContent(title, options, type, images, visionEnabled) }
  ];

  try {
    const { content, model, latencyMs, usage } = await callLlm(env, messages, llmConfig);
    const parsed = parseLlmAnswer(content, type);
    const reason = parsed.reason;
    // 选择/判断题的字母答案换成选项原文, OCS 才能稳定匹配 (见 lettersToOptionTexts)
    const answers = type === 'completion' ? parsed.answers : lettersToOptionTexts(parsed.answers, options);
    const status = answers.length > 0 ? 'ok' : 'no_answer';
    await logSearch(env, {
      questionType: type,
      title,
      options,
      images: images.length,
      model,
      answers: JSON.stringify({ answers, reason }),
      reason,
      latencyMs,
      status,
      error: '',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens
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
        model,
        latency_ms: latencyMs,
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          cached_tokens: usage.cachedTokens
        }
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSearch(env, {
      questionType: type,
      title,
      options,
      images: images.length,
      model: llmConfig.model || '',
      answers: '',
      reason: '',
      latencyMs: 0,
      status: 'error',
      error: message,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0
    });
    return json({ code: 1, msg: `答题失败: ${message.slice(0, 300)}` });
  }
}