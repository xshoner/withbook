import path from "node:path";
import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { BACKUP_FORMAT, buildBackupZip } from "@/lib/export/backup-zip";
import { extraKeysFor } from "@/lib/export/backup-extras";
import { BACKUP_IMPORT_MAX } from "@/lib/export/backup-limits";
import { getObject } from "@/lib/storage";

export const maxDuration = 300;

/**
 * 프로젝트 전체 백업(.zip) — project.json(책·목차·본문) + assets/(이미지) + extras.json(표지 디자인·참고 자료·고친 개요·만든 그림 목록) + manifest.json
 * 기본은 버전 기록을 뺀다. ?versions=all 이면 버전 기록까지 담는다. 어느 쪽이든 그대로 복원된다.
 * ?json=1: 내려받기 주소와 함께 크기·빠진 이미지·복원 한도 초과 여부를 JSON으로 준다(화면이 안내한다).
 * 장을 하나씩 읽어 ZIP에 흘려 넣어(스트림) 원고 전체·버전 전체를 한꺼번에 메모리에 올리지 않는다.
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/backup">) => {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const withVersions = url.searchParams.get("versions") === "all";
  const asJson = url.searchParams.get("json") === "1";
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      chapters: { orderBy: { order: "asc" }, select: { id: true, sections: { select: { id: true } } } },
      glossary: true,
      tocReports: true,
      assets: true,
    },
  });
  if (!p) return fail("책을 찾을 수 없습니다.", 404);
  const { chapters, ...head } = p;
  const sectionIds = chapters.flatMap((c) => c.sections.map((s) => s.id));
  const keys = extraKeysFor(id, sectionIds);
  const extras = await prisma.appSetting.findMany({
    where: { OR: [{ key: { in: keys.exact } }, ...keys.prefixes.map((k) => ({ key: { startsWith: k } }))] },
    select: { key: true, value: true },
  });
  let missing: string[] = [];
  const out = await buildBackupZip({
    head,
    chapterIds: chapters.map((c) => c.id),
    loadChapter: (cid) =>
      prisma.chapter.findUnique({
        where: { id: cid },
        include: { sections: { orderBy: { order: "asc" }, include: { versions: withVersions ? { orderBy: { createdAt: "asc" } } : false } } },
      }),
    assets: p.assets.filter((a) => a.path).map((a) => ({ name: `assets/${a.id}${path.extname(a.path)}`, load: () => getObject("assets", a.path) })),
    tail: [
      { name: "extras.json", build: async () => Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, rows: extras }), "utf8") },
      {
        name: "manifest.json",
        build: async (m) => {
          missing = m;
          return Buffer.from(
            JSON.stringify({
              format: BACKUP_FORMAT,
              createdAt: new Date().toISOString(),
              includes: { versions: withVersions, chapters: chapters.length, sections: sectionIds.length, images: p.assets.length - m.length, extras: extras.length },
              missingImages: m,
              excluded: ["AI 설정·API 키", "기본 문체(계정 전체)", "장 퇴고 기록·교정 내역·AI 부분 원고(짧게 보관하는 작업 기록)"],
            }),
            "utf8",
          );
        },
      },
    ],
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${p.title}_백업_${stamp}${withVersions ? "_버전포함" : ""}.zip`;
  const info = { size: out.length, missingImages: missing.length, overImportLimit: out.length > BACKUP_IMPORT_MAX, importLimit: BACKUP_IMPORT_MAX };
  const res = await deliverFile(out, filename, "application/zip", asJson ? info : {});
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    if (asJson) return res;
    const { download } = await res.json();
    return Response.redirect(download, 302);
  }
  return res;
});
