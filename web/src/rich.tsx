import { useState } from 'react';
import { splitRichText } from './format';
import { IconClose, IconImageOff } from './icons';

export interface ZoomTarget {
  url: string;
  /** 原图尺寸, 未加载完成时为 0 */
  w: number;
  h: number;
}

type OnZoom = (target: ZoomTarget) => void;

/**
 * 题目图片。超星图床会拒绝带其他站点 Referer 的请求 (403),
 * 所以 <img> 与原图链接都不带 Referer。
 * 小图 (公式碎片, 黑字透明底) 内联在文字中并垫浅色底, 大图 (表格、截图) 单独成块。
 */
function RichImage({ url, onZoom }: { url: string; onZoom: OnZoom }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a className="img-fail" href={url} target="_blank" rel="noreferrer" title={url}>
        <IconImageOff size={12} />
        图片
      </a>
    );
  }
  const block = size !== null && (size.h > 48 || size.w > 240);
  return (
    <button
      type="button"
      className={block ? 'img-block' : 'img-inline'}
      onClick={() => onZoom({ url, w: size?.w ?? 0, h: size?.h ?? 0 })}
      aria-label="放大图片"
    >
      <img
        src={url}
        referrerPolicy="no-referrer"
        alt="题目图片"
        loading="lazy"
        style={block && size ? { width: Math.min(Math.round(size.w * 1.25), 520) } : undefined}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
      />
      {block && size && (
        <span className="img-caption">
          原图 {size.w}×{size.h} px
          <br />
          点击放大
        </span>
      )}
    </button>
  );
}

/** 渲染夹带图片 URL 的题目 / 选项文本 */
export function RichText({ text, onZoom }: { text: string; onZoom: OnZoom }) {
  return (
    <>
      {splitRichText(text).map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <RichImage key={`${i}:${seg.url}`} url={seg.url} onZoom={onZoom} />
        )
      )}
    </>
  );
}

export function Lightbox({ target, onClose }: { target: ZoomTarget; onClose: () => void }) {
  const scale = target.w && target.h ? Math.min(8, 760 / target.w, 440 / target.h) : 1;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <strong>图片预览</strong>
          {target.w > 0 && (
            <span className="muted">
              原图 {target.w}×{target.h} px · 放大 {scale.toFixed(1)}×
            </span>
          )}
          <span className="grow" />
          <a href={target.url} target="_blank" rel="noreferrer">
            在新标签页打开原图
          </a>
          <button type="button" className="btn btn-sm icon-btn" onClick={onClose} aria-label="关闭预览">
            <IconClose />
          </button>
        </div>
        <div className="lightbox-body">
          <img
            src={target.url}
            referrerPolicy="no-referrer"
            alt="放大的题目图片"
            style={target.w ? { width: Math.round(target.w * scale) } : undefined}
          />
        </div>
        <span className="lightbox-url mono">{target.url}</span>
      </div>
    </div>
  );
}
