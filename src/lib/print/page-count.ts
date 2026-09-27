import "server-only";
import { prisma } from "../db";

/**
 * 책의 실제 조판 쪽수 — 표지 책등 폭의 기준. AppSetting `pages:{책 id}`에 둔다 (스키마 변경 없음)
 *   source: "editor"(집필 화면의 숨은 조판이 잰 값) | "pdf"(본문 전체 PDF를 만든 값)
 * 가장 최근에 잰 값을 쓴다. 캐시 없이 읽는다(표지를 열 때 방금 잰 값이 보이게).
 */
export type PageCount = { total: number; source: "editor" | "pdf"; at: string };

export const pageCountKey = (projectId: string) => `pages:${projectId}`;

export function cleanTotal(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 3000 ? n : null;
}

export async function loadPageCount(projectId: string): Promise<PageCount | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: pageCountKey(projectId) } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as PageCount;
    return cleanTotal(v?.total) ? v : null;
  } catch {
    return null;
  }
}

/** 기록 — 같은 값이면 쓰지 않는다. 잘못된 값이면 false */
export async function savePageCount(projectId: string, total: unknown, source: PageCount["source"]) {
  const n = cleanTotal(total);
  if (!n) return false;
  const prev = await loadPageCount(projectId);
  if (prev?.total === n && prev.source === source) return true;
  const key = pageCountKey(projectId);
  const value = JSON.stringify({ total: n, source, at: new Date().toISOString() } satisfies PageCount);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return true;
}
