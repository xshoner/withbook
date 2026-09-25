import "server-only";
import { prisma } from "./db";
import { parseDoc, type JNode } from "./doc/doc";
import { saveSection, snapshot } from "./sections";

/**
 * 편집기 밖에서 절 본문을 고친다 (책 전체 바꾸기·장 퇴고·확인 표시 정리).
 * 절마다 한 트랜잭션에서 바꾸기 전 원고를 reason 버전으로 남기고 저장한다(자동 저장 버전은 따로 만들지 않는다).
 * opts.snapshot=false: 호출자가 이미 버전을 남긴 경우(교정 — 교정 요청 때 남긴다). 동시에 3개 절씩 처리한다. 편집 화면은 저장 후 다시 불러와야 한다.
 * 밖에서 읽은 원고로 결과를 만들고, 트랜잭션 안에서 그 행을 잠근 뒤(FOR UPDATE) 원고를 다시 읽는다.
 * 그사이 자동 저장 등으로 원고가 바뀌었으면 최신 원고에 fn을 다시 적용한다 — 들어온 입력을 덮어쓰지 않는다.
 * (다시 적용하는 드문 경우 fn이 한 절에 두 번 불린다 — 호출자가 세는 개수는 그만큼 늘 수 있다)
 */
export async function editSections(
  sectionIds: string[],
  reason: string,
  fn: (doc: JNode, sectionId: string) => JNode | null,
  opts: { status?: string; snapshot?: boolean } = {},
): Promise<string[]> {
  const rows = await prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, content: true } });
  const jobs = rows.flatMap((r) => {
    const content = changed(r.content, fn(parseDoc(r.content), r.id));
    return content ? [{ id: r.id, before: r.content, content }] : [];
  });
  const edited = new Set<string>();
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      const done = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Section" WHERE "id" = ${j.id} FOR UPDATE`;
        const fresh = await tx.section.findUnique({ where: { id: j.id }, select: { content: true } });
        if (!fresh) return false; // 그사이 지워졌다
        const content = fresh.content === j.before ? j.content : changed(fresh.content, fn(parseDoc(fresh.content), j.id));
        if (!content) return false;
        if (opts.snapshot !== false) await snapshot(j.id, reason, fresh.content, tx);
        await saveSection(j.id, { content, status: opts.status ?? "editing" }, { tx, skipAutosave: true });
        return true;
      });
      if (done) edited.add(j.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return jobs.filter((j) => edited.has(j.id)).map((j) => j.id);
}

/** 바뀐 원고 JSON (그대로면 null) */
function changed(before: string, next: JNode | null) {
  const content = next && JSON.stringify(next);
  return content && content !== before ? content : null;
}

/** 프로젝트의 모든 절 (읽는 순서는 부르는 쪽에서 정한다) */
export async function projectSectionIds(projectId: string) {
  const rows = await prisma.section.findMany({ where: { chapter: { projectId } }, select: { id: true } });
  return rows.map((r) => r.id);
}
