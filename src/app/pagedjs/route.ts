import fs from "node:fs/promises";
import path from "node:path";

let cached: string | null = null;

/** node_modules의 Paged.js 폴리필을 그대로 제공 */
export async function GET() {
  if (!cached) cached = await fs.readFile(path.resolve(process.cwd(), "node_modules/pagedjs/dist/paged.polyfill.js"), "utf8");
  return new Response(cached, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
