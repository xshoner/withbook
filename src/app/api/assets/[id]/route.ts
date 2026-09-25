import { prisma } from "@/lib/db";
import { fail, handle } from "@/lib/api";
import { getObject, signedViewUrl } from "@/lib/storage";

// 서명 URL 유효 1시간, 브라우저는 그보다 조금 짧게(55분) 기억한다
const SIGNED_TTL = 3600;
const REDIRECT_MAX_AGE = 3300;

/**
 * 원고 이미지.
 * - 웹(Storage): 1시간짜리 서명 URL로 302 이동 — 함수 응답 크기(4.5MB) 제한·매번 내려받기를 피한다
 *   PDF 조판 브라우저도 같다(pdf.ts가 저장소의 서명된 assets 주소만 허용) — 큰 이미지도 PDF에 들어간다
 * - 로컬: 바이트 + 긴 캐시 (이미지 ID마다 내용이 바뀌지 않으므로 immutable)
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/assets/[id]">) => {
  const { id } = await ctx.params;
  const a = await prisma.asset.findUnique({ where: { id }, select: { id: true, path: true, mime: true } });
  if (!a) return fail("이미지를 찾을 수 없습니다.", 404);
  const url = await signedViewUrl("assets", a.path, SIGNED_TTL);
  if (url) return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": `private, max-age=${REDIRECT_MAX_AGE}` } });
  const etag = `"${a.id}"`;
  const cache = { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: cache });
  const buf = await getObject("assets", a.path);
  if (!buf) return fail("이미지 파일을 찾을 수 없습니다.", 404);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": a.mime, ...cache } });
});
