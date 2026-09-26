"use client";

import { useSyncExternalStore } from "react";
import { api, readStream, type StreamEvent } from "@/lib/client";
import { appendDocs, charCount, markdownToDoc, parseDoc, textblocks, type JNode } from "@/lib/doc/doc";
import { trimIncompleteTail } from "@/lib/doc/edit";
import { allFinished, HEARTBEAT_MS, paragraphRanges, prepareResume, STALE_MS, type AutoItem, type AutoOptions, type AutoRun, type Stage } from "@/lib/autowrite";
import { toast } from "../ui/feedback";
import { registerJobKind, sectionBusyWith } from "./jobStore";
import { runJob } from "./aiJobs";
import { flushAllPending, saveViaQueue, settleSection } from "./useAutosave";
import { saveProofResult } from "./proofJobs";
import type { AppliedChange } from "./ProofPanel";

/**
 * 전체 자동 집필 — 편집기 밖(모듈)에서 돈다. 절을 옮기거나 책 설정 화면에 다녀와도 계속된다.
 *
 * 두 줄이 동시에 돈다(파이프라인):
 *  - 집필 줄: 책 순서대로 절을 하나씩 쓴다. 다 쓰면 팩트체크·검수를 기다리지 않고 바로 다음 절로 간다.
 *  - 점검 줄: 집필이 끝난 절을 순서대로 받아 팩트체크 → 검수를 한다. 다음 절 집필이 끝나 있으면 곧바로 그 절로 넘어간다.
 *
 * 멈춤 대비:
 *  - 단계가 바뀔 때마다 진행 상태를 서버에 남기고, 진행 중에는 20초마다 소식을 남긴다(heartbeat).
 *  - 호출이 실패하면 연결이 돌아올 때까지 기다렸다가 간격을 늘려 다시 한다(단계마다 최대 4번).
 *  - 두 절 연속 집필에 실패하면(설정·키 문제일 가능성이 높다) 멈추고 이유를 보여 준다.
 *  - 창을 닫았거나 새로 고친 뒤 다시 열면, 소식이 끊긴 진행을 찾아 남은 단계부터 자동으로 이어 간다.
 *  - 진행 중에는 화면이 꺼지지 않게 한다(Wake Lock, 지원하는 브라우저에서).
 */

const OWNER = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
const RETRY_DELAYS = [5_000, 20_000, 60_000];
/** 검수 요청 하나에 보내는 분량(자) — 서버가 2,000자씩 3개를 동시에 교정하므로 AI 호출 한 번 걸리는 시간 안팎 */
const REVIEW_CHUNK = 6000;
const NO_RETRY = /AI 연결 설정이 없습니다|기본 주소를 쓸 수 없습니다|인증에 실패|\(40[134]\)|로그인이 필요/;

export type Activity = { writer: string; checker: string };

type State = { projectId: string | null; run: AutoRun | null; activity: Activity; driving: boolean; foreign: boolean };
let state: State = { projectId: null, run: null, activity: { writer: "", checker: "" }, driving: false, foreign: false };
const subs = new Set<() => void>();
const editedSubs = new Set<(sectionIds: string[]) => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const useAutoWrite = () => useSyncExternalStore(subscribe, () => state, () => state);

/** 점검 줄이 서버에서 절 본문을 고친 뒤 — 편집 화면이 그 절을 다시 불러오게 */
export function onAutoEdited(f: (sectionIds: string[]) => void) {
  editedSubs.add(f);
  return () => {
    editedSubs.delete(f);
  };
}

/* ---------- 서버에서 고치는 중인 절 잠금 (편집·다른 AI 작업과 겹치지 않게) — 점검 줄과 이어쓰기가 서로 다른 절을 잠글 수 있다 ---------- */
const checking = new Set<string>();
const lockSubs = new Set<() => void>();
function lock(id: string) {
  checking.add(id);
  lockSubs.forEach((f) => f());
}
function unlock(id: string) {
  checking.delete(id);
  lockSubs.forEach((f) => f());
  editedSubs.forEach((f) => f([id]));
}
export const autoChecking = (sectionId: string) => checking.has(sectionId);
export const useAutoChecking = (sectionId: string) =>
  useSyncExternalStore(
    (f) => {
      lockSubs.add(f);
      return () => {
        lockSubs.delete(f);
      };
    },
    () => checking.has(sectionId),
    () => false,
  );
registerJobKind("auto", { label: "자동 집필 점검", busy: autoChecking, any: () => state.driving });

export const autoRunning = () => state.driving;

/* ---------- 서버 보관 ---------- */
let ctrl: AbortController | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let saving: Promise<unknown> = Promise.resolve();

class TakenOver extends Error {}

async function persist(takeover = false) {
  const { projectId, run } = state;
  if (!projectId || !run) return;
  const body = { run: { ...run, owner: OWNER }, takeover };
  // 순서대로 저장 (늦게 보낸 옛 상태가 새 상태를 덮지 않게)
  const p = saving.then(async () => {
    const res = await fetch(`/api/projects/${projectId}/autowrite`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 409) throw new TakenOver("다른 창에서 자동 집필을 이어 받았습니다. 이 창은 진행을 멈춥니다.");
    if (!res.ok) throw new Error(`진행 상태 저장 실패 (${res.status})`);
  });
  saving = p.catch(() => {});
  try {
    await p;
  } catch (e) {
    if (e instanceof TakenOver) {
      ctrl?.abort();
      set({ foreign: true });
      toast.error(e.message);
      throw e;
    }
    // 연결이 잠깐 끊긴 경우 — 다음 저장·heartbeat가 다시 올린다
    console.warn("[autowrite]", e);
  }
}

function patchItem(it: AutoItem, patch: Partial<AutoItem>) {
  const run = state.run;
  if (!run) return;
  Object.assign(it, patch);
  set({ run: { ...run, items: run.items.map((x) => (x.sectionId === it.sectionId ? { ...x, ...patch } : x)) } });
}

const itemOf = (id: string) => state.run?.items.find((x) => x.sectionId === id) ?? null;

/* ---------- 도우미 ---------- */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

function waitOnline(signal: AbortSignal) {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("online", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    window.addEventListener("online", done);
    signal.addEventListener("abort", done);
  });
}

class Stopped extends Error {}
const alive = () => !!ctrl && !ctrl.signal.aborted && state.run?.status === "running";

/** 실패하면 연결을 기다렸다가 간격을 늘려 다시 한다. 멈추면 Stopped */
async function withRetry<T>(it: AutoItem, lane: keyof Activity, what: string, fn: () => Promise<T>): Promise<T> {
  const signal = ctrl!.signal;
  for (let attempt = 0; ; attempt++) {
    if (!alive()) throw new Stopped();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setActivity(lane, `${it.label} — 인터넷 연결을 기다리는 중…`);
      await waitOnline(signal);
    }
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Stopped || e instanceof TakenOver || !alive()) throw e instanceof TakenOver ? e : new Stopped();
      const msg = e instanceof Error ? e.message : String(e);
      // 설정·키 문제는 다시 해도 같다 — 바로 실패로 넘긴다
      if (attempt >= RETRY_DELAYS.length || NO_RETRY.test(msg)) throw e;
      const wait = RETRY_DELAYS[attempt];
      patchItem(it, { attempts: attempt + 1, error: msg });
      setActivity(lane, `${it.label} ${what} 다시 시도 대기 (${attempt + 1}/${RETRY_DELAYS.length}, ${wait / 1000}초) — ${msg}`);
      void persist().catch(() => {});
      await sleep(wait, signal);
    }
  }
}

function setActivity(lane: keyof Activity, text: string) {
  set({ activity: { ...state.activity, [lane]: text } });
}

/* ---------- 화면 꺼짐 방지 ---------- */
let wakeLock: { release: () => Promise<void> } | null = null;
async function keepAwake() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (wl && document.visibilityState === "visible") wakeLock = await wl.request("screen");
  } catch {}
}
const onVisible = () => {
  if (state.driving && document.visibilityState === "visible") void keepAwake();
};
/** 창을 닫거나 새로 고칠 때 — 진행을 놓았다고 서버에 알려 다시 연 창이 1분을 기다리지 않고 바로 이어 받게 */
const onPageHide = () => {
  if (!state.driving || !state.projectId) return;
  try {
    navigator.sendBeacon(`/api/projects/${state.projectId}/autowrite`, new Blob([JSON.stringify({ release: OWNER })], { type: "application/json" }));
  } catch {}
};

/* ---------- 단계 ---------- */

async function writeOne(it: AutoItem, i: number, n: number) {
  const opts = state.run!.options;
  const job = await runJob({
    sectionId: it.sectionId,
    label: it.label,
    mode: "overwrite",
    url: `/api/sections/${it.sectionId}/write`,
    body: { targetPages: it.targetPages, mode: "overwrite", extraInstruction: opts.extraInstruction },
    target: Math.round(it.targetPages * (opts.charsPerPage || 700)),
    batch: { i, n },
    signal: ctrl!.signal,
    auto: true,
    quiet: true,
  });
  if (!alive()) throw new Stopped();
  if (job.stopped) {
    // 상단 [■]·Esc로 이 절 집필을 멈췄다 — 자동 집필 전체를 일시 정지한다
    pause("집필을 직접 멈춰 자동 집필을 일시 정지했습니다.");
    throw new Stopped();
  }
  if (job.error) throw new Error(job.error);
  if (!job.chars && !job.md.trim()) throw new Error("AI가 본문을 쓰지 않았습니다.");
  return { chars: job.chars, truncated: !!job.truncated };
}

/**
 * 출력·시간 한도로 끝까지 못 쓴 절을 이어 쓴다 — 그 절을 잠그고, 끊긴 반쪽 문장을 지운 뒤, 남은 분량을 [뒤에 이어쓰기]로 붙인다.
 * 편집기가 열려 있어도 잠금이 풀릴 때 서버 원고를 다시 불러오므로 겹치지 않는다.
 */
async function continueOne(it: AutoItem) {
  const opts = state.run!.options;
  const cpp = opts.charsPerPage || 700;
  const signal = ctrl!.signal;
  lock(it.sectionId);
  try {
    if (!(await flushAllPending())) throw new Error("편집 중인 원고를 저장하지 못했습니다.");
    await settleSection(it.sectionId);
    const cur = parseDoc((await api<{ content: string }>(`/api/sections/${it.sectionId}`)).content);
    const trimmed = trimIncompleteTail(cur);
    if (trimmed !== cur && !(await saveViaQueue(it.sectionId, { content: JSON.stringify(trimmed), status: "ai_draft" }))) throw new Error("원고를 저장하지 못했습니다.");
    const target = it.targetPages * cpp;
    const have = charCount(trimmed);
    // 남은 분량(최소 반 쪽) — 거의 다 썼으면 마무리만
    const pages = Math.min(60, Math.max(0.5, Math.round(((target - have) / cpp) * 2) / 2));
    const note = "[자동 이어쓰기] 앞 본문이 한도에 걸려 중간에 끊겼다. 이미 쓴 내용을 되풀이하지 말고 바로 이어서 쓰고, 이 절을 자연스럽게 마무리한다.";
    const base = { targetPages: pages, mode: "continue", extraInstruction: [opts.extraInstruction, note].filter(Boolean).join("\n\n") };
    let md = "";
    let truncated = false;
    type Resume = { fromPart: number; parts: NonNullable<StreamEvent["parts"]> };
    let resume = null as Resume | null;
    for (let round = 0; round < 8; round++) {
      const body = resume ? { ...base, resume: { fromPart: resume.fromPart, parts: resume.parts, written: md } } : base;
      resume = null;
      const res = await fetch(`/api/sections/${it.sectionId}/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      await readStream(res, (e) => {
        if (e.t === "delta") md += e.v ?? "";
        else if (e.t === "resume" && e.parts && e.fromPart) resume = { fromPart: e.fromPart, parts: e.parts };
        else if (e.t === "status" && e.v === "truncated") truncated = true;
        else if (e.t === "status" && e.v && e.v !== "partial") setActivity("writer", `${it.label} 이어 쓰는 중… ${e.v}`);
        else if (e.t === "error") throw new Error(e.v);
      });
      if (!resume || signal.aborted) break;
    }
    if (signal.aborted) throw new Stopped();
    if (resume) truncated = true;
    if (!md.trim()) throw new Error("이어 쓴 본문이 없습니다.");
    await settleSection(it.sectionId);
    const fresh = parseDoc((await api<{ content: string }>(`/api/sections/${it.sectionId}`)).content);
    const next = appendDocs(fresh, markdownToDoc(md));
    const content = JSON.stringify(next);
    if (!(await saveViaQueue(it.sectionId, { content, status: "ai_draft" }))) throw new Error("이어 쓴 원고를 저장하지 못했습니다.");
    api(`/api/sections/${it.sectionId}/versions`, { method: "POST", json: { content, reason: "ai_output" } }).catch(() => {});
    return { chars: charCount(next), truncated };
  } catch (e) {
    if (signal.aborted) throw new Stopped();
    throw e;
  } finally {
    unlock(it.sectionId);
  }
}

type Marker = { paragraph: number; offset: number; footnote?: number; marker: string; kind: "check" | "image"; before: string };

async function factOne(it: AutoItem) {
  const projectId = state.projectId!;
  const r = await api<{ sections: { sectionId: string; markers: Marker[] }[] }>(`/api/projects/${projectId}/checks?sectionId=${it.sectionId}`);
  const markers = (r.sections[0]?.markers ?? []).filter((m) => m.kind === "check");
  const stats = { pass: 0, revise: 0, fail: 0 };
  for (const [k, m] of markers.entries()) {
    if (!alive()) throw new Stopped();
    setActivity("checker", `팩트체크 중… ${it.label} (${k + 1}/${markers.length})`);
    try {
      const res = await withRetry(it, "checker", "팩트체크", () =>
        api<{ verdict: "pass" | "revise"; applied: boolean }>(`/api/projects/${projectId}/factcheck`, {
          method: "POST",
          json: { sectionId: it.sectionId, paragraph: m.paragraph, offset: m.offset, footnote: m.footnote, marker: m.marker, before: m.before },
        }),
      );
      if (!res.applied) stats.fail++;
      else if (res.verdict === "pass") stats.pass++;
      else stats.revise++;
    } catch (e) {
      if (e instanceof Stopped || e instanceof TakenOver) throw e;
      stats.fail++; // 이 표시는 남겨 두고(확인할 것에 그대로) 다음 표시로
    }
  }
  return stats;
}

async function reviewOne(it: AutoItem) {
  const level = state.run!.options.reviewLevel;
  setActivity("checker", `검수 중… ${it.label}`);
  const sec = await api<{ content: string }>(`/api/sections/${it.sectionId}`);
  const before = parseDoc(sec.content) as JNode;
  type Change = { paragraph: number; before: string; after: string; type: string; reason: string };
  // 긴 절도 요청 하나가 서버 시간 한도(약 4분)에 걸리지 않게 약 6,000자씩 나눠 부른다 — 문단 번호는 절 전체 기준이라 한 번에 적용한다
  const ranges = paragraphRanges(textblocks(before).map((b) => b.text), REVIEW_CHUNK);
  const r: { changes: Change[]; failed: Change[] } = { changes: [], failed: [] };
  for (const [k, range] of ranges.entries()) {
    if (!alive()) throw new Stopped();
    setActivity("checker", `검수 중… ${it.label}${ranges.length > 1 ? ` (${k + 1}/${ranges.length})` : ""}`);
    const part = await withRetry(it, "checker", "검수", () =>
      api<{ changes: Change[]; failed: Change[] }>(`/api/sections/${it.sectionId}/proofread`, {
        method: "POST",
        json: { content: sec.content, level, ...range, snapshot: k === 0 },
      }),
    );
    r.changes.push(...part.changes);
    r.failed.push(...part.failed);
  }
  if (!alive()) throw new Stopped();
  const res = r.changes.length
    ? await api<{ applied: number[] }>(`/api/sections/${it.sectionId}/proofread/apply`, {
        method: "POST",
        json: { changes: r.changes.map((c, i) => ({ i, paragraph: c.paragraph, before: c.before, after: c.after })) },
      })
    : { applied: [] };
  const ok = new Set(res.applied);
  const result: AppliedChange[] = [
    ...r.changes.map((c, i) => ({ ...c, state: ok.has(i) ? ("applied" as const) : ("failed" as const) })),
    ...r.failed.map((c) => ({ ...c, state: "failed" as const })),
  ];
  // 그 절을 열면 [교정 내역]에서 고친 곳을 확인·되돌리기할 수 있다
  if (result.length) await saveProofResult(it.sectionId, { label: `${it.label} (자동 검수)`, before, result });
  return ok.size;
}

/** 점검(팩트체크·검수) 하나 — 그 절을 잠그고, 편집 중이던 입력을 먼저 저장한 뒤 서버에서 고친다 */
async function checkStep(it: AutoItem, stage: "fact" | "review") {
  const label = stage === "fact" ? "팩트체크" : "검수";
  // 사용자가 그 절에서 교정 등 다른 작업을 하고 있으면 끝날 때까지 기다린다
  while (sectionBusyWith(it.sectionId, "auto")) {
    if (!alive()) throw new Stopped();
    setActivity("checker", `${it.label} — 다른 작업이 끝나기를 기다리는 중…`);
    await sleep(3000, ctrl!.signal);
  }
  patchItem(it, { [stage]: "running" as Stage, attempts: 0 });
  void persist().catch(() => {});
  lock(it.sectionId);
  try {
    if (!(await flushAllPending())) throw new Error("편집 중인 원고를 저장하지 못했습니다.");
    if (stage === "fact") {
      const stats = await withRetry(it, "checker", label, () => factOne(it));
      patchItem(it, { fact: "done", factStats: stats, attempts: 0, error: undefined });
    } else {
      const fixes = await withRetry(it, "checker", label, () => reviewOne(it));
      patchItem(it, { review: "done", reviewFixes: fixes, attempts: 0, error: undefined });
    }
  } catch (e) {
    if (e instanceof Stopped || e instanceof TakenOver) {
      if (itemOf(it.sectionId)?.[stage] === "running") patchItem(it, { [stage]: "pending" as Stage });
      throw e;
    }
    patchItem(it, { [stage]: "error" as Stage, error: `${label} 실패: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    unlock(it.sectionId);
  }
  await persist();
}

/* ---------- 두 줄 ---------- */
let wakeChecker: (() => void) | null = null;
const nudge = () => wakeChecker?.();

async function writerLane() {
  const items = state.run!.items;
  let failStreak = 0;
  for (const [i, ref] of items.entries()) {
    const it = itemOf(ref.sectionId)!;
    if (it.write !== "pending" && it.write !== "running") continue;
    if (!alive()) return;
    patchItem(it, { write: "running", attempts: 0, error: undefined });
    setActivity("writer", `집필 중… ${it.label} (${i + 1}/${items.length})`);
    await persist();
    try {
      const r = await withRetry(it, "writer", "집필", async () => {
        // 이 절에서 사용자가 다른 작업(교정 등)을 하는 중이면 끝날 때까지 기다렸다가 쓴다
        while (sectionBusyWith(it.sectionId)) {
          if (!alive()) throw new Stopped();
          setActivity("writer", `${it.label} — 다른 작업이 끝나기를 기다리는 중…`);
          await sleep(3000, ctrl!.signal);
        }
        setActivity("writer", `집필 중… ${it.label} (${i + 1}/${items.length})`);
        return writeOne(it, i + 1, items.length);
      });
      let { chars, truncated } = r;
      // 한도에 걸려 끊긴 절은 완료로 두지 않고 이어 쓴다 (최대 2번)
      for (let round = 1; truncated && round <= 2; round++) {
        setActivity("writer", `${it.label} — 한도에 걸려 끊긴 뒤를 이어 쓰는 중… (${round}/2)`);
        ({ chars, truncated } = await withRetry(it, "writer", "이어쓰기", () => continueOne(it)));
      }
      patchItem(it, { write: "done", chars, attempts: 0, error: truncated ? "참고: 두 번 이어 썼지만 끝까지 쓰지 못했습니다. 절 끝을 확인하세요." : undefined });
      failStreak = 0;
    } catch (e) {
      if (e instanceof Stopped || e instanceof TakenOver) {
        if (itemOf(it.sectionId)?.write === "running") patchItem(it, { write: "pending" });
        return;
      }
      failStreak++;
      patchItem(it, { write: "error", error: `집필 실패: ${e instanceof Error ? e.message : String(e)}` });
      if (failStreak >= 2) {
        pause(`두 절 연속 집필에 실패해 멈췄습니다 — ${e instanceof Error ? e.message : String(e)}. AI 설정·연결을 확인한 뒤 [이어서 진행]을 누르세요.`, "error");
        return;
      }
    } finally {
      nudge();
    }
    await persist().catch(() => {});
  }
  setActivity("writer", "집필 완료");
}

async function checkerLane() {
  const opts = state.run!.options;
  if (!opts.factcheck && !opts.review) return;
  for (const ref of state.run!.items) {
    // 이 절의 집필이 끝날 때까지 기다린다 (그동안 집필 줄은 다음 절을 쓴다)
    for (;;) {
      if (!alive()) return;
      const w = itemOf(ref.sectionId)!.write;
      if (w === "done" || w === "skipped" || w === "error") break;
      setActivity("checker", `다음 절 집필이 끝나기를 기다리는 중… (${ref.label})`);
      await new Promise<void>((resolve) => {
        wakeChecker = resolve;
        setTimeout(resolve, 5000);
      });
    }
    const it = itemOf(ref.sectionId)!;
    if (it.write === "error") {
      patchItem(it, { fact: it.fact === "pending" ? "skipped" : it.fact, review: it.review === "pending" ? "skipped" : it.review });
      continue;
    }
    try {
      if (it.fact === "pending" || it.fact === "running") await checkStep(it, "fact");
      if (it.review === "pending" || it.review === "running") await checkStep(itemOf(ref.sectionId)!, "review");
    } catch {
      return; // 멈춤·다른 창 인계
    }
  }
  setActivity("checker", "점검 완료");
}

async function drive() {
  if (state.driving || !state.run) return;
  ctrl = new AbortController();
  set({ driving: true, foreign: false, activity: { writer: "", checker: "" } });
  void keepAwake();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pagehide", onPageHide);
  heartbeat = setInterval(() => void persist().catch(() => {}), HEARTBEAT_MS);
  try {
    await persist(true);
    const lanes = await Promise.allSettled([writerLane(), checkerLane()]);
    for (const l of lanes) if (l.status === "rejected" && !(l.reason instanceof TakenOver)) console.error("[autowrite]", l.reason);
  } catch (e) {
    if (!(e instanceof TakenOver)) console.error("[autowrite]", e);
  } finally {
    clearInterval(heartbeat);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pagehide", onPageHide);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    const run = state.run;
    const takenOver = state.foreign;
    ctrl = null;
    set({ driving: false });
    if (run && !takenOver && run.status === "running" && allFinished(run)) {
      set({ run: { ...run, status: "done" } });
      await persist().catch(() => {});
      const failed = run.items.filter((x) => x.write === "error" || x.fact === "error" || x.review === "error").length;
      if (failed) toast(`전체 자동 집필을 마쳤습니다. ${failed}개 절은 일부 단계가 실패했습니다 — 진행 창에서 [실패한 단계 다시]를 누르세요.`, { sticky: true });
      else toast.success("전체 자동 집필을 마쳤습니다.");
    }
  }
}

/* ---------- 바깥에서 부르는 것 ---------- */

/** 이 책의 진행 상태를 불러온다. 소식이 끊긴 진행 중 상태면 'stale' */
export async function loadAutoRun(projectId: string): Promise<"none" | "active" | "stale" | "foreign" | "paused" | "finished"> {
  if (state.driving && state.projectId === projectId) return "active";
  if (state.driving && state.projectId !== projectId) {
    // 다른 책을 진행 중이다 — 이 책 상태만 읽어 보여 준다
  }
  const r = await api<{ run: AutoRun | null; now: number }>(`/api/projects/${projectId}/autowrite`);
  if (state.driving) {
    if (state.projectId !== projectId) return r.run ? "foreign" : "none";
    return "active";
  }
  set({ projectId, run: r.run, foreign: false });
  if (!r.run) return "none";
  if (r.run.status === "running") {
    if (r.run.owner !== OWNER && r.now - r.run.updatedAt < STALE_MS) {
      set({ foreign: true });
      return "foreign";
    }
    return "stale";
  }
  return r.run.status === "paused" ? "paused" : "finished";
}

export async function startAutoRun(projectId: string, items: AutoItem[], options: AutoOptions) {
  if (state.driving) throw new Error("전체 자동 집필이 이미 진행 중입니다.");
  if (!items.length) throw new Error("진행할 절이 없습니다.");
  const cur = await api<{ run: AutoRun | null; now: number }>(`/api/projects/${projectId}/autowrite`);
  if (cur.run?.status === "running" && cur.run.owner !== OWNER && cur.now - cur.run.updatedAt < STALE_MS) throw new Error("다른 창에서 전체 자동 집필을 진행하고 있습니다.");
  const now = Date.now();
  const run: AutoRun = { version: 1, runId: `${now.toString(36)}-${OWNER.slice(0, 6)}`, status: "running", startedAt: now, updatedAt: now, owner: OWNER, options, items };
  set({ projectId, run });
  void drive();
}

/** 멈춘(또는 소식이 끊긴) 진행을 남은 단계부터 이어 간다 */
export async function resumeAutoRun(projectId: string, retryFailed = false) {
  if (state.driving) return;
  if (state.projectId !== projectId || !state.run) await loadAutoRun(projectId);
  if (!state.run) throw new Error("이어 갈 자동 집필이 없습니다.");
  if (state.foreign) throw new Error("다른 창에서 전체 자동 집필을 진행하고 있습니다.");
  if (!(await flushAllPending())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
  set({ run: { ...prepareResume(state.run, retryFailed), owner: OWNER } });
  void drive();
}

export function pause(reason = "일시 정지했습니다.", kind: "user" | "error" = "user") {
  const run = state.run;
  if (!run || run.status !== "running") return;
  set({ run: { ...run, status: "paused", pauseReason: reason, pauseKind: kind } });
  ctrl?.abort();
  void persist().catch(() => {});
}

export const pauseAutoRun = () => pause("직접 일시 정지했습니다.");

/** 끝낸다 — 쓴 원고는 그대로 두고 진행 기록만 닫는다 */
export async function stopAutoRun() {
  const run = state.run;
  if (!run) return;
  set({ run: { ...run, status: "stopped", pauseReason: "직접 끝냈습니다." } });
  ctrl?.abort();
  await persist().catch(() => {});
}

/** 끝난 진행 기록을 치운다 */
export async function dismissAutoRun() {
  const { projectId, run } = state;
  if (!projectId || !run || state.driving) return;
  await api(`/api/projects/${projectId}/autowrite`, { method: "DELETE" });
  set({ run: null });
}
