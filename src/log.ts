import type { Env } from './index';
import type { FailedAttempt } from './llm';

/** 与 schema.sql 保持同步; 幂等建表, 免除部署时手动 init 的顺序依赖 */
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'unknown',
  title TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',
  images INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  think_effort TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  fallbacks TEXT NOT NULL DEFAULT ''
)`;

/** 旧库(无 token / think_effort / ip / base_url / fallbacks 列)的幂等迁移: 重复列报错会被忽略 */
const MIGRATIONS = [
  'ALTER TABLE logs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE logs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE logs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE logs ADD COLUMN think_effort TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE logs ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE logs ADD COLUMN base_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE logs ADD COLUMN fallbacks TEXT NOT NULL DEFAULT ''"
];

let schemaReady = false;

async function ensureSchema(env: Env): Promise<boolean> {
  if (schemaReady) return true;
  try {
    await env.DB!.prepare(CREATE_TABLE_SQL).run();
    for (const sql of MIGRATIONS) {
      try {
        await env.DB!.prepare(sql).run();
      } catch {
        // duplicate column: 已迁移过
      }
    }
    schemaReady = true;
    return true;
  } catch (err) {
    console.error('D1 建表失败', err);
    return false;
  }
}

export interface SearchLog {
  questionType: string;
  title: string;
  options: string;
  images: number;
  model: string;
  answers: string;
  reason: string;
  latencyMs: number;
  status: 'ok' | 'no_answer' | 'error' | 'unauthorized';
  error: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 请求携带的思考强度, 未携带为空串 */
  thinkEffort: string;
  /** 请求方 IP (CF-Connecting-IP), 取不到为空串 */
  ip: string;
  /** 最后一次尝试的候选的 baseUrl (与 model / thinkEffort / error 对应), 未尝试为空串 */
  baseUrl: string;
  /** 最后一次尝试之前失败的尝试 */
  fallbacks: FailedAttempt[];
}

export async function logSearch(env: Env, entry: SearchLog): Promise<void> {
  if (!env.DB || env.LOG_ENABLED === 'false') return;
  if (!(await ensureSchema(env))) return;
  try {
    await env.DB.prepare(
      `INSERT INTO logs (ts, question_type, title, options, images, model, answers, reason, latency_ms, status, error, prompt_tokens, completion_tokens, cached_tokens, think_effort, ip, base_url, fallbacks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        new Date().toISOString(),
        entry.questionType,
        entry.title.slice(0, 500),
        entry.options.slice(0, 2000),
        entry.images,
        entry.model,
        entry.answers.slice(0, 1000),
        entry.reason,
        entry.latencyMs,
        entry.status,
        entry.error.slice(0, 1000),
        entry.promptTokens,
        entry.completionTokens,
        entry.cachedTokens,
        entry.thinkEffort.slice(0, 32),
        entry.ip.slice(0, 64),
        entry.baseUrl.slice(0, 500),
        serializeFallbacks(entry.fallbacks)
      )
      .run();
  } catch (err) {
    console.error('D1 日志写入失败', err);
  }
}

/** 逐条截断 error 后再序列化, 保证存入的始终是合法 JSON; 无降级时存空串 */
function serializeFallbacks(fallbacks: FailedAttempt[]): string {
  if (!fallbacks.length) return '';
  return JSON.stringify(fallbacks.map((f) => ({ ...f, baseUrl: f.baseUrl.slice(0, 500), error: f.error.slice(0, 300) })));
}

export async function queryLogs(env: Env, limit: number): Promise<unknown[]> {
  if (!env.DB) return [];
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return results;
}