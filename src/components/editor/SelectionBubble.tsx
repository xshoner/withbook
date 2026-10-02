"use client";

import { useEffect, useState } from "react";
import { REWRITE_LABEL, type RewriteAction } from "./EditorToolbar";

/** 각주는 단어·짧은 구절에만 단다 (addFootnote와 같은 한도) */
export const FOOTNOTE_MAX = 80;

/**
 * 드래그 선택 말풍선 — 고른 길이에 맞는 메뉴를 먼저 보인다.
 *  단어·구절(한 문단 안, 짧음) → 각주 달기
 *  문장·문단 → 다듬기·늘리기·줄이기…
 * [⋯]를 누르면 다른 쪽 메뉴도 펼친다(구절을 다듬거나 긴 구절에 각주를 달 때).
 */
export default function SelectionBubble(props: {
  x: number;
  y: number;
  /** 고른 글자 수와 한 문단 안인지 */
  length: number;
  singleBlock: boolean;
  disabled: boolean;
  fnBusy: boolean;
  rewriteBusy: string | null;
  onFootnote: (ai: boolean) => void;
  onRewrite: (a: RewriteAction) => void;
  onMemory: () => void;
}) {
  const word = props.singleBlock && props.length <= 30;
  const canNote = props.singleBlock && props.length <= FOOTNOTE_MAX;
  const [more, setMore] = useState(false);
  // 다른 곳을 고르면 펼친 메뉴를 접는다
  useEffect(() => setMore(false), [word]);

  const btn = "rounded-md px-2 py-1 text-xs whitespace-nowrap disabled:opacity-50";
  const noteButtons = (
    <>
      <button className={`${btn} font-semibold text-amber-800 hover:bg-amber-50`} disabled={props.disabled} onClick={() => props.onFootnote(true)} title="고른 말에 AI가 각주를 씁니다">
        {props.fnBusy ? "각주 쓰는 중…" : "✦ AI 각주"}
      </button>
      <button className={`${btn} text-amber-800 hover:bg-amber-50`} disabled={props.disabled} onClick={() => props.onFootnote(false)} title="각주를 달고 내용을 직접 씁니다">
        직접 각주
      </button>
    </>
  );
  const rewriteButtons = (Object.keys(REWRITE_LABEL) as RewriteAction[]).map((a) => (
    <button key={a} className={`${btn} text-violet-800 hover:bg-violet-50`} disabled={props.disabled} onClick={() => props.onRewrite(a)}>
      {props.rewriteBusy === a ? "…" : REWRITE_LABEL[a]}
    </button>
  ));
  const divider = <span className="mx-0.5 h-4 border-l border-stone-200" aria-hidden />;
  const second = word ? rewriteButtons : canNote ? noteButtons : null;

  return (
    <div
      data-fn-ui
      role="toolbar"
      aria-label="고른 글에 쓸 기능"
      className="fixed z-40 flex max-w-[92vw] flex-wrap items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-0.5 font-sans shadow-lg"
      style={{ left: Math.max(8, props.x - 8), top: Math.max(8, props.y - 40) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {word ? noteButtons : rewriteButtons}
      {more && second && (
        <>
          {divider}
          {second}
        </>
      )}
      {divider}
      <button className={`${btn} text-teal-800 hover:bg-teal-50`} onClick={props.onMemory} title="책의 기억에 남깁니다 — 이후 AI 작업이 이 정의·표현을 지킵니다">
        기억
      </button>
      {second && !more && (
        <button className={`${btn} text-stone-500 hover:bg-stone-100`} onClick={() => setMore(true)} title={word ? "다듬기·늘리기 등 더 보기" : "각주 달기 더 보기"} aria-label="더 보기">
          ⋯
        </button>
      )}
    </div>
  );
}
