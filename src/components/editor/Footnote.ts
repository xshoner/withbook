"use client";

import { Node } from "@tiptap/core";

/**
 * 각주 — 단어 바로 뒤에 붙는 인라인 원자. 번호는 CSS 카운터로 문서 순서대로 매긴다.
 * attrs.note: 각주 내용, attrs.term: 각주를 단 단어(목록 표시용), attrs.auto: AI가 단 각주
 */
export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      note: { default: "" },
      term: { default: "" },
      auto: { default: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "sup[data-footnote]",
        getAttrs: (el) => ({
          note: (el as HTMLElement).getAttribute("data-note") ?? "",
          term: (el as HTMLElement).getAttribute("data-term") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const a = node.attrs as { note: string; term: string; auto: boolean };
    return [
      "sup",
      {
        "data-footnote": "",
        "data-note": a.note,
        "data-term": a.term,
        class: `fn-ref${a.auto ? " fn-auto" : ""}${a.note ? "" : " fn-empty"}`,
        title: a.note || "각주 내용이 비어 있습니다 — 클릭해서 입력",
      },
    ];
  },
  renderText() {
    return "";
  },
});

export type FootnoteAttrs = { note: string; term: string; auto: boolean };
