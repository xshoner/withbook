"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

export default function FindPanel({ editor }: { editor: Editor | null }) {
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setMessage(""); }, [query]);
  function find(backward = false) {
    if (!editor || !query) return;
    const matches: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const text = node.textBetween(0, node.content.size, "", "\ufffc");
      let offset = 0;
      while ((offset = text.indexOf(query, offset)) !== -1) {
        matches.push({ from: pos + 1 + offset, to: pos + 1 + offset + query.length });
        offset += query.length;
      }
      return false;
    });
    if (!matches.length) return setMessage("찾은 결과가 없습니다.");
    const { from, to } = editor.state.selection;
    let index = backward ? matches.findLastIndex((m) => m.to <= from) : matches.findIndex((m) => m.from >= to);
    if (index < 0) index = backward ? matches.length - 1 : 0;
    editor.chain().focus().setTextSelection(matches[index]).scrollIntoView().run();
    setMessage(`${index + 1} / ${matches.length}개`);
  }
  // 도구줄 안에 들어가는 묶음 모양 (이름표 + 칸막이 버튼)
  const btn = "px-1.5 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40";
  return <div className="flex items-stretch overflow-hidden rounded-md border border-stone-300 bg-white text-xs shadow-sm">
    <label htmlFor="manuscript-find" className="flex items-center bg-teal-700 px-1.5 text-[11px] font-semibold text-white">본문 찾기</label>
    <div className="flex items-center divide-x divide-stone-200">
      <input id="manuscript-find" className="w-24 border-0 px-1.5 py-1 text-xs outline-none" value={query}
        placeholder="검색어" onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); } }} />
      <button className={btn} disabled={!query} onClick={() => find(true)}>이전</button>
      <button className={btn} disabled={!query} onClick={() => find()}>다음</button>
      <button className={btn} onClick={() => setQuery("[확인 필요]")} title="[확인 필요] 표시 찾기">[확인 필요]</button>
      <span role="status" aria-live="polite" className={message ? "px-2 text-stone-500" : "hidden"}>{message}</span>
    </div>
  </div>;
}
