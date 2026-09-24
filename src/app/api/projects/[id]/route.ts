import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { parseLayout } from "@/lib/layout";
import { validateMargins } from "@/lib/print/spec";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]">) => {
  const { id } = await ctx.params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      chapters: {
        orderBy: { order: "asc" },
        include: {
          sections: {
            orderBy: { order: "asc" },
            select: { id: true, title: true, order: true, gist: true, hook: true, targetPages: true, status: true, charCount: true, updatedAt: true },
          },
        },
      },
      glossary: true,
      _count: { select: { tocReports: true } },
    },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  return ok({ ...p, layout: parseLayout(p.layout) });
});

const FIELDS = ["title", "subtitle", "author", "topic", "intent", "audience", "keyMessage", "tone", "references", "extra"] as const;

export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const data: Record<string, unknown> = {};
  for (const f of FIELDS) if (typeof b[f] === "string") data[f] = b[f];
  if (b.targetPages !== undefined) data.targetPages = Number(b.targetPages) || 200;
  if (b.charsPerPage !== undefined) data.charsPerPage = Math.min(1200, Math.max(300, Number(b.charsPerPage) || 700));
  if (b.styleProfile !== undefined) data.styleProfile = b.styleProfile ? JSON.stringify(b.styleProfile) : null;
  if (b.layout) {
    const cur = await prisma.project.findUnique({ where: { id }, select: { layout: true } });
    const merged = parseLayout(JSON.stringify({ ...parseLayout(cur?.layout), ...b.layout }));
    const errs = validateMargins(merged.margins);
    if (errs.length) return fail(errs.join("\n"));
    data.layout = JSON.stringify(merged);
  }
  if (b.restore) data.deletedAt = null;
  await prisma.project.update({ where: { id }, data });
  return ok({ ok: true });
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]">) => {
  const { id } = await ctx.params;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";
  if (permanent) await prisma.project.delete({ where: { id } });
  else await prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
  return ok({ ok: true });
});
