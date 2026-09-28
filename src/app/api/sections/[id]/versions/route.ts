import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { snapshot } from "@/lib/sections";
import { revisePointers } from "@/lib/revise-log";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const vs = await prisma.version.findMany({
    where: { sectionId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, charCount: true, createdAt: true },
  });
  // 장 퇴고 버전에는 그때 장 전체에서 몇 곳을 고쳤는지(이 절 / 장 전체) 붙인다
  const revise = await revisePointers(vs.filter((v) => v.reason === "chapter_revise").map((v) => v.id));
  return ok(vs.map((v) => (revise.has(v.id) ? { ...v, revise: revise.get(v.id) } : v)));
});

/** 스냅샷 {content, reason?} — reason: manual(수동) | ai_output(AI가 쓴 초안 원본 — 작가 수정률·문체 학습의 기준) | rewrite(선택 영역 AI 적용 전) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const reason = ["ai_output", "rewrite", "conflict"].includes(b.reason) ? b.reason : "manual";
  const v = await snapshot(id, reason, typeof b.content === "string" ? b.content : undefined);
  return ok({ id: v?.id });
});
