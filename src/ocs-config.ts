/**
 * 生成 OCS AnswererWrapper 配置。
 *
 * 在 OCS 设置 -> 题库配置 中粘贴该 JSON, 或直接填入 /ocs-config.json 的地址
 * (AnswerWrapperParser 支持从 URL 加载配置)。
 * 若配置了 AUTH_TOKEN, 会内嵌进 Authorization 头 —— 该接口是公开的,
 * 拿到 URL 的人即可使用你的题库; 介意的话手动粘贴配置并去掉 token。
 */
export interface OcsConfigOptions {
  token?: string;
  /** 请求方携带的 LLM 配置(可选, 通过 /ocs-config.json?apiKey=...&baseUrl=...&model=... 回显) */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export function buildOcsConfig(origin: string, options: OcsConfigOptions = {}): unknown[] {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const data: Record<string, string> = { title: '${title}', options: '${options}', type: '${type}' };
  if (options.apiKey) data.apiKey = options.apiKey;
  if (options.baseUrl) data.baseUrl = options.baseUrl;
  if (options.model) data.model = options.model;
  return [
    {
      name: 'OCS Quiz (LLM)',
      homepage: origin,
      url: `${origin}/api/search`,
      method: 'post',
      contentType: 'json',
      type: 'GM_xmlhttpRequest',
      headers,
      data,
      handler: "return (res)=> res.code === 0 ? [res.data.question, res.data.answers.join('|')] : undefined"
    }
  ];
}