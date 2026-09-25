"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 앱 안 알림·확인 창 — 브라우저 alert/confirm/prompt 대신 쓴다 (화면을 멈추지 않고, 오류는 닫을 때까지 남는다).
 *   toast("저장했습니다")                              잠깐 떴다 사라지는 안내
 *   toast.error("AI 오류: …", { action: { label: "다시", run } })   닫을 때까지 남는 오류
 *   if (await confirmDialog("지울까요?", { danger: true })) …
 *   const v = await promptDialog("어떤 톤으로?", { choices: ["더 친근하게"] })   // 취소하면 null
 * <FeedbackHost />는 layout.tsx에 한 번 둔다.
 */

type Action = { label: string; run: () => void };
type Toast = { id: number; kind: "info" | "success" | "error"; text: string; action?: Action; sticky: boolean };
type Ask = {
  id: number;
  kind: "confirm" | "prompt";
  text: string;
  okLabel: string;
  danger?: boolean;
  placeholder?: string;
  initial?: string;
  choices?: string[];
  resolve: (v: string | boolean | null) => void;
};

let toasts: Toast[] = [];
let asks: Ask[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

function push(kind: Toast["kind"], text: string, opts: { action?: Action; sticky?: boolean } = {}) {
  const t: Toast = { id: ++seq, kind, text, action: opts.action, sticky: opts.sticky ?? kind === "error" };
  toasts = [...toasts.slice(-4), t];
  emit();
  if (!t.sticky) setTimeout(() => dismiss(t.id), t.action ? 8000 : 4000);
  return t.id;
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = Object.assign((text: string, opts?: { action?: Action; sticky?: boolean }) => push("info", text, opts), {
  success: (text: string, opts?: { action?: Action; sticky?: boolean }) => push("success", text, opts),
  error: (text: string, opts?: { action?: Action; sticky?: boolean }) => push("error", text, opts),
});

/** 오류 객체·문자열을 오류 알림으로 */
export const toastError = (e: unknown, prefix = "") => toast.error(prefix + (e instanceof Error ? e.message : String(e)));

export function confirmDialog(text: string, opts: { okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    asks = [...asks, { id: ++seq, kind: "confirm", text, okLabel: opts.okLabel ?? "확인", danger: opts.danger, resolve: (v) => resolve(v === true) }];
    emit();
  });
}

export function promptDialog(text: string, opts: { okLabel?: string; placeholder?: string; initial?: string; choices?: string[] } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    asks = [...asks, { id: ++seq, kind: "prompt", text, okLabel: opts.okLabel ?? "확인", placeholder: opts.placeholder, initial: opts.initial, choices: opts.choices, resolve: (v) => resolve(typeof v === "string" ? v : null) }];
    emit();
  });
}

function close(a: Ask, v: string | boolean | null) {
  asks = asks.filter((x) => x.id !== a.id);
  emit();
  a.resolve(v);
}

const snapToasts = () => toasts;
const snapAsks = () => asks;

export function FeedbackHost() {
  const ts = useSyncExternalStore(subscribe, snapToasts, snapToasts);
  const as = useSyncExternalStore(subscribe, snapAsks, snapAsks);
  const ask = as[0];
  return (
    <>
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-[min(92vw,520px)] -translate-x-1/2 flex-col gap-2" aria-live="polite">
        {ts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg px-4 py-2.5 text-sm shadow-xl ${
              t.kind === "error" ? "bg-red-700 text-white" : t.kind === "success" ? "bg-stone-800 text-white" : "bg-stone-800 text-stone-100"
            }`}
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-keep">{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 rounded border border-white/40 px-2 py-0.5 text-xs font-semibold hover:bg-white/10"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="shrink-0 text-white/70 hover:text-white" aria-label="알림 닫기" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      {ask && <AskDialog key={ask.id} ask={ask} />}
    </>
  );
}

function AskDialog({ ask }: { ask: Ask }) {
  const [v, setV] = useState(ask.initial ?? "");
  const input = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (ask.kind === "prompt" ? input.current : okRef.current)?.focus();
  }, [ask.kind]);
  const ok = () => (ask.kind === "prompt" ? v.trim() && close(ask, v.trim()) : close(ask, true));
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && close(ask, ask.kind === "prompt" ? null : false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") close(ask, ask.kind === "prompt" ? null : false);
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={ask.text} className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
        <p className="whitespace-pre-wrap break-keep text-sm leading-6 text-stone-800">{ask.text}</p>
        {ask.kind === "prompt" && (
          <>
            {ask.choices && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {ask.choices.map((c) => (
                  <button key={c} className={`rounded-full border px-2.5 py-1 text-xs ${v === c ? "border-amber-600 bg-amber-50 text-amber-900" : "border-stone-300 hover:bg-stone-50"}`} onClick={() => setV(c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
            <input
              ref={input}
              className="input mt-3"
              value={v}
              placeholder={ask.placeholder}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && ok()}
            />
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={() => close(ask, ask.kind === "prompt" ? null : false)}>
            취소
          </button>
          <button ref={okRef} className={ask.danger ? "btn-primary bg-red-700 hover:bg-red-800" : "btn-primary"} disabled={ask.kind === "prompt" && !v.trim()} onClick={ok}>
            {ask.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
