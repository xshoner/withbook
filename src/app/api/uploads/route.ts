import { randomUUID } from "node:crypto";
import { fail, handle, ok } from "@/lib/api";
import { signedUploadUrl } from "@/lib/storage";
import { storageConfigured } from "@/lib/supabase/admin";

/** 큰 파일 직접 업로드용 서명 주소 발급 (웹 배포). 로컬은 { local: true } — 요청에 바로 실어 보낸다 */
export const POST = handle(async (req: Request) => {
  if (!storageConfigured()) return ok({ local: true });
  const b = await req.json();
  const size = Number(b.size) || 0;
  if (size <= 0 || size > 60 * 1024 * 1024) return fail("파일은 60MB 이하로 올려주세요.", 413);
  const ext = String(b.name ?? "").match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? "";
  const key = `u/${randomUUID()}/file${ext}`;
  return ok(await signedUploadUrl(key));
});
