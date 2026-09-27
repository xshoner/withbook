"use client";

import { get, set, update } from "idb-keyval";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AutosaveQueue, SaveError, type Conflict, type Draft, type Patch, type SaveResult, type SaveState } from "@/lib/autosave-queue";
import { contentHash } from "@/lib/doc/doc";
import { cancelSummaryPreparation, scheduleSummaryPreparation } from "./preparation";
export type { Conflict, Patch, SaveState } from "@/lib/autosave-queue";

const key = (id: string) => `bookk-pending:${id}`;
const queues = new Map<string, AutosaveQueue>();
/** 절 이름 (상단 저장 표시·실패 안내에 쓴다) — 편집기가 열 때 알려 준다 */
const labels = new Map<string, string>();
export const sectionLabel = (id: string) => labels.get(id) || "이름 모를 절";

function queue(id: string) {
  let q = queues.get(id);
  if (!q) {
    q = new AutosaveQueue({
      async save(patch) {
        const res = await fetch(`/api/sections/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch), signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const c = res.status === 409 && body?.conflict ? { content: String(body.conflict.content ?? ""), hash: String(body.conflict.contentHash ?? ""), updatedAt: body.conflict.updatedAt } : undefined;
          throw new SaveError(body.error ?? `저장 실패 (${res.status})`, res.status, c);
        }
        const result = await res.json();
        if (patch.content !== undefined) scheduleSummaryPreparation(id, () => !queues.get(id)?.draft);
        return result;
      },
      persist: (draft) => set(key(id), draft),
      acknowledge: (token) => update<Draft | undefined>(key(id), (value) => value?.token === token ? undefined : value),
      offline: () => !navigator.onLine,
      hash: contentHash,
      changed: scheduleSummary,
    });
    queues.set(id, q);
  }
  return q;
}

/* ---------- 모든 절의 저장 상태 요약 (상단 저장 표시) ---------- */

export type SaveSummary = {
  kind: SaveState["kind"];
  at?: Date;
  msg?: string;
  /** 저장하지 못한 절 (실패·오프라인·충돌) */
  failing: { id: string; label: string; kind: SaveState["kind"]; msg?: string }[];
};
let summary: SaveSummary = { kind: "idle", failing: [] };
let summaryKey = "";
let lastSavedAt: Date | undefined;
let summaryQueued = false;
const summarySubs = new Set<() => void>();

function scheduleSummary() {
  if (summaryQueued) return;
  summaryQueued = true;
  queueMicrotask(() => {
    summaryQueued = false;
    const failing: SaveSummary["failing"] = [];
    let saving = false;
    let dirty = false;
    for (const [id, q] of queues) {
      const k = q.conflict ? "conflict" : q.state.kind;
      if (k === "error" || k === "offline" || k === "conflict") failing.push({ id, label: sectionLabel(id), kind: k, msg: q.state.msg });
      else if (k === "saving") saving = true;
      else if (k === "dirty" || q.draft) dirty = true;
      if (k === "saved" && q.state.at && (!lastSavedAt || q.state.at > lastSavedAt)) lastSavedAt = q.state.at;
    }
    const kind: SaveState["kind"] = failing.some((f) => f.kind === "conflict")
      ? "conflict"
      : failing.some((f) => f.kind === "error")
        ? "error"
        : failing.length
          ? "offline"
          : saving
            ? "saving"
            : dirty
              ? "dirty"
              : lastSavedAt
                ? "saved"
                : "idle";
    const next: SaveSummary = { kind, at: kind === "saved" ? lastSavedAt : undefined, msg: failing[0]?.msg, failing };
    const k = JSON.stringify(next);
    if (k === summaryKey) return; // 바뀐 것이 없으면 알리지 않는다
    summaryKey = k;
    summary = next;
    summarySubs.forEach((f) => f());
  });
}

/** 모든 절의 저장 상태 요약 — 바뀔 때만 다시 그린다 */
export function useSaveSummary() {
  return useSyncExternalStore(
    (f) => {
      summarySubs.add(f);
      return () => {
        summarySubs.delete(f);
      };
    },
    () => summary,
    () => summary,
  );
}

/* ---------- 창 닫기·숨기기: 모든 절 ---------- */
const hasUnsaved = () => [...queues.values()].some((q) => q.draft || q.conflict);
if (typeof window !== "undefined") {
  // 어느 절이든 서버에 못 보낸 입력(실패·충돌 포함)이 있으면 묻는다 — 절을 옮긴 뒤에도 (편집기마다 달던 것을 하나로)
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsaved()) return;
    queues.forEach((q) => void q.persistNow());
    // A second beacon can overtake a PUT. Keep the local recovery copy instead.
    event.preventDefault();
    event.returnValue = "";
  });
  const hide = () => {
    committers.forEach((fn) => fn());
    queues.forEach((q) => {
      void q.persistNow();
      void q.flush();
    });
  };
  window.addEventListener("pagehide", hide);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && hide());
  window.addEventListener("online", () => queues.forEach((q) => void q.flush()));
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

/** 서버에 아직 보내지 못한 절 이름 (flushAllPending 실패 안내용) */
export function unsavedLabels() {
  return [...queues.entries()].filter(([, q]) => q.draft || q.conflict).map(([id]) => sectionLabel(id));
}

/**
 * 편집기 없이 절을 저장한다 (다른 절을 보는 동안 끝난 AI 집필 등) — 같은 저장 큐를 거치므로 편집기 저장과 겹치지 않는다.
 * baseHash: 이 원고를 만들 때 읽은 서버 본문의 해시 (그사이 다른 곳에서 고쳤으면 덮지 않는다). 없으면 확인 없이 저장한다.
 */
export async function saveViaQueue(id: string, patch: Patch, opts: { baseHash?: string | null } = {}) {
  const q = queue(id);
  cancelSummaryPreparation(id);
  if (!q.draft && !q.conflict) q.base = opts.baseHash ?? null;
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

/** 서버가 이 절 본문을 이렇게 바꿨다(버전 복원 등) — 다음 자동 저장의 충돌 확인 기준을 맞춘다 */
export function noteServerContent(id: string, content: string) {
  queue(id).setBase(contentHash(content));
}

/** 편집기가 불러온 원고의 기준 해시를 알린다. 복구본을 이어 쓰면 그 복구본이 기준으로 삼았던 해시를 쓴다 */
export function primeBase(id: string, hash: string | null) {
  queue(id).setBase(hash);
}

/** 저장 충돌 중인 서버 본문 */
export const conflictOf = (id: string): Conflict | null => queues.get(id)?.conflict ?? null;

/**
 * 저장 충돌 풀기 — 어느 쪽을 골라도 다른 쪽 원고는 버전 기록에 남긴다(잃지 않는다).
 *  - mine: 서버 본문을 버전으로 남긴 뒤 내 원고로 덮는다
 *  - server: 내 원고를 버전으로 남긴 뒤 서버 본문을 받아들인다 (편집기는 부른 쪽이 다시 불러온다)
 * 버전을 남기지 못하면 아무것도 바꾸지 않고 오류를 던진다 (내 원고는 브라우저 복구본에 그대로 있다).
 */
export async function resolveConflict(id: string, choice: "mine" | "server") {
  const q = queues.get(id);
  const c = q?.conflict;
  if (!q || !c) return true;
  const keep = choice === "mine" ? c.content : q.draft?.content;
  if (keep) {
    const res = await fetch(`/api/sections/${id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: keep, reason: "conflict" }) });
    if (!res.ok) throw new Error(`${choice === "mine" ? "다른 곳에서 고친 원고" : "내 원고"}를 버전 기록에 남기지 못해 그대로 두었습니다 (${res.status}).`);
  }
  if (choice === "mine") return q.keepMine();
  const sketch = q.draft?.sketch;
  await q.takeServer();
  if (sketch !== undefined) q.mark({ sketch }); // 스케치는 충돌과 상관없다 — 잃지 않게 다시 보낸다
  return true;
}

export function useAutosave(sectionId: string | null, label: string, onSaved?: (result: SaveResult) => void) {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const callback = useRef(onSaved);
  callback.current = onSaved;
  const q = sectionId ? queue(sectionId) : null;
  if (sectionId) labels.set(sectionId, label);
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
    return () => {
      // 절을 옮기기 전 마지막 입력(250ms 묶음)을 먼저 큐에 넣는다 — 구독을 끊은 뒤에 넣으면 실패해도 아무도 모른다
      if (sectionId) committers.get(sectionId)?.();
      unsubscribe();
      // 실패해도 큐는 남아 다시 시도하고, 상단 저장 표시와 창 닫기 경고가 이 절을 계속 본다
      void q.flush().then(() => {
        if (sectionId && q.idle() && queues.get(sectionId) === q) queues.delete(sectionId);
        scheduleSummary();
      });
    };
  }, [q, sectionId]);
  return { state, markDirty, flush };
}

/**
 * 절을 열 때 이어 쓸 브라우저 복구본. 이미 서버에 저장된 것과 같으면(저장 확인만 못 받은 경우) 버리고 null.
 * server: 방금 읽은 서버 원고
 */
export async function recoverPending(sectionId: string, server?: { content: string; sketch: string }): Promise<Draft | null> {
  // Server and browser clocks cannot establish whether a draft was acknowledged.
  const active = queues.get(sectionId);
  if (active?.draft) return active.draft;
  let d: Draft | null = null;
  try { d = (await get<Draft>(key(sectionId))) ?? null; } catch { return null; }
  if (d && server && (d.content === undefined || d.content === server.content) && (d.sketch === undefined || d.sketch === server.sketch)) {
    void update<Draft | undefined>(key(sectionId), (value) => value?.token === d!.token ? undefined : value).catch(() => {});
    return null;
  }
  return d;
}
