import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { saveSection, snapshot } from "@/lib/sections";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/versions/[id]">) => {
  const { id } = await ctx.params;
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) return fail("버전을 찾을 수 없습니다.", 404);
  return ok(v);
});

/** 이 버전으로 복원 (현재 내용은 restore 버전으로 먼저 보관) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/versions/[id]">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) return fail("버전을 찾을 수 없습니다.", 404);
  await snapshot(v.sectionId, "restore", b.currentContent);
  const s = await saveSection(v.sectionId, { content: v.content, status: "editing" });
  return ok({ content: v.content, ...s });
});
