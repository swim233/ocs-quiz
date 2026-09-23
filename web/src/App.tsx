import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Detail } from './Detail';
import { LogList } from './LogList';
import { timeParts, type LogRow } from './format';
import { IconImage, IconLogout, IconMoon, IconRefresh, IconSearch, IconSun } from './icons';
import { Lightbox, type ZoomTarget } from './rich';

const TOKEN_KEY = 'ocs-quiz-token';
const THEME_KEY = 'ocs-quiz-theme';
const AUTO_REFRESH_KEY = 'ocs-quiz-auto-refresh';
const AUTO_REFRESH_MS = 3000;

type Theme = 'dark' | 'light';
type Filter = 'all' | 'ok' | 'no_answer' | 'failed' | 'images';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ok', label: '成功' },
  { key: 'no_answer', label: '无答案' },
  { key: 'failed', label: '失败' },
  { key: 'images', label: '含图片' }
];

// localStorage 在隐私模式等场景可能不可用, 读写失败时静默降级
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function matchesFilter(row: LogRow, filter: Filter): boolean {
  switch (filter) {
    case 'ok':
      return row.status === 'ok';
    case 'no_answer':
      return row.status === 'no_answer';
    case 'failed':
      return row.status === 'error' || row.status === 'unauthorized';
    case 'images':
      return row.images > 0;
    default:
      return true;
  }
}

/** 日志只插入不修改, id 序列相同即内容相同 */
function sameIds(a: LogRow[], b: LogRow[]): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i].id);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function matchesQuery(row: LogRow, q: string): boolean {
  return [row.title, row.options, row.answers, row.reason, row.error, row.model, row.ip].some((v) =>
    (v || '').toLowerCase().includes(q)
  );
}

export default function App() {
  const [token, setToken] = useState(() => readStorage(TOKEN_KEY) || '');
  const [loginInput, setLoginInput] = useState(token);
  const [theme, setTheme] = useState<Theme>(() => (readStorage(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [rows, setRows] = useState<LogRow[]>([]);
  /** id 大于该值的记录是实时刷新新到达的, 列表中高亮一次; 首次加载不高亮 */
  const [freshAfter, setFreshAfter] = useState(Infinity);
  const [autoRefresh, setAutoRefresh] = useState(() => readStorage(AUTO_REFRESH_KEY) !== 'off');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(50);
  const [refreshedAt, setRefreshedAt] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);

  const rowsRef = useRef<LogRow[]>([]);
  /** 每次请求递增; 只有最新一次请求的响应会被采用 (如切换条数时丢弃旧条数的轮询结果) */
  const seqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => writeStorage(AUTO_REFRESH_KEY, autoRefresh ? 'on' : 'off'), [autoRefresh]);

  /** silent: 实时刷新的后台轮询, 不显示加载态, 也不在请求前清掉错误提示, 避免每 3 s 闪一次 */
  const load = useCallback(async (t: string, lim: number, silent = false) => {
    if (silent && busyRef.current) return;
    const seq = ++seqRef.current;
    const latest = () => seq === seqRef.current;
    busyRef.current = true;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const res = await fetch(`/api/logs?limit=${lim}`, { headers: { Authorization: `Bearer ${t}` } });
      if (!latest()) return;
      if (res.status === 401) {
        writeStorage(TOKEN_KEY, null);
        setToken('');
        setError('Token 无效, 请重新登录');
        return;
      }
      const data = (await res.json()) as { code: number; msg?: string; data?: LogRow[]; timeoutMs?: number };
      if (!latest()) return;
      if (data.code !== 0 || !data.data) {
        setError(data.msg || '加载失败');
        return;
      }
      const prev = rowsRef.current;
      if (!sameIds(prev, data.data)) {
        rowsRef.current = data.data;
        setRows(data.data);
        setFreshAfter(prev.length ? Math.max(...prev.map((r) => r.id)) : Infinity);
      }
      setTimeoutMs(data.timeoutMs ?? 0);
      setError('');
      setRefreshedAt(timeParts(new Date()).time);
    } catch (e) {
      if (latest()) setError(String(e));
    } finally {
      if (latest()) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (token) void load(token, limit);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 实时刷新: 每 3 s 静默拉取一次; 标签页在后台时跳过, 切回前台立即刷新
  useEffect(() => {
    if (!token || !autoRefresh) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void load(token, limit, true);
    };
    const timer = window.setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [token, limit, autoRefresh, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => matchesFilter(r, filter) && (!q || matchesQuery(r, q)));
  }, [rows, filter, query]);

  const selected = visible.find((r) => r.id === selectedId) ?? visible[0] ?? null;

  // ↑ ↓ 切换记录 (输入框内除外), Esc 关闭图片预览
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setZoom(null);
        return;
      }
      if (zoom || !selected || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const next = visible[visible.indexOf(selected) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        setSelectedId(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected, zoom]);

  const logout = () => {
    // 作废进行中的请求, 其响应不再写回
    seqRef.current++;
    busyRef.current = false;
    setLoading(false);
    writeStorage(TOKEN_KEY, null);
    setToken('');
    rowsRef.current = [];
    setRows([]);
    setFreshAfter(Infinity);
    setRefreshedAt('');
    setSelectedId(null);
  };

  // 主题切换做整页淡入淡出; 浏览器不支持 View Transitions 或用户偏好减少动效时直接切换
  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      document.documentElement.dataset.theme = next;
      flushSync(() => setTheme(next));
    };
    if ('startViewTransition' in document && !reducedMotion()) document.startViewTransition(apply);
    else apply();
  };

  const themeToggle = (
    <button
      type="button"
      className="btn"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? '当前为暗色主题，切换到亮色' : '当前为亮色主题，切换到暗色'}
    >
      <span key={theme} className="theme-icon">
        {theme === 'dark' ? <IconMoon /> : <IconSun />}
      </span>
      {theme === 'dark' ? '暗色' : '亮色'}
    </button>
  );

  if (!token) {
    return (
      <main className="login">
        <div className="login-head">
          <h1>OCS Quiz 日志</h1>
          {themeToggle}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = loginInput.trim();
            if (!t) return;
            writeStorage(TOKEN_KEY, t);
            setToken(t);
          }}
        >
          <label className="sr-only" htmlFor="token">
            访问 Token
          </label>
          <input
            id="token"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="输入访问 Token"
            autoFocus
          />
          <button type="submit" className="btn btn-primary">
            进入
          </button>
        </form>
        <p className="hint">Token 为部署时配置的 AUTH_TOKEN; 若 Worker 未配置, 填任意值即可进入。</p>
        {error && <p className="error-text">{error}</p>}
      </main>
    );
  }

  const okCount = rows.filter((r) => r.status === 'ok').length;
  const rate = rows.length ? ((okCount / rows.length) * 100).toFixed(1) : '0';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>OCS Quiz</strong>
          <span className="muted">日志</span>
        </div>
        <label className="search">
          <IconSearch />
          <span className="sr-only">搜索</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索题目、选项、答案、错误、IP…"
          />
        </label>
        <div className="seg" role="group" aria-label="按状态筛选">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.key === 'images' && <IconImage size={14} />}
              {f.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="muted small">
          最近 {rows.length} 条 · 成功率 {rate}%
        </span>
        <label className="limit muted small">
          条数
          <select
            className="btn btn-sm"
            value={limit}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLimit(v);
              void load(token, v);
            }}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={200}>200</option>
          </select>
        </label>
        {themeToggle}
        <button
          type="button"
          className="btn live"
          aria-pressed={autoRefresh}
          onClick={() => {
            if (!autoRefresh) void load(token, limit, true);
            setAutoRefresh(!autoRefresh);
          }}
          title={autoRefresh ? `每 ${AUTO_REFRESH_MS / 1000} 秒自动刷新，点击暂停` : '自动刷新已暂停，点击开启'}
        >
          <span className="live-dot" aria-hidden="true" />
          实时刷新
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void load(token, limit)}
          disabled={loading}
          aria-busy={loading}
          title={refreshedAt ? `更新于 ${refreshedAt}` : undefined}
        >
          <span className={`refresh-icon${loading ? ' spinning' : ''}`}>
            <IconRefresh />
          </span>
          刷新
        </button>
        <button type="button" className="btn icon-btn" onClick={logout} aria-label="退出">
          <IconLogout />
        </button>
      </header>
      {error && <p className="banner-error">{error}</p>}
      <div className="layout">
        <LogList
          rows={visible}
          total={rows.length}
          selectedId={selected?.id ?? null}
          following={selectedId === null}
          freshAfter={freshAfter}
          refreshedAt={refreshedAt}
          timeoutMs={timeoutMs}
          onSelect={setSelectedId}
          loading={loading}
        />
        <main className="detail">
          {selected ? (
            <Detail key={selected.id} row={selected} timeoutMs={timeoutMs} onZoom={setZoom} />
          ) : (
            <p className="detail-empty">{loading ? '加载中…' : '暂无日志记录'}</p>
          )}
        </main>
      </div>
      {zoom && <Lightbox target={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
