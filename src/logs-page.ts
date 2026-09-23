/** /logs 只读日志页面: 服务端渲染表格, 零外部依赖 */
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
}

const STATUS_LABEL: Record<string, string> = {
  ok: '成功',
  no_answer: '无答案',
  error: '失败',
  unauthorized: '未授权'
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRow(row: LogRow): string {
  const status = row.status in STATUS_LABEL ? STATUS_LABEL[row.status] : row.status;
  return `<tr>
    <td>${escapeHtml(row.ts)}</td>
    <td>${escapeHtml(row.question_type)}</td>
    <td class="status-${escapeHtml(row.status)}">${escapeHtml(status)}</td>
    <td>${row.images}</td>
    <td>${escapeHtml(row.model)}</td>
    <td class="title">${escapeHtml(row.title)}</td>
    <td class="title">${escapeHtml(row.answers)}</td>
    <td>${row.latency_ms}ms</td>
    <td class="title">${escapeHtml(row.error)}</td>
  </tr>`;
}

export function renderLogsPage(rows: LogRow[], origin: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>OCS Quiz 日志</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; background: #0f1115; color: #e6e6e6; }
h1 { font-size: 20px; }
p.meta { color: #9ca3af; font-size: 13px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border: 1px solid #2a2d35; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #1a1d24; position: sticky; top: 0; }
.title { max-width: 380px; word-break: break-all; }
.status-ok { color: #4ade80; font-weight: 600; }
.status-no_answer { color: #facc15; font-weight: 600; }
.status-error { color: #f87171; font-weight: 600; }
a { color: #60a5fa; }
</style>
</head>
<body>
<h1>OCS Quiz 日志</h1>
<p class="meta">共 ${rows.length} 条 · <a href="${origin}/logs?limit=50">刷新</a> · <a href="${origin}/logs?limit=200">最近 200 条</a></p>
<table>
<thead><tr><th>时间 (UTC)</th><th>题型</th><th>状态</th><th>图片</th><th>模型</th><th>题目</th><th>答案</th><th>耗时</th><th>错误</th></tr></thead>
<tbody>
${rows.map(renderRow).join('\n')}
</tbody>
</table>
</body>
</html>`;
}