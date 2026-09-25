/** Source selection only: no model calls and no writes. */
export type ContextSource = {
  id: string;
  label: string;
  title: string;
  paragraphs: string[];
  /** Only a summary whose hash matches the current original may be supplied. */
  summary?: string | null;
};
export const WRITING_CONTEXT_CHARS = 5000;

function terms(query: string) {
  const stop = new Set(["그리고", "하지만", "있는", "없는", "한다", "대한", "통해", "위해", "내용", "사례", "설명", "작성", "집필", "이번", "독자"]);
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .flatMap(t => [t, t.replace(/(에서는|으로는|에서|에게|으로|까지|부터|이란|이랑|처럼|은|는|을|를|의|에|와|과)$/u, "")])
    .filter(t => t.length >= 2 && !stop.has(t)))].slice(0, 100);
}
function score(text: string, words: string[]) {
  const lower = text.toLowerCase();
  return words.reduce((n, word) => n + (lower.includes(word) ? 1 : 0), 0);
}
function clip(text: string, max: number) {
  if (max <= 0) return "";
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

function passage(text: string, words: string[], max: number, ending: boolean) {
  if (text.length <= max) return text;
  const positions = words.map(word => text.toLowerCase().indexOf(word)).filter(pos => pos >= 0);
  const focus = positions.length ? Math.min(...positions) : ending ? text.length : 0;
  const start = Math.max(0, Math.min(text.length - max + 2, focus - Math.floor(max / 3)));
  return (start ? "…" : "") + clip(text.slice(start), max - (start ? 1 : 0));
}

function excerpt(source: ContextSource, words: string[], max: number) {
  const rows = source.paragraphs.map((text, index) => ({ text, index, score: score(text, words) }));
  const ranked = [...rows].sort((a, b) => b.score - a.score || a.index - b.index);
  // Keep the ending for continuity and the opening for the section's main claim.
  const indices = [...new Set([ranked[0]?.index, rows.length - 1, 0].filter((n): n is number => n !== undefined && n >= 0))];
  const selected: { index: number; text: string }[] = [];
  let remaining = max;
  for (const index of indices) {
    const row = rows[index];
    if (!row || remaining < 50) continue;
    const allowance = Math.min(remaining, Math.max(200, Math.floor(max / Math.min(2, indices.length))));
    const label = `[문단 ${index + 1}] `;
    const text = label + passage(row.text, words, Math.max(1, allowance - label.length), index === rows.length - 1);
    selected.push({ index, text }); remaining -= text.length + 1;
  }
  return selected.sort((a, b) => a.index - b.index).map(row => row.text).join("\n");
}

/** Latest sources are mandatory; relevance reserves room for earlier related sections. */
export function writingContext(sources: ContextSource[], query: string, budget = WRITING_CONTEXT_CHARS) {
  if (budget <= 0) return "";
  const words = terms(query);
  const written = sources.map((source, order) => ({ source, order }))
    .filter(({ source }) => source.paragraphs.some(p => p.trim()));
  const recent = written.slice(-3).reverse();
  const earlier = written.slice(0, -3).map(row => ({ ...row,
    rank: 3 * score(row.source.title, words) + score(row.source.paragraphs.join("\n"), words),
  })).sort((a, b) => b.rank - a.rank || b.order - a.order);
  const chosen = [...recent, ...earlier];
  const chunks: { order: number; text: string }[] = [];
  let remaining = budget;
  for (const { source, order } of chosen) {
    if (remaining < 150) break;
    const cap = Math.min(remaining, recent.some(row => row.order === order) ? 1000 : 850);
    const header = clip(`[${source.label} ${source.title} · ${source.summary ? "최신 요약·원문" : "최신 원문 발췌"}]`, 180);
    const summary = source.summary ? clip(source.summary, Math.min(400, cap - header.length - 2)) : "";
    const bodyBudget = cap - header.length - summary.length - 3;
    const body = excerpt(source, words, Math.max(0, bodyBudget));
    const text = clip([header, summary, body].filter(Boolean).join("\n"), cap);
    chunks.push({ order, text }); remaining -= text.length + 2;
  }
  return chunks.sort((a, b) => a.order - b.order).map(row => row.text).join("\n\n");
}
