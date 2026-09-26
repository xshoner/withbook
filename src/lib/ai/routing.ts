/** Browser-safe task routing. Unassigned tasks keep using the existing connection. */
export const AI_SCOPES = {
  default: { label: "기본 연결", description: "별도 연결을 지정하지 않은 모든 작업" },
  summary: { label: "요약", description: "앞 절·장 내용 정리 — 빠른 모델 추천" },
  outline: { label: "목차·개요", description: "책 목차 설계와 긴 절의 집필 개요" },
  writing: { label: "본문 집필", description: "새 원고 작성·이어쓰기·분량 조정" },
  revision: { label: "교정·퇴고", description: "문장 수정·교정·장 전체 퇴고" },
  style: { label: "문체 분석", description: "문체 분석과 작가의 수정에서 학습" },
  footnote: { label: "각주", description: "각주 작성과 자동 제안" },
  factcheck: { label: "팩트체크", description: "‘확인할 것’의 [확인 필요] 문장을 최신 자료로 판정·보완 — GPT-5.6 Terra 추천" },
  cover: { label: "표지 디자인", description: "커버 디자인 에디터의 [AI 제작] 표지 그림 생성 (Images API) — gpt-image-2.5-sunburst 추천" },
} as const;

export type AiScope = keyof typeof AI_SCOPES;

export function parseAiScope(value: unknown): AiScope {
  if (value === undefined || value === null) return "default";
  if (typeof value === "string" && Object.hasOwn(AI_SCOPES, value)) return value as AiScope;
  throw Object.assign(new Error("올바른 AI 용도를 선택하세요."), { status: 400 });
}

export function scopeForPurpose(purpose: string): AiScope {
  if (["summary", "chapter_summary"].includes(purpose)) return "summary";
  if (["toc_design", "section_outline"].includes(purpose)) return "outline";
  if (["section_write", "section_write_part", "length_adjust"].includes(purpose)) return "writing";
  if (["proofread", "chapter_revise"].includes(purpose) || purpose.startsWith("rewrite_")) return "revision";
  if (["style_analyze", "style_learn"].includes(purpose)) return "style";
  if (["footnote", "footnote_auto"].includes(purpose)) return "footnote";
  if (purpose === "factcheck") return "factcheck";
  if (purpose === "cover_image" || purpose === "cover_image_edit") return "cover";
  return "default";
}

/** A saved credential must never silently follow a connection to a different host. */
export function updatedApiKey(
  current: { apiKey: string; baseUrl: string; provider: string; keyName: string },
  next: { apiKey?: string; baseUrl?: string; provider?: string; keyName?: string; clearKey?: boolean },
) {
  if (next.clearKey) return "";
  if (next.apiKey?.trim()) return next.apiKey.trim();
  const changed = (next.baseUrl !== undefined && next.baseUrl.replace(/\/+$/, "") !== current.baseUrl.replace(/\/+$/, "")) ||
    (next.provider !== undefined && next.provider !== current.provider) ||
    (next.keyName !== undefined && next.keyName !== current.keyName);
  if (current.apiKey && changed) throw Object.assign(new Error("연결 주소·제공자·키 이름을 바꿀 때는 새 API 키를 입력하거나 저장된 키 지우기를 선택하세요."), { status: 400 });
  return current.apiKey;
}
