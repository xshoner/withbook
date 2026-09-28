import path from "node:path";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/maintenance";
import { putObject, removeObjects } from "@/lib/storage";
import { readUpload } from "@/lib/uploads";
import { readZipEntry } from "@/lib/zip-limits";
import { validDocument } from "@/lib/section-input";
import { charCount, parseDoc } from "@/lib/doc/doc";
import { imageSize } from "@/lib/imageSize";
import { remapExtras } from "@/lib/export/backup-extras";
import { BACKUP_IMPORT_MAX } from "@/lib/export/backup-limits";

export const maxDuration = 300;

/**
 * 백업 zip으로 새 프로젝트 복원 — 책·목차·본문·버전·이미지와 extras.json(표지 디자인·참고 자료·고친 개요·만든 그림 목록).
 * 저장소에 없어 비어 있던 이미지는 건너뛰고 알린다(책 전체 복원이 이미지 한 장 때문에 실패하지 않게).
 * 예전 백업(extras.json 없음)도 그대로 받는다.
 */
export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const file = await readUpload(form, "file", BACKUP_IMPORT_MAX).catch((e) => {
    if (e?.status === 413) throw Object.assign(new Error("백업 ZIP은 50MB 이하로 올려주세요. 버전 기록을 빼고 다시 백업하면 작아집니다."), { status: 413 });
    throw e;
  });
  if (!file) return fail("백업 파일이 없습니다.");
  const zip = await JSZip.loadAsync(file.buffer);
  if (Object.keys(zip.files).length > 5000) return fail("백업 파일 수가 너무 많습니다.", 413);
  const metadata = zip.file("project.json");
  if (!metadata) return fail("책 정보(project.json)가 없습니다.");
  const meta = JSON.parse((await readZipEntry(metadata, 40 * 1024 * 1024)).toString("utf8"));
  if (meta.format !== "bookk-writer-backup") return fail("withbook 백업 파일이 아닙니다.");
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
  const extrasFile = zip.file("extras.json");
  const extras = extrasFile ? JSON.parse((await readZipEntry(extrasFile, 40 * 1024 * 1024)).toString("utf8"))?.rows : [];

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
  const sectionMap = new Map<string, string>();
  const stored: string[] = [];
  const warnings: string[] = [];
  try {
    let remaining = 200 * 1024 * 1024;
    let skipped = 0;
    for (const a of p.assets ?? []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(a.id)) throw Object.assign(new Error("이미지 ID가 올바르지 않습니다."), { status: 400 });
      const entry = Object.keys(zip.files).find((f) => f === `assets/${a.id}${path.extname(f)}`);
      const buffer = entry ? await readZipEntry(zip.file(entry)!, Math.min(20 * 1024 * 1024, remaining)) : null;
      // 백업할 때 저장소에 없던 이미지는 빈 항목이다 — 건너뛰고 알린다
      if (!entry || !buffer?.length) {
        skipped++;
        continue;
      }
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
    if (skipped) warnings.push(`백업에 들어 있지 않은 이미지 ${skipped}개는 건너뛰었습니다(원고의 그 자리는 비어 보일 수 있습니다).`);
    const remap = (c: string) => {
      let s = c ?? "";
      idMap.forEach((n, o) => (s = s.split(o).join(n)));
      return s;
    };
    for (const c of p.chapters ?? []) {
      const ch = await prisma.chapter.create({
        data: { projectId: np.id, order: c.order, title: c.title, kind: c.kind, promise: c.promise ?? "", summary: c.summary, summaryHash: c.summaryHash },
      });
      // 절을 하나씩 만들어 옛 id → 새 id를 기록한다 (참고 자료·고친 개요를 제 절에 되돌려 놓으려고)
      for (const s of c.sections ?? []) {
        const ns = await prisma.section.create({
          data: {
            chapterId: ch.id,
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
          },
          select: { id: true },
        });
        if (typeof s.id === "string") sectionMap.set(s.id, ns.id);
      }
    }
    const rows = remapExtras(extras, np.id, sectionMap, remap);
    if (rows.length) await prisma.appSetting.createMany({ data: rows, skipDuplicates: true });
    return ok({ id: np.id, warnings });
  } catch (error) {
    // The new project is not returned until all children and assets exist.
    await prisma.project.delete({ where: { id: np.id } });
    await prisma.appSetting.deleteMany({ where: { OR: [{ key: `cover:${np.id}` }, ...[...sectionMap.values()].flatMap((sid) => [{ key: { startsWith: `ref:${sid}:` } }, { key: `outline-edit:${sid}` }, { key: `figure-ai:${sid}` }])] } }).catch(() => {});
    await removeObjects("assets", stored).catch(() => {});
    throw error;
  }
});
