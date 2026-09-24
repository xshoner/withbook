import "server-only";
import { prisma } from "./db";
import { charCount, parseDoc } from "./doc/doc";
import { sectionInput } from "./section-input";

const STATUSES = new Set(["empty", "sketch", "ai_draft", "editing", "proofread"]);

export async function saveSection(id: string, b: { content?: string; sketch?: string; status?: string }) {
  b = sectionInput.parse(b);
  const data: Record<string, unknown> = {};
  if (typeof b.content === "string") {
    data.content = b.content;
    data.charCount = charCount(parseDoc(b.content));
  }
  if (typeof b.sketch === "string") data.sketch = b.sketch;
  if (b.status && STATUSES.has(b.status)) data.status = b.status;
  return prisma.$transaction(async (tx) => {
    const current = await tx.section.findUniqueOrThrow({ where: { id } });
    if (b.content !== undefined && b.content !== current.content && current.charCount > 0) {
      const latest = await tx.version.findFirst({ where: { sectionId: id, reason: "autosave" }, orderBy: { createdAt: "desc" } });
      if (!latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000) {
        await tx.version.create({ data: { sectionId: id, reason: "autosave", content: current.content, charCount: current.charCount } });
        const old = await tx.version.findMany({ where: { sectionId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: 100, select: { id: true } });
        if (old.length) await tx.version.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
      }
    }
    return tx.section.update({ where: { id }, data, select: { updatedAt: true, charCount: true, status: true } });
  });
}

export async function snapshot(sectionId: string, reason: string, content?: string) {
  let c = content;
  if (c === undefined) {
    const s = await prisma.section.findUnique({ where: { id: sectionId }, select: { content: true } });
    c = s?.content ?? "";
  }
  const n = charCount(parseDoc(c));
  if (!n && reason !== "manual") return null;
  const v = await prisma.version.create({ data: { sectionId, reason, content: c, charCount: n } });
  // 절당 최근 100개만 보관
  const old = await prisma.version.findMany({ where: { sectionId }, orderBy: { createdAt: "desc" }, skip: 100, select: { id: true } });
  if (old.length) await prisma.version.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return v;
}
