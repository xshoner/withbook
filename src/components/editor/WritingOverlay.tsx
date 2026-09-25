"use client";

import { useEffect, useState } from "react";

/**
 * AI 집필 중 진행 창 — 새로 쓰는 절의 편집 화면 가운데에만 뜬다(다른 절은 편집 가능). 본문은 다 쓴 뒤 한 번에 넣으므로 화면이 흔들리지 않는다.
 * 최근 몇 줄만 아래에서 위로 굴러 올라가게 보여 준다.
 */
export default function WritingOverlay(props: {
  status: string;
  text: string;
  chars: number;
  target: number;
  step?: { i: number; n: number; label: string } | null;
  onStop: () => void;
  /** 시작 시각 — 첫 문장 전 경과 시간 */
  startedAt?: number;
}) {
  const elapsed = useElapsed(props.startedAt, !props.chars);
  const pct = props.target > 0 ? Math.min(100, Math.round((props.chars / props.target) * 100)) : 0;
  const tail = props.text.replace(/⟦주:[^⟧]*⟧/g, "").replace(/[#*>]/g, "").trim();
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-stone-900/25 backdrop-blur-[2px]">
      <div className="w-[520px] max-w-[92%] rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="writing-pen" aria-hidden>
            ✎
          </span>
          <div className="min-w-0 flex-1">
            <div className="writing-title font-bookhead text-lg">지금은 집필 중</div>
            <div className="truncate text-xs text-stone-500">
              {props.step ? `${props.step.i}/${props.step.n}번째 절 · ${props.step.label} — ` : ""}
              {props.status}
            </div>
          </div>
          <button className="btn-primary bg-red-700 px-3 py-1 text-xs hover:bg-red-800" onClick={props.onStop} title="Esc">
            ■ 중지
          </button>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-stone-100">
          <div className={`h-full rounded-full bg-amber-600 transition-[width] duration-500 ${props.chars ? "" : "writing-indeterminate"}`} style={{ width: props.chars ? `${Math.max(3, pct)}%` : "30%" }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-stone-400">
          <span>
            {props.chars
              ? `${props.chars.toLocaleString()}자 작성`
              : `문체·앞뒤 흐름을 구상하는 중 · ${elapsed}초 — 첫 문장까지 보통 1~2분 (그동안 다른 절을 편집하세요)`}
          </span>
          {props.target > 0 && <span>목표 약 {props.target.toLocaleString()}자</span>}
        </div>
        <div className="writing-roll mt-4 h-[4.8em] overflow-hidden rounded-lg bg-stone-50 px-3 py-2 font-book text-[12.5px] leading-[1.6em] text-stone-600">
          <div className="flex h-full flex-col justify-end">
            <p className="whitespace-pre-line">{tail ? tail.slice(-180) : "…"}</p>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-stone-400">다 쓰면 이 절에 한 번에 들어갑니다 · 그동안 목차에서 <b className="text-stone-600">다른 절을 열어 편집</b>해도 집필은 계속됩니다 · Esc 중지</p>
      </div>
    </div>
  );
}

/** 1초마다 경과 초 (on일 때만 센다) */
function useElapsed(startedAt: number | undefined, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on, startedAt]);
  return startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
}
