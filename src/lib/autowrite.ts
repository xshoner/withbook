/**
 * 전체 자동 집필 — 진행 상태(서버 AppSetting `autowrite:{책 id}`에 보관)와 순수 계산.
 * 브라우저가 절마다 집필 → 팩트체크 → 검수를 차례로 부르고, 단계가 바뀔 때마다 이 상태를 서버에 남긴다.
 * 창을 닫거나 연결이 끊겨도 다시 열면 남은 단계부터 이어 간다.
 */

export type Stage = "pending" | "running" | "done" | "skipped" | "error";

export type AutoItem = {
  sectionId: string;
  label: string;
  chapterTitle: string;
  targetPages: number;
  write: Stage;
  fact: Stage;
  review: Stage;
  /** 이번 단계의 시도 횟수 (단계가 끝나면 0) */
  attempts: number;
  error?: string;
  chars?: number;
  factStats?: { pass: number; revise: number; fail: number };
  reviewFixes?: number;
};

export type AutoOptions = {
  extraInstruction: string;
  factcheck: boolean;
  review: boolean;
  reviewLevel: "proof" | "light";
  /** true: 본문이 있는 절도 새로 쓴다(지금 본문은 버전 기록에 보관) · false: 본문이 있는 절은 집필을 건너뛰고 팩트체크·검수만 */
  rewrite: boolean;
  /** 진행 표시용 1쪽당 글자 수 */
  charsPerPage?: number;
};

export type AutoRun = {
  version: 1;
  runId: string;
  status: "running" | "paused" | "done" | "stopped";
  pauseReason?: string;
  /** user: 직접 멈춤 · error: 연속 실패로 멈춤(잠시 뒤 자동으로 다시 시도한다) */
  pauseKind?: "user" | "error";
  startedAt: number;
  /** 진행 중인 창이 20초마다 새로 쓴다 — 오래되면 그 창이 닫혔다고 보고 이어 받는다 */
  updatedAt: number;
  owner: string;
  options: AutoOptions;
  items: AutoItem[];
};

/** 이 시간 동안 소식이 없으면 진행하던 창이 닫힌 것으로 본다 */
export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;

export type PlanSection = { id: string; label: string; title: string; chapterTitle: string; chapterKind: string; targetPages: number; charCount: number };

/** 책 순서대로 할 일 목록 — 앞붙이·뒷붙이는 includeMatter일 때만 */
export function buildPlan(sections: PlanSection[], opts: AutoOptions, includeMatter: boolean): AutoItem[] {
  return sections
    .filter((s) => includeMatter || s.chapterKind === "body")
    .map((s) => {
      const skipWrite = !opts.rewrite && s.charCount > 0;
      return {
        sectionId: s.id,
        label: `${s.label} ${s.title}`.trim(),
        chapterTitle: s.chapterTitle,
        targetPages: s.targetPages > 0 ? s.targetPages : 3,
        write: skipWrite ? "skipped" : "pending",
        fact: opts.factcheck ? "pending" : "skipped",
        review: opts.review ? "pending" : "skipped",
        attempts: 0,
        chars: skipWrite ? s.charCount : undefined,
      };
    });
}

/**
 * 이어 가기 전 정리 — 끊길 때 진행 중이던 단계는 처음부터 다시 한다.
 * retryFailed면 실패한 단계도 다시 한다(집필이 실패한 절은 뒤 단계도 되살린다).
 */
export function prepareResume(run: AutoRun, retryFailed: boolean): AutoRun {
  const again = (s: Stage) => s === "running" || (retryFailed && s === "error");
  return {
    ...run,
    status: "running",
    pauseReason: undefined,
    pauseKind: undefined,
    items: run.items.map((it) => {
      const write: Stage = again(it.write) ? "pending" : it.write;
      const revive = (s: Stage, on: boolean): Stage => (again(s) || (write === "pending" && it.write === "error" && s === "skipped" && on) ? "pending" : s);
      return {
        ...it,
        write,
        fact: revive(it.fact, run.options.factcheck),
        review: revive(it.review, run.options.review),
        attempts: 0,
        error: again(it.write) || again(it.fact) || again(it.review) ? undefined : it.error,
      };
    }),
  };
}

const finished = (s: Stage) => s === "done" || s === "skipped" || s === "error";

/** 모든 절의 모든 단계가 끝났나 */
export const allFinished = (run: AutoRun) => run.items.every((it) => finished(it.write) && finished(it.fact) && finished(it.review));

export function summarize(run: AutoRun) {
  const n = run.items.length;
  const count = (k: "write" | "fact" | "review", s: Stage) => run.items.filter((it) => it[k] === s).length;
  const steps = run.items.reduce((a, it) => a + [it.write, it.fact, it.review].filter((s) => s !== "skipped").length, 0);
  const doneSteps = run.items.reduce((a, it) => a + [it.write, it.fact, it.review].filter((s) => s === "done" || s === "error").length, 0);
  return {
    n,
    written: count("write", "done"),
    writeSkipped: count("write", "skipped"),
    checked: count("fact", "done"),
    reviewed: count("review", "done"),
    failed: run.items.filter((it) => it.write === "error" || it.fact === "error" || it.review === "error").length,
    percent: steps ? Math.round((doneSteps / steps) * 100) : 100,
  };
}

/** 서버에 올 수 있는 모양인지 (크기·필드 최소 검사) */
export function isAutoRun(v: unknown): v is AutoRun {
  const r = v as AutoRun;
  return !!r && r.version === 1 && typeof r.runId === "string" && Array.isArray(r.items) && r.items.length <= 2000 && typeof r.options === "object" && !!r.options;
}

/** 문단 글들을 약 size자씩 묶은 문단 번호 범위(1부터, 양끝 포함) — 검수를 요청 여러 개로 나눌 때. 빈 문단만 있는 범위는 만들지 않는다 */
export function paragraphRanges(texts: string[], size: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = 0;
  let len = 0;
  texts.forEach((t, i) => {
    if (len > 0 && len + t.length > size) {
      out.push({ from, to: i });
      from = 0;
      len = 0;
    }
    if (!t.trim()) return;
    if (!from) from = i + 1;
    len += t.length;
  });
  if (from) out.push({ from, to: texts.length });
  return out;
}
