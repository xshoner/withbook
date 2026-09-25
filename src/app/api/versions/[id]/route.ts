import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { saveSection, snapshot } from "@/lib/sections";
import { validDocument } from "@/lib/section-input";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/versions/[id]">) => {
  const { id } = await ctx.params;
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) return fail("버전을 찾을 수 없습니다.", 404);
  return ok(v);
});

/** 이 버전으로 복원 (현재 내용은 restore 버전으로 먼저 보관) — 보관·복원을 한 트랜잭션으로, autosave 중복 보관 없이 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/versions/[id]">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) return fail("버전을 찾을 수 없습니다.", 404);
  // 화면이 보낸 현재 내용(아직 저장 전일 수 있음)이 올바른 문서일 때만 쓰고, 아니면 DB 내용을 보관
  const current = typeof b.currentContent === "string" && b.currentContent.length <= 2_000_000 && validDocument(b.currentContent) ? b.currentContent : undefined;
  const s = await prisma.$transaction(async (tx) => {
    await snapshot(v.sectionId, "restore", current, tx);
    return saveSection(v.sectionId, { content: v.content, status: "editing" }, { tx, skipAutosave: true });
  });
  return ok({ content: v.content, ...s });
});
