import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { isAutoRun, STALE_MS, type AutoRun } from "@/lib/autowrite";

/**
 * 전체 자동 집필 진행 상태 — AppSetting `autowrite:{책 id}`. 서버가 여러 대여도 같은 값을 보도록 캐시 없이 DB에서 읽는다.
 * 한 번에 한 창만 진행한다: 다른 창이 최근(1분 안)에 소식을 남긴 진행 중 상태는 takeover 없이 덮어쓰지 않는다(409).
 */
const key = (id: string) => `autowrite:${id}`;
const MAX = 1_000_000;

async function read(id: string): Promise<AutoRun | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    return isAutoRun(v) ? v : null;
  } catch {
    return null;
  }
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  return ok({ run: await read(id), now: Date.now() });
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  const text = await req.text();
  if (text.length > MAX) return fail("자동 집필 상태가 너무 큽니다.", 413);
  const b = JSON.parse(text) as { run?: unknown; takeover?: boolean };
  if (!isAutoRun(b.run)) return fail("입력 데이터 형식이 올바르지 않습니다.");
  if (!(await prisma.project.findUnique({ where: { id }, select: { id: true } }))) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const cur = await read(id);
  const now = Date.now();
  if (cur && cur.owner !== b.run.owner && cur.status === "running" && now - cur.updatedAt < STALE_MS && !b.takeover)
    return fail("다른 창에서 전체 자동 집필을 진행하고 있습니다.", 409);
  const run: AutoRun = { ...b.run, updatedAt: now };
  const value = JSON.stringify(run);
  await prisma.appSetting.upsert({ where: { key: key(id) }, create: { key: key(id), value }, update: { value } });
  return ok({ ok: true, updatedAt: now });
});

/** 진행하던 창이 닫힐 때(sendBeacon) — 그 창의 진행이면 소식 시각을 지워 다른 창이 바로 이어 받게 한다 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  const b = (await req.json()) as { release?: unknown };
  const cur = await read(id);
  if (cur && typeof b.release === "string" && cur.owner === b.release && cur.status === "running") {
    const value = JSON.stringify({ ...cur, updatedAt: 0 });
    await prisma.appSetting.update({ where: { key: key(id) }, data: { value } });
  }
  return ok({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  const cur = await read(id);
  if (cur?.status === "running" && Date.now() - cur.updatedAt < STALE_MS) return fail("진행 중인 자동 집필은 먼저 멈추세요.", 409);
  await prisma.appSetting.deleteMany({ where: { key: key(id) } });
  return ok({ ok: true });
});
