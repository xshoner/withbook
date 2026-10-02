/** 서버 오류 일지의 순수 계산 (DB 없이 — 테스트용으로 따로 둔다). 기록·읽기는 error-log.ts */

export const errorLogKey = (day: string) => `errors:${day}`;
const MAX_GROUPS = 20;

export type ErrorGroup = { route: string; kind: string; msg: string; n: number; last: string };
export type ErrorDay = { total: number; groups: ErrorGroup[] };

/** /api/sections/cmg1abc…/write → /api/sections/[id]/write (id처럼 보이는 조각을 묶는다) */
export function normalizeRoute(pathname: string) {
  return pathname
    .split("/")
    .map((seg) => (/^[a-z0-9_-]{16,}$/i.test(seg) && /\d/.test(seg) ? "[id]" : seg))
    .join("/");
}

/** 오류 종류 — 원문 대신 이름·코드·상태만 */
export function errorKind(e: any, status: number) {
  const name = typeof e?.name === "string" && e.name !== "Error" ? e.name : "Error";
  const code = typeof e?.code === "string" ? ` ${e.code}` : "";
  return `${name}${code} ${status}`;
}

/** 하루 기록에 한 건 더한다 (같은 경로·종류·문구면 묶는다). 순수 함수 — 테스트용 */
export function addError(day: ErrorDay, g: Omit<ErrorGroup, "n">): ErrorDay {
  const groups = day.groups.map((x) => ({ ...x }));
  const hit = groups.find((x) => x.route === g.route && x.kind === g.kind && x.msg === g.msg);
  if (hit) {
    hit.n++;
    hit.last = g.last;
  } else if (groups.length < MAX_GROUPS) groups.push({ ...g, n: 1 });
  return { total: day.total + 1, groups };
}

export function parseErrorDay(v: string | null | undefined): ErrorDay {
  try {
    const j = JSON.parse(v ?? "");
    if (j && typeof j.total === "number" && Array.isArray(j.groups)) return j;
  } catch {}
  return { total: 0, groups: [] };
}

