/**
 * 뒷붙이: 찾아보기(색인)·참고문헌 — 순수 함수만(DB·AI 없이 테스트).
 * 저장: AppSetting `book-index:{책}` = IndexConfig, `book-biblio:{책}` = BiblioConfig
 * 찾아보기 쪽 번호는 원고에 표시를 넣지 않고, 조판이 끝난 뒤 쪽마다 글에서 용어를 찾아 채운다(bookHtml 후처리) —
 * 미리보기·PDF·쪽수 측정이 모두 같은 결과를 낸다.
 */
import type { JNode } from "./doc/doc";

/** 문서에서 이 종류의 노드를 모두 (doc.ts를 값으로 불러오지 않는다 — 테스트가 이 파일만 읽도록) */
function nodesOf(doc: JNode, type: string): JNode[] {
  const out: JNode[] = [];
  const walk = (n: JNode) => {
    if (n.type === type) out.push(n);
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

export type IndexTerm = { term: string; /** 본문에서 함께 찾을 다른 표기(쉼표로 입력) */ aliases: string[]; /** "→ ○○ 참조" */ see: string };
export type IndexConfig = { enabled: boolean; terms: IndexTerm[] };
export type BiblioEntry = { id: string; text: string };
export type BiblioConfig = { enabled: boolean; entries: BiblioEntry[] };

export const INDEX_MAX_TERMS = 400;
export const BIBLIO_MAX_ENTRIES = 400;

export const indexKey = (projectId: string) => `book-index:${projectId}`;
export const biblioKey = (projectId: string) => `book-biblio:${projectId}`;

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function normalizeIndex(v: any): IndexConfig {
  const seen = new Set<string>();
  const terms: IndexTerm[] = [];
  for (const t of Array.isArray(v?.terms) ? v.terms : []) {
    const term = clean(t?.term, 60);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    const aliases = (Array.isArray(t?.aliases) ? t.aliases : typeof t?.aliases === "string" ? t.aliases.split(",") : [])
      .map((a: unknown) => clean(a, 60))
      .filter((a: string) => a && a !== term)
      .slice(0, 8);
    terms.push({ term, aliases: [...new Set<string>(aliases)], see: clean(t?.see, 60) });
    if (terms.length >= INDEX_MAX_TERMS) break;
  }
  return { enabled: Boolean(v?.enabled), terms };
}

export function normalizeBiblio(v: any): BiblioConfig {
  const entries: BiblioEntry[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(v?.entries) ? v.entries : []) {
    const text = clean(typeof e === "string" ? e : e?.text, 600);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const id = typeof e?.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(e.id) ? e.id : `b${entries.length.toString(36)}${Math.abs(hash(text)).toString(36)}`;
    entries.push({ id, text });
    if (entries.length >= BIBLIO_MAX_ENTRIES) break;
  }
  return { enabled: Boolean(v?.enabled), entries };
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ---------------- 찾아보기 정렬·묶음 ---------------- */

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const MERGE: Record<string, string> = { ㄲ: "ㄱ", ㄸ: "ㄷ", ㅃ: "ㅂ", ㅆ: "ㅅ", ㅉ: "ㅈ" };

/** 찾아보기 묶음 머리 — 한글은 첫소리(된소리는 예사소리에), 로마자는 대문자, 그 밖은 "기타" */
export function indexHead(term: string): string {
  const c = term.trim().codePointAt(0) ?? 0;
  if (c >= 0xac00 && c <= 0xd7a3) {
    const cho = CHO[Math.floor((c - 0xac00) / 588)];
    return MERGE[cho] ?? cho;
  }
  const ch = term.trim()[0] ?? "";
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  return "기타";
}

/** 한글(가나다) → 로마자(ABC) → 기타 순으로 묶는다 */
export function groupIndex(terms: IndexTerm[]): { head: string; terms: IndexTerm[] }[] {
  const rank = (h: string) => (h === "기타" ? 2 : /^[A-Z]$/.test(h) ? 1 : 0);
  const sorted = [...terms].sort((a, b) => {
    const ha = indexHead(a.term);
    const hb = indexHead(b.term);
    return rank(ha) - rank(hb) || a.term.localeCompare(b.term, "ko");
  });
  const out: { head: string; terms: IndexTerm[] }[] = [];
  for (const t of sorted) {
    const h = indexHead(t.term);
    if (out.at(-1)?.head !== h) out.push({ head: h, terms: [] });
    out.at(-1)!.terms.push(t);
  }
  return out;
}

/** 쪽 번호 목록을 "12, 15–17, 30"처럼 (이어진 쪽은 줄인다) */
export function pageRanges(pages: number[]): string {
  const ps = [...new Set(pages.filter((n) => n > 0))].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < ps.length; ) {
    let j = i;
    while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    out.push(j - i >= 2 ? `${ps[i]}–${ps[j]}` : j > i ? `${ps[i]}, ${ps[j]}` : `${ps[i]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/* ---------------- 참고문헌 후보 모으기 ---------------- */

export type BiblioCandidate = { text: string; from: "footnote" | "figure" | "reference"; where: string };

/** 출처처럼 보이는 글 — 서명 괄호·연도·주소·출처·쪽·출판 표지 */
const SOURCE_RE = /『|「|《|〈|“[^”]{2,}”|\b(19|20)\d{2}\b|https?:\/\/|doi|출처|원문|자료:|pp?\.\s*\d|\d+\s*쪽|출판|펴냄|보고서|논문|Journal|Press|et al\./i;
const FIGURE_CREDIT_RE = /출처|CC[ -]?BY|CC0|퍼블릭 도메인|Public domain|Wikimedia|라이선스|저작자|©/i;

/**
 * 원고에서 참고문헌 후보를 모은다 — 출처처럼 보이는 각주, 그림 캡션의 출처·라이선스, 절 참고 자료 이름.
 * 같은 글은 한 번만. AI가 이 목록을 참고문헌 형식으로 정리한다(후보가 아닌 것은 버린다).
 */
export function collectBiblioCandidates(sections: { where: string; content: JNode; refs: string[] }[], max = 300): BiblioCandidate[] {
  const out: BiblioCandidate[] = [];
  const seen = new Set<string>();
  const push = (text: string, from: BiblioCandidate["from"], where: string) => {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (t.length < 4 || seen.has(t) || out.length >= max) return;
    seen.add(t);
    out.push({ text: t, from, where });
  };
  for (const s of sections) {
    for (const fn of nodesOf(s.content, "footnote")) {
      const note = String(fn.attrs?.note ?? "");
      if (SOURCE_RE.test(note)) push(note, "footnote", s.where);
    }
    for (const fig of nodesOf(s.content, "figure")) {
      const cap = String(fig.attrs?.caption ?? "");
      if (FIGURE_CREDIT_RE.test(cap)) push(cap, "figure", s.where);
    }
    for (const r of s.refs) push(r, "reference", s.where);
  }
  return out;
}

/* ---------------- 찾아보기 후보(자주 나오는 말) ---------------- */

const JOSA = /(으로써|으로서|에서는|에게서|이라는|이라고|으로|에서|에게|까지|부터|보다|처럼|이다|하는|하고|했다|이며|라는|이나|은|는|이|가|을|를|의|에|와|과|도|로|만)$/;

/** 원고에 자주(3번 이상) 나오는 2~10자 낱말 — 조사를 대강 떼고. AI가 원고의 실제 표기를 고르도록 돕는 참고 목록 */
export function frequentWords(text: string, top = 150): string[] {
  const count = new Map<string, number>();
  for (const raw of text.match(/[가-힣A-Za-z][가-힣A-Za-z0-9·-]{1,14}/g) ?? []) {
    const w = raw.replace(JOSA, "");
    if (w.length < 2 || w.length > 10) continue;
    count.set(w, (count.get(w) ?? 0) + 1);
  }
  return [...count.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .slice(0, top)
    .map(([w, n]) => `${w}(${n})`);
}
