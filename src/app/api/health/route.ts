import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { readErrorDay } from "@/lib/error-log";
import { dailyMaintenance } from "@/lib/maintenance";
import { todayKst } from "@/lib/progress";
import { checkAccess, webMode } from "@/lib/security";
import { storageConfigured } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** 매일 점검용 비밀 값이 맞는가 (HEALTH_TOKEN이 없으면 보고를 열지 않는다) */
function reportAllowed(req: Request) {
  const want = process.env.HEALTH_TOKEN ?? "";
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (want.length < 16 || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/**
 * 상태 확인 (로그인 없이 열림 — proxy.ts PUBLIC). 비밀·개수·오류 내용은 보내지 않고 참/거짓만 알린다.
 * db: SELECT 1 성공 여부 · storage: 웹 모드는 Supabase Storage 설정, 로컬 모드는 항상 참(data/storage)
 * ?report=1 + Authorization: Bearer {HEALTH_TOKEN}: 어제·오늘 서버 오류 일지도 보낸다(매일 아침 GitHub Actions 점검).
 * 이때 하루 한 번 정리(dailyMaintenance)도 응답 뒤에 돌린다 — 아무도 접속하지 않는 날에도 정리되게.
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
  const body: Record<string, unknown> = { ok: okAll, db, storage, time: new Date().toISOString() };
  if (new URL(req.url).searchParams.get("report") === "1") {
    if (!reportAllowed(req)) return Response.json({ error: "권한이 없습니다." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const today = todayKst();
    const yesterday = todayKst(new Date(Date.now() - 86_400_000));
    if (db) {
      const [y, t] = await Promise.all([readErrorDay(yesterday), readErrorDay(today)]);
      body.errors = { [yesterday]: y, [today]: t };
      after(() => dailyMaintenance().catch((e) => console.warn("[maintenance]", e?.message)));
    }
  }
  return Response.json(body, { status: okAll ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
