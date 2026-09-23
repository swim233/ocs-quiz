/**
 * 生成 OCS AnswererWrapper 配置。
 *
 * 在 OCS 设置 -> 题库配置 中粘贴该 JSON, 或直接填入 /ocs-config.json 的地址
 * (AnswerWrapperParser 支持从 URL 加载配置; OCS 仅在保存时拉取一次, 结果存于本地)。
 * 若配置了 AUTH_TOKEN: 携带正确 token (?token= 或 Bearer 头) 时内嵌真实 token,
 * 否则写入占位符 TOKEN_PLACEHOLDER。带 token 的 URL 等同于 token 本身, 注意保管。
 */
export const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

export interface OcsConfigOptions {
  /** 写入 Authorization 头的 token (真实值或占位符); 未配置 AUTH_TOKEN 时省略 */
  token?: string;
  /** BYOK 配置, 通过 /ocs-config.json?apiKey=...&baseUrl=...&model=... 回显; 未提供时留空, 提示用户填写 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 可选的思考强度 (?thinkEffort=), 留空表示使用服务商默认强度 */
  thinkEffort?: string;
}

export function buildOcsConfig(origin: string, options: OcsConfigOptions = {}): unknown[] {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const data: Record<string, string> = {
    title: '${title}',
    options: '${options}',
    type: '${type}',
    apiKey: options.apiKey || '',
    baseUrl: options.baseUrl || '',
    model: options.model || '',
    thinkEffort: options.thinkEffort || ''
  };
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
      // 多个答案用 # 连接: # 在 OCS 分隔符中优先级最高, 且不会像 | 那样在代码类答案中被禁用
      handler: "return (res)=> res.code === 0 ? [res.data.question, res.data.answers.join('#')] : [res.msg, undefined]"
    }
  ];
}