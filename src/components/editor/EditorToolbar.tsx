"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { memo } from "react";
import type { LayoutSettings } from "@/lib/layout";
import FindPanel from "./FindPanel";
import Menu from "./Menu";

export type RewriteAction = "polish" | "expand" | "shorten" | "tone" | "example" | "custom";
/** 선택 말풍선 순서 — custom(직접 지시)은 지시를 물은 뒤 보낸다 */
export const REWRITE_LABEL: Record<RewriteAction, string> = { polish: "다듬기", expand: "늘리기", shorten: "줄이기", tone: "톤 바꾸기", example: "예시 추가", custom: "직접 지시…" };

type Props = {
  editor: Editor;
  /** 버튼이 꺼진 이유 (툴팁) — 비어 있으면 쓸 수 있다 */
  busyReason: string;
  bodySizePt: number;
  lineHeight: number;
  paraSpacingMm: number;
  onLayout: (patch: Partial<LayoutSettings>) => void;
  onPickImage: () => void;
  onBookSearch: (query: string) => void;
};

/**
 * 서식 도구줄 — 글 모양(소제목·굵게·목록…) · 그림 · 되돌리기 · 폰트 서식 · 찾기만 둔다.
 * AI 기능(다듬기·각주 등)은 본문을 드래그하면 뜨는 말풍선에, 이미지 추천·자동 각주는 오른쪽 패널 탭에 한 곳씩만 있다.
 * 굵게·소제목 같은 켜짐 표시는 커서가 움직일 때마다 바뀌어야 하므로 useEditorState로 이 도구줄만 다시 그린다(편집기 전체가 아니라).
 */
function EditorToolbar({ editor, busyReason, bodySizePt, lineHeight, paraSpacingMm, onLayout, onPickImage, onBookSearch }: Props) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      heading: e.isActive("heading"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      blockquote: e.isActive("blockquote"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
    }),
  });
  const tb = (label: React.ReactNode, title: string, onClick: () => void, on = false) => (
    <button
      key={title}
      title={busyReason || title}
      aria-label={title}
      aria-pressed={on}
      disabled={!!busyReason}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs disabled:opacity-40 ${on ? "bg-stone-800 text-white" : "text-stone-700 hover:bg-stone-200"}`}
    >
      {label}
    </button>
  );
  const sep = <span className="mx-1 h-4 border-l border-stone-300" aria-hidden />;
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="서식">
      {tb("소제목", "소제목", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), active.heading)}
      {tb(<b>B</b>, "굵게 (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), active.bold)}
      {tb(<i>I</i>, "기울임 (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), active.italic)}
      {sep}
      {tb("❝", "인용", () => editor.chain().focus().toggleBlockquote().run(), active.blockquote)}
      {tb("•", "글머리 목록", () => editor.chain().focus().toggleBulletList().run(), active.bulletList)}
      {tb("1.", "번호 목록", () => editor.chain().focus().toggleOrderedList().run(), active.orderedList)}
      {tb("―", "구분선", () => editor.chain().focus().setHorizontalRule().run())}
      {tb(
        <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
          <circle cx="7" cy="8" r="1.5" />
          <path d="M3 15l4.5-4.5 3 3 2.5-2.5L17 15" />
        </svg>,
        "그림 넣기 (본문에 끌어다 놓거나 붙여 넣어도 됩니다)",
        onPickImage,
      )}
      {sep}
      {tb("↶", "실행 취소 (Ctrl+Z)", () => editor.chain().focus().undo().run())}
      {tb("↷", "다시 실행 (Ctrl+Y)", () => editor.chain().focus().redo().run())}
      {sep}
      <Menu label="폰트 서식 ▾" tone="text-sky-800" title="글자 크기·줄 간격·문단 간격 — 책 전체 본문에 적용됩니다">
        <div className="space-y-2 p-3 text-xs text-stone-600">
          <p className="text-[11px] text-stone-500">책 전체 본문에 적용됩니다</p>
          <label className="flex items-center justify-between gap-3">
            글자 크기
            <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={bodySizePt} onChange={(e) => onLayout({ bodySizePt: Number(e.target.value) })}>
              {[9, 9.5, 10, 10.5, 11, 11.5, 12].map((v) => (
                <option key={v} value={v}>
                  {`${v}pt`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            줄 간격
            <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={lineHeight} onChange={(e) => onLayout({ lineHeight: Number(e.target.value) })}>
              {[1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2].map((v) => (
                <option key={v} value={v}>
                  {`${Math.round(v * 100)}%`}
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
      <span className="ml-auto hidden text-[11px] text-stone-400 lg:inline">글을 드래그하면 AI 다듬기·각주 메뉴가 뜹니다</span>
    </div>
  );
}

export default memo(EditorToolbar);
