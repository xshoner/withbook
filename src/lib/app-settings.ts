import "server-only";
import { prisma } from "./db";

/**
 * 앱 전역 설정 저장소 (DB의 AppSetting 표) — 서버가 여러 대여도 같은 값을 쓴다.
 * 키: ai(AI 연결) · instruction(instruction.md 본문) · instructionHistory · globalStyle(기본 문체 프로필)
 */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 5_000;

/**
 * 읽기 — 같은 서버 안에서 5초 캐시. 다른 서버가 방금 바꾼 값이 늦게 보일 수 있으므로
 * 읽고-고치고-쓰는 곳은 { fresh: true }로 DB에서 바로 읽는다(표지 디자인은 cover/store가 캐시 없이 따로 다룬다).
 */
export async function getSetting<T>(key: string, opts: { fresh?: boolean } = {}): Promise<T | null> {
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL) return hit.value as T | null;
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  let value: T | null = null;
  try {
    value = row ? (JSON.parse(row.value) as T) : null;
  } catch {}
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function setSetting(key: string, value: unknown) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
  cache.set(key, { at: Date.now(), value });
}
