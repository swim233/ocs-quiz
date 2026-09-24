/**
 * 本地联调用的假 LLM 服务 (node scripts/stub-llm.mjs, 监听 8788)。
 *
 * 行为:
 * - POST <任意前缀>/chat/completions: 前缀不同即可当作不同的 baseUrl
 *   (如 http://127.0.0.1:8788/a/v1 与 /b/v1), 用于验证 providers 降级。
 *   按 Bearer key 模拟候选故障 (验证换下一个候选):
 *   fail-401 -> 401 (错误信息回显打码的 key), fail-429 -> 429, fail-500 -> 500,
 *   slow-<ms> -> 延迟 <ms> 毫秒后正常作答 (验证总时限)。
 *   其余 key: 若请求含 image_url 内容 -> 400 (模拟模型不支持视觉, 触发候选内部的兼容性降级);
 *   若题目含 NOANSWER -> 返回空答案 (验证「无法作答」路径);
 *   否则返回固定答案 {"answers":["B"],"reason":"stub answer"}。
 * - GET /last: 返回收到的所有请求 (user 消息 + 请求头), 用于验证多模态 payload
 *   与 apiKey 是否真实传递。
 * - GET /reset: 清空请求记录, 便于统计单次搜题触发的 LLM 调用次数。
 */
import http from 'node:http';

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      const userMsg = (parsed.messages || []).find((m) => m.role === 'user');
      received.push({ url: req.url, content: userMsg, headers: req.headers, body: parsed });
      const key = (req.headers.authorization || '').replace(/^Bearer /, '');
      const failure = FAILURES[key];
      if (failure) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: failure.message } }));
        return;
      }
      const delay = /^slow-(\d+)$/.exec(key);
      setTimeout(() => answer(res, userMsg), delay ? Number(delay[1]) : 0);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.method === 'GET' && req.url === '/reset') {
    received.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

const FAILURES = {
  'fail-401': { status: 401, message: 'Incorrect API key provided: fail-****401' },
  'fail-429': { status: 429, message: 'Rate limit reached' },
  'fail-500': { status: 500, message: 'Internal server error' }
};

function answer(res, userMsg) {
  const hasImage =
    Array.isArray(userMsg?.content) && userMsg.content.some((p) => p.type === 'image_url');
  if (hasImage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'this model does not support images', type: 'invalid_request_error' }
      })
    );
    return;
  }
  const text = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content ?? '');
  const content = text.includes('NOANSWER')
    ? '{"answers":[],"reason":"题目信息不足"}'
    : '{"answers":["B"],"reason":"stub answer"}';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 40 }
      }
    })
  );
}

server.listen(8788, '127.0.0.1', () => console.log('stub llm listening on 8788'));
