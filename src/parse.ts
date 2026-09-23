export interface ParsedAnswer {
  answers: string[];
  reason: string;
}

/**
 * 解析 LLM 输出为答案数组。
 *
 * LLM 被要求只输出 JSON: {"answers": [...], "reason": "..."}
 * 此处做宽松解析: 去掉代码围栏、截取 JSON 对象、兼容 answer/result 字段名。
 * JSON 解析失败时退化为纯文本按类型拆分。
 */
export function parseLlmAnswer(raw: string, type: string): ParsedAnswer {
  const text = stripFences(raw.trim());
  const obj = tryExtractJson(text);
  if (obj) {
    const rawAnswers = obj.answers ?? obj.answer ?? obj.result;
    const answers = Array.isArray(rawAnswers)
      ? rawAnswers.map((v: unknown) => String(v).trim()).filter(Boolean)
      : splitStringAnswers(typeof rawAnswers === 'string' ? rawAnswers : String(rawAnswers ?? ''), type);
    return {
      answers: dedupe(answers),
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : ''
    };
  }
  return { answers: dedupe(splitStringAnswers(text, type)), reason: '' };
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

function tryExtractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 纯文本答案拆分:
 * - completion: 只用 `|` 分隔(多个空), 避免拆坏含标点的答案文本
 * - 其他类型: 去掉常见分隔符后若为纯字母, 逐字符拆成选项字母;
 *   否则按常见分隔符拆分
 */
function splitStringAnswers(s: string, type: string): string[] {
  s = s.trim();
  if (!s) return [];
  if (type === 'completion') {
    return s
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  const cleaned = s.replace(/[,，.。、;；#\s]+/g, '');
  if (/^[A-Za-z]+$/.test(cleaned)) {
    return [...cleaned].map((c) => c.toUpperCase());
  }
  return s
    .split(/[,，.。、;；#|\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 把选项字母答案换成对应的选项原文。
 *
 * OCS 发来的 options 是按行排列、不带字母的选项文本, 而 OCS 的字母兜底匹配条件苛刻
 * (多选须为未拆分的升序大写串, 判断题只认对/错类词语), 返回原文可走 OCS 的文本匹配。
 * 仅当所有答案都是落在选项范围内的单个字母时才替换, 否则原样返回。
 */
export function lettersToOptionTexts(answers: string[], options: string): string[] {
  const lines = options
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const indexes = answers.map((a) => (/^[A-Za-z]$/.test(a) ? a.toUpperCase().charCodeAt(0) - 65 : -1));
  if (indexes.length === 0 || indexes.some((i) => i < 0 || i >= lines.length)) return answers;
  return dedupe(indexes.map((i) => lines[i]));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}