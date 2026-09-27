import "server-only";
import { prisma } from "./db";
import { purgeTrash } from "./trash";
import { purgePartials } from "./ai/partial";
import { purgeOldObjects } from "./storage";
import { clearProjectSettings } from "./project-cleanup";

/** 마지막으로 정리한 날(YYYY-MM-DD) — 서버리스 인스턴스가 여러 개여도 하루 한 번만 돌게 DB에 둔다 */
export const MAINTENANCE_KEY = "maintenance:last";
let lastCheck = "";

/** 오늘 정리할 차례를 차지한다 — 다른 인스턴스가 이미 돌렸으면 false */
async function claimToday(today: string) {
  const value = JSON.stringify(today);
  try {
    await prisma.appSetting.create({ data: { key: MAINTENANCE_KEY, value } });
    return true;
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
  const r = await prisma.appSetting.updateMany({ where: { key: MAINTENANCE_KEY, NOT: { value } }, data: { value } });
  return r.count > 0;
}

const DAY = 24 * 3600 * 1000;

/**
 * 하루 한 번 정리 — 책 목록 응답을 보낸 뒤(after) 돈다.
 * - 휴지통에서 30일이 지난 프로젝트(표지 디자인·실제 쪽수 기록 포함), 지운 장·절(30일)
 * - 개요 캐시(1일), AI 집필 부분 원고(7일), 끊긴 목차 설계 표시(1일), 확정하지 않은 원고 가져오기(1일)
 * - 내보내기(exports)·업로드 대기(incoming) 버킷의 하루 지난 파일
 * (DB 자체 백업은 Supabase가 맡는다. 프로젝트 단위 백업은 [내보내기 → 백업 ZIP])
 */
export async function dailyMaintenance() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastCheck === today) return;
  lastCheck = today;
  try {
    if (!(await claimToday(today))) return;
  } catch (e: any) {
    console.warn("[maintenance] 실행 기록을 확인하지 못함", e?.message);
    return;
  }
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      console.warn(`[maintenance] ${name} 실패`, e?.message);
    }
  };
  await step("휴지통 프로젝트", async () => {
    const cutoff = new Date(Date.now() - 30 * DAY);
    const gone = await prisma.project.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } });
    for (const p of gone) {
      const sections = await prisma.section.findMany({ where: { chapter: { projectId: p.id } }, select: { id: true } });
      await prisma.project.delete({ where: { id: p.id } });
      // 책마다 AppSetting에 둔 표지 디자인·실제 쪽수·휴지통·절 참고 자료 등도 함께 지운다
      await clearProjectSettings(prisma, p.id, sections.map((s) => s.id));
    }
  });
  // 지운 장·절(휴지통)도 30일이 지나면 비운다
  await step("장·절 휴지통", () => purgeTrash(30));
  // Rebuildable outline cache expires after one day, including orphaned sections.
  await step("개요 캐시", () =>
    prisma.appSetting.deleteMany({ where: { key: { startsWith: "ai:outline-cache:" }, updatedAt: { lt: new Date(Date.now() - DAY) } } }),
  );
  await step("AI 부분 원고", () => purgePartials());
  await step("원고 가져오기 대기", () =>
    prisma.appSetting.deleteMany({ where: { key: { startsWith: "manuscript-import:" }, updatedAt: { lt: new Date(Date.now() - DAY) } } }),
  );
  await step("목차 설계 표시", () =>
    prisma.appSetting.deleteMany({ where: { key: { startsWith: "toc-design:" }, updatedAt: { lt: new Date(Date.now() - DAY) } } }),
  );
  // 내려받기 주소(10분)가 지난 내보내기 파일과, 올리다 만 업로드 대기 파일
  await step("exports 버킷", () => purgeOldObjects("exports", DAY));
  await step("incoming 버킷", () => purgeOldObjects("incoming", DAY));
}

/** 원고 이미지 저장 경로 (assets 버킷 안) */
export function assetKey(projectId: string, assetId: string, ext: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^[a-zA-Z0-9_-]+$/.test(assetId)) throw Object.assign(new Error("ID가 올바르지 않습니다."), { status: 400 });
  return `projects/${projectId}/${assetId}${ext}`;
}
