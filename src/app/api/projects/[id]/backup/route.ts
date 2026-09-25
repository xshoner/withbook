import path from "node:path";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { getObject, mapLimit } from "@/lib/storage";

export const maxDuration = 300;

/**
 * 프로젝트 전체 백업(.zip: project.json + 이미지) — 웹은 내려받기 주소로 이동
 * ?versions=none 이면 버전 기록을 뺀다(기본 all). 버전 없는 백업도 그대로 복원된다.
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/backup">) => {
  const { id } = await ctx.params;
  const withVersions = new URL(req.url).searchParams.get("versions") !== "none";
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      chapters: { include: { sections: { include: { versions: withVersions } } } },
      glossary: true,
      tocReports: true,
      assets: true,
    },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify({ format: "bookk-writer-backup", version: 1, project: p }));
  // 이미지는 이미 압축된 형식(JPG·PNG·WEBP)이라 다시 압축하지 않는다(STORE). 4개씩 나란히 내려받기
  await mapLimit(p.assets, 4, async (a) => {
    const buf = await getObject("assets", a.path);
    if (buf) zip.file(`assets/${a.id}${path.extname(a.path)}`, buf, { compression: "STORE" });
  });
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await deliverFile(out, `${p.title}_백업_${stamp}.zip`, "application/zip");
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const { download } = await res.json();
    return Response.redirect(download, 302);
  }
  return res;
});
