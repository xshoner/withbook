"use client";

import { api } from "@/lib/client";
import type { JNode } from "@/lib/doc/doc";
import { toast } from "../ui/feedback";
import { createJobStore, registerJobKind, sectionBusyWith } from "./jobStore";
import type { AppliedChange } from "./ProofPanel";

/**
 * AI 교정·교열 작업 — 편집기 밖(모듈)에서 돈다. 교정 중에 다른 절로 옮겨도 멈추지 않는다.
 * 교정하는 절은 끝날 때까지 잠근다(문단 번호로 고치므로 그사이 본문이 바뀌면 안 된다). 다른 절은 편집할 수 있다.
 * 끝날 때 그 절 편집기가 열려 있으면 편집기가 고치고(applier), 아니면 서버가 저장된 원고에 바로 적용한다.
 * 결과(변경 내역)는 서버에도 7일 보관한다(proof-result) — 새로 고침·다른 기기에서도 [교정 내역]에 보인다.
 */

type Change = Omit<AppliedChange, "state">;

export type ProofJob = {
  sectionId: string;
  label: string;
  state: "running" | "done";
  /** 교정 전 원고 — [전체 되돌리기] 기준 */
  before: JNode;
  result: AppliedChange[] | null;
};

type Applier = (changes: Change[], failed: Change[], before: JNode) => Promise<AppliedChange[] | null>;

const store = createJobStore<ProofJob, Applier>();
const { jobs, appliers, emit } = store;
const ctrls = new Map<string, AbortController>();

export const useProofJobs = store.useJobs;

export const proofRunning = (sectionId: string) => jobs.get(sectionId)?.state === "running";
registerJobKind("proof", { label: "교정·교열", busy: proofRunning, any: () => [...jobs.values()].some((j) => j.state === "running") });

export const registerProofApplier = store.registerApplier;

/** 교정을 멈춘다 (고친 것은 넣지 않는다) */
export function stopProof(sectionId: string) {
  ctrls.get(sectionId)?.abort();
}

export function waitProofIdle(sectionId: string): Promise<void> {
  if (!proofRunning(sectionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = store.subscribe(() => {
      if (proofRunning(sectionId)) return;
      off();
      resolve();
    });
  });
}

/** 끝난 교정 결과를 편집기가 가져가면 치운다 */
export function takeProofResult(sectionId: string): ProofJob | null {
  const j = jobs.get(sectionId);
  if (!j || j.state !== "done") return null;
  jobs.delete(sectionId);
  emit();
  return j;
}

/* ---------- 서버 보관 (새로 고침해도 남게) ---------- */
export type SavedProof = { label: string; before: JNode; result: AppliedChange[] };

export function saveProofResult(sectionId: string, p: SavedProof) {
  return api(`/api/sections/${sectionId}/proof-result`, { method: "PUT", json: p }).catch(() => {});
}

export async function loadProofResult(sectionId: string): Promise<SavedProof | null> {
  try {
    const r = await api<SavedProof | null>(`/api/sections/${sectionId}/proof-result`);
    return r && Array.isArray(r.result) && r.before ? r : null;
  } catch {
    return null;
  }
}

export function clearProofResult(sectionId: string) {
  return api(`/api/sections/${sectionId}/proof-result`, { method: "DELETE" }).catch(() => {});
}

export async function runProof(o: { sectionId: string; label: string; before: JNode; level: "proof" | "light" }) {
  if (proofRunning(o.sectionId)) return;
  const other = sectionBusyWith(o.sectionId, "proof");
  if (other) {
    toast.error(`${o.label}: ${other} 중이라 교정을 시작할 수 없습니다.`);
    return;
  }
  const ctrl = new AbortController();
  ctrls.set(o.sectionId, ctrl);
  const job: ProofJob = { sectionId: o.sectionId, label: o.label, state: "running", before: o.before, result: null };
  jobs.set(o.sectionId, job);
  emit();
  void clearProofResult(o.sectionId); // 지난 교정 내역은 이제 기준이 아니다
  try {
    const r = await api<{ changes: Change[]; failed: Change[] }>(`/api/sections/${o.sectionId}/proofread`, {
      method: "POST",
      json: { content: JSON.stringify(o.before), level: o.level },
      signal: ctrl.signal,
    });
    const ap = appliers.get(o.sectionId);
    let result: AppliedChange[];
    if (ap) {
      // 편집기가 바로 보여 준다 — 잠금을 먼저 풀어야(running이 아니어야) 편집기가 편집 가능 상태로 돌아간다
      jobs.delete(o.sectionId);
      emit();
      result = (await ap(r.changes, r.failed, o.before)) ?? [];
    } else {
      // 편집기가 닫혀 있다 — 서버가 저장된 원고에 적용
      const res = await api<{ applied: number[] }>(`/api/sections/${o.sectionId}/proofread/apply`, {
        method: "POST",
        json: { changes: r.changes.map((c, i) => ({ i, paragraph: c.paragraph, before: c.before, after: c.after })) },
      });
      const ok = new Set(res.applied);
      result = [...r.changes.map((c, i) => ({ ...c, state: ok.has(i) ? ("applied" as const) : ("failed" as const) })), ...r.failed.map((c) => ({ ...c, state: "failed" as const }))];
      jobs.set(o.sectionId, { ...job, state: "done", result });
      toast.success(`${o.label} 교정을 마쳤습니다 (${ok.size}곳 고침). 그 절을 열면 [교정 내역]에서 확인·되돌리기할 수 있습니다.`);
    }
    if (result.length) void saveProofResult(o.sectionId, { label: o.label, before: o.before, result });
  } catch (e) {
    jobs.delete(o.sectionId);
    if (ctrl.signal.aborted) toast(`${o.label} 교정을 멈췄습니다.`);
    else toast.error(`교정 오류 (${o.label}): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctrls.delete(o.sectionId);
  }
  emit();
}
