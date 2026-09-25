"use client";

import { useSyncExternalStore } from "react";
import { api, readStream } from "@/lib/client";
import { appendDocs, charCount, markdownToDoc, parseDoc, type JNode } from "@/lib/doc/doc";
import { toast } from "../ui/feedback";
import { saveViaQueue, settleSection } from "./useAutosave";

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
};

type Applier = (job: AiJob, doc: JNode) => Promise<string | null>;

const jobs = new Map<string, AiJob>();
const ctrls = new Map<string, AbortController>();
const appliers = new Map<string, Applier>();
const subs = new Set<() => void>();
let snapshot: AiJob[] = [];
const emit = () => {
  snapshot = [...jobs.values()];
  subs.forEach((f) => f());
};

export function useAiJobs(): AiJob[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snapshot,
    () => snapshot,
  );
}

export const jobFor = (sectionId: string) => jobs.get(sectionId) ?? null;
export const anyRunning = () => [...jobs.values()].some((j) => j.state === "running");
/** 이 절 본문을 AI가 통째로 새로 쓰는 중인가 (그동안 그 절만 잠근다) */
export const locksSection = (j: AiJob | null) => !!j && j.state === "running" && (j.mode === "overwrite" || j.mode === "adjust");

/** 열린 편집기가 끝난 결과를 직접 넣는다. 돌려준 함수로 해제 */
export function registerApplier(sectionId: string, fn: Applier) {
  appliers.set(sectionId, fn);
  return () => {
    if (appliers.get(sectionId) === fn) appliers.delete(sectionId);
  };
}

export function stopJob(sectionId: string) {
  ctrls.get(sectionId)?.abort();
}

export function stopAll() {
  ctrls.forEach((c) => c.abort());
}

/** 끝난 새 버전 후보·오류 기록을 치운다 */
export function clearJob(sectionId: string) {
  if (jobs.get(sectionId)?.state === "running") return;
  jobs.delete(sectionId);
  emit();
}

function update(j: AiJob, patch: Partial<AiJob>) {
  Object.assign(j, patch);
  if (jobs.get(j.sectionId) === j) {
    jobs.set(j.sectionId, { ...j }); // 새 객체 → 구독하는 화면이 다시 그린다
    emit();
  }
}

// 탭을 닫으면 쓰던 글을 잃으므로 한 번 묻는다
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if (anyRunning()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

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
};

/** 작업 하나를 시작하고 끝날 때까지 기다린다 (결과는 applier 또는 저장 큐로 반영) */
export async function runJob(o: StartOptions): Promise<AiJob> {
  if (jobs.get(o.sectionId)?.state === "running") throw new Error("이 절은 이미 AI가 쓰고 있습니다.");
  const ctrl = new AbortController();
  if (o.signal) o.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  ctrls.set(o.sectionId, ctrl);
  const job: AiJob = { sectionId: o.sectionId, label: o.label, mode: o.mode, state: "running", status: "준비 중…", md: "", chars: 0, target: o.target, batch: o.batch, figures: o.figures ?? [] };
  jobs.set(o.sectionId, job);
  emit();
  let md = "";
  let last = 0;
  try {
    const res = await fetch(o.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o.body), signal: ctrl.signal });
    await readStream(res, (e) => {
      if (e.t === "status" && e.v === "truncated") return update(job, { notice: "AI 출력이 한도에 걸려 중간에 끊겼습니다. [집필하기 → 뒤에 이어쓰기]로 이어 쓸 수 있습니다." });
      if (e.t === "status" && e.v === "partial") return update(job, { notice: "긴 절이라 한 번에 쓸 수 있는 시간(약 5분)을 넘겨 앞부분까지만 썼습니다. [집필하기 → 뒤에 이어쓰기]로 나머지를 이어 쓰세요." });
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
  } catch (e) {
    if (!ctrl.signal.aborted) update(job, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    ctrls.delete(o.sectionId);
  }

  const aborted = ctrl.signal.aborted;
  if (!md.trim()) {
    update(job, { state: job.error ? "error" : "aborted" });
    if (job.error) toast.error(`AI 오류 (${job.label}): ${job.error}`);
    if (job.mode !== "newVersion" || !job.error) {
      jobs.delete(o.sectionId);
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
    toast.error(e instanceof Error ? e.message : String(e));
  }
  jobs.delete(o.sectionId);
  emit();
  if (content) {
    api(`/api/sections/${o.sectionId}/versions`, { method: "POST", json: { content, reason: "ai_output" } }).catch(() => {});
    fetch(`/api/sections/${o.sectionId}/summarize`, { method: "POST" }).catch(() => {});
    if (!appliers.has(o.sectionId)) toast.success(`${job.label} ${aborted ? "쓴 데까지 저장했습니다" : "집필을 마쳤습니다"}.`);
    if (job.error) toast.error(`AI 오류 (${job.label}): ${job.error} — 쓴 데까지는 넣었습니다.`);
  }
  if (job.notice) toast(`${job.label}: ${job.notice}`, { sticky: true });
  return job;
}

let batchCtrl: AbortController | null = null;
export const batchRunning = () => !!batchCtrl;
export function stopBatch() {
  batchCtrl?.abort();
}

/** 여러 절을 책 순서대로 하나씩 (앞 절 요약이 다음 절에 이어진다) */
export async function runBatch(items: Omit<StartOptions, "batch" | "signal">[]) {
  if (batchCtrl) throw new Error("다중 집필이 이미 진행 중입니다.");
  batchCtrl = new AbortController();
  const done: string[] = [];
  try {
    for (const [i, it] of items.entries()) {
      if (batchCtrl.signal.aborted) break;
      const j = await runJob({ ...it, batch: { i: i + 1, n: items.length }, signal: batchCtrl.signal });
      if (j.state !== "error" && !batchCtrl.signal.aborted) done.push(it.label);
    }
  } finally {
    batchCtrl = null;
  }
  return done;
}
