/** 책 진행 현황 — 마감일까지 남은 날과 하루에 써야 할 쪽 (책 목록 카드) */

export const deadlineKey = (projectId: string) => `deadline:${projectId}`;

/** "YYYY-MM-DD" 형식이고 실제 있는 날짜인가 */
export function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 한국 시간 기준 오늘 (YYYY-MM-DD) */
export function todayKst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export type DeadlinePlan = {
  /** 마감일까지 남은 날 — 마감일 당일은 1(오늘 하루 남음), 지났으면 0 이하 */
  daysLeft: number;
  /** 남은 쪽 (목표 - 지금) — 0 이상 */
  pagesLeft: number;
  /** 하루에 써야 할 쪽 (소수 한 자리). 이미 다 썼거나 마감이 지났으면 null */
  perDay: number | null;
};

export function deadlinePlan(deadline: string, pagesNow: number, targetPages: number, today = todayKst()): DeadlinePlan {
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
  const daysLeft = Math.round(day(deadline) - day(today)) + 1;
  const pagesLeft = Math.max(0, Math.round(targetPages - pagesNow));
  const perDay = pagesLeft > 0 && daysLeft > 0 ? Math.ceil((pagesLeft / daysLeft) * 10) / 10 : null;
  return { daysLeft, pagesLeft, perDay };
}
