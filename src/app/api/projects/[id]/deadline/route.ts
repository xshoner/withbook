import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { deadlineKey, validDate } from "@/lib/progress";

/** 책 마감일 정하기·지우기 — { date: "YYYY-MM-DD" | null } */
export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/deadline">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  if (!(await prisma.project.findUnique({ where: { id }, select: { id: true } }))) return fail("책을 찾을 수 없습니다.", 404);
  const key = deadlineKey(id);
  if (b.date === null || b.date === "") {
    await prisma.appSetting.deleteMany({ where: { key } });
    return ok({ deadline: null });
  }
  if (!validDate(b.date)) return fail("마감일 형식이 올바르지 않습니다.");
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: b.date }, update: { value: b.date } });
  return ok({ deadline: b.date });
});
