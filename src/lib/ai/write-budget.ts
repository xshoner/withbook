import type { OutlinePart } from "./outline-text";

/**
 * 절 집필 요청 하나의 시간 배분 — 모두 요청 시작 기준(ms).
 * AI 호출 예산은 요청 시작 후 240초(client.ts AI_BUDGET_MS), Vercel Hobby 함수 한도는 300초(늘릴 수 없음).
 * 준비(앞 내용 요약·개요)가 예산을 다 써서 본문을 시작하지 못하는 일이 없도록 준비 단계마다 기다리는 시간을 정한다.
 * 서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */
/** 앞 내용 요약은 여기까지만 기다린다 — 늦은 요약은 빼고(앞 절 끝부분은 그대로 들어간다) 바로 쓴다 */
export const SUMMARY_DEADLINE_MS = 45_000;
/** 긴 절 개요는 여기까지만 기다린다 — 늦으면 분량만 나눈 기본 개요로 쓴다 */
export const OUTLINE_DEADLINE_MS = 150_000;
/** 이 요청에서 쓰는 첫 파트는 이때까지만 시작한다 — 늦으면 같은 개요로 새 요청에서 쓴다(resume) */
export const FIRST_PART_START_MS = 110_000;
/** 두 번째 파트부터는 이때까지만 시작한다 (파트 하나는 보통 1분 안팎) */
export const PART_START_BUDGET_MS = 150_000;
/** 기본 개요(개요가 늦거나 해석되지 않을 때)의 파트 하나 분량 */
export const FALLBACK_PART_CHARS = 1500;

/**
 * 파트 p를 이 요청에서 시작할지, 새 요청으로 넘길지(resume).
 * from: 이 요청이 처음 쓰는 파트. 첫 파트는 준비가 길었을 때만 넘긴다 — 새 요청은 개요·요약을 다시 만들지 않아 곧바로 시작한다.
 */
export function partStart(elapsedMs: number, p: number, from: number): "write" | "resume" {
  return elapsedMs > (p === from ? FIRST_PART_START_MS : PART_START_BUDGET_MS) ? "resume" : "write";
}

/** 요청 시작에서 deadlineMs까지 남은 시간 (0 이상) */
export function timeLeft(startedAt: number, deadlineMs: number, now = Date.now()) {
  return Math.max(0, startedAt + deadlineMs - now);
}

/**
 * 개요가 없을 때 쓰는 기본 개요 — 소제목 없이 분량을 고르게 나누고 스케치 줄을 차례로 배정한다.
 * 한 번에 긴 본문을 쓰다 시간 한도에 걸리지 않도록 파트 하나를 FALLBACK_PART_CHARS 안팎으로 둔다.
 */
export function fallbackParts(targetChars: number, sketch = ""): OutlinePart[] {
  const total = Math.max(1, Math.round(Number(targetChars) || 0));
  const n = Math.max(1, Math.min(20, Math.ceil(total / FALLBACK_PART_CHARS)));
  const lines = String(sketch ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  return Array.from({ length: n }, (_, i) => ({
    heading: "",
    points: [],
    sketchItems: lines.filter((_, k) => Math.floor((k * n) / lines.length) === i),
    chars: Math.round(total / n),
  }));
}

/** 서버 시간 한도(AiError 504)로 끝난 호출인지 */
export const isDeadlineError = (e: unknown) => (e as { status?: unknown } | null)?.status === 504;

/**
 * promise를 ms까지만 기다린다. 늦으면 { done: false } — 작업은 그대로 두되(끝나면 캐시에 남는다) 그 실패는 삼킨다.
 */
export async function withinTime<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  const settled = promise.then((value) => ({ done: true as const, value }));
  settled.catch(() => {}); // 기다리지 않게 된 작업이 나중에 실패해도 처리되지 않은 거부로 남지 않게
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}
