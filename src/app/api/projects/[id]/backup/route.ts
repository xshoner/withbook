import path from "node:path";
import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { buildBackupZip } from "@/lib/export/backup-zip";
import { getObject } from "@/lib/storage";

export const maxDuration = 300;

/**
 * 프로젝트 전체 백업(.zip: project.json + 이미지) — 웹은 내려받기 주소로 이동
 * 기본은 버전 기록을 뺀다. ?versions=all 이면 버전 기록까지 담는다. 어느 쪽이든 그대로 복원된다.
 * 장을 하나씩 읽어 ZIP에 흘려 넣어(스트림) 원고 전체·버전 전체를 한꺼번에 메모리에 올리지 않는다.
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/backup">) => {
  const { id } = await ctx.params;
  const withVersions = new URL(req.url).searchParams.get("versions") === "all";
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      chapters: { orderBy: { order: "asc" }, select: { id: true } },
      glossary: true,
      tocReports: true,
      assets: true,
    },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const { chapters, ...head } = p;
  const out = await buildBackupZip({
    head,
    chapterIds: chapters.map((c) => c.id),
    loadChapter: (cid) =>
      prisma.chapter.findUnique({
        where: { id: cid },
        include: { sections: { orderBy: { order: "asc" }, include: { versions: withVersions ? { orderBy: { createdAt: "asc" } } : false } } },
      }),
    assets: p.assets.filter((a) => a.path).map((a) => ({ name: `assets/${a.id}${path.extname(a.path)}`, load: () => getObject("assets", a.path) })),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await deliverFile(out, `${p.title}_백업_${stamp}${withVersions ? "_버전포함" : ""}.zip`, "application/zip");
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const { download } = await res.json();
    return Response.redirect(download, 302);
  }
  return res;
});
