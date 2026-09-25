import "server-only";
import path from "node:path";
import { prisma } from "./db";
import { purgeTrash } from "./trash";

export const dataDir = () => path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(process.cwd(), "data"));
let lastCheck = "";

/**
 * 하루 한 번 휴지통에서 30일이 지난 프로젝트를 지운다.
 * (DB 자체 백업은 Supabase가 맡는다. 프로젝트 단위 백업은 [내보내기 → 백업 ZIP])
 */
export async function dailyMaintenance() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastCheck === today) return;
  lastCheck = today;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await prisma.project.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  } catch {}
  // 지운 장·절(휴지통)도 30일이 지나면 비운다
  try {
    await purgeTrash(30);
  } catch {}
}

/** 원고 이미지 저장 경로 (assets 버킷 안) */
export function assetKey(projectId: string, assetId: string, ext: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^[a-zA-Z0-9_-]+$/.test(assetId)) throw Object.assign(new Error("ID가 올바르지 않습니다."), { status: 400 });
  return `projects/${projectId}/${assetId}${ext}`;
}
