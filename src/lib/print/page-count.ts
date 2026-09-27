import "server-only";
import { prisma } from "../db";

/**
 * 책의 실제 조판 쪽수 — 표지 책등 폭의 기준. AppSetting `pages:{책 id}`에 둔다 (스키마 변경 없음)
 *   source: "editor"(집필 화면의 숨은 조판이 잰 값) | "pdf"(본문 전체 PDF를 만든 값)
 * 가장 최근에 잰 값을 쓴다. 캐시 없이 읽는다(표지를 열 때 방금 잰 값이 보이게).
 *   chars: 잴 때 책 본문 글자 수 — 그 뒤 편집기 밖에서(자동 집필 등) 글이 늘거나 줄면 책 목록이 그 차이만큼 쪽수를 보정한다
 */
export type PageCount = { total: number; source: "editor" | "pdf"; at: string; chars?: number };

export const pageCountKey = (projectId: string) => `pages:${projectId}`;

export function cleanTotal(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 3000 ? n : null;
}

export async function loadPageCount(projectId: string): Promise<PageCount | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: pageCountKey(projectId) } }).catch(() => null);
  return row ? parsePageCount(row.value) : null;
}

/** 책 본문 글자 수 합 (절 charCount) */
export async function projectChars(projectId: string) {
  const r = await prisma.section.aggregate({ where: { chapter: { projectId } }, _sum: { charCount: true } });
  return r._sum.charCount ?? 0;
}

/**
 * 책 목록에 보일 쪽수 — 잰 쪽수가 있으면 그 값에 잰 뒤 늘거나 준 글자만큼(charsPerPage) 더한다. 없으면 글자 수로 어림한다.
 * exact: 잰 뒤 글자 수가 (거의) 그대로여서 집필 화면의 쪽수와 같은 값
 */
export function listPages(chars: number, charsPerPage: number, measured: PageCount | null): { pages: number; exact: boolean } {
  const cpp = charsPerPage || 700;
  if (!measured) return { pages: Math.round(chars / cpp), exact: false };
  if (measured.chars === undefined) return { pages: measured.total, exact: false };
  const diff = chars - measured.chars;
  if (Math.abs(diff) < cpp / 4) return { pages: measured.total, exact: true };
  return { pages: Math.max(1, measured.total + Math.round(diff / cpp)), exact: false };
}

export function parsePageCount(raw: string | null | undefined): PageCount | null {
  try {
    const v = JSON.parse(raw ?? "") as PageCount;
    return cleanTotal(v?.total) ? v : null;
  } catch {
    return null;
  }
}

/** 기록 — 같은 값이면 쓰지 않는다. 잘못된 값이면 false */
export async function savePageCount(projectId: string, total: unknown, source: PageCount["source"]) {
  const n = cleanTotal(total);
  if (!n) return false;
  const [prev, chars] = await Promise.all([loadPageCount(projectId), projectChars(projectId)]);
  if (prev?.total === n && prev.source === source && prev.chars === chars) return true;
  const key = pageCountKey(projectId);
  const value = JSON.stringify({ total: n, source, at: new Date().toISOString(), chars } satisfies PageCount);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return true;
}

/**
 * 마지막으로 만든 책 전체 PDF의 점검 결과 — 제출 전 점검(판형·KoPub 글꼴 임베딩·짝수 쪽)이 쓴다. AppSetting `pdf-check:{책 id}`
 */
export type SavedPdfCheck = { pages: number; widthMm: number; heightMm: number; sizeOk: boolean; fontsEmbedded: string[]; kopubEmbedded: boolean; size: "bleed" | "trim"; padEven: boolean; at: string };
export const pdfCheckKey = (projectId: string) => `pdf-check:${projectId}`;

export async function savePdfCheck(projectId: string, check: Omit<SavedPdfCheck, "at">) {
  const key = pdfCheckKey(projectId);
  const value = JSON.stringify({ ...check, fontsEmbedded: check.fontsEmbedded.slice(0, 20), at: new Date().toISOString() } satisfies SavedPdfCheck);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function loadPdfCheck(projectId: string): Promise<SavedPdfCheck | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: pdfCheckKey(projectId) } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as SavedPdfCheck;
    return cleanTotal(v?.pages) ? v : null;
  } catch {
    return null;
  }
}
