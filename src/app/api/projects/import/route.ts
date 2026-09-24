import path from "node:path";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/backup";
import { putObject, removeObjects } from "@/lib/storage";
import { readUpload } from "@/lib/uploads";

export const maxDuration = 300;
import { readZipEntry } from "@/lib/zip-limits";
import { validDocument } from "@/lib/section-input";
import { charCount, parseDoc } from "@/lib/doc/doc";
import { imageSize } from "@/lib/imageSize";

/** 백업 zip으로 새 프로젝트 복원 */
export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const file = await readUpload(form, "file", 50 * 1024 * 1024).catch((e) => {
    if (e?.status === 413) throw Object.assign(new Error("백업 ZIP은 50MB 이하로 올려주세요."), { status: 413 });
    throw e;
  });
  if (!file) return fail("백업 파일이 없습니다.");
  const zip = await JSZip.loadAsync(file.buffer);
  if (Object.keys(zip.files).length > 5000) return fail("백업 파일 수가 너무 많습니다.", 413);
  const metadata = zip.file("project.json");
  if (!metadata) return fail("프로젝트 정보가 없습니다.");
  const meta = JSON.parse((await readZipEntry(metadata, 20 * 1024 * 1024)).toString("utf8"));
  if (meta.format !== "bookk-writer-backup") return fail("BookK Writer 백업 파일이 아닙니다.");
  const p = meta.project;
  if (!p || typeof p.title !== "string" || !Array.isArray(p.chapters) || !Array.isArray(p.assets ?? [])) return fail("백업 구조가 올바르지 않습니다.");
  for (const chapter of p.chapters) {
    if (!Array.isArray(chapter.sections)) return fail("절 목록이 올바르지 않습니다.");
    for (const section of chapter.sections) {
      if (typeof section.content !== "string" || !validDocument(section.content)) return fail("백업 원고 형식이 올바르지 않습니다.");
      for (const version of section.versions ?? []) {
        if (typeof version.content !== "string" || !validDocument(version.content)) return fail("백업 버전 형식이 올바르지 않습니다.");
      }
    }
  }
  const np = await prisma.project.create({
    data: {
      title: p.title,
      subtitle: p.subtitle,
      author: p.author,
      topic: p.topic,
      intent: p.intent,
      audience: p.audience,
      keyMessage: p.keyMessage,
      tone: p.tone,
      references: p.references,
      targetPages: p.targetPages,
      extra: p.extra,
      styleProfile: p.styleProfile,
      styleSamples: p.styleSamples,
      layout: p.layout,
      charsPerPage: p.charsPerPage,
      glossary: { create: (p.glossary ?? []).map((g: any) => ({ term: g.term, preferred: g.preferred, note: g.note })) },
      tocReports: { create: (p.tocReports ?? []).map((t: any) => ({ json: t.json, createdAt: t.createdAt })) },
    },
  });
  const idMap = new Map<string, string>();
  const stored: string[] = [];
  try {
  let remaining = 200 * 1024 * 1024;
  for (const a of p.assets ?? []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(a.id)) throw Object.assign(new Error("이미지 ID가 올바르지 않습니다."), { status: 400 });
    const entry = Object.keys(zip.files).find((f) => f === `assets/${a.id}${path.extname(f)}`);
    if (!entry) throw Object.assign(new Error("백업 이미지가 누락되었습니다."), { status: 400 });
    const buffer = await readZipEntry(zip.file(entry)!, Math.min(20 * 1024 * 1024, remaining));
    remaining -= buffer.length;
    const size = imageSize(buffer);
    if (!size || size.width <= 0 || size.height <= 0 || size.width * size.height > 100_000_000) throw Object.assign(new Error("백업 이미지 형식이 올바르지 않습니다."), { status: 400 });
    const na = await prisma.asset.create({
      data: { projectId: np.id, filename: a.filename, mime: size.mime, widthPx: size.width, heightPx: size.height, path: "" },
    });
    const dest = assetKey(np.id, na.id, path.extname(entry));
    await putObject("assets", dest, buffer, size.mime);
    stored.push(dest);
    await prisma.asset.update({ where: { id: na.id }, data: { path: dest } });
    idMap.set(a.id, na.id);
  }
  const remap = (c: string) => {
    let s = c ?? "";
    idMap.forEach((n, o) => (s = s.split(o).join(n)));
    return s;
  };
  for (const c of p.chapters ?? []) {
    await prisma.chapter.create({
      data: {
        projectId: np.id,
        order: c.order,
        title: c.title,
        kind: c.kind,
        promise: c.promise ?? "",
        summary: c.summary,
        summaryHash: c.summaryHash,
        sections: {
          create: (c.sections ?? []).map((s: any) => ({
            order: s.order,
            title: s.title,
            gist: s.gist,
            hook: s.hook,
            targetPages: s.targetPages,
            status: s.status,
            sketch: s.sketch,
            content: remap(s.content),
            charCount: charCount(parseDoc(s.content)),
            summary: s.summary,
            summaryHash: s.summaryHash,
            versions: {
              create: (s.versions ?? []).map((v: any) => ({ reason: v.reason, content: remap(v.content), charCount: v.charCount, createdAt: v.createdAt })),
            },
          })),
        },
      },
    });
  }
  return ok({ id: np.id });
  } catch (error) {
    // The new project is not returned until all children and assets exist.
    await prisma.project.delete({ where: { id: np.id } });
    await removeObjects("assets", stored).catch(() => {});
    throw error;
  }
});
