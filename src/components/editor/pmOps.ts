"use client";

import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";

/** 서버 textblocks()와 같은 순서(문단·소제목)로 n번째(1부터) 텍스트 블록을 찾는다 */
export function textblockAt(doc: PMNode, index: number): { node: PMNode; pos: number } | null {
  let i = 0;
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      i++;
      if (i === index) found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** 블록 안 글자 오프셋 → 문서 위치 (hardBreak = 1글자 "\n", 각주 같은 인라인 원자 = 0글자) */
function blockText(node: PMNode) {
  let t = "";
  node.forEach((c) => {
    t += c.isText ? c.text : c.type.name === "hardBreak" ? "\n" : "";
  });
  return t;
}

/** 서버와 같은 텍스트 오프셋을 문서 위치로 바꾼다. atEnd면 오프셋 직전 글자 바로 뒤(원자 앞)를 고른다. */
export function offsetToPos(node: PMNode, blockPos: number, offset: number, atEnd = false): number {
  let text = 0;
  let pos = blockPos + 1;
  let result = -1;
  node.forEach((c, childOffset) => {
    if (result >= 0) return;
    const start = blockPos + 1 + childOffset;
    const len = c.isText ? c.text!.length : c.type.name === "hardBreak" ? 1 : 0;
    if (offset < text + len || (atEnd && offset === text + len && len > 0)) {
      result = start + (offset - text);
      return;
    }
    text += len;
    pos = start + c.nodeSize;
  });
  return result >= 0 ? result : pos;
}

export function findInBlock(editor: Editor, index: number, needle: string): { from: number; to: number } | "none" | "many" {
  const b = textblockAt(editor.state.doc, index);
  if (!b) return "none";
  const text = blockText(b.node);
  const first = text.indexOf(needle);
  if (first < 0) return "none";
  if (text.indexOf(needle, first + 1) >= 0) return "many";
  return { from: offsetToPos(b.node, b.pos, first), to: offsetToPos(b.node, b.pos, first + needle.length, true) };
}

/** n번째 텍스트 블록에서 term이 처음 나오는 자리 바로 뒤 위치 (자동 각주용) */
export function posAfterTerm(editor: Editor, index: number, term: string): number | null {
  const b = textblockAt(editor.state.doc, index);
  if (!b) return null;
  const at = blockText(b.node).indexOf(term);
  if (at < 0) return null;
  return offsetToPos(b.node, b.pos, at + term.length, true);
}

/** 앞뒤 공통 부분을 빼고 실제로 달라진 가운데만 바꾼다 → 굵게 등 서식이 걸린 부분을 보존 */
export function replaceInBlock(editor: Editor, index: number, before: string, after: string): boolean {
  const r = findInBlock(editor, index, before);
  if (typeof r === "string") return false;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const b = textblockAt(editor.state.doc, index)!;
  const start = blockText(b.node).indexOf(before);
  const from = offsetToPos(b.node, b.pos, start + p);
  const to = p === before.length - s ? from : offsetToPos(b.node, b.pos, start + before.length - s, true);
  const text = after.slice(p, after.length - s);
  const tr = text ? editor.state.tr.insertText(text, from, to) : editor.state.tr.delete(from, to);
  editor.view.dispatch(tr);
  return true;
}

export function selectInBlock(editor: Editor, index: number, text: string) {
  const r = findInBlock(editor, index, text);
  if (typeof r === "string") return false;
  editor.chain().focus().setTextSelection(r).scrollIntoView().run();
  return true;
}
