import "server-only";
import { prisma, rawTable } from "./db";
import { todayKst } from "./progress";
import { addError, errorKind, errorLogKey, normalizeRoute, parseErrorDay, type ErrorDay } from "./error-day";

export { errorLogKey, type ErrorDay } from "./error-day";

/**
 * 서버 오류 일지 — 5xx로 끝난 요청을 날짜별(한국 시간)로 모아 센다. AppSetting `errors:YYYY-MM-DD`.
 * 매일 아침 GitHub Actions(daily-check)가 /api/health?report=1로 읽어, 오류가 있으면 저장소 이슈로 알린다.
 * 저장소가 공개라 이슈에 그대로 올라간다 — 원고 내용이 섞일 수 있는 원래 오류 문구는 남기지 않고,
 * 오류 종류(이름·코드·상태)와 화면에 이미 보이던 한국어 안내(expose)만 남긴다.
 */

const KEEP_DAYS = 30;

/** 오류 한 건 기록 — 실패해도 요청 응답에는 영향이 없게 2초 안에서 끝낸다 */
export async function recordServerError(pathname: string, e: unknown, status: number) {
  const key = errorLogKey(todayKst());
  const err = e as any;
  const entry = {
    route: normalizeRoute(pathname),
    kind: errorKind(err, status),
    msg: err?.expose && typeof err.message === "string" ? err.message.slice(0, 120) : "",
    last: new Date().toISOString(),
  };
  const write = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO ${rawTable("AppSetting")} (key, value, "updatedAt") VALUES (${key}, '{"total":0,"groups":[]}', now()) ON CONFLICT (key) DO NOTHING`;
    const rows = await tx.$queryRaw<{ value: string }[]>`SELECT value FROM ${rawTable("AppSetting")} WHERE key = ${key} FOR UPDATE`;
    const next = addError(parseErrorDay(rows[0]?.value), entry);
    await tx.appSetting.update({ where: { key }, data: { value: JSON.stringify(next) } });
  });
  await Promise.race([write, new Promise((r) => setTimeout(r, 2_000))]).catch((x) => console.warn("[error-log] 기록 실패", x?.message));
}

export async function readErrorDay(day: string): Promise<ErrorDay> {
  const row = await prisma.appSetting.findUnique({ where: { key: errorLogKey(day) } });
  return parseErrorDay(row?.value);
}

/** 오래된 오류 일지 지우기 (하루 한 번 정리에서) */
export async function purgeErrorLogs(now = new Date()) {
  const cutoff = todayKst(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "errors:" } }, select: { key: true } });
  const old = rows.map((r) => r.key).filter((k) => k.slice("errors:".length) < cutoff);
  if (old.length) await prisma.appSetting.deleteMany({ where: { key: { in: old } } });
}
