"use client";

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type { FootnoteAttrs } from "./Footnote";
import { useDocValue } from "./editorHooks";

type Item = FootnoteAttrs & { pos: number };

function listFootnotes(doc: PMNode): Item[] {
  const out: Item[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === "footnote") out.push({ pos, ...(n.attrs as FootnoteAttrs) });
  });
  return out;
}

/** 각주 내용 입력 — 입력하는 동안은 이 칸의 글을 보여 주고(문서 목록은 조금 늦게 다시 읽는다), 칸을 떠나면 문서 값에 맞춘다 */
function NoteInput({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      className="input min-h-[56px] resize-y p-1.5 text-xs leading-5 disabled:bg-stone-50 disabled:text-stone-500"
      placeholder="각주 내용을 입력하세요"
      value={draft}
      disabled={disabled}
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        setDraft(value);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

/** [각주] 탭 — 탭을 열었을 때만 각주 목록을 읽는다 (입력마다 편집기 전체를 다시 그리지 않게) */
export default function FootnotesPanel(props: {
  editor: Editor;
  /** 잠긴 이유 (비어 있으면 고칠 수 있다) */
  lockReason: string;
  fnBusy: null | "one" | "auto" | "regen";
  regenPos: number | null;
  activePos: number | null;
  onAuto: () => void;
  onSelect: (pos: number) => void;
  onChange: (pos: number, note: string) => void;
  onRegen: (pos: number) => void;
  onDelete: (pos: number) => void;
}) {
  const footnotes = useDocValue(props.editor, listFootnotes, { key: (l) => JSON.stringify(l), initial: [] as Item[], delay: 150 });
  const locked = !!props.lockReason;
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="space-y-2 border-b border-stone-200 p-3">
        <button className="btn-accent w-full" disabled={!!props.fnBusy || locked} title={props.lockReason || undefined} onClick={props.onAuto}>
          {props.fnBusy === "auto" ? "중요 키워드 찾는 중…" : "✦ AI 자동 각주 (이 절 전체)"}
        </button>
        <p className="text-[11px] leading-4 text-stone-500">
          본문에서 단어를 드래그하면 각주를 달 수 있습니다. 번호를 누르면 고칩니다.
        </p>
        {locked && <p className="rounded bg-stone-100 px-2 py-1 text-[11px] text-stone-600">{props.lockReason} — 끝날 때까지 각주를 고칠 수 없습니다.</p>}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {!footnotes.length && <p className="py-6 text-center text-xs text-stone-400">아직 각주가 없습니다.</p>}
        {footnotes.map((f, i) => (
          <div key={`${f.pos}-${i}`} className={`rounded-lg border p-2 ${props.activePos === f.pos ? "border-amber-400 bg-amber-50/50" : "border-stone-200"}`}>
            <div className="mb-1 flex items-center gap-1.5 text-xs">
              <b className={f.auto ? "text-violet-700" : "text-amber-700"}>{i + 1})</b>
              <span className="min-w-0 flex-1 truncate font-semibold text-stone-700">{f.term || "(단어 미상)"}</span>
              {f.auto && <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700">AI</span>}
              <button className="text-stone-500 hover:underline" onClick={() => props.onSelect(f.pos)}>
                위치
              </button>
            </div>
            <NoteInput value={f.note} disabled={locked} onChange={(v) => props.onChange(f.pos, v)} />
            <div className="mt-1 flex justify-end gap-2 text-[11px]">
              <button className="text-violet-700 hover:underline disabled:opacity-40" disabled={!!props.fnBusy || locked} onClick={() => props.onRegen(f.pos)}>
                {props.fnBusy === "regen" && props.regenPos === f.pos ? "쓰는 중…" : "AI로 다시 쓰기"}
              </button>
              <button className="text-red-600 hover:underline disabled:opacity-40" disabled={locked} onClick={() => props.onDelete(f.pos)}>
                삭제
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
