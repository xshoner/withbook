"use client";

import { useSyncExternalStore } from "react";
import { createJobStore, registerJobKind, sectionBusyWith } from "./jobStore";
import { api, readStream, type StreamEvent } from "@/lib/client";
import { appendDocs, charCount, markdownToDoc, parseDoc, type JNode } from "@/lib/doc/doc";
import { toast } from "../ui/feedback";
import { saveViaQueue, settleSection } from "./useAutosave";
import type { WriteTiming } from "@/lib/ai/write-timing";
import { scheduleSummaryPreparation } from "./preparation";

/**
 * AI 집필 작업 — 편집기 밖(모듈)에서 돈다. 쓰는 동안 다른 절로 옮겨 편집해도 멈추지 않는다.
 * - overwrite/adjust: 그 절 전체가 대상 → 그 절만 잠그고, 다른 절은 자유롭게 편집
 * - continue: 대상은 끝부분 → 그 절도 편집할 수 있고, 다 쓰면 그때의 본문 뒤에 붙인다
 * - newVersion: 본문을 건드리지 않고 후보로만 보관
 * 끝날 때 그 절 편집기가 열려 있으면 편집기가 넣고(applier), 아니면 저장 큐로 바로 저장한다.
 */

export type JobMode = "overwrite" | "continue" | "adjust" | "newVersion";

export type AiJob = {
  sectionId: string;
  label: string;
  mode: JobMode;
  state: "running" | "done" | "error" | "aborted";
  status: string;
  md: string;
  chars: number;
  target: number;
  batch?: { i: number; n: number };
  /** 분량 조정: 원고의 그림을 ⟦그림N⟧ 자리에 되돌려 넣는다 */
  figures: JNode[];
  notice?: string;
  error?: string;
  /** 시작 시각 — 첫 문장이 나오기 전 경과 시간 표시용 */
  startedAt: number;
  /** 전체 자동 집필이 시작한 작업 — 상단 [■]은 자동 집필을 멈춘다 */
  auto?: boolean;
  /** 끝났을 때 중지된 상태였나 (사용자 중지 포함) */
  stopped?: boolean;
  /** 출력 한도·서버 시간 한도로 끝까지 쓰지 못했다 (쓴 데까지는 넣었다) */
  truncated?: boolean;
};

type Applier = (job: AiJob, doc: JNode) => Promise<string | null>;

const store = createJobStore<AiJob, Applier>();
const { jobs, appliers, emit } = store;
const ctrls = new Map<string, AbortController>();
const lastTimings = new Map<string, WriteTiming>();
export function useLastWriteTiming(sectionId: string) {
  return useSyncExternalStore(
    store.subscribe,
    () => lastTimings.get(sectionId) ?? null,
    () => null,
  );
}

export const useAiJobs = store.useJobs;

export const jobFor = (sectionId: string) => jobs.get(sectionId) ?? null;
export const anyRunning = () => [...jobs.values()].some((j) => j.state === "running");
/** 이 절 본문을 AI가 통째로 새로 쓰는 중인가 (그동안 그 절만 잠근다) */
export const locksSection = (j: AiJob | null) => !!j && j.state === "running" && (j.mode === "overwrite" || j.mode === "adjust");
const running = (sectionId: string) => jobs.get(sectionId)?.state === "running";
// 탭을 닫을 때 묻기·교정과 겹치지 않기 (jobStore)
registerJobKind("ai", { label: "AI 집필", busy: running, any: anyRunning });

/** 열린 편집기가 끝난 결과를 직접 넣는다. 돌려준 함수로 해제 */
export const registerApplier = store.registerApplier;

export function stopJob(sectionId: string) {
  ctrls.get(sectionId)?.abort();
}

export function stopAll() {
  ctrls.forEach((c) => c.abort());
}

/** 이 절의 작업이 끝날 때까지 (중지한 뒤 쓴 데까지 저장되기를 기다릴 때) */
export function waitJobIdle(sectionId: string): Promise<void> {
  if (!running(sectionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = store.subscribe(() => {
      if (running(sectionId)) return;
      off();
      resolve();
    });
  });
}

/** 끝난 새 버전 후보·오류 기록을 치운다 */
export function clearJob(sectionId: string) {
  if (jobs.get(sectionId)?.state === "running") return;
  forget(sectionId);
  emit();
}

/**
 * 진행 중인 작업 객체(runJob이 쥐고 고치는 것). jobs에는 화면용 복사본을 넣는다 — 그래서 "지금 이 절의 작업인가"는 복사본이 아니라 이것과 비교한다.
 * (예전에는 jobs의 값과 비교해 첫 갱신 뒤 복사본으로 바뀌면서 이후 진행·완료 상태가 화면에 반영되지 않았다)
 */
const live = new Map<string, AiJob>();

function update(j: AiJob, patch: Partial<AiJob>) {
  Object.assign(j, patch);
  if (live.get(j.sectionId) === j && jobs.has(j.sectionId)) {
    jobs.set(j.sectionId, { ...j }); // 새 객체 → 구독하는 화면이 다시 그린다
    emit();
  }
}

function forget(sectionId: string) {
  jobs.delete(sectionId);
  live.delete(sectionId);
}

/** 편집기가 없을 때 — 서버의 지금 본문을 기준으로 결과를 만들어 저장 큐로 저장 */
async function saveDetached(job: AiJob, doc: JNode): Promise<string> {
  let next = doc;
  if (job.mode === "continue") {
    await settleSection(job.sectionId);
    const cur = await api<{ content: string }>(`/api/sections/${job.sectionId}`);
    next = appendDocs(parseDoc(cur.content), doc);
  }
  const content = JSON.stringify(next);
  if (!(await saveViaQueue(job.sectionId, { content, status: "ai_draft" }))) throw new Error("AI가 쓴 원고를 저장하지 못했습니다. 연결을 확인하세요 (브라우저에 보관 중).");
  return content;
}

export type StartOptions = {
  sectionId: string;
  label: string;
  mode: JobMode;
  url: string;
  body: object;
  target: number;
  figures?: JNode[];
  batch?: { i: number; n: number };
  signal?: AbortSignal;
  auto?: boolean;
  /** 완료·오류 알림을 띄우지 않는다 (부른 쪽이 따로 보여 준다) */
  quiet?: boolean;
};

/** 작업 하나를 시작하고 끝날 때까지 기다린다 (결과는 applier 또는 저장 큐로 반영) */
export async function runJob(o: StartOptions): Promise<AiJob> {
  if (running(o.sectionId)) throw new Error("이 절은 이미 AI가 쓰고 있습니다.");
  const other = sectionBusyWith(o.sectionId, "ai");
  if (other) throw new Error(`${o.label}: ${other} 중이라 AI 집필을 시작할 수 없습니다.`);
  const ctrl = new AbortController();
  if (o.signal) o.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  ctrls.set(o.sectionId, ctrl);
  const job: AiJob = { sectionId: o.sectionId, label: o.label, mode: o.mode, state: "running", status: "준비 중…", md: "", chars: 0, target: o.target, batch: o.batch, figures: o.figures ?? [], startedAt: Date.now(), auto: o.auto };
  jobs.set(o.sectionId, { ...job });
  live.set(o.sectionId, job);
  emit();
  let md = "";
  let last = 0;
  type Resume = { fromPart: number; parts: NonNullable<StreamEvent["parts"]> };
  let resumeFrom: Resume | null = null;
  // 긴 절은 한 요청의 시간 한도로 멈추면(resume) 같은 개요로 다음 요청을 이어 보낸다 — 사용자가 [이어쓰기]를 누르지 않아도 끝까지 쓴다
  let resume = null as Resume | null;
  try {
    for (let round = 0; round < 8; round++) {
      resume = null as Resume | null;
      const body = round === 0 ? o.body : { ...o.body, resume: { fromPart: resumeFrom!.fromPart, parts: resumeFrom!.parts, written: md } };
      const res = await fetch(o.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      await readStream(res, (e) => {
        if (e.t === "timing" && e.timing) {
          lastTimings.delete(o.sectionId);
          lastTimings.set(o.sectionId, e.timing);
          if (lastTimings.size > 100) lastTimings.delete(lastTimings.keys().next().value!);
          emit();
          return;
        }
        if (e.t === "resume" && e.parts && e.fromPart) {
          resume = { fromPart: e.fromPart, parts: e.parts };
          return;
        }
        if (e.t === "status" && e.v === "truncated") return update(job, { truncated: true, notice: "AI 출력이 한도에 걸려 중간에 끊겼습니다. [집필하기 → 뒤에 이어쓰기]로 이어 쓸 수 있습니다." });
        if (e.t === "status" && e.v === "partial") return; // 아래에서 자동으로 이어 쓴다
        if (e.t === "status") return update(job, { status: e.v ?? "" });
        if (e.t === "delta") {
          md += e.v ?? "";
          if (Date.now() - last > 250) {
            last = Date.now();
            update(job, { md, chars: charCount(markdownToDoc(md)), status: job.status.startsWith("구상") ? "집필 중…" : job.status });
          }
        }
        if (e.t === "error") throw new Error(e.v);
      });
      update(job, { md, chars: charCount(markdownToDoc(md)) });
      const next = resume as Resume | null;
      if (!next || ctrl.signal.aborted) break;
      resumeFrom = next;
      update(job, { status: `이어서 쓰는 중… (${next.fromPart + 1}/${next.parts.length})` });
    }
    if ((resume as Resume | null) && !ctrl.signal.aborted)
      update(job, { truncated: true, notice: "긴 절이라 자동으로 여러 번 이어 썼지만 끝까지 쓰지 못했습니다. [집필하기 → 뒤에 이어쓰기]로 나머지를 이어 쓰세요." });
  } catch (e) {
    if (!ctrl.signal.aborted) update(job, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    ctrls.delete(o.sectionId);
  }

  const aborted = ctrl.signal.aborted;
  job.stopped = aborted;
  if (!md.trim()) {
    update(job, { state: job.error ? "error" : "aborted" });
    if (job.error && !o.quiet) toast.error(`AI 오류 (${job.label}): ${job.error}`);
    if (job.mode !== "newVersion" || !job.error) {
      forget(o.sectionId);
      emit();
    }
    return job;
  }
  // 새 버전 후보: 본문은 그대로, 편집기가 후보로 보여 준다
  if (job.mode === "newVersion") {
    update(job, { state: "done", status: "완료" });
    const ap = appliers.get(o.sectionId);
    if (ap) await ap(job, markdownToDoc(md)).catch(() => null);
    else toast.success(`${job.label} 새 버전 후보가 준비됐습니다. 그 절을 열어 비교하세요.`);
    return job;
  }
  // 중지했어도 쓴 데까지는 넣는다
  const doc = markdownToDoc(md, job.figures);
  let content: string | null = null;
  try {
    const ap = appliers.get(o.sectionId);
    content = ap ? await ap(job, doc) : await saveDetached(job, doc);
  } catch (e) {
    if (!job.error) job.error = e instanceof Error ? e.message : String(e);
    if (!o.quiet) toast.error(e instanceof Error ? e.message : String(e));
  }
  forget(o.sectionId);
  emit();
  if (content) {
    api(`/api/sections/${o.sectionId}/versions`, { method: "POST", json: { content, reason: "ai_output" } }).catch(() => {});
    scheduleSummaryPreparation(o.sectionId, undefined, 0);
    if (!appliers.has(o.sectionId) && !o.quiet) toast.success(`${job.label} ${aborted ? "쓴 데까지 저장했습니다" : "집필을 마쳤습니다"}.`);
    if (job.error && !o.quiet) toast.error(`AI 오류 (${job.label}): ${job.error} — 쓴 데까지는 넣었습니다.`);
  } else if (!job.error) job.error = "AI가 쓴 원고를 저장하지 못했습니다.";
  if (job.notice && !o.quiet) toast(`${job.label}: ${job.notice}`, { sticky: true });
  return job;
}

let batchCtrl: AbortController | null = null;
export const batchRunning = () => !!batchCtrl;
export function stopBatch() {
  batchCtrl?.abort();
}

/** 여러 절을 책 순서대로 하나씩 (앞 절 요약이 다음 절에 이어진다). 이미 작업 중인 절은 건너뛰고 계속한다 */
export async function runBatch(items: Omit<StartOptions, "batch" | "signal">[]) {
  if (batchCtrl) throw new Error("다중 집필이 이미 진행 중입니다.");
  batchCtrl = new AbortController();
  const done: string[] = [];
  const skipped: string[] = [];
  try {
    for (const [i, it] of items.entries()) {
      if (batchCtrl.signal.aborted) break;
      if (running(it.sectionId) || sectionBusyWith(it.sectionId, "ai")) {
        skipped.push(it.label);
        continue;
      }
      const j = await runJob({ ...it, batch: { i: i + 1, n: items.length }, signal: batchCtrl.signal }).catch(() => null);
      if (!j) skipped.push(it.label);
      else if (j.state !== "error" && !batchCtrl.signal.aborted) done.push(it.label);
    }
  } finally {
    batchCtrl = null;
  }
  if (skipped.length) toast(`다른 작업 중이라 건너뛴 절: ${skipped.join(", ")}`, { sticky: true });
  return done;
}
