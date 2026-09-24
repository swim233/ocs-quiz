/**
 * 生成 OCS AnswererWrapper 配置。
 *
 * 在 OCS 设置 -> 题库配置 中粘贴该 JSON, 或直接填入 /ocs-config.json 的地址
 * (AnswerWrapperParser 支持从 URL 加载配置; OCS 仅在保存时拉取一次, 结果存于本地)。
 * 若配置了 AUTH_TOKEN: 携带正确 token (?token= 或 Bearer 头) 时内嵌真实 token,
 * 否则写入占位符 TOKEN_PLACEHOLDER。带 token 的 URL 等同于 token 本身, 注意保管。
 */
import type { FailedAttempt, LlmConfig } from './llm';

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
      // 多个答案用 # 连接: # 在 OCS 分隔符中优先级最高, 且不会像 | 那样在代码类答案中被禁用;
      // 第三项为 extra_data ({ ai, tags }, tags 见 buildAnswerTags); OCS 是否显示取决于版本, 实测部分版本只显示答案
      handler:
        "return (res)=> res.code === 0 ? [res.data.question, res.data.answers.join('#'), { ai: true, tags: res.data.tags }] : [res.msg, undefined]"
    }
  ];
}

/** OCS 答案标签; color 为 OCS 预置的样式类名 */
export interface OcsTag {
  text: string;
  title: string;
  color: 'blue' | 'green' | 'gray' | 'red' | 'yellow';
}

/**
 * 生成答案标签, 由 handler 原样透传给 OCS; 放在服务端生成, 以后调整标签无需用户重新复制配置。
 * OCS 是否显示取决于版本: 按 4.15 源码会显示在搜索结果的答案前, 但实测部分版本只显示答案, 不显示标签。
 * - 模型名, 悬停显示服务商域名与思考强度
 * - 发生降级时追加「降级 #N」(N 为作答候选的序号), 悬停列出前面候选的失败原因
 * 按 4.15 源码, OCS 以 innerHTML 插入 text, 悬停提示 (easy-us tooltip) 也以 innerHTML 渲染 title (\n 转为 <br>), 两者都需转义。
 */
export function buildAnswerTags(candidate: LlmConfig, index: number, fallbacks: FailedAttempt[]): OcsTag[] {
  const modelTitle = [hostOf(candidate.baseUrl), candidate.thinkEffort ? `思考强度: ${candidate.thinkEffort}` : '']
    .filter(Boolean)
    .join('\n');
  const tags: OcsTag[] = [{ text: escapeHtml(candidate.model), title: escapeHtml(modelTitle), color: 'gray' }];
  if (fallbacks.length) {
    const lines = fallbacks.map((f) => `#${f.index} ${f.model}: ${f.error.slice(0, 100)}`);
    tags.push({ text: `降级 #${index}`, title: escapeHtml(['前面的候选失败:', ...lines].join('\n')), color: 'yellow' });
  }
  return tags;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}