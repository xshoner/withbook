import "server-only";
import { prisma } from "./db";

/**
 * 앱 전역 설정 저장소 (DB의 AppSetting 표) — 서버가 여러 대여도 같은 값을 쓴다.
 * 키: ai(AI 연결) · instruction(instruction.md 본문) · instructionHistory · globalStyle(기본 문체 프로필)
 */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 5_000;

export async function getSetting<T>(key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T | null;
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
