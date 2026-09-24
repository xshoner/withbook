import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { analyzeStyle } from "@/lib/ai/tasks";
import { buildCorpus, extractText, loadReferenceDocs, type RefDoc } from "@/lib/style/reference";
import { readGlobalStyle } from "@/lib/style/global";
import { readUploads } from "@/lib/uploads";

export const maxDuration = 300;

/**
 * 프로젝트 문체 프로필 만들기 (multipart)
 * source=global: 기본 프로필 복사 | source=analyze: style reference 폴더(옵션) + 붙여넣기/업로드 샘플로 분석
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/style">) => {
  const { id } = await ctx.params;
  const form = await req.formData();
  const source = String(form.get("source") ?? "analyze");
  if (source === "global") {
    const g = await readGlobalStyle();
    if (!g) return fail("기본 문체 프로필이 아직 없습니다. 먼저 style reference 폴더로 학습하세요.");
    await prisma.project.update({ where: { id }, data: { styleProfile: JSON.stringify(g.profile) } });
    return ok({ profile: g.profile });
  }
  const docs: RefDoc[] = [];
  if (form.get("useReference") === "1") docs.push(...(await loadReferenceDocs()));
  const pasted = String(form.get("samples") ?? "").trim();
  if (pasted) docs.push({ name: "붙여넣은 글", kind: "sns", text: pasted, chars: pasted.length });
  for (const f of await readUploads(form, "files", 60 * 1024 * 1024)) {
    const text = await extractText(f.name, f.buffer);
    if (text.trim()) docs.push({ name: f.name, kind: "book", text, chars: text.length });
  }
  if (!docs.length) return fail("분석할 글이 없습니다.");
  const corpus = buildCorpus(docs);
  const profile = await analyzeStyle(corpus, id);
  await prisma.project.update({
    where: { id },
    data: { styleProfile: JSON.stringify(profile), styleSamples: corpus.slice(0, 20000) },
  });
  return ok({ profile });
});
