import "server-only";
import type { Prisma } from "@prisma/client";
import type { prisma as Client } from "./db";
import { clearSectionExtras } from "./section-refs-store";

type Db = Prisma.TransactionClient | typeof Client;

/** 책마다 AppSetting에 둔 행의 키 (책 id 기준) — 표지 디자인·실제 쪽수·마지막 PDF 점검·목차 설계 표시·사실 확인/베타 리더 결과·마감일 */
export const projectSettingKeys = (projectId: string) => [`cover:${projectId}`, `pages:${projectId}`, `pdf-check:${projectId}`, `toc-design:${projectId}`, `ai:consistency:${projectId}`, `book-memory:${projectId}`, `book-index:${projectId}`, `book-biblio:${projectId}`, `deadline:${projectId}`];
export const projectSettingPrefixes = (projectId: string) => [`trash:${projectId}:`, `ai:beta:${projectId}:`, `revise-run:${projectId}:`];

/**
 * 책을 영구 삭제한 뒤 남는 AppSetting 행 정리 — 책 단위 행, 지운 장·절 휴지통, 절마다 둔 참고 자료·고친 개요·개요 캐시.
 * sectionIds는 지우기 전에 모아 둔다(절 행은 책과 함께 지워진다).
 */
export async function clearProjectSettings(db: Db, projectId: string, sectionIds: string[]) {
  await db.appSetting.deleteMany({
    where: { OR: [{ key: { in: projectSettingKeys(projectId) } }, ...projectSettingPrefixes(projectId).map((p) => ({ key: { startsWith: p } }))] },
  });
  await clearSectionExtras(db, sectionIds);
}
