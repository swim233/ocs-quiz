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

/** 若配置了 AUTH_TOKEN, 要求请求携带 Authorization: Bearer <token> */
export function authorize(request: Request, token?: string): boolean {
  if (!token) return true;
  return request.headers.get("Authorization") === `Bearer ${token}`;
}
