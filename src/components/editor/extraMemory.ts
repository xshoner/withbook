"use client";

/**
 * 집필 추가 지시 기억 (책마다, 이 브라우저에만) — 절을 옮겨도 다시 쓸 수 있게.
 * keep: 켜 두면 지금 쓴 지시를 다른 절에서도 그대로 채운다 · recent: 최근에 집필에 쓴 지시(최대 8개)
 */
export type ExtraMemory = { keep: boolean; text: string; recent: string[] };

const key = (projectId: string) => `bookk-extra:${projectId}`;
const EMPTY: ExtraMemory = { keep: false, text: "", recent: [] };

export function loadExtra(projectId: string): ExtraMemory {
  try {
    const v = JSON.parse(localStorage.getItem(key(projectId)) ?? "null");
    if (v && typeof v === "object") return { keep: !!v.keep, text: String(v.text ?? ""), recent: Array.isArray(v.recent) ? v.recent.map(String).slice(0, 8) : [] };
  } catch {}
  return EMPTY;
}

export function saveExtra(projectId: string, m: ExtraMemory) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(m));
  } catch {}
}

/** 집필에 쓴 지시를 최근 목록 맨 앞에 (같은 글은 한 번만) */
export function rememberExtra(m: ExtraMemory, text: string): ExtraMemory {
  const t = text.trim();
  if (!t) return m;
  return { ...m, recent: [t, ...m.recent.filter((r) => r !== t)].slice(0, 8) };
}
