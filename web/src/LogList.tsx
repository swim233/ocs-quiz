import { useEffect, useMemo, useRef } from 'react';
import {
  SLOW_MS,
  STATUS_LABEL,
  analyzeRow,
  dayLabel,
  formatLatency,
  plainText,
  timeParts,
  typeLabel,
  type LogRow
} from './format';
import { IconImage } from './icons';

interface Group {
  key: string;
  label: string;
  meta: string;
  rows: LogRow[];
}

/** 按北京时间日期分组 (rows 已按 id 倒序) */
function groupRows(rows: LogRow[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    const tp = timeParts(row.ts);
    let g = groups[groups.length - 1];
    if (!g || g.key !== tp.date) {
      g = { key: tp.date, label: dayLabel(tp), meta: '', rows: [] };
      groups.push(g);
    }
    g.rows.push(row);
  }
  for (const g of groups) {
    const count = (pred: (r: LogRow) => boolean) => g.rows.filter(pred).length;
    const ok = count((r) => r.status === 'ok');
    const failed = count((r) => r.status === 'error' || r.status === 'unauthorized');
    const noAnswer = count((r) => r.status === 'no_answer');
    const parts = [`${g.rows.length} 条`];
    if (ok === g.rows.length) parts.push('全部成功');
    else {
      if (ok) parts.push(`${ok} 成功`);
      if (failed) parts.push(`${failed} 失败`);
      if (noAnswer) parts.push(`${noAnswer} 无答案`);
    }
    g.meta = parts.join(' · ');
  }
  return groups;
}

function ListItem({ row, on, onSelect }: { row: LogRow; on: boolean; onSelect: (id: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [on]);

  const { summary } = analyzeRow(row);
  const failed = row.status === 'error' || row.status === 'unauthorized';
  const effort = row.think_effort || '';
  return (
    <button
      ref={ref}
      type="button"
      className={`item${on ? ' on' : ''}`}
      aria-current={on ? 'true' : undefined}
      onClick={() => onSelect(row.id)}
    >
      <span className="item-meta">
        <span className={`dot dot-${row.status}`} />
        <span>{STATUS_LABEL[row.status] ?? row.status}</span>
        <span>· {typeLabel(row.question_type)}</span>
        {row.images > 0 && (
          <span className="pill" title={`${row.images} 张图片`}>
            <IconImage size={12} />
            {row.images}
          </span>
        )}
        {effort && <span className="pill pill-effort">思考 {effort}</span>}
        <span className="grow" />
        <span className="mono">{timeParts(row.ts).time}</span>
      </span>
      <span className="item-title">{plainText(row.title) || '（无题目）'}</span>
      <span className={`item-sub${failed ? ' err' : ''}`}>
        {summary}
        {!failed && row.latency_ms > 0 && (
          <>
            {' · '}
            <span className={row.latency_ms >= SLOW_MS ? 'warn' : undefined}>{formatLatency(row.latency_ms)}</span>
          </>
        )}
      </span>
    </button>
  );
}

export function LogList({
  rows,
  total,
  selectedId,
  onSelect,
  loading
}: {
  rows: LogRow[];
  total: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
}) {
  const groups = useMemo(() => groupRows(rows), [rows]);
  return (
    <aside className="list" aria-label="日志列表">
      <div className="list-scroll">
        {groups.map((g) => (
          <section key={g.key}>
            <div className="group-head">
              <strong>{g.label}</strong>
              <span>{g.meta}</span>
            </div>
            {g.rows.map((row) => (
              <ListItem key={row.id} row={row} on={row.id === selectedId} onSelect={onSelect} />
            ))}
          </section>
        ))}
        {rows.length === 0 && (
          <p className="list-empty">{loading ? '加载中…' : total ? '没有匹配的记录' : '暂无日志记录'}</p>
        )}
      </div>
      <div className="list-foot">
        <span>
          显示 {rows.length} / {total} · 北京时间
        </span>
        <span>↑ ↓ 切换记录</span>
      </div>
    </aside>
  );
}
