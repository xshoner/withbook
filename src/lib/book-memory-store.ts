import "server-only";
import { prisma } from "./db";
import { type MemoryItem, memoryKey, memoryText, normalizeMemory } from "./book-memory";

export async function readMemory(projectId: string): Promise<MemoryItem[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: memoryKey(projectId) } }).catch(() => null);
  if (!row) return [];
  try {
    return normalizeMemory(JSON.parse(row.value));
  } catch {
    return [];
  }
}

export async function writeMemory(projectId: string, items: MemoryItem[]) {
  const value = JSON.stringify({ items: normalizeMemory(items) });
  await prisma.appSetting.upsert({ where: { key: memoryKey(projectId) }, create: { key: memoryKey(projectId), value }, update: { value } });
}

/** AI 프롬프트용 블록 (없으면 빈 문자열) */
export async function readMemoryText(projectId: string) {
  return memoryText(await readMemory(projectId));
}
