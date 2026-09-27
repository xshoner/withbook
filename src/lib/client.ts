"use client";
import type { WriteTiming } from "./ai/write-timing";

/** api() 기본 시간 한도 — 서버 함수 한도(Vercel maxDuration 300초)보다 조금 길게. 멈춘 서버가 절을 끝없이 잠그지 않게 */
export const API_TIMEOUT_MS = 310_000;

/** 시간 한도로 멈춘 요청 — 사용자가 멈춘 것(AbortError)과 구분한다 */
export class RequestTimeoutError extends Error {}

/**
 * 클라이언트 fetch 도우미 — 서버 오류 메시지를 그대로 던진다.
 * timeoutMs: 응답을 기다리는 최대 시간 (기본 API_TIMEOUT_MS, 0이면 한도 없음). signal과 함께 쓸 수 있다.
 */
export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown; timeoutMs?: number }): Promise<T> {
  const { json, timeoutMs = API_TIMEOUT_MS, ...rest } = init ?? {};
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = timeout ? (rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout) : rest.signal;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal,
      headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (e) {
    if (timeout?.aborted && !rest.signal?.aborted) throw new RequestTimeoutError(`서버가 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않아 요청을 멈췄습니다. 잠시 후 다시 시도하세요.`);
    throw e;
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export type StreamEvent = {
  /** ping: 서버가 오래 생각하는 동안 연결이 살아 있음을 알리는 신호 (화면에는 보이지 않는다) */
  t: "status" | "delta" | "done" | "error" | "timing" | "resume" | "ping";
  v?: string;
  chars?: number;
  timing?: WriteTiming;
  /** resume: 긴 절을 같은 개요로 이어 쓸 다음 파트 */
  fromPart?: number;
  parts?: { heading: string; points: string[]; sketchItems: string[]; chars: number }[];
};

/** 스트림이 이만큼 아무 소식도 없으면 끊긴 것으로 본다 — 서버의 AI 호출 한도(240초)보다 길게 (첫 글자 전 긴 생각을 끊지 않게) */
export const STREAM_STALL_MS = 260_000;
/** 서버가 ping을 보내는 스트림이면 더 빨리 알아챈다 */
export const STREAM_STALL_AFTER_PING_MS = 90_000;

/** 스트림이 멈춰 끊은 경우 */
export class StreamStallError extends Error {}

/**
 * NDJSON 스트림 읽기.
 * stallMs: 이 시간 동안 아무 줄도 오지 않으면 읽기를 멈추고 StreamStallError (0 = 한도 없음).
 * ping을 한 번이라도 받으면 그 뒤로는 stallAfterPingMs를 쓴다.
 */
export async function readStream(
  res: Response,
  onEvent: (e: StreamEvent) => void,
  opts: { stallMs?: number; stallAfterPingMs?: number } = {},
) {
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
  let stallMs = opts.stallMs ?? 0;
  const read = () => {
    if (!stallMs) return reader.read();
    let t: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new StreamStallError(`AI 응답이 ${Math.round(stallMs / 1000)}초 동안 오지 않아 멈췄습니다. 연결을 확인한 뒤 다시 시도하세요 (쓴 데까지는 넣습니다).`)), stallMs);
    });
    return Promise.race([reader.read(), stall]).finally(() => clearTimeout(t));
  };
  try {
  while (true) {
    const { done, value } = await read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const e = JSON.parse(line) as StreamEvent;
      if (e.t === "ping" && stallMs && opts.stallAfterPingMs) stallMs = opts.stallAfterPingMs;
      onEvent(e);
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
