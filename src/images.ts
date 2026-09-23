/**
 * 从题目/选项文本中提取图片 URL。
 *
 * OCS 在超星/爱课程/智慧树的搜题流程中会把题目和选项里的 <img> src
 * 以隐藏文本追加进 title/options(optimizationElementWithImage),
 * 因此图片题会以裸 URL 形式出现在文本里。
 *
 * 提取策略:
 * 1. markdown 图片语法 ![alt](url)
 * 2. 裸 http(s) URL, 排除明显的非图片扩展名
 *    (无扩展名或未知扩展名的图床链接也保留, 交给多模态模型; 若模型不支持
 *    图片, llm.ts 会自动降级为纯文本重试)
 */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s"'<>()\\]+/gi;
const NON_IMAGE_EXT_RE = /\.(html?|css|js|json|xml|txt|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp[34]|mov|avi|wav|m4a)(?:[?#].*)?$/i;

export const MAX_IMAGES = 4;

export function extractImageUrls(...texts: string[]): string[] {
  const text = texts.join('\n');
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };

  for (const m of text.matchAll(MARKDOWN_IMAGE_RE)) push(m[1]);
  for (const m of text.matchAll(BARE_URL_RE)) {
    const u = m[0].replace(/[),.;:!?。，、]+$/, '');
    if (!NON_IMAGE_EXT_RE.test(u)) push(u);
  }
  return urls.slice(0, MAX_IMAGES);
}