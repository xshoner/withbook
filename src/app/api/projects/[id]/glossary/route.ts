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

/** 고치기 — body { gid, term?, preferred?, note? } */
export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/glossary">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const data: { term?: string; preferred?: string; note?: string } = {};
  if (typeof b.term === "string") data.term = b.term.trim();
  if (typeof b.preferred === "string") data.preferred = b.preferred.trim();
  if (typeof b.note === "string") data.note = b.note.trim();
  if (data.term === "" || data.preferred === "") return fail("용어와 표기를 입력하세요.");
  const r = await prisma.glossary.updateMany({ where: { id: String(b.gid ?? ""), projectId: id }, data });
  if (!r.count) return fail("용어를 찾을 수 없습니다.", 404);
  return ok(await prisma.glossary.findFirst({ where: { id: String(b.gid), projectId: id } }));
});
