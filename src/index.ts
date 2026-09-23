import { authorize, corsHeaders, handleOptions, json } from './http';
import { extractImageUrls } from './images';
import { buildSystemPrompt, buildUserContent, callLlm, type ChatMessage } from './llm';
import { logSearch, queryLogs } from './log';
import { renderLogsPage } from './logs-page';
import { buildOcsConfig } from './ocs-config';
import { parseLlmAnswer } from './parse';

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
      return json(
        buildOcsConfig(url.origin, {
          token: env.AUTH_TOKEN,
          apiKey: url.searchParams.get('apiKey') || undefined,
          baseUrl: url.searchParams.get('baseUrl') || undefined,
          model: url.searchParams.get('model') || undefined
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
      // 浏览器无法带 Authorization 头, 页面路由额外接受 ?token= 参数
      const tokenOk =
        !env.AUTH_TOKEN ||
        request.headers.get('Authorization') === `Bearer ${env.AUTH_TOKEN}` ||
        url.searchParams.get('token') === env.AUTH_TOKEN;
      if (!tokenOk) return json({ code: 1, msg: '未授权' }, 401);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      const rows = (await queryLogs(env, limit)) as unknown[];
      return new Response(renderLogsPage(rows as Parameters<typeof renderLogsPage>[0], url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
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
    model: typeof body.model === 'string' && body.model ? body.model : undefined
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserContent(title, options, type, images, visionEnabled) }
  ];

  try {
    const { content, model, latencyMs, usage } = await callLlm(env, messages, llmConfig);
    const { answers, reason } = parseLlmAnswer(content, type);
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