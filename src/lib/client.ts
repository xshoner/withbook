"use client";
import type { WriteTiming } from "./ai/write-timing";

/** 클라이언트 fetch 도우미 — 서버 오류 메시지를 그대로 던진다 */
export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export type StreamEvent = { t: "status" | "delta" | "done" | "error" | "timing"; v?: string; chars?: number; timing?: WriteTiming };

/** NDJSON 스트림 읽기 */
export async function readStream(res: Response, onEvent: (e: StreamEvent) => void) {
  if (!res.ok || !res.body) {
    let msg = `요청 실패 (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function download(url: string, body: unknown, fallbackName: string) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `실패 (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  // 웹 배포: 서버가 파일을 저장소에 올리고 내려받기 주소(JSON)를 준다
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const j = await res.json();
    const a = document.createElement("a");
    a.href = j.download;
    a.download = j.filename ?? fallbackName;
    a.click();
    const h = new Headers();
    if (j.check) h.set("x-pdf-check", encodeURIComponent(JSON.stringify(j.check)));
    return h;
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return res.headers;
}

export const fmtTime = (d: string | Date) => {
  const t = new Date(d);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
};

export const fmtDate = (d: string | Date) => {
  const t = new Date(d);
  return `${t.getFullYear()}.${String(t.getMonth() + 1).padStart(2, "0")}.${String(t.getDate()).padStart(2, "0")} ${fmtTime(t)}`;
};

export const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  empty: { label: "빈 페이지", cls: "bg-stone-100 text-stone-500" },
  sketch: { label: "스케치", cls: "bg-sky-100 text-sky-700" },
  ai_draft: { label: "AI 초안", cls: "bg-violet-100 text-violet-700" },
  editing: { label: "수정 중", cls: "bg-amber-100 text-amber-800" },
  proofread: { label: "교정 완료", cls: "bg-emerald-100 text-emerald-700" },
};
