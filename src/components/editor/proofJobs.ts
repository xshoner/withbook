"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/client";
import type { JNode } from "@/lib/doc/doc";
import { toast } from "../ui/feedback";
import type { AppliedChange } from "./ProofPanel";

/**
 * AI 교정·교열 작업 — 편집기 밖(모듈)에서 돈다. 교정 중에 다른 절로 옮겨도 멈추지 않는다.
 * 교정하는 절은 끝날 때까지 잠근다(문단 번호로 고치므로 그사이 본문이 바뀌면 안 된다). 다른 절은 편집할 수 있다.
 * 끝날 때 그 절 편집기가 열려 있으면 편집기가 고치고(applier), 아니면 서버가 저장된 원고에 바로 적용한다.
 * 결과(변경 내역)는 그 절을 다시 열면 [교정 내역]에 보인다.
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

const jobs = new Map<string, ProofJob>();
const appliers = new Map<string, Applier>();
const subs = new Set<() => void>();
let snap: ProofJob[] = [];
const emit = () => {
  snap = [...jobs.values()];
  subs.forEach((f) => f());
};

export function useProofJobs(): ProofJob[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snap,
    () => snap,
  );
}

export const proofRunning = (sectionId: string) => jobs.get(sectionId)?.state === "running";

export function registerProofApplier(sectionId: string, fn: Applier) {
  appliers.set(sectionId, fn);
  return () => {
    if (appliers.get(sectionId) === fn) appliers.delete(sectionId);
  };
}

/** 끝난 교정 결과를 편집기가 가져가면 치운다 */
export function takeProofResult(sectionId: string): ProofJob | null {
  const j = jobs.get(sectionId);
  if (!j || j.state !== "done") return null;
  jobs.delete(sectionId);
  emit();
  return j;
}

export async function runProof(o: { sectionId: string; label: string; before: JNode; level: "proof" | "light" }) {
  if (proofRunning(o.sectionId)) return;
  const job: ProofJob = { sectionId: o.sectionId, label: o.label, state: "running", before: o.before, result: null };
  jobs.set(o.sectionId, job);
  emit();
  try {
    const r = await api<{ changes: Change[]; failed: Change[] }>(`/api/sections/${o.sectionId}/proofread`, {
      method: "POST",
      json: { content: JSON.stringify(o.before), level: o.level },
    });
    const ap = appliers.get(o.sectionId);
    let result: AppliedChange[];
    if (ap) {
      result = (await ap(r.changes, r.failed, o.before)) ?? [];
      jobs.delete(o.sectionId); // 편집기가 바로 보여 줬다
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
  } catch (e) {
    jobs.delete(o.sectionId);
    toast.error(`교정 오류 (${o.label}): ${e instanceof Error ? e.message : String(e)}`);
  }
  emit();
}
