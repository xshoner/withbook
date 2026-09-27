"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { memo } from "react";
import type { LayoutSettings } from "@/lib/layout";
import FindPanel from "./FindPanel";
import Menu from "./Menu";
import ToolGroup from "./ToolGroup";

export type RewriteAction = "polish" | "expand" | "shorten" | "tone" | "example";
export const REWRITE_LABEL: Record<RewriteAction, string> = { polish: "다듬기", expand: "늘리기", shorten: "줄이기", tone: "톤 바꾸기", example: "예시 추가" };

type Props = {
  editor: Editor;
  /** 버튼이 꺼진 이유 (툴팁) — 비어 있으면 쓸 수 있다 */
  busyReason: string;
  fnBusy: null | "one" | "auto" | "regen";
  rewriteBusy: string | null;
  bodySizePt: number;
  lineHeight: number;
  paraSpacingMm: number;
  onLayout: (patch: Partial<LayoutSettings>) => void;
  onAddFootnote: (ai: boolean) => void;
  onAutoFootnote: () => void;
  onRewrite: (a: RewriteAction) => void;
  onPickImage: () => void;
  onBookSearch: (query: string) => void;
};

/**
 * 서식 도구줄 — 본문 서식 · 각주 · 선택 AI · 책 서식 · 찾기.
 * 굵게·소제목 같은 켜짐 표시는 커서가 움직일 때마다 바뀌어야 하므로 useEditorState로 이 도구줄만 다시 그린다(편집기 전체가 아니라).
 */
function EditorToolbar({ editor, busyReason, fnBusy, rewriteBusy, bodySizePt, lineHeight, paraSpacingMm, onLayout, onAddFootnote, onAutoFootnote, onRewrite, onPickImage, onBookSearch }: Props) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      heading: e.isActive("heading"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      blockquote: e.isActive("blockquote"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      selEmpty: e.state.selection.empty,
    }),
  });
  const selEmpty = active.selEmpty;
  const tb = (label: string, onClick: () => void, on = false, title?: string) => (
    <button
      key={label + (title ?? "")}
      title={busyReason || title || label}
      aria-label={title ?? label}
      aria-pressed={on}
      disabled={!!busyReason}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`px-1.5 py-1 text-xs disabled:opacity-40 ${on ? "bg-stone-800 text-white" : "text-stone-700 hover:bg-stone-100"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToolGroup label="본문" tone="bg-stone-700">
        {tb("소제목", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), active.heading)}
        {tb("굵게", () => editor.chain().focus().toggleBold().run(), active.bold)}
        {tb("기울임", () => editor.chain().focus().toggleItalic().run(), active.italic)}
        {tb("인용", () => editor.chain().focus().toggleBlockquote().run(), active.blockquote)}
        {tb("•", () => editor.chain().focus().toggleBulletList().run(), active.bulletList, "글머리 목록")}
        {tb("1.", () => editor.chain().focus().toggleOrderedList().run(), active.orderedList, "번호 목록")}
        {tb("―", () => editor.chain().focus().setHorizontalRule().run(), false, "구분선")}
        {tb("🖼", onPickImage, false, "이미지 넣기 (끌어다 놓거나 붙여 넣어도 됩니다)")}
        {tb("↶", () => editor.chain().focus().undo().run(), false, "실행 취소 (Ctrl+Z)")}
        {tb("↷", () => editor.chain().focus().redo().run(), false, "다시 실행 (Ctrl+Y)")}
      </ToolGroup>
      <ToolGroup label="각주" tone="bg-amber-700">
        <button
          title={selEmpty ? "먼저 각주를 달 단어를 드래그해 선택하세요" : busyReason || "드래그한 단어에 AI가 각주를 씁니다"}
          disabled={selEmpty || !!busyReason}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAddFootnote(true)}
          className={`px-1.5 py-1 text-xs ${selEmpty ? "text-stone-400" : "bg-amber-100 font-semibold text-amber-900 hover:bg-amber-200"} disabled:opacity-50`}
        >
          {fnBusy === "one" ? "각주 쓰는 중…" : "✦ AI 각주"}
        </button>
        {tb("직접", () => onAddFootnote(false), false, "선택한 단어(또는 커서 위치)에 각주를 달고 내용을 직접 입력합니다")}
        {tb(fnBusy === "auto" ? "찾는 중…" : "자동", onAutoFootnote, false, "AI가 이 절의 중요 키워드를 골라 각주를 답니다")}
      </ToolGroup>
      <Menu
        label={rewriteBusy ? `✦ ${REWRITE_LABEL[rewriteBusy as RewriteAction] ?? ""} 중…` : "✦ 선택 AI ▾"}
        tone="text-violet-800"
        disabled={!!busyReason || selEmpty}
        title={selEmpty ? "본문을 드래그해 선택하면 다듬기·늘리기·줄이기·톤·예시를 쓸 수 있습니다" : busyReason || "선택한 부분을 AI로 고칩니다 (결과를 비교한 뒤 적용)"}
      >
        {(Object.keys(REWRITE_LABEL) as RewriteAction[]).map((a) => (
          <button key={a} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-violet-50" onMouseDown={(e) => e.preventDefault()} onClick={() => onRewrite(a)}>
            {REWRITE_LABEL[a]}
          </button>
        ))}
      </Menu>
      <Menu label="서식 ▾" tone="text-sky-800" title="글자 크기·줄 간격·문단 간격 — 책 전체 본문에 적용됩니다 (미리보기·PDF·HWPX 포함)">
        <div className="space-y-2 p-3 text-xs text-stone-600">
          <p className="text-[11px] text-stone-500">책 전체 본문에 적용됩니다</p>
          <label className="flex items-center justify-between gap-3">
            글자 크기
            <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={bodySizePt} onChange={(e) => onLayout({ bodySizePt: Number(e.target.value) })}>
              {[9, 9.5, 10, 10.5, 11, 11.5, 12].map((v) => (
                <option key={v} value={v}>
                  {v}pt
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            줄 간격
            <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={lineHeight} onChange={(e) => onLayout({ lineHeight: Number(e.target.value) })}>
              {[1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2].map((v) => (
                <option key={v} value={v}>
                  {Math.round(v * 100)}%
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            문단 간격
            <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={paraSpacingMm} onChange={(e) => onLayout({ paraSpacingMm: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 5, 6].map((v) => (
                <option key={v} value={v}>
                  {v ? `${v}mm` : "없음"}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Menu>
      <FindPanel editor={editor} onBookSearch={onBookSearch} disabled={!!busyReason} />
    </div>
  );
}

export default memo(EditorToolbar);
