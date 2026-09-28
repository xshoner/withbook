"use client";

import { useSyncExternalStore } from "react";

/**
 * 집중 모드 — 목차·오른쪽 패널을 접고, 실제 조판(쪽 나눔 측정)을 입력이 한참 멈췄을 때만 돌린다.
 * 저사양 기기(코어 4개 이하·메모리 4GB 이하·데이터 절약)에서는 집중 모드가 아니어도 조판 측정만 느긋하게 한다.
 * 브라우저마다 기억한다(localStorage — 읽지 못해도 기본값으로 동작).
 */
const KEY = "withbook:focus";
let focus = false;
const subs = new Set<() => void>();
if (typeof window !== "undefined") {
  try {
    focus = localStorage.getItem(KEY) === "1";
  } catch {}
}

export function setFocusMode(on: boolean) {
  focus = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  subs.forEach((f) => f());
}
export const toggleFocusMode = () => setFocusMode(!focus);
export const isFocusMode = () => focus;

export function useFocusMode() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => focus,
    () => false,
  );
}

/** 저사양 기기 — 조판 측정을 느긋하게 (CPU 코어·메모리·데이터 절약 설정으로 판단) */
export function lowPowerDevice() {
  if (typeof navigator === "undefined") return false;
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (n.hardwareConcurrency ?? 8) <= 4 || (n.deviceMemory ?? 8) <= 4 || n.connection?.saveData === true;
}

/** 조판 측정을 느긋하게 할까 — 집중 모드이거나 저사양 기기 */
export const relaxedPagination = () => focus || lowPowerDevice();

export const FOCUS_KEY_LABEL = "Ctrl+Shift+.";
/** 집중 모드 단축키 — Ctrl(맥 Cmd)+Shift+. */
export const isFocusKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "." || e.key === ">" || e.code === "Period");
