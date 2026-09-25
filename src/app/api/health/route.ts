import { prisma } from "@/lib/db";
import { checkAccess, webMode } from "@/lib/security";
import { storageConfigured } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * 상태 확인 (로그인 없이 열림 — proxy.ts PUBLIC). 비밀·개수·오류 내용은 보내지 않고 참/거짓만 알린다.
 * db: SELECT 1 성공 여부 · storage: 웹 모드는 Supabase Storage 설정, 로컬 모드는 항상 참(data/storage)
 */
export async function GET(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const db = await Promise.race([
    prisma.$queryRaw`SELECT 1`.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]).catch((e) => {
    console.error("[health] DB 확인 실패", e);
    return false;
  });
  const storage = webMode() ? storageConfigured() : true;
  const okAll = db && storage;
  return Response.json(
    { ok: okAll, db, storage, time: new Date().toISOString() },
    { status: okAll ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
