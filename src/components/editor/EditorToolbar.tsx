"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { memo } from "react";
import type { LayoutSettings } from "@/lib/layout";
import FindPanel from "./FindPanel";
import Menu from "./Menu";
import ToolGroup from "./ToolGroup";

export type RewriteAction = "polish" | "expand" | "shorten" | "tone" | "example" | "custom";
/** 선택 AI 메뉴·말풍선 순서 — custom(직접 지시)은 지시를 물은 뒤 보낸다 */
export const REWRITE_LABEL: Record<RewriteAction, string> = { polish: "다듬기", expand: "늘리기", shorten: "줄이기", tone: "톤 바꾸기", example: "예시 추가", custom: "직접 지시…" };

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
  /** 이미지 추천 — 오른쪽 [이미지] 탭을 열고 AI가 문단마다 맞는 도표·그래프·도식을 찾는다 */
  onImageSuggest: () => void;
  imageBusy: boolean;
};

/**
 * 서식 도구줄 — 본문 서식 · 각주 · 이미지 추천 · 선택 AI · 폰트 서식 · 찾기.
 * 굵게·소제목 같은 켜짐 표시는 커서가 움직일 때마다 바뀌어야 하므로 useEditorState로 이 도구줄만 다시 그린다(편집기 전체가 아니라).
 */
function EditorToolbar({ editor, busyReason, fnBusy, rewriteBusy, bodySizePt, lineHeight, paraSpacingMm, onLayout, onAddFootnote, onAutoFootnote, onRewrite, onPickImage, onBookSearch, onImageSuggest, imageBusy }: Props) {
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
        <button
          title={busyReason || "그림 넣기 — 파일을 고르거나, 본문에 끌어다 놓거나 붙여 넣어도 됩니다"}
          aria-label="그림 넣기"
          disabled={!!busyReason}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onPickImage}
          className="flex items-center gap-1 px-1.5 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40"
        >
          <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
            <circle cx="7" cy="8" r="1.5" />
            <path d="M3 15l4.5-4.5 3 3 2.5-2.5L17 15" />
          </svg>
          그림
        </button>
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
      <ToolGroup label="이미지" tone="bg-indigo-700">
        <button
          title={busyReason || "AI가 이 절의 문단마다 맞는 논문 도표·그래프·도식을 찾아 추천합니다 — 승인하면 그 문단 끝에 캡션과 함께 들어갑니다"}
          disabled={!!busyReason || imageBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onImageSuggest}
          className="bg-indigo-50 px-1.5 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
        >
          {imageBusy ? "찾는 중…" : "✦ 이미지 추천"}
        </button>
      </ToolGroup>
      <Menu
        label={rewriteBusy ? `✦ ${REWRITE_LABEL[rewriteBusy as RewriteAction] ?? ""} 중…` : "✦ 선택 AI ▾"}
        tone="text-violet-800"
        disabled={!!busyReason || selEmpty}
        title={selEmpty ? "본문을 드래그해 선택하면 다듬기·늘리기·줄이기·톤·예시·직접 지시를 쓸 수 있습니다" : busyReason || "선택한 부분을 AI로 고칩니다 (결과를 비교한 뒤 적용)"}
      >
        {(Object.keys(REWRITE_LABEL) as RewriteAction[]).map((a) => (
          <button key={a} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-violet-50" onMouseDown={(e) => e.preventDefault()} onClick={() => onRewrite(a)}>
            {REWRITE_LABEL[a]}
          </button>
        ))}
      </Menu>
      <Menu label="폰트 서식 ▾" tone="text-sky-800" title="글자 크기·줄 간격·문단 간격 — 책 전체 본문에 적용됩니다 (미리보기·PDF·HWPX 포함)">
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
