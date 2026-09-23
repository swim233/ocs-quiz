import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import {
  LATENCY_LABEL,
  STATUS_LABEL,
  analyzeRow,
  dayLabel,
  formatLatency,
  latencyLevel,
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

interface ItemProps {
  row: LogRow;
  on: boolean;
  /** 实时刷新新到达的记录, 挂载时高亮一次 */
  fresh: boolean;
  /** 在列表中的序号, 用于入场动画错开 */
  index: number;
  /** 选中时是否滚动到可见; 跟随最新记录时不滚动, 以免把用户正在浏览的列表拉回顶部 */
  scrollOnSelect: boolean;
  timeoutMs: number;
  onSelect: (id: number) => void;
}

function ListItem({ row, on, fresh, index, scrollOnSelect, timeoutMs, onSelect }: ItemProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on && scrollOnSelect) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  const { summary } = analyzeRow(row);
  const failed = row.status === 'error' || row.status === 'unauthorized';
  const effort = row.think_effort || '';
  const level = latencyLevel(row.latency_ms, timeoutMs);
  return (
    <button
      ref={ref}
      type="button"
      className={`item${on ? ' on' : ''}${fresh ? ' fresh' : ''}`}
      style={{ '--i': index } as CSSProperties}
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
            <span className={level ? `lat-${level}` : undefined} title={level ? LATENCY_LABEL[level] : undefined}>
              {formatLatency(row.latency_ms)}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

/** 首次加载时的占位骨架 */
function Skeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="sk-item">
          <span className="sk sk-meta" />
          <span className="sk sk-title" />
          <span className="sk sk-sub" />
        </div>
      ))}
    </div>
  );
}

export function LogList({
  rows,
  total,
  selectedId,
  following,
  freshAfter,
  refreshedAt,
  timeoutMs,
  onSelect,
  loading
}: {
  rows: LogRow[];
  total: number;
  selectedId: number | null;
  /** 用户未手动选择, 选中项自动跟随最新记录 */
  following: boolean;
  freshAfter: number;
  refreshedAt: string;
  /** 服务端的 LLM_TIMEOUT_MS, 用于耗时着色; 未知时为 0 */
  timeoutMs: number;
  onSelect: (id: number) => void;
  loading: boolean;
}) {
  const groups = useMemo(() => groupRows(rows), [rows]);
  let index = 0;
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
              <ListItem
                key={row.id}
                row={row}
                on={row.id === selectedId}
                fresh={row.id > freshAfter}
                index={index++}
                scrollOnSelect={!following}
                timeoutMs={timeoutMs}
                onSelect={onSelect}
              />
            ))}
          </section>
        ))}
        {rows.length === 0 &&
          (loading && total === 0 ? (
            <>
              <p className="sr-only">加载中…</p>
              <Skeleton />
            </>
          ) : (
            <p className="list-empty">{total ? '没有匹配的记录' : '暂无日志记录'}</p>
          ))}
      </div>
      <div className="list-foot">
        <span>
          显示 {rows.length} / {total}
          {refreshedAt && (
            <>
              {' · 更新于 '}
              {/* freshAfter 只在数据有变化时改变, 以它为 key 让时间仅在有新数据时闪一下 */}
              <span key={freshAfter} className="mono tick">
                {refreshedAt}
              </span>
            </>
          )}
        </span>
        <span>北京时间 · ↑ ↓ 切换记录</span>
      </div>
    </aside>
  );
}
