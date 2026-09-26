"use client";

import { useEffect, useState } from "react";
import { ParagraphDiff } from "../InlineDiff";

/**
 * 새 버전 후보 크게 비교 — 지금 본문과 후보를 나란히(또는 바뀐 곳만) 보고 그 자리에서 고른다.
 * 후보를 쓰는 중이면 쓰는 대로 늘어나고, 다 쓴 뒤에 고를 수 있다.
 */
export default function CandidateCompareDialog(props: {
  current: string[];
  candidate: string[];
  writing: boolean;
  status: string;
  onAccept: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"side" | "diff">("side");
  const chars = (ps: string[]) => ps.join("").length.toLocaleString();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const column = (title: string, ps: string[], tone: string, empty: string) => (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-stone-200">
      <div className={`border-b border-stone-200 px-3 py-1.5 text-xs font-semibold ${tone}`}>
        {title} <span className="font-normal text-stone-400">· {chars(ps)}자 · {ps.length}문단</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 font-book text-[13px] leading-6 text-stone-800">
        {ps.length ? ps.map((p, i) => <p key={i}>{p}</p>) : <p className="py-8 text-center text-xs text-stone-400">{empty}</p>}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onMouseDown={props.onClose}>
      <div role="dialog" aria-label="새 버전 비교" className="flex h-[88vh] w-[1200px] max-w-full flex-col rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-2.5">
          <h2 className="font-semibold">새 버전 비교</h2>
          {props.writing && (
            <span className="flex items-center gap-1.5 text-xs text-violet-700">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
              {props.status || "작성 중…"}
            </span>
          )}
          <div className="ml-auto flex overflow-hidden rounded-md border border-stone-300 text-xs">
            <button className={`px-2.5 py-1 ${view === "side" ? "bg-stone-800 text-white" : ""}`} onClick={() => setView("side")}>
              나란히 보기
            </button>
            <button className={`px-2.5 py-1 ${view === "diff" ? "bg-stone-800 text-white" : ""}`} onClick={() => setView("diff")}>
              바뀐 곳만
            </button>
          </div>
          <button className="btn-ghost" aria-label="닫기" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          {view === "side" ? (
            <>
              {column("지금 본문", props.current, "text-stone-700", "본문이 비어 있습니다")}
              {column("새 버전 후보", props.candidate, "text-violet-800", props.writing ? "구상 중… 첫 문장이 나오면 여기에 보입니다" : "후보가 비어 있습니다")}
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-stone-200 p-4 text-[13px]">
              <p className="mb-2 text-[11px] text-stone-400">빨강 취소선 = 지금 본문에서 빠지는 말 · 초록 밑줄 = 후보에서 새로 쓴 말. 바뀌지 않은 문단은 접어 둡니다.</p>
              <ParagraphDiff before={props.current} after={props.candidate} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-stone-200 px-4 py-2.5">
          <span className="text-xs text-stone-500">
            {props.writing ? "다 쓴 뒤에 고를 수 있습니다." : "[이 버전 사용]을 누르면 지금 본문은 버전 기록에 보관되고 후보로 바뀝니다."}
          </span>
          <button className="btn ml-auto" disabled={props.writing} onClick={props.onDiscard}>
            버리기
          </button>
          <button className="btn-primary" disabled={props.writing || !props.candidate.length} onClick={props.onAccept}>
            이 버전 사용
          </button>
        </div>
      </div>
    </div>
  );
}
