import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { getObject } from "@/lib/storage";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/assets/[id]">) => {
  const { id } = await ctx.params;
  const a = await prisma.asset.findUnique({ where: { id } });
  if (!a) return fail("이미지를 찾을 수 없습니다.", 404);
  const buf = await getObject("assets", a.path);
  if (!buf) return fail("이미지 파일을 찾을 수 없습니다.", 404);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": a.mime, "Cache-Control": "private, max-age=31536000, immutable" } });
});
