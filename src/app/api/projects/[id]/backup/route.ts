import path from "node:path";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { getObject } from "@/lib/storage";

export const maxDuration = 300;

/** 프로젝트 전체 백업(.zip: project.json + 이미지) — 웹은 내려받기 주소로 이동 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/backup">) => {
  const { id } = await ctx.params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      chapters: { include: { sections: { include: { versions: true } } } },
      glossary: true,
      tocReports: true,
      assets: true,
    },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify({ format: "bookk-writer-backup", version: 1, project: p }, null, 1));
  for (const a of p.assets) {
    const buf = await getObject("assets", a.path);
    if (buf) zip.file(`assets/${a.id}${path.extname(a.path)}`, buf);
  }
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await deliverFile(out, `${p.title}_백업_${stamp}.zip`, "application/zip");
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const { download } = await res.json();
    return Response.redirect(download, 302);
  }
  return res;
});
