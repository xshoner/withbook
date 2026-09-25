import { z } from "zod";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";

/**
 * 끝난 교정 결과(변경 내역·교정 전 원고) 보관 — 새로 고침해도 [교정 내역]에서 확인·되돌리기할 수 있게.
 * AppSetting 키 proof-result:{절 id}, 7일 뒤 만료. 새 교정을 시작하거나 전체 되돌리면 지운다.
 */
const TTL = 7 * 24 * 60 * 60_000;
const MAX = 3_000_000;
const key = (id: string) => `proof-result:${id}`;

const change = z.object({
  paragraph: z.number().int(),
  before: z.string(),
  after: z.string(),
  type: z.string(),
  reason: z.string(),
  state: z.enum(["applied", "reverted", "failed"]),
});
const body = z.object({ label: z.string().max(500).default(""), before: z.record(z.string(), z.unknown()), result: z.array(change).max(5000) });

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/proof-result">) => {
  const { id } = await ctx.params;
  const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
  if (!row) return ok(null);
  try {
    const v = JSON.parse(row.value) as { expiresAt?: string };
    if (v.expiresAt && Date.parse(v.expiresAt) > Date.now()) return ok(v);
  } catch {}
  await prisma.appSetting.deleteMany({ where: { key: key(id) } });
  return ok(null);
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/proof-result">) => {
  const { id } = await ctx.params;
  const text = await req.text();
  if (text.length > MAX) return fail("교정 결과가 너무 커서 보관하지 않았습니다.", 413);
  const b = body.parse(JSON.parse(text));
  if (!(await prisma.section.findUnique({ where: { id }, select: { id: true } }))) return fail("절을 찾을 수 없습니다.", 404);
  const value = JSON.stringify({ ...b, savedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL).toISOString() });
  await prisma.appSetting.upsert({ where: { key: key(id) }, create: { key: key(id), value }, update: { value } });
  return ok({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/proof-result">) => {
  const { id } = await ctx.params;
  await prisma.appSetting.deleteMany({ where: { key: key(id) } });
  return ok({ ok: true });
});
