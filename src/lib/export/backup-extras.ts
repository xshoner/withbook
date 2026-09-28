/**
 * 백업에 함께 담는 AppSetting 행 (책·절에 딸린 작업 자료) — 백업·복원이 같은 규칙을 쓴다(DB 없이 테스트).
 *   cover:{책}              표지 디자인(배치·글·AI 프롬프트, 그림은 assets/로)
 *   book-memory:{책}        책의 기억(작가가 확정한 정의·주장·쓴 사례·쓰지 않을 것·표현 유지)
 *   ref:{절}:{자료}          절 참고 자료
 *   outline-edit:{절}        작가가 고친 개요
 *   figure-ai:{절}           [직접 만들기]로 만든 그림 목록
 * 담지 않는 것: AI 설정·API 키·기본 문체(계정 전체 설정), 퇴고 기록·교정 내역·AI 부분 원고(짧게 보관하는 작업 기록), 캐시
 */
export type ExtraRow = { key: string; value: string };

export const extraKeysFor = (projectId: string, sectionIds: string[]) => ({
  exact: [`cover:${projectId}`, `book-memory:${projectId}`, ...sectionIds.flatMap((s) => [`outline-edit:${s}`, `figure-ai:${s}`])],
  prefixes: sectionIds.map((s) => `ref:${s}:`),
});

const RULES: { re: RegExp; kind: "project" | "section" }[] = [
  { re: /^cover:([^:]+)$/, kind: "project" },
  { re: /^book-memory:([^:]+)$/, kind: "project" },
  { re: /^outline-edit:([^:]+)$/, kind: "section" },
  { re: /^figure-ai:([^:]+)$/, kind: "section" },
  { re: /^ref:([^:]+):([A-Za-z0-9_-]{1,60})$/, kind: "section" },
];

/**
 * 복원할 때 키의 책·절 id를 새 id로 바꾸고, 값 안의 이미지 id도 새 id로 바꾼다.
 * 모르는 키·옛 id를 찾지 못한 행은 버린다(다른 책의 설정을 덮지 않게).
 */
export function remapExtras(rows: unknown, projectId: string, sectionMap: Map<string, string>, remapValue: (v: string) => string, maxValue = 2_000_000): ExtraRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ExtraRow[] = [];
  for (const r of rows) {
    if (!r || typeof r.key !== "string" || typeof r.value !== "string" || r.value.length > maxValue) continue;
    for (const rule of RULES) {
      const m = r.key.match(rule.re);
      if (!m) continue;
      if (rule.kind === "project") out.push({ key: r.key.replace(m[1], projectId), value: remapValue(r.value) });
      else {
        const sid = sectionMap.get(m[1]);
        if (sid) out.push({ key: r.key.replace(m[1], sid), value: remapValue(r.value) });
      }
      break;
    }
  }
  return out;
}
