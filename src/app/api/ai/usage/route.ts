import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const GET = handle(async (req: Request) => {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  const where = projectId ? { projectId } : {};
  const [sum, byPurpose, recent] = await Promise.all([
    prisma.aiLog.aggregate({ where, _sum: { promptTokens: true, completionTokens: true, cost: true }, _count: true }),
    prisma.aiLog.groupBy({ by: ["purpose"], where, _sum: { promptTokens: true, completionTokens: true, cost: true }, _count: true }),
    prisma.aiLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return ok({ sum, byPurpose, recent });
});
