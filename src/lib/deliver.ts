import "server-only";
import { randomUUID } from "node:crypto";
import { putObject, signedDownloadUrl } from "./storage";
import { storageConfigured } from "./supabase/admin";

/**
 * 만든 파일을 돌려준다. 웹 배포는 응답 크기 제한(4.5MB)이 있어 exports 버킷에 올리고
 * { download: 서명 URL } JSON을 보낸다. 로컬은 파일을 그대로 응답한다.
 */
export async function deliverFile(data: Buffer | Uint8Array, filename: string, contentType: string, extra: Record<string, unknown> = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (storageConfigured()) {
    const key = `exp/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${filename.match(/\.[A-Za-z0-9]+$/)?.[0] ?? ""}`;
    await putObject("exports", key, buf, contentType);
    return Response.json({ download: await signedDownloadUrl("exports", key, filename), filename, ...extra });
  }
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
  if (extra.check) headers["X-Pdf-Check"] = encodeURIComponent(JSON.stringify(extra.check));
  return new Response(new Uint8Array(buf), { headers });
}
