"use client";

import type { FootnoteAttrs } from "./Footnote";

/** 각주 번호 클릭 → 내용 편집 팝업 */
export default function FootnotePopover(props: {
  x: number;
  y: number;
  number: number;
  attrs: FootnoteAttrs;
  busy: boolean;
  onChange: (v: string) => void;
  onRegen: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { attrs } = props;
  const left = Math.min(Math.max(8, props.x - 150), (typeof window !== "undefined" ? window.innerWidth : 1200) - 330);
  const top = Math.min(props.y + 8, (typeof window !== "undefined" ? window.innerHeight : 800) - 230);
  return (
    <div data-fn-ui className="fixed z-50 w-80 rounded-lg border border-stone-200 bg-white p-3 font-sans shadow-2xl" style={{ left, top }}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs">
        <b className={attrs.auto ? "text-violet-700" : "text-amber-700"}>각주 {props.number > 0 ? props.number : ""})</b>
        <span className="min-w-0 flex-1 truncate text-stone-600">{attrs.term}</span>
        {attrs.auto && <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700">AI</span>}
        <button className="px-1 text-stone-400 hover:text-stone-700" onClick={props.onClose} title="닫기 (Esc)">
          ✕
        </button>
      </div>
      <textarea
        autoFocus={!attrs.note}
        className="input min-h-[84px] resize-y p-2 text-xs leading-5"
        placeholder="각주 내용을 입력하세요 (쪽 아래에 인쇄됩니다)"
        value={attrs.note}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      />
      <div className="mt-2 flex items-center gap-2 text-xs">
        <button className="btn px-2 py-1 text-xs" disabled={props.busy} onClick={props.onRegen}>
          {props.busy ? "쓰는 중…" : attrs.note ? "✦ AI로 다시 쓰기" : "✦ AI로 쓰기"}
        </button>
        <button className="ml-auto text-red-600 hover:underline" onClick={props.onDelete}>
          각주 삭제
        </button>
      </div>
    </div>
  );
}
