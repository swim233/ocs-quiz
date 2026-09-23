/**
 * 本地联调用的假 LLM 服务 (node scripts/stub-llm.mjs, 监听 8788)。
 *
 * 行为:
 * - POST /v1/chat/completions: 若请求含 image_url 内容 -> 400 (模拟模型不支持视觉,
 *   触发 worker 的降级重试); 否则返回固定答案 {"answers":["B"],"reason":"stub answer"}。
 * - GET /last: 返回收到的所有请求 (user 消息 + 请求头), 用于验证多模态 payload
 *   与 apiKey 是否真实传递。
 */
import http from 'node:http';

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
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
      received.push({ content: userMsg, headers: req.headers, body: parsed });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"answers":["B"],"reason":"stub answer"}' } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 40 }
          }
        })
      );
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8788, '127.0.0.1', () => console.log('stub llm listening on 8788'));