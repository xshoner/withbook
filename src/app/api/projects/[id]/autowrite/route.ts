import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { isAutoRun, STALE_MS, type AutoRun } from "@/lib/autowrite";

/**
 * 자동 집필 진행 상태 — AppSetting `autowrite:{책 id}`. 서버가 여러 대여도 같은 값을 보도록 캐시 없이 DB에서 읽는다.
 * 한 번에 한 창만 진행한다: 다른 창이 최근(1분 안)에 소식을 남긴 진행 중 상태는 takeover 없이 덮어쓰지 않는다(409).
 * 쓰기는 조건부다 — 읽은 값 그대로일 때만 바꾼다(updateMany where value = 읽은 값, 없으면 create).
 * 두 창이 동시에 시작해도 둘 다 같은 옛 상태를 보고 통과하지 못하고, 늦은 쪽은 다시 읽어 판정한다.
 */
const key = (id: string) => `autowrite:${id}`;
const MAX = 1_000_000;

async function readRow(id: string): Promise<{ raw: string | null; run: AutoRun | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
  if (!row) return { raw: null, run: null };
  try {
    const v = JSON.parse(row.value);
    return { raw: row.value, run: isAutoRun(v) ? v : null };
  } catch {
    return { raw: row.value, run: null };
  }
}
const read = async (id: string) => (await readRow(id)).run;

/** 읽은 값(raw)이 그대로일 때만 쓴다 — 그사이 다른 요청이 바꿨으면 false */
async function writeIf(id: string, raw: string | null, value: string) {
  if (raw === null) {
    try {
      await prisma.appSetting.create({ data: { key: key(id), value } });
      return true;
    } catch (e: any) {
      if (e?.code === "P2002") return false; // 다른 요청이 먼저 만들었다
      throw e;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key: key(id), value: raw }, data: { value } });
  return r.count > 0;
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
  if (!(await prisma.project.findUnique({ where: { id }, select: { id: true } }))) return fail("책을 찾을 수 없습니다.", 404);
  // 조건부 쓰기가 밀리면(동시 요청) 다시 읽고 판정한다 — 같은 창의 잦은 저장끼리 부딪혀도 몇 번 안에 끝난다
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, run: cur } = await readRow(id);
    const now = Date.now();
    if (cur && cur.owner !== b.run.owner && cur.status === "running" && now - cur.updatedAt < STALE_MS && !b.takeover)
      return fail("다른 창에서 자동 집필을 진행하고 있습니다.", 409);
    const run: AutoRun = { ...b.run, updatedAt: now };
    if (await writeIf(id, raw, JSON.stringify(run))) return ok({ ok: true, updatedAt: now });
  }
  return fail("자동 집필 상태를 저장하지 못했습니다(동시에 여러 요청). 잠시 뒤 다시 시도하세요.", 409);
});

/** 진행하던 창이 닫힐 때(sendBeacon) — 그 창의 진행이면 소식 시각을 지워 다른 창이 바로 이어 받게 한다 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  const b = (await req.json()) as { release?: unknown };
  const { raw, run: cur } = await readRow(id);
  // 그사이 다른 창이 이어 받았으면(값이 바뀜) 건드리지 않는다
  if (cur && typeof b.release === "string" && cur.owner === b.release && cur.status === "running") await writeIf(id, raw, JSON.stringify({ ...cur, updatedAt: 0 }));
  return ok({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/autowrite">) => {
  const { id } = await ctx.params;
  const cur = await read(id);
  if (cur?.status === "running" && Date.now() - cur.updatedAt < STALE_MS) return fail("진행 중인 자동 집필은 먼저 멈추세요.", 409);
  await prisma.appSetting.deleteMany({ where: { key: key(id) } });
  return ok({ ok: true });
});
