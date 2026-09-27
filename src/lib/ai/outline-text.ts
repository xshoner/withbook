import { createHash } from "node:crypto";

/**
 * 긴 절 집필 개요 ↔ 작가가 읽고 고칠 수 있는 글.
 * 개요(parts)는 파트마다 소제목·다룰 내용·배정된 스케치·분량을 가진다. 글 형식:
 *
 *   ## 소제목 (약 1,400자)
 *   - 다룰 내용
 *   - [스케치] 이 파트에 배정한 스케치 항목
 *
 * 브라우저·서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */
export type OutlinePart = { heading: string; points: string[]; sketchItems: string[]; chars: number };

/** 작가가 고친 개요 한도 — 파트 수는 이어 쓰기(resume) 입력 한도와 같다 */
export const OUTLINE_MAX_PARTS = 20;
export const OUTLINE_MAX_TEXT = 20_000;

const SKETCH_TAG = "[스케치]";

export function partsToText(parts: OutlinePart[]): string {
  return parts
    .map((p) => {
      const head = `## ${p.heading.trim() || "(소제목 없음)"}${p.chars > 0 ? ` (약 ${Math.round(p.chars).toLocaleString("en-US")}자)` : ""}`;
      const lines = [...p.points.map((x) => `- ${x.trim()}`), ...p.sketchItems.map((x) => `- ${SKETCH_TAG} ${x.trim()}`)];
      return [head, ...lines].join("\n");
    })
    .join("\n\n");
}

const HEAD_RE = /^#{1,6}\s*(.*)$/;
const CHARS_RE = /\s*[(（]\s*(?:약\s*)?([\d,]+)\s*자\s*[)）]\s*$/;

/**
 * 글 → 개요. 분량 표시가 없는 파트는 남은 분량(targetChars − 적힌 분량)을 고르게 나눈다.
 * 소제목(##) 없이 쓴 글은 소제목 없는 파트 하나로 본다. 형식이 틀리면 오류 문구를 던진다.
 */
export function textToParts(text: string, targetChars: number): OutlinePart[] {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!src.trim()) throw Object.assign(new Error("개요가 비어 있습니다."), { status: 400 });
  if (src.length > OUTLINE_MAX_TEXT) throw Object.assign(new Error(`개요가 너무 깁니다(${OUTLINE_MAX_TEXT.toLocaleString()}자 이하).`), { status: 400 });
  const parts: (OutlinePart & { fixed: boolean })[] = [];
  let cur: (OutlinePart & { fixed: boolean }) | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(HEAD_RE);
    if (h) {
      let heading = h[1].trim();
      const c = heading.match(CHARS_RE);
      const chars = c ? Number(c[1].replace(/,/g, "")) : 0;
      if (c) heading = heading.slice(0, c.index).trim();
      if (heading === "(소제목 없음)") heading = "";
      cur = { heading: heading.slice(0, 60), points: [], sketchItems: [], chars, fixed: chars > 0 };
      parts.push(cur);
      continue;
    }
    if (!cur) {
      cur = { heading: "", points: [], sketchItems: [], chars: 0, fixed: false };
      parts.push(cur);
    }
    const item = line.replace(/^[-*•]\s*|^\d+[.)]\s+/, "").trim();
    if (!item) continue;
    if (item.startsWith(SKETCH_TAG)) {
      const s = item.slice(SKETCH_TAG.length).trim();
      if (s) cur.sketchItems.push(s.slice(0, 500));
    } else cur.points.push(item.slice(0, 500));
  }
  if (!parts.length) throw Object.assign(new Error("개요가 비어 있습니다."), { status: 400 });
  if (parts.length > OUTLINE_MAX_PARTS) throw Object.assign(new Error(`파트는 ${OUTLINE_MAX_PARTS}개까지 나눌 수 있습니다.`), { status: 400 });
  const target = Math.max(0, Math.round(Number(targetChars) || 0));
  const fixedSum = parts.reduce((a, p) => a + (p.fixed ? p.chars : 0), 0);
  const free = parts.filter((p) => !p.fixed);
  if (free.length) {
    const each = Math.max(300, Math.round(Math.max(0, target - fixedSum) / free.length) || 0);
    for (const p of free) p.chars = each;
  }
  return parts.map(({ fixed: _fixed, ...p }) => p);
}

/**
 * 개요가 무엇을 보고 만들어졌는지 — 스케치·분량·절 제목·요지·참고 자료가 바뀌면 달라진다(오래된 개요 표시용).
 * 집필 캐시 해시(렌더된 프롬프트 전체)와 달리 앞 절 요약처럼 조회에 AI가 필요한 값은 넣지 않는다.
 */
export function outlineInputHash(v: { sketch?: string | null; targetPages?: number | null; title?: string | null; gist?: string | null; refIds?: string[] }) {
  const payload = JSON.stringify({
    sketch: (v.sketch ?? "").trim(),
    targetPages: Math.round((Number(v.targetPages) || 0) * 10) / 10,
    title: (v.title ?? "").trim(),
    gist: (v.gist ?? "").trim(),
    refs: [...(v.refIds ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** 작가가 고친 개요 저장 키 (일일 정리의 개요 캐시 `ai:outline-cache:`와 다른 접두어 — 만료되지 않는다) */
export const editedOutlineKey = (sectionId: string) => `outline-edit:${sectionId}`;
export const outlineCacheKey = (sectionId: string) => `ai:outline-cache:${sectionId}`;

export type EditedOutline = { outline: string; parts: OutlinePart[]; inputHash: string; editedAt: string };
