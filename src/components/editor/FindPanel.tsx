"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

type Range = { from: number; to: number };

/** 이 절에서 찾기·바꾸기 + 책 전체 찾기 창 열기 */
export default function FindPanel({ editor, onBookSearch, disabled }: { editor: Editor | null; onBookSearch: (query: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setMessage("");
  }, [query]);

  function matches(): Range[] {
    const out: Range[] = [];
    if (!editor || !query) return out;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      // 각주 같은 인라인 원자는 한 칸(￼)으로 두어 위치가 문서와 맞게 한다
      const text = node.textBetween(0, node.content.size, "", "￼");
      for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) out.push({ from: pos + 1 + at, to: pos + 1 + at + query.length });
      return false;
    });
    return out;
  }

  function find(backward = false) {
    if (!editor || !query) return;
    const ms = matches();
    if (!ms.length) return setMessage("찾은 결과가 없습니다.");
    const { from, to } = editor.state.selection;
    let index = backward ? ms.findLastIndex((m) => m.to <= from) : ms.findIndex((m) => m.from >= to);
    if (index < 0) index = backward ? ms.length - 1 : 0;
    editor.chain().focus().setTextSelection(ms[index]).scrollIntoView().run();
    setMessage(`${index + 1} / ${ms.length}개`);
  }

  /** 지금 선택된 것이 검색어면 바꾸고 다음으로 */
  function replaceOne() {
    if (!editor || !query) return;
    const { from, to } = editor.state.selection;
    if (editor.state.doc.textBetween(from, to, "", "￼") === query) {
      const tr = replacement ? editor.state.tr.insertText(replacement, from, to) : editor.state.tr.delete(from, to);
      editor.view.dispatch(tr);
    }
    find();
  }

  function replaceAll() {
    if (!editor || !query) return;
    const ms = matches();
    if (!ms.length) return setMessage("찾은 결과가 없습니다.");
    // 한 번의 되돌리기(Ctrl+Z)로 모두 돌아가도록 한 트랜잭션에 뒤에서부터
    let tr = editor.state.tr;
    for (const m of [...ms].reverse()) tr = replacement ? tr.insertText(replacement, m.from, m.to) : tr.delete(m.from, m.to);
    editor.view.dispatch(tr);
    setMessage(`${ms.length}곳을 바꿨습니다.`);
  }

  // 도구줄 안에 들어가는 묶음 모양 (이름표 + 칸막이 버튼)
  const btn = "px-1.5 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40";
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-stone-300 bg-white text-xs shadow-sm">
      <label htmlFor="manuscript-find" className="flex items-center bg-teal-700 px-1.5 text-[11px] font-semibold text-white">
        찾기
      </label>
      <div className="flex items-center divide-x divide-stone-200">
        <input
          id="manuscript-find"
          className="w-24 border-0 px-1.5 py-1 text-xs outline-none"
          value={query}
          placeholder="검색어"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              find(e.shiftKey);
            }
          }}
        />
        <button className={btn} disabled={!query} onClick={() => find(true)}>
          이전
        </button>
        <button className={btn} disabled={!query} onClick={() => find()}>
          다음
        </button>
        <button className={btn} onClick={() => setReplaceOpen(!replaceOpen)} title="이 절에서 바꾸기">
          바꾸기{replaceOpen ? " ▴" : " ▾"}
        </button>
        {replaceOpen && (
          <>
            <input className="w-24 border-0 px-1.5 py-1 text-xs outline-none" value={replacement} placeholder="바꿀 말" onChange={(e) => setReplacement(e.target.value)} />
            <button className={btn} disabled={!query || disabled} onClick={replaceOne} title="선택된 검색어를 바꾸고 다음으로">
              하나
            </button>
            <button className={btn} disabled={!query || disabled} onClick={replaceAll} title="이 절의 모든 검색어를 바꿉니다 (Ctrl+Z로 되돌리기)">
              이 절 모두
            </button>
          </>
        )}
        <button className={btn} onClick={() => onBookSearch(query)} title="책 전체에서 찾고 바꾸기">
          책 전체
        </button>
        <button className={btn} onClick={() => setQuery("[확인 필요]")} title="[확인 필요] 표시 찾기">
          [확인 필요]
        </button>
        <span role="status" aria-live="polite" className={message ? "px-2 text-stone-500" : "hidden"}>
          {message}
        </span>
      </div>
    </div>
  );
}
