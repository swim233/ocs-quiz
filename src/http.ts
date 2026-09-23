/** CORS 头:OCS 在浏览器里用 fetch 跨域调用,必须放行 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * 若配置了 token, 要求请求携带 Authorization: Bearer <token>; 未配置时放行。
 * 传入 url 时额外接受 ?token= 参数 (浏览器直接打开或 OCS 从 URL 导入配置时无法带请求头)。
 */
export function authorize(request: Request, token?: string, url?: URL): boolean {
  if (!token) return true;
  return (
    request.headers.get("Authorization") === `Bearer ${token}` ||
    url?.searchParams.get("token") === token
  );
}

/**
 * 请求方 IP。CF-Connecting-IP 由 Cloudflare 边缘写入, 客户端无法伪造;
 * X-Forwarded-For 可被客户端自行填写, 不采用。本地 wrangler dev 下同样会设置。
 */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "";
}
