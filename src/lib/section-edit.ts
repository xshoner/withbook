import "server-only";
import { prisma } from "./db";
import { parseDoc, type JNode } from "./doc/doc";
import { saveSection, snapshot } from "./sections";

/**
 * 편집기 밖에서 절 본문을 고친다 (책 전체 바꾸기·장 퇴고·확인 표시 정리).
 * 절마다 한 트랜잭션에서 바꾸기 전 원고를 reason 버전으로 남기고 저장한다(자동 저장 버전은 따로 만들지 않는다).
 * 동시에 3개 절씩 처리한다. 편집 화면은 저장 후 다시 불러와야 한다.
 */
export async function editSections(
  sectionIds: string[],
  reason: string,
  fn: (doc: JNode, sectionId: string) => JNode | null,
): Promise<string[]> {
  const rows = await prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, content: true } });
  const jobs = rows.flatMap((r) => {
    const next = fn(parseDoc(r.content), r.id);
    const content = next && JSON.stringify(next);
    return content && content !== r.content ? [{ id: r.id, before: r.content, content }] : [];
  });
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      await prisma.$transaction(async (tx) => {
        await snapshot(j.id, reason, j.before, tx);
        await saveSection(j.id, { content: j.content, status: "editing" }, { tx, skipAutosave: true });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return jobs.map((j) => j.id);
}

/** 프로젝트의 모든 절 (읽는 순서는 부르는 쪽에서 정한다) */
export async function projectSectionIds(projectId: string) {
  const rows = await prisma.section.findMany({ where: { chapter: { projectId } }, select: { id: true } });
  return rows.map((r) => r.id);
}
