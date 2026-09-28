import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { MEMORY_KINDS, MEMORY_MAX_ITEMS, MEMORY_TEXT_MAX, type MemoryKind } from "@/lib/book-memory";
import { readMemory, writeMemory } from "@/lib/book-memory-store";

/**
 * 책의 기억 — GET 목록 · POST {kind, text, where?} 추가 · PATCH {id, kind?, text?} 고치기 · DELETE ?id= 지우기
 * 한 항목씩 바꿔 두 창에서 따로 추가해도 서로 지우지 않는다.
 */
const kind = z.enum(Object.keys(MEMORY_KINDS) as [MemoryKind, ...MemoryKind[]]);

async function project(id: string) {
  return prisma.project.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/memory">) => {
  const { id } = await ctx.params;
  if (!(await project(id))) return fail("책을 찾을 수 없습니다.", 404);
  return ok({ items: await readMemory(id) });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/memory">) => {
  const { id } = await ctx.params;
  const b = z.object({ kind, text: z.string().trim().min(1).max(2000), where: z.string().max(200).optional() }).parse(await req.json());
  if (!(await project(id))) return fail("책을 찾을 수 없습니다.", 404);
  const items = await readMemory(id);
  const text = b.text.slice(0, MEMORY_TEXT_MAX);
  if (items.some((i) => i.kind === b.kind && i.text === text)) return ok({ items, duplicate: true });
  if (items.length >= MEMORY_MAX_ITEMS) return fail(`책의 기억은 ${MEMORY_MAX_ITEMS}개까지입니다. 오래된 항목을 정리하세요.`);
  const item = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: b.kind, text, ...(b.where ? { where: b.where.slice(0, 80) } : {}), at: new Date().toISOString() };
  await writeMemory(id, [...items, item]);
  return ok({ items: [...items, item], item });
});

export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/memory">) => {
  const { id } = await ctx.params;
  const b = z.object({ id: z.string(), kind: kind.optional(), text: z.string().trim().min(1).max(2000).optional() }).parse(await req.json());
  const items = await readMemory(id);
  const next = items.map((i) => (i.id === b.id ? { ...i, ...(b.kind ? { kind: b.kind } : {}), ...(b.text ? { text: b.text.slice(0, MEMORY_TEXT_MAX) } : {}) } : i));
  await writeMemory(id, next);
  return ok({ items: next });
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/memory">) => {
  const { id } = await ctx.params;
  const mid = new URL(req.url).searchParams.get("id") ?? "";
  const next = (await readMemory(id)).filter((i) => i.id !== mid);
  await writeMemory(id, next);
  return ok({ items: next });
});
