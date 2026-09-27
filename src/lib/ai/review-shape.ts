import { z } from "zod";

/**
 * 책 전체 일관성 점검 · 베타 리더 응답 형식과 위치 연결(절 번호 → 절 id·문단).
 * 서버(review.ts)와 화면(ChecksDialog)·테스트가 함께 쓴다.
 */

export type SectionRef = { sectionId: string; chapterId: string; label: string; title: string; chapterTitle: string };
export type SectionIndex = SectionRef[];

const str = z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : String(v)), z.string());
const list = <T extends z.ZodTypeAny>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(item));

export const CONSISTENCY_TYPES = ["contradiction", "repetition", "promise", "terminology", "flow", "other"] as const;
export type ConsistencyType = (typeof CONSISTENCY_TYPES)[number];
export const CONSISTENCY_LABEL: Record<ConsistencyType, string> = {
  contradiction: "서로 어긋남",
  repetition: "사례 반복",
  promise: "지키지 않은 약속",
  terminology: "용어 흔들림",
  flow: "흐름",
  other: "기타",
};

export const consistencySchema = z.object({
  overview: str.default(""),
  items: list(
    z.object({
      type: str.default("other"),
      severity: str.default("medium"),
      title: str.default(""),
      detail: str.default(""),
      suggestion: str.default(""),
      refs: list(str).default([]),
    }),
  ).default([]),
});

export type ConsistencyItem = {
  type: ConsistencyType;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  suggestion: string;
  refs: SectionRef[];
};
export type ConsistencyResult = { overview: string; items: ConsistencyItem[]; coverage?: { chapters: number; skipped: number } };

const sev = (v: string): ConsistencyItem["severity"] => (v === "high" || v === "low" ? v : "medium");
const typ = (v: string): ConsistencyType => ((CONSISTENCY_TYPES as readonly string[]).includes(v) ? (v as ConsistencyType) : "other");

/** "S3"·"[S3]"·"C2" → 절. 장 번호(C)는 그 장의 첫 절로 간다. 같은 절은 한 번만 */
export function mapConsistencyRefs(v: z.infer<typeof consistencySchema>, index: SectionIndex): Omit<ConsistencyResult, "coverage"> {
  const chapters = [...new Set(index.map((s) => s.chapterId))];
  const refOf = (raw: string): SectionRef | null => {
    const m = raw.match(/([SC])\s*(\d+)/i);
    if (!m) return null;
    const n = Number(m[2]);
    if (m[1].toUpperCase() === "S") return index[n - 1] ?? null;
    const cid = chapters[n - 1];
    return cid ? (index.find((s) => s.chapterId === cid) ?? null) : null;
  };
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const items = v.items
    .filter((it) => it.title.trim() || it.detail.trim())
    .map((it) => {
      const seen = new Set<string>();
      const refs = it.refs.map(refOf).filter((r): r is SectionRef => !!r && !seen.has(r.sectionId) && !!seen.add(r.sectionId));
      return { type: typ(it.type), severity: sev(it.severity), title: it.title.trim(), detail: it.detail.trim(), suggestion: it.suggestion.trim(), refs };
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { overview: v.overview.trim(), items };
}

const betaPoint = z.object({ ref: str.default(""), quote: str.default(""), why: str.default(""), suggestion: str.default("") });
export const betaSchema = z.object({
  overall: str.default(""),
  engagement: z.preprocess((v) => Number(v), z.number()).catch(0).default(0),
  drags: list(betaPoint).default([]),
  unclear: list(betaPoint).default([]),
  questions: list(z.object({ ref: str.default(""), question: str.default("") })).default([]),
  cut: list(betaPoint).default([]),
  strengths: list(str).default([]),
});

/** 원고 위치: 절 id·문단 번호(1부터)·찾아갈 글(문단에 실제로 있는 인용일 때만) */
export type BetaPlace = { sectionId: string; label: string; title: string; paragraph: number; text: string } | null;
export type BetaPoint = { place: BetaPlace; quote: string; why: string; suggestion: string };
export type BetaResult = {
  overall: string;
  engagement: number;
  drags: BetaPoint[];
  unclear: BetaPoint[];
  questions: { place: BetaPlace; question: string }[];
  cut: BetaPoint[];
  strengths: string[];
};

/** "S2-5" → 둘째 절의 5문단. blocks: 절마다 문단 글(인용이 실제로 있는지 확인용) */
export function mapBetaRefs(v: z.infer<typeof betaSchema>, index: SectionIndex, blocks: string[][]): BetaResult {
  const place = (ref: string, quote = ""): BetaPlace => {
    const m = ref.match(/S\s*(\d+)\s*-\s*(\d+)/i);
    if (!m) return null;
    const si = Number(m[1]) - 1;
    const s = index[si];
    const p = Number(m[2]);
    if (!s || !blocks[si]?.[p - 1]) return null;
    const q = quote.trim().replace(/^["“'‘]|["”'’]$/g, "");
    const text = q && blocks[si][p - 1].includes(q.slice(0, 30)) ? q.slice(0, 30) : "";
    return { sectionId: s.sectionId, label: s.label, title: s.title, paragraph: p, text };
  };
  const point = (x: z.infer<typeof betaPoint>): BetaPoint => ({ place: place(x.ref, x.quote), quote: x.quote.trim(), why: x.why.trim(), suggestion: x.suggestion.trim() });
  const keep = (x: BetaPoint) => !!(x.why || x.quote);
  return {
    overall: v.overall.trim(),
    engagement: Math.max(0, Math.min(5, Math.round(v.engagement || 0))),
    drags: v.drags.map(point).filter(keep),
    unclear: v.unclear.map(point).filter(keep),
    questions: v.questions.filter((q) => q.question.trim()).map((q) => ({ place: place(q.ref), question: q.question.trim() })),
    cut: v.cut.map(point).filter(keep),
    strengths: v.strengths.map((s) => s.trim()).filter(Boolean),
  };
}
