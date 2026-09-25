import "server-only";
import { prisma } from "./db";
import { parseDoc, type JNode } from "./doc/doc";
import { saveSection, snapshot } from "./sections";

/**
 * 편집기 밖에서 절 본문을 고친다 (책 전체 바꾸기·장 퇴고·확인 표시 정리).
 * 바꾸기 전 원고를 reason 버전으로 남기고, 바뀐 절만 저장한다. 편집 화면은 저장 후 다시 불러와야 한다.
 */
export async function editSections(
  sectionIds: string[],
  reason: string,
  fn: (doc: JNode, sectionId: string) => JNode | null,
): Promise<string[]> {
  const rows = await prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, content: true } });
  const changed: string[] = [];
  for (const r of rows) {
    const next = fn(parseDoc(r.content), r.id);
    if (!next) continue;
    const content = JSON.stringify(next);
    if (content === r.content) continue;
    await snapshot(r.id, reason, r.content);
    await saveSection(r.id, { content, status: "editing" });
    changed.push(r.id);
  }
  return changed;
}

/** 프로젝트의 모든 절 (읽는 순서는 부르는 쪽에서 정한다) */
export async function projectSectionIds(projectId: string) {
  const rows = await prisma.section.findMany({ where: { chapter: { projectId } }, select: { id: true } });
  return rows.map((r) => r.id);
}
