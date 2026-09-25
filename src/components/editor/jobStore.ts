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
