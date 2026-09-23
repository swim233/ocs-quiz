import { useCallback, useEffect, useMemo, useState } from 'react';
import { Detail } from './Detail';
import { LogList } from './LogList';
import type { LogRow } from './format';
import { IconImage, IconLogout, IconMoon, IconSearch, IconSun } from './icons';
import { Lightbox, type ZoomTarget } from './rich';

const TOKEN_KEY = 'ocs-quiz-token';
const THEME_KEY = 'ocs-quiz-theme';

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

function matchesQuery(row: LogRow, q: string): boolean {
  return [row.title, row.options, row.answers, row.reason, row.error, row.model].some((v) =>
    (v || '').toLowerCase().includes(q)
  );
}

export default function App() {
  const [token, setToken] = useState(() => readStorage(TOKEN_KEY) || '');
  const [loginInput, setLoginInput] = useState(token);
  const [theme, setTheme] = useState<Theme>(() => (readStorage(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(50);
  const [refreshedAt, setRefreshedAt] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  const load = useCallback(async (t: string, lim: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/logs?limit=${lim}`, { headers: { Authorization: `Bearer ${t}` } });
      if (res.status === 401) {
        writeStorage(TOKEN_KEY, null);
        setToken('');
        setError('Token 无效, 请重新登录');
        return;
      }
      const data = (await res.json()) as { code: number; msg?: string; data?: LogRow[] };
      if (data.code !== 0 || !data.data) {
        setError(data.msg || '加载失败');
        return;
      }
      setRows(data.data);
      setRefreshedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) void load(token, limit);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

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
    writeStorage(TOKEN_KEY, null);
    setToken('');
    setRows([]);
  };

  const themeToggle = (
    <button
      type="button"
      className="btn"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={theme === 'dark' ? '当前为暗色主题，切换到亮色' : '当前为亮色主题，切换到暗色'}
    >
      {theme === 'dark' ? <IconMoon /> : <IconSun />}
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
            placeholder="搜索题目、选项、答案、错误…"
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
          className="btn btn-primary"
          onClick={() => void load(token, limit)}
          disabled={loading}
          title={refreshedAt ? `更新于 ${refreshedAt}` : undefined}
        >
          {loading ? '加载中…' : '刷新'}
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
          onSelect={setSelectedId}
          loading={loading}
        />
        <main className="detail">
          {selected ? (
            <Detail key={selected.id} row={selected} onZoom={setZoom} />
          ) : (
            <p className="detail-empty">{loading ? '加载中…' : '暂无日志记录'}</p>
          )}
        </main>
      </div>
      {zoom && <Lightbox target={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
