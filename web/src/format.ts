/** /api/logs 返回的一行日志 (与 schema.sql 保持同步) */
export interface LogRow {
  id: number;
  ts: string;
  question_type: string;
  title: string;
  options: string;
  images: number;
  model: string;
  answers: string;
  reason: string;
  latency_ms: number;
  status: string;
  error: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  /** 迁移前的旧记录可能缺失 */
  think_effort?: string;
  /** 请求方 IP; 新增该列之前的旧记录为空串 */
  ip?: string;
  /** 最后一次尝试的候选的 baseUrl; 旧记录缺失或为空串 */
  base_url?: string;
  /** 此前失败的尝试, JSON 数组 (见 parseFallbacks); 无降级为空串 */
  fallbacks?: string;
}

/** 一次失败的尝试 (与服务端 FailedAttempt 保持同步) */
export interface Fallback {
  index: number;
  baseUrl: string;
  model: string;
  thinkEffort: string;
  error: string;
  latencyMs: number;
}

/** 空串、旧记录缺失或无法解析时返回空数组; 忽略不是对象的元素 */
export function parseFallbacks(raw?: string): Fallback[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((f): f is Fallback => typeof f === 'object' && f !== null && !Array.isArray(f))
      : [];
  } catch {
    return [];
  }
}

/** 列表与详情中展示 baseUrl 时只取域名 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export const STATUS_LABEL: Record<string, string> = {
  ok: '成功',
  no_answer: '无答案',
  error: '失败',
  unauthorized: '未授权'
};

const TYPE_LABEL: Record<string, string> = {
  single: '单选',
  multiple: '多选',
  judgement: '判断',
  completion: '填空',
  unknown: '未知'
};

export const typeLabel = (type: string) => TYPE_LABEL[type] ?? type;

/** 耗时分级着色: 较慢标黄, 很慢标橙, 接近超时上限 (LLM_TIMEOUT_MS 的 2/3) 标红并提示 */
const SLOW_MS = 5000;
const VERY_SLOW_MS = 20000;
const NEAR_TIMEOUT_RATIO = 2 / 3;

export type LatencyLevel = 'slow' | 'very-slow' | 'near-timeout';

export const LATENCY_LABEL: Record<LatencyLevel, string> = {
  slow: '较慢（≥ 5 s）',
  'very-slow': '很慢（≥ 20 s）',
  'near-timeout': '接近超时上限'
};

/** timeoutMs 为服务端的 LLM_TIMEOUT_MS, 未知时传 0 (不判断接近超时) */
export function latencyLevel(ms: number, timeoutMs: number): LatencyLevel | null {
  if (timeoutMs > 0 && ms >= timeoutMs * NEAR_TIMEOUT_RATIO) return 'near-timeout';
  if (ms >= VERY_SLOW_MS) return 'very-slow';
  if (ms >= SLOW_MS) return 'slow';
  return null;
}

export const EFFORT_STEPS = ['默认', 'none', 'low', 'high', 'max'];

// ---------- 时间: 统一按北京时间展示 ----------

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short'
});

export interface TimeParts {
  /** YYYY-MM-DD, 用于分组 */
  date: string;
  /** HH:MM:SS */
  time: string;
  year: number;
  month: number;
  day: number;
  weekday: string;
}

export function timeParts(value: string | Date): TimeParts {
  const p: Record<string, string> = {};
  for (const part of TIME_FORMAT.formatToParts(new Date(value))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: p.weekday
  };
}

export function dayLabel(tp: TimeParts, now = new Date()): string {
  const today = timeParts(now);
  const yesterday = timeParts(new Date(now.getTime() - 86_400_000));
  const md = `${tp.month}月${tp.day}日`;
  if (tp.date === today.date) return `今天 · ${md}`;
  if (tp.date === yesterday.date) return `昨天 · ${md}`;
  return `${tp.year === today.year ? '' : `${tp.year}年`}${md} ${tp.weekday}`;
}

export function formatLatency(ms: number): string {
  return ms ? `${(ms / 1000).toFixed(2)} s` : '—';
}

// ---------- 题目文本: 图片 URL 与文字混排 ----------

export type Segment = { kind: 'text'; text: string } | { kind: 'image'; url: string };

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
/**
 * 1) 以图片扩展名结尾的最短 URL: 超星会把多张图片与文字直接拼接,
 *    如 "https://…/a.png/2+https://…/b.png的渐进表达式", 需在第一个扩展名处截断
 * 2) 其余 URL: 截止到空白、括号或中文字符
 */
const URL_RE =
  /https?:\/\/[^\s"'<>()\\　-〿一-鿿＀-￯]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s"'<>()\\　-〿一-鿿＀-￯]*)?(?![A-Za-z0-9])|https?:\/\/[^\s"'<>()\\　-〿一-鿿＀-￯]+/gi;

export function splitRichText(text: string): Segment[] {
  const src = text.replace(MARKDOWN_IMAGE_RE, '$1');
  const segments: Segment[] = [];
  let last = 0;
  for (const m of src.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const start = m.index ?? 0;
    if (start > last) segments.push({ kind: 'text', text: src.slice(last, start) });
    segments.push({ kind: 'image', url });
    last = start + url.length;
  }
  if (last < src.length) segments.push({ kind: 'text', text: src.slice(last) });
  return segments;
}

/** 列表等单行场景: 图片替换为 [图] */
export function plainText(text: string): string {
  return splitRichText(text)
    .map((s) => (s.kind === 'text' ? s.text : '[图]'))
    .join('')
    .trim();
}

// ---------- 答案 ----------

export function parseAnswers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { answers?: unknown };
    if (Array.isArray(parsed.answers)) return parsed.answers.map(String);
  } catch {
    // answers 超长被截断时不是合法 JSON
  }
  return [];
}

export interface OptionView {
  letter: string;
  text: string;
  selected: boolean;
}

export interface RowView {
  answers: string[];
  options: OptionView[];
  /** 填空题 (或无选项题) 的逐空答案 */
  blanks: string[];
  /** 列表中的一行摘要 */
  summary: string;
  /** 返回给 OCS 的内容: 成功为 # 连接的答案, 无答案为 msg; 失败不展示 */
  returned: string[];
  returnedIsMsg: boolean;
}

export function analyzeRow(row: LogRow): RowView {
  const answers = parseAnswers(row.answers);
  const lines = row.options
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const isChoice = lines.length > 0 && row.question_type !== 'completion';
  // 新日志存选项原文, 修复前的旧日志存字母, 两种都要能匹配
  const options: OptionView[] = isChoice
    ? lines.map((text, i) => {
        const letter = String.fromCharCode(65 + i);
        return { letter, text, selected: answers.some((a) => a.trim() === text || a.trim().toUpperCase() === letter) };
      })
    : [];
  const blanks = isChoice ? [] : answers;

  let returned: string[] = [];
  let returnedIsMsg = false;
  if (row.status === 'ok') returned = answers;
  else if (row.status === 'no_answer') {
    returned = [`无法作答: ${row.reason || '模型未给出答案'}`];
    returnedIsMsg = true;
  }

  return { answers, options, blanks, summary: summarize(row, options, answers), returned, returnedIsMsg };
}

function summarize(row: LogRow, options: OptionView[], answers: string[]): string {
  if (row.status === 'no_answer') return `无法作答：${row.reason || '模型未给出答案'}`;
  if (row.status !== 'ok') return row.error || STATUS_LABEL[row.status] || row.status;
  const picked = options.filter((o) => o.selected);
  if (picked.length === 1) {
    const text = plainText(picked[0].text);
    return row.question_type === 'judgement' ? `答：${text}` : `答：${picked[0].letter} ${text}`;
  }
  if (picked.length > 1) return `答：${picked.map((o) => o.letter).join(' ')}`;
  if (answers.length > 1) return `答：${answers.length} 空`;
  if (answers.length === 1) return `答：${plainText(answers[0])}`;
  return '答：—';
}
