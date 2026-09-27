"use client";

import { useEffect, useState } from "react";
import { api } from "./client";

export type Me = { role: "superadmin" | "editor"; email?: string };

let cached: Promise<Me> | null = null;

/** 지금 사용자(GET /api/me) — 탭 안에서 한 번만 묻는다. 실패하면 editor로 본다(관리자 항목을 숨기는 쪽이 안전) */
export function loadMe(): Promise<Me> {
  cached ??= api<Me>("/api/me").catch(() => {
    cached = null;
    return { role: "editor" } as Me;
  });
  return cached;
}

/** 관리자(superadmin)인지 — 확인 전에는 null */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    loadMe().then((m) => alive && setMe(m));
    return () => {
      alive = false;
    };
  }, []);
  return me;
}
