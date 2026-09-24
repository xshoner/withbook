import { fail, handle, ok } from "@/lib/api";
import { analyzeStyle } from "@/lib/ai/tasks";
import { addReferenceFile, buildCorpus, listReferenceFiles, loadReferenceDocs, removeReferenceFile } from "@/lib/style/reference";
import { readGlobalStyle, writeGlobalStyle } from "@/lib/style/global";
import { readUploads } from "@/lib/uploads";

export const maxDuration = 300;

/** 문체 학습 자료 목록 + 기본 문체 프로필 */
export const GET = handle(async () => {
  const [{ dir, files }, g] = await Promise.all([listReferenceFiles(), readGlobalStyle()]);
  return ok({ dir, files, global: g });
});

/** 자료 전체(기존 + 새로 올린 파일)로 기본 문체 프로필을 다시 학습 */
export const POST = handle(async () => {
  const docs = await loadReferenceDocs();
  if (!docs.length) return ok({ error: "문체 학습 자료에서 읽을 수 있는 글을 찾지 못했습니다." });
  const profile = await analyzeStyle(buildCorpus(docs));
  const g = { profile, files: docs.map((d) => `${d.name} (${d.kind}, ${d.chars.toLocaleString()}자)`), analyzedAt: new Date().toISOString() };
  await writeGlobalStyle(g);
  return ok({ global: g });
});

/** 학습 자료 추가 (multipart files) */
export const PUT = handle(async (req: Request) => {
  const form = await req.formData();
  const files = await readUploads(form, "files", 60 * 1024 * 1024);
  if (!files.length) return fail("올릴 파일이 없습니다.");
  for (const f of files) await addReferenceFile(f.name, f.buffer);
  return ok({ added: files.map((f) => f.name), ...(await listReferenceFiles()) });
});

/** 학습 자료 삭제 (?name=) */
export const DELETE = handle(async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!name) return fail("파일 이름이 없습니다.");
  await removeReferenceFile(name);
  return ok(await listReferenceFiles());
});
