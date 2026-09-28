/**
 * 책의 기억 — 작가가 확정한 사항(정의·주장·사례·쓰지 않을 것·표현 유지). 집필·퇴고·교정·부분 수정·일관성 검사 프롬프트에
 * 짧은 고정 블록으로 들어간다(임베딩·검색 없이 — 가볍게). 순수 함수만 둔다(DB 없이 테스트).
 * 저장: AppSetting `book-memory:{책 id}` = { items: MemoryItem[] }
 */
export const MEMORY_KINDS = {
  definition: { label: "정의", hint: "이 책에서 이 말은 이런 뜻으로 쓴다" },
  claim: { label: "핵심 주장", hint: "책 전체가 지키는 주장·결론" },
  case: { label: "쓴 사례", hint: "이미 쓴 사례·일화 — 다른 장에서 되풀이하지 않는다" },
  avoid: { label: "쓰지 않을 것", hint: "다루지 않기로 한 내용·표현" },
  keep: { label: "표현 유지", hint: "의도한 표현 — 교정·퇴고가 고치자고 하지 않는다" },
} as const;
export type MemoryKind = keyof typeof MEMORY_KINDS;

export type MemoryItem = { id: string; kind: MemoryKind; text: string; where?: string; at: string };

export const MEMORY_MAX_ITEMS = 80;
export const MEMORY_TEXT_MAX = 400;
/** 프롬프트에 넣는 블록 최대 길이 — 넘치면 표현 유지·주장·정의부터 넣고 나머지는 개수만 알린다 */
export const MEMORY_PROMPT_MAX = 2000;

const PROMPT_ORDER: MemoryKind[] = ["keep", "avoid", "claim", "definition", "case"];

export const memoryKey = (projectId: string) => `book-memory:${projectId}`;

export function normalizeMemory(v: unknown): MemoryItem[] {
  const items = Array.isArray((v as any)?.items) ? (v as any).items : Array.isArray(v) ? v : [];
  const out: MemoryItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it.text !== "string" || !Object.hasOwn(MEMORY_KINDS, it.kind)) continue;
    const text = it.text.trim().slice(0, MEMORY_TEXT_MAX);
    const id = typeof it.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(it.id) ? it.id : "";
    if (!text || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: it.kind, text, ...(typeof it.where === "string" && it.where.trim() ? { where: it.where.trim().slice(0, 80) } : {}), at: typeof it.at === "string" ? it.at.slice(0, 40) : "" });
    if (out.length >= MEMORY_MAX_ITEMS) break;
  }
  return out;
}

/** 프롬프트 블록 — 비었으면 빈 문자열(템플릿이 "(없음)"으로 쓴다) */
export function memoryText(items: MemoryItem[], max = MEMORY_PROMPT_MAX): string {
  const lines: string[] = [];
  let used = 0;
  let left = 0;
  for (const kind of PROMPT_ORDER) {
    for (const it of items.filter((i) => i.kind === kind)) {
      const line = `- [${MEMORY_KINDS[kind].label}] ${it.text}${it.where ? ` (${it.where})` : ""}`;
      if (used + line.length + 1 > max) {
        left++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (left) lines.push(`- (그 밖 ${left}개는 길이 제한으로 생략)`);
  return lines.join("\n");
}
