import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { snapshot } from "@/lib/sections";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const vs = await prisma.version.findMany({
    where: { sectionId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, charCount: true, createdAt: true },
  });
  return ok(vs);
});

/** 수동 스냅샷 {content} */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const v = await snapshot(id, "manual", b.content);
  return ok({ id: v?.id });
});
