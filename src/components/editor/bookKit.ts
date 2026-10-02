import { Extension } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic } from "@tiptap/extension-italic";
import { BulletList, ListItem, ListKeymap, OrderedList } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Dropcursor, Gapcursor, TrailingNode, UndoRedo } from "@tiptap/extensions";

/**
 * 책 원고에 쓰는 기본 확장만 — StarterKit에서 링크·코드·취소선·밑줄을 뺀 것과 같다(순서도 같게).
 * StarterKit은 꺼 둔 확장도 함께 싣는다(링크가 쓰는 linkifyjs 등) → 편집 화면 첫 진입 JS를 줄이려고 직접 고른다.
 */
export const BookKit = Extension.create({
  name: "bookKit",
  addExtensions() {
    return [
      Bold,
      Blockquote,
      BulletList,
      Document,
      Dropcursor,
      Gapcursor,
      HardBreak,
      Heading.configure({ levels: [3] }),
      UndoRedo,
      HorizontalRule,
      Italic,
      ListItem,
      ListKeymap,
      OrderedList,
      Paragraph,
      Text,
      TrailingNode,
    ];
  },
});
