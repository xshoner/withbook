import fs from "node:fs/promises";
import { SERVED_FONTS, localFontPath, publicFontUrl } from "@/lib/fonts";
import { storageConfigured } from "@/lib/supabase/admin";

/** 편집 화면·조판용 KoPub 글꼴. 로컬 파일이 있으면 그대로, 없으면 저장소의 공개 주소로 보낸다(파일이 5MB 안팎이라 응답 크기 제한 회피) */
export async function GET(_req: Request, ctx: RouteContext<"/api/fonts/[file]">) {
  const { file } = await ctx.params;
  if (!SERVED_FONTS.includes(file)) return new Response("not found", { status: 404 });
  const type = file.endsWith(".woff2") ? "font/woff2" : "font/ttf";
  const buf = await fs.readFile(localFontPath(file)).catch(() => null);
  if (buf) return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
  if (!storageConfigured()) return new Response("font not found", { status: 404 });
  // 버킷 파일은 1년 캐시(scripts/upload-fonts.mjs). 이동 응답은 7일만 기억한다(글꼴을 바꿔 올려도 곧 반영되게)
  return new Response(null, { status: 307, headers: { Location: publicFontUrl(file), "Cache-Control": "public, max-age=604800" } });
}
