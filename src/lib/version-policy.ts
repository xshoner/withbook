/**
 * 절당 보관 규칙 (버전마다 원고 전체를 담으므로 DB 용량을 지킨다)
 * - 자동 저장: 최근 10개 + 그보다 오래된 것은 하루 1개씩 최근 14일치
 * - 직접 저장: 30개 · AI 초안 원본(ai_output): 최근 3개(수정률은 가장 최근 것만 쓴다)
 * - 그 밖(AI 집필 전·교정 전·복원 전 등): 합쳐서 30개
 */
const KEEP = { autosaveRecent: 10, autosaveDays: 14, manual: 30, aiOutput: 3, other: 30 };

/** 남길 버전을 고른다 (순수 함수). rows는 최신순 */
export function versionsToDrop(rows: { id: string; reason: string; createdAt: Date }[], now = Date.now()): string[] {
  const drop: string[] = [];
  const count: Record<string, number> = {};
  const days = new Set<string>();
  for (const v of rows) {
    const group = v.reason === "autosave" || v.reason === "manual" || v.reason === "ai_output" ? v.reason : "other";
    const n = (count[group] = (count[group] ?? 0) + 1);
    if (group === "autosave") {
      if (n <= KEEP.autosaveRecent) continue;
      const day = v.createdAt.toISOString().slice(0, 10);
      if (now - v.createdAt.getTime() <= KEEP.autosaveDays * 86_400_000 && !days.has(day)) {
        days.add(day);
        continue;
      }
      drop.push(v.id);
    } else if (n > (group === "manual" ? KEEP.manual : group === "ai_output" ? KEEP.aiOutput : KEEP.other)) drop.push(v.id);
  }
  return drop;
}
