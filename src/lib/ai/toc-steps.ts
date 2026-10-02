/**
 * 목차 설계를 여러 요청으로 나눠 하기 — 각 요청이 서버 시간 한도(Vercel Hobby 300초) 안에 끝나게.
 *   1) 골격: 콘셉트·흐름·장 제목·약속·절 제목·권장 분량 (설계 근거·절 요지·흥미 포인트는 비워 둔다)
 *   2) 장별 세부: 장마다 설계 근거와 절 요지·흥미 포인트를 채운다 (브라우저가 2~3개씩 동시에 요청)
 * 골격을 만들면 바로 보고서로 저장하고 detailPending(아직 세부를 채우지 않은 장 번호, 1부터)을 단다.
 * 장을 채울 때마다 그 번호를 지우고, 모두 채우면 필드를 없앤다 — 끝난 보고서는 예전 한 번에 만든 보고서와 모양이 같다.
 * 화면을 떠났다 돌아오면 detailPending이 남은 장부터 이어서 채운다.
 * 브라우저·서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */
export type TocSection = { title: string; gist: string; hook: string; targetPages: number };
export type TocChapter = { title: string; promise: string; rationale: string; sections: TocSection[] };
export type TocReportJson = {
  concept: string;
  flow: string;
  chapters: TocChapter[];
  readerHooks: string[];
  differentiation: string[];
  estimatedPages: number;
  frontMatter: string[];
  backMatter: string[];
  /** 세부 설계가 남은 장 번호(1부터) — 다 채우면 없다 */
  detailPending?: number[];
};

/** 장별 세부 설계를 동시에 몇 개까지 요청할지 */
export const TOC_DETAIL_CONCURRENCY = 3;

/** 번호는 앱이 붙이므로 AI가 넣은 "1장.", "제1장", "1.1" 같은 접두어 제거 (제자리에서 고친다) */
export function cleanTocTitles(chapters: TocChapter[]) {
  for (const c of chapters) {
    c.title = c.title.replace(/^\s*(제\s*)?\d+\s*(장|부)\s*[.:·\-–—]?\s*/, "").trim() || c.title;
    for (const s of c.sections) s.title = s.title.replace(/^\s*\d+(\.\d+)*\s*[.:)\-–—]?\s+/, "").trim() || s.title;
  }
  return chapters;
}

/** 골격 보고서 — 모든 장을 세부 설계 대기로 표시 */
export function withDetailPending<T extends { chapters: unknown[] }>(design: T): T & { detailPending: number[] } {
  return { ...design, detailPending: design.chapters.map((_, i) => i + 1) };
}

/** 세부 설계가 남은 장 번호 (범위를 벗어난 번호·중복은 뺀다) */
export function pendingChapters(rep: { chapters: unknown[]; detailPending?: unknown }): number[] {
  if (!Array.isArray(rep.detailPending)) return [];
  const n = rep.chapters.length;
  return [...new Set(rep.detailPending.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= n))].sort((a, b) => a - b);
}

const norm = (t: string) => String(t ?? "").replace(/[\s"'“”‘’.,·:;!?~\-–—()[\]]/g, "").toLowerCase();

/**
 * 골격의 장에 세부 설계를 합친다 — 제목·절 순서·절 개수·권장 분량은 골격 그대로 두고(이미 화면에 보였다)
 * 설계 근거와 절 요지·흥미 포인트만 가져온다. 절은 제목으로 짝짓고, 제목이 안 맞은 절끼리는 절 개수가 같을 때만 순서로 짝짓는다.
 */
export function mergeChapterDetail(skeleton: TocChapter, detail: TocChapter): TocChapter {
  const same = detail.sections.length === skeleton.sections.length;
  const byTitle = skeleton.sections.map((s) => detail.sections.findIndex((x) => norm(x.title) === norm(s.title)));
  const used = new Set(byTitle.filter((k) => k >= 0));
  // 제목이 안 맞은 절끼리는 순서대로 짝짓는다 (절 개수가 같을 때만)
  const left = same ? detail.sections.map((_, k) => k).filter((k) => !used.has(k)) : [];
  return {
    title: skeleton.title,
    promise: skeleton.promise || detail.promise || "",
    rationale: detail.rationale || skeleton.rationale || "",
    sections: skeleton.sections.map((s, i) => {
      const k = byTitle[i] >= 0 ? byTitle[i] : (left.shift() ?? -1);
      const d = k >= 0 ? detail.sections[k] : undefined;
      return { ...s, gist: d?.gist || s.gist || "", hook: d?.hook || s.hook || "" };
    }),
  };
}

function withoutPending<T extends TocReportJson>(rep: T, chapterNo: number): T {
  const rest = pendingChapters(rep).filter((n) => n !== chapterNo);
  const next = { ...rep };
  if (rest.length) next.detailPending = rest;
  else delete next.detailPending;
  return next;
}

/** chapterNo(1부터) 장의 세부 설계를 합친 새 보고서 */
export function applyChapterDetail<T extends TocReportJson>(rep: T, chapterNo: number, detail: TocChapter): T {
  const idx = chapterNo - 1;
  if (!rep.chapters[idx]) return rep;
  const chapters = rep.chapters.slice();
  chapters[idx] = mergeChapterDetail(rep.chapters[idx], detail);
  return withoutPending({ ...rep, chapters }, chapterNo);
}

/** chapterNo 장을 통째로 바꾼 새 보고서 ([이 장만 다시]) — 세부 설계도 함께 들어 있으므로 대기에서 뺀다 */
export function replaceChapter<T extends TocReportJson>(rep: T, chapterNo: number, chapter: TocChapter): T {
  const idx = chapterNo - 1;
  if (!rep.chapters[idx]) return rep;
  const chapters = rep.chapters.slice();
  chapters[idx] = chapter;
  return withoutPending({ ...rep, chapters }, chapterNo);
}

/** 프롬프트에 넣는 목차 글 — "1장 제목 — 약속" / "   1.1 절 제목: 요지 (3쪽)" */
export function tocDesignText(rep: Pick<TocReportJson, "chapters">): string {
  return rep.chapters
    .map((c, i) => {
      const head = `${i + 1}장 ${c.title}${c.promise ? ` — ${c.promise}` : ""}`;
      const secs = c.sections.map((s, j) => `   ${i + 1}.${j + 1} ${s.title}${s.gist ? `: ${s.gist}` : ""} (${Number(s.targetPages) || 0}쪽)`);
      return [head, ...secs].join("\n");
    })
    .join("\n");
}

/** items를 동시에 n개까지 처리한다 (브라우저의 장별 세부 설계용). stop()이 true면 새 항목을 시작하지 않는다 */
export async function runLimited<T>(items: T[], n: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}
