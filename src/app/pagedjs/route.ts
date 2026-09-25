import fs from "node:fs/promises";
import path from "node:path";

let cached: string | null = null;

/**
 * node_modules의 Paged.js 폴리필(압축판, 약 500KB)을 제공한다.
 * 주소에 버전(?v=)을 붙여 부르므로 1년 캐시 — 미리보기·측정을 열 때마다 다시 받지 않는다.
 */
export async function GET() {
  if (!cached) cached = await fs.readFile(path.resolve(process.cwd(), "node_modules/pagedjs/dist/paged.polyfill.min.js"), "utf8");
  return new Response(cached, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
}
