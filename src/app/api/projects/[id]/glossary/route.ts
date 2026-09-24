import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/glossary">) => {
  const { id } = await ctx.params;
  return ok(await prisma.glossary.findMany({ where: { projectId: id }, orderBy: { term: "asc" } }));
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/glossary">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  if (!b.term?.trim() || !b.preferred?.trim()) return fail("용어와 표기를 입력하세요.");
  const g = await prisma.glossary.create({
    data: { projectId: id, term: b.term.trim(), preferred: b.preferred.trim(), note: b.note ?? "" },
  });
  return ok(g);
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/glossary">) => {
  const { id } = await ctx.params;
  const gid = new URL(req.url).searchParams.get("gid") ?? "";
  await prisma.glossary.deleteMany({ where: { id: gid, projectId: id } });
  return ok({ ok: true });
});
