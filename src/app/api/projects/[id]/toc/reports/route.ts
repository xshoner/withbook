import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/toc/reports">) => {
  const { id } = await ctx.params;
  const reps = await prisma.tocReport.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 10 });
  return ok(reps.map((r) => ({ id: r.id, createdAt: r.createdAt, ...JSON.parse(r.json) })));
});
