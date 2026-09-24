import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { saveSection } from "@/lib/sections";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]">) => {
  const { id } = await ctx.params;
  const s = await prisma.section.findUnique({ where: { id } });
  if (!s) return fail("절을 찾을 수 없습니다.", 404);
  return ok(s);
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]">) => {
  const { id } = await ctx.params;
  return ok(await saveSection(id, await req.json()));
});
