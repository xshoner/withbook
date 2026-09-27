/**
 * 절 참고 자료 — 작가가 절마다 붙인 자료(기사·논문 발췌·메모 등)를 집필 근거로 쓴다.
 * 저장: AppSetting `ref:{절 id}:{자료 id}` = { id, name, chars, createdAt, text } (스키마 변경 없음).
 * 목록은 같은 접두어로 모아 읽으므로 따로 둔 목록 행이 없다(동시에 올려도 서로 덮어쓰지 않는다).
 * 브라우저·서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */
export type RefItem = { id: string; name: string; chars: number; createdAt: string };
export type RefRow = RefItem & { text: string };

/** 올릴 수 있는 파일 크기 */
export const REF_MAX_BYTES = 10 * 1024 * 1024;
/** 자료 하나에서 보관하는 글자 수 (넘으면 앞부분만) */
export const REF_MAX_CHARS = 60_000;
/** 절 하나에 붙일 수 있는 자료 수 */
export const REF_MAX_COUNT = 10;
/** 집필 프롬프트에 넣는 참고 자료 전체 글자 수 */
export const REF_PROMPT_BUDGET = 12_000;

export const refPrefix = (sectionId: string) => `ref:${sectionId}:`;
export const refKey = (sectionId: string, refId: string) => `${refPrefix(sectionId)}${refId}`;

export const REF_EXT = [".txt", ".md", ".pdf", ".docx", ".hwpx"];

export function cleanRefName(name: unknown): string {
  return String(name ?? "")
    .replace(/[\u0000-\u001f⟦⟧]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** 붙여 넣은·뽑아낸 글 정리 — 줄바꿈 통일, 빈 줄 줄이기, 한도 넘으면 자른다 */
export function cleanRefText(text: unknown): { text: string; truncated: boolean } {
  const t = String(text ?? "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= REF_MAX_CHARS) return { text: t, truncated: false };
  return { text: t.slice(0, REF_MAX_CHARS), truncated: true };
}

/**
 * 집필 프롬프트용 참고 자료 묶음. 예산을 자료마다 고르게 나누고, 짧은 자료가 남긴 몫은 긴 자료에 돌린다.
 * 자료가 없으면 빈 문자열(프롬프트의 {{#if}} 블록이 빠진다).
 */
export function buildReferencesBlock(refs: { name: string; text: string }[], budget = REF_PROMPT_BUDGET): string {
  const list = refs.map((r) => ({ name: cleanRefName(r.name) || "이름 없는 자료", text: String(r.text ?? "").trim() })).filter((r) => r.text);
  if (!list.length || budget <= 0) return "";
  const alloc = new Array<number>(list.length).fill(0);
  let left = budget;
  let open = list.map((_, i) => i);
  while (open.length && left > 0) {
    const share = Math.floor(left / open.length);
    if (share <= 0) break;
    const next: number[] = [];
    for (const i of open) {
      const need = list[i].text.length - alloc[i];
      const give = Math.min(need, share);
      alloc[i] += give;
      left -= give;
      if (alloc[i] < list[i].text.length) next.push(i);
    }
    open = next;
  }
  return list
    .map((r, i) => {
      const cut = alloc[i] < r.text.length;
      const body = r.text.slice(0, alloc[i]).trimEnd();
      return `### 자료 ${i + 1}: ${r.name}${cut ? ` (앞 ${alloc[i].toLocaleString("en-US")}자만 발췌)` : ""}\n${body}${cut ? "\n…(이하 생략)" : ""}`;
    })
    .join("\n\n");
}
