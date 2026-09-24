import { z } from "zod";

const nodeTypes = new Set(["doc", "paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem", "horizontalRule", "hardBreak", "figure", "footnote", "text"]);
export function validDocument(raw: string): boolean {
  if (raw === "") return true;
  try {
    const root = JSON.parse(raw);
    if (root?.type !== "doc") return false;
    const pending = [{ node: root, depth: 0 }];
    let count = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count > 50000 || depth > 30 || !node || typeof node !== "object" || !nodeTypes.has(node.type)) return false;
      if (node.text !== undefined && typeof node.text !== "string") return false;
      if (node.attrs !== undefined && (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs))) return false;
      if (node.marks !== undefined && (!Array.isArray(node.marks) || node.marks.some((m: any) => !m || !["bold", "italic"].includes(m.type)))) return false;
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) return false;
        for (const child of node.content) pending.push({ node: child, depth: depth + 1 });
      }
    }
    return true;
  } catch { return false; }
}

export const sectionInput = z.object({
  content: z.string().max(2_000_000).refine(validDocument).optional(),
  sketch: z.string().max(200_000).optional(),
  status: z.enum(["empty", "sketch", "ai_draft", "editing", "proofread"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
