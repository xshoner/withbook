"use client";

import { get, set, update } from "idb-keyval";
import { useCallback, useEffect, useRef, useState } from "react";
import { AutosaveQueue, SaveError, type Draft, type Patch, type SaveResult, type SaveState } from "@/lib/autosave-queue";
import { cancelSummaryPreparation, scheduleSummaryPreparation } from "./preparation";
export type { Patch, SaveState } from "@/lib/autosave-queue";

const key = (id: string) => `bookk-pending:${id}`;
const queues = new Map<string, AutosaveQueue>();
function queue(id: string) {
  let q = queues.get(id);
  if (!q) {
    q = new AutosaveQueue({
      async save(patch) {
        const res = await fetch(`/api/sections/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch), signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new SaveError((await res.json().catch(() => ({}))).error ?? `저장 실패 (${res.status})`, res.status);
        const result = await res.json();
        if (patch.content !== undefined) scheduleSummaryPreparation(id, () => !queues.get(id)?.draft);
        return result;
      },
      persist: (draft) => set(key(id), draft),
      acknowledge: (token) => update<Draft | undefined>(key(id), (value) => value?.token === token ? undefined : value),
      offline: () => !navigator.onLine,
    });
    queues.set(id, q);
  }
  return q;
}

/** 열린 편집기가 아직 큐에 넣지 않은 입력(250ms 묶음)을 넣는 함수 — 저장을 기다리기 전에 먼저 부른다 */
const committers = new Map<string, () => void>();
export function registerCommit(id: string, fn: () => void) {
  committers.set(id, fn);
  return () => {
    if (committers.get(id) === fn) committers.delete(id);
  };
}

export async function flushAllPending() {
  committers.forEach((fn) => fn());
  return (await Promise.all([...queues.values()].map((q) => q.flush()))).every(Boolean);
}

/** 편집기 없이 절을 저장한다 (다른 절을 보는 동안 끝난 AI 집필 등) — 같은 저장 큐를 거치므로 편집기 저장과 겹치지 않는다 */
export async function saveViaQueue(id: string, patch: Patch) {
  const q = queue(id);
  cancelSummaryPreparation(id);
  q.mark(patch);
  const ok = await q.flush();
  if (q.idle() && queues.get(id) === q) queues.delete(id);
  return ok;
}

/** 이 절에 밀린 저장을 보낸다. 보낼 것이 없거나 다 보냈으면 true */
export async function settleSection(id: string) {
  committers.get(id)?.();
  return (await queues.get(id)?.flush()) ?? true;
}

export function useAutosave(sectionId: string | null, onSaved?: (result: SaveResult) => void) {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const callback = useRef(onSaved);
  callback.current = onSaved;
  const q = sectionId ? queue(sectionId) : null;
  const flush = useCallback(() => q?.flush() ?? Promise.resolve(true), [q]);
  const markDirty = useCallback((patch: Patch) => {
    if (sectionId) cancelSummaryPreparation(sectionId);
    q?.mark(patch);
  }, [q, sectionId]);
  useEffect(() => {
    if (!q) return;
    const unsubscribe = q.subscribe((state, result) => {
      setState(state);
      if (result) callback.current?.(result);
    });
    const hidden = () => { if (document.visibilityState === "hidden") void q.flush(); };
    const online = () => void q.flush();
    const unload = (event: BeforeUnloadEvent) => {
      if (!q.draft) return;
      // A second beacon can overtake a PUT. Keep the local recovery copy instead.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", hidden);
      q.stopTimer();
      // 저장이 끝나고 다른 편집기가 이 절을 다시 열지 않았으면 큐를 지운다 (열어 본 절마다 쌓이지 않게)
      void q.flush().then(() => {
        if (sectionId && q.idle() && queues.get(sectionId) === q) queues.delete(sectionId);
      });
    };
  }, [q, sectionId]);
  return { state, markDirty, flush };
}

export async function recoverPending(sectionId: string): Promise<Draft | null> {
  // Server and browser clocks cannot establish whether a draft was acknowledged.
  const active = queues.get(sectionId);
  if (active?.draft) return active.draft;
  try { return (await get<Draft>(key(sectionId))) ?? null; } catch { return null; }
}
