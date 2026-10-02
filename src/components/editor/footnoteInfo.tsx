"use client";

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { useDocValue } from "./editorHooks";

// 편집 화면에 늘 필요한 각주 정보 — 목록 패널(FootnotesPanel)은 [각주] 탭을 열 때만 불러온다

function countFootnotes(doc: PMNode) {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === "footnote") n++;
  });
  return n;
}

/** 이 위치 각주의 번호 (문서 순서, 1부터). 각주가 아니면 0 */
export function footnoteNumberAt(editor: Editor, pos: number) {
  let n = 0;
  let found = 0;
  editor.state.doc.descendants((node, p) => {
    if (found) return false;
    if (node.type.name !== "footnote") return;
    n++;
    if (p === pos) found = n;
  });
  return found;
}

/** 오른쪽 패널 [각주] 탭 이름 — 각주 수가 바뀔 때만 다시 그린다 */
export function FootnoteTabLabel({ editor }: { editor: Editor | null }) {
  const n = useDocValue(editor, countFootnotes, { key: String, initial: 0, delay: 400 });
  return <>각주{n ? ` ${n}` : ""}</>;
}
