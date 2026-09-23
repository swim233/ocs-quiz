import { useEffect, useState } from 'react';

interface LogRow {
  id: number;
  ts: string;
  question_type: string;
  title: string;
  images: number;
  model: string;
  answers: string;
  latency_ms: number;
  status: string;
  error: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

const TOKEN_KEY = 'ocs-quiz-token';
const STATUS_LABEL: Record<string, string> = { ok: '成功', no_answer: '无答案', error: '失败', unauthorized: '未授权' };

function TokenCell({ label, value }: { label: string; value: number }) {
  return (
    <span className={`token ${value > 0 ? 'token-hot' : ''}`}>
      {label} {value}
    </span>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [loginInput, setLoginInput] = useState(token);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(50);
  const [refreshedAt, setRefreshedAt] = useState('');

  const load = async (t: string, lim: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/logs?limit=${lim}`, {
        headers: { Authorization: `Bearer ${t}` }
      });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
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
      setRefreshedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void load(token, limit);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!token) {
    return (
      <main className="login">
        <h1>OCS Quiz 日志</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = loginInput.trim();
            if (!t) return;
            localStorage.setItem(TOKEN_KEY, t);
            setToken(t);
          }}
        >
          <input
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="输入访问 Token"
            autoFocus
          />
          <button type="submit">进入</button>
        </form>
        <p className="hint">Token 为部署时配置的 AUTH_TOKEN; 若 Worker 未配置, 填任意值即可进入。</p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>OCS Quiz 日志</h1>
        <div className="controls">
          <label>
            条数
            <select
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
          <button onClick={() => void load(token, limit)} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
          {refreshedAt && <span className="hint">更新于 {refreshedAt}</span>}
          <button
            className="logout"
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken('');
            }}
          >
            退出
          </button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>时间 (UTC)</th>
            <th>题型</th>
            <th>状态</th>
            <th>图</th>
            <th>模型</th>
            <th>Token 入/出/缓存</th>
            <th>题目</th>
            <th>答案</th>
            <th>耗时</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.ts}</td>
              <td>{r.question_type}</td>
              <td className={`status-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</td>
              <td>{r.images}</td>
              <td>{r.model}</td>
              <td className="tokens">
                <TokenCell label="入" value={r.prompt_tokens} />
                <TokenCell label="出" value={r.completion_tokens} />
                <TokenCell label="缓存" value={r.cached_tokens} />
              </td>
              <td className="title">{r.title}</td>
              <td className="title">{r.answers}</td>
              <td>{r.latency_ms}ms</td>
              <td className="title">{r.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && <p className="hint">暂无日志记录</p>}
    </main>
  );
}