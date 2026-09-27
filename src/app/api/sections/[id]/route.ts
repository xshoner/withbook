import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { contentHash } from "@/lib/doc/doc";
import { SaveConflictError, saveSection } from "@/lib/sections";

/** contentHash: 저장 충돌 확인 기준 (PUT의 baseHash로 되돌려 보낸다) */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]">) => {
  const { id } = await ctx.params;
  const s = await prisma.section.findUnique({ where: { id } });
  if (!s) return fail("절을 찾을 수 없습니다.", 404);
  return ok({ ...s, contentHash: contentHash(s.content) });
});

/**
 * 저장 {content?, sketch?, status?, baseHash?}
 * baseHash가 있고 지금 저장된 본문의 해시와 다르면 덮지 않고 409 + 서버 본문 (다른 창·서버 작업이 먼저 고친 경우).
 * baseHash 없이 보내면 예전처럼 그대로 저장한다.
 */
export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]">) => {
  const { id } = await ctx.params;
  const { baseHash, ...patch } = (await req.json()) ?? {};
  try {
    return ok(await saveSection(id, patch, { baseHash: typeof baseHash === "string" && baseHash ? baseHash : undefined }));
  } catch (e) {
    if (!(e instanceof SaveConflictError)) throw e;
    return ok({ error: e.message, conflict: e.current }, { status: 409 });
  }
});
