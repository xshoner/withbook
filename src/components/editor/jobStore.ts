"use client";

import { useSyncExternalStore } from "react";

/**
 * 편집기 밖에서 도는 작업(AI 집필·교정)의 공통 저장소 — 절 id별 작업, 구독, 열린 편집기의 applier.
 * 종류(kind)마다 "이 절이 바쁜가"를 등록해 두면 서로 import하지 않고도 겹치는 작업을 막을 수 있다.
 */
export function createJobStore<J extends { sectionId: string }, A>() {
  const jobs = new Map<string, J>();
  const appliers = new Map<string, A>();
  const subs = new Set<() => void>();
  let snap: J[] = [];
  const emit = () => {
    snap = [...jobs.values()];
    subs.forEach((f) => f());
  };
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  };
  return {
    jobs,
    appliers,
    emit,
    subscribe,
    useJobs: (): J[] => useSyncExternalStore(subscribe, () => snap, () => snap),
    /** 이 절의 작업만 — 다른 절 작업이 진행돼도(쓰는 중 250ms마다) 다시 그리지 않는다 */
    useJob: (sectionId: string): J | null => useSyncExternalStore(subscribe, () => jobs.get(sectionId) ?? null, () => null),
    /** 고른 값이 바뀔 때만 다시 그린다 — select는 원시값(문자열·숫자·참/거짓)을 돌려줘야 한다 */
    useSelect: <T extends string | number | boolean | null>(select: (jobs: Map<string, J>) => T): T =>
      useSyncExternalStore(subscribe, () => select(jobs), () => select(new Map())),
    /** 열린 편집기가 끝난 결과를 직접 넣는다. 돌려준 함수로 해제 */
    registerApplier(sectionId: string, fn: A) {
      appliers.set(sectionId, fn);
      return () => {
        if (appliers.get(sectionId) === fn) appliers.delete(sectionId);
      };
    },
  };
}

type Kind = { label: string; busy: (sectionId: string) => boolean; any: () => boolean };
const kinds = new Map<string, Kind>();

/** 작업 종류 등록 — busy: 그 절에서 돌고 있나, any: 어디서든 돌고 있나 */
export function registerJobKind(name: string, k: Kind) {
  kinds.set(name, k);
}

/** 편집기 안 짧은 작업(선택 영역 AI 결과 확인·각주 AI 요청) — 절 id → 작업 이름. 자동 집필 점검이 끝나기를 기다리게 한다 */
const local = new Map<string, string>();
registerJobKind("local", { label: "편집기 AI 작업", busy: (id) => local.has(id), any: () => false });
export function setLocalBusy(sectionId: string, what: string | null) {
  if (what ? local.get(sectionId) === what : !local.has(sectionId)) return;
  if (what) local.set(sectionId, what);
  else local.delete(sectionId);
}

/** 이 절에서 돌고 있는 작업 이름 (except 종류는 뺀다). 없으면 null */
export function sectionBusyWith(sectionId: string, except?: string): string | null {
  for (const [name, k] of kinds) if (name !== except && k.busy(sectionId)) return k.label;
  return null;
}

// 탭을 닫으면 작업이 끊기므로(결과도 잃는다) 한 번 묻는다
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if ([...kinds.values()].some((k) => k.any())) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
