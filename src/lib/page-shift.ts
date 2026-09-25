import type { PagedInfo, SectionPageInfo } from "../components/types";

export type ShiftOptions = {
  /** 새 장은 오른쪽(홀수) 쪽에서 시작 (layout.chapterStartRight) */
  startRight: boolean;
  /** 책 순서의 장과 그 절 id — 이 절 뒤에 장이 더 있는지 알려고 쓴다 */
  chapters: { id: string; sectionIds: string[] }[];
};

/**
 * 절 하나를 다시 잰 결과를 책 전체 측정값에 합친다 — 그 절이 차지하는 쪽 수가 달라진 만큼(d) 뒤 절·장의 쪽을 민다.
 * - 쪽 번호는 본문 시작 면(bodyStart)부터 1쪽이다. 앞붙이(본문 시작 앞) 절이 늘면 면 번호(idx)만 밀리고 쪽 번호는 그대로다.
 * - d가 홀수이고 뒤에 오른쪽 시작(빈 쪽 자동 삽입) 경계가 있으면 빈 쪽이 생기거나 없어져 여기서는 맞출 수 없다 → null(책 전체를 다시 잰다).
 * - 왼쪽·오른쪽은 면 번호의 홀짝으로 다시 정한다 (1면 = 오른쪽).
 */
export function shiftSection(info: PagedInfo, sid: string, m: SectionPageInfo, o: ShiftOptions): PagedInfo | null {
  const old = info.sections[sid];
  if (!old) return info;
  const span = (x: SectionPageInfo) => x.endIdx - x.startIdx + 1;
  const d = span(m) - span(old);
  const front = old.startIdx < info.bodyStart; // 쪽 번호가 없는 앞붙이 쪽
  if (d % 2 !== 0) {
    const ci = o.chapters.findIndex((c) => c.sectionIds.includes(sid));
    const later = ci >= 0 && o.chapters.slice(ci + 1).some((c) => c.sectionIds.length > 0);
    // 본문 시작은 늘 오른쪽 · 장 시작도 오른쪽이면 뒤 장마다 빈 쪽이 달라진다
    if ((front && info.bodyStart > old.endIdx) || (o.startRight && later)) return null;
  }
  const bodyStart = front ? info.bodyStart + d : info.bodyStart;
  const numOf = (idx: number) => (idx >= bodyStart ? idx - bodyStart + 1 : 0);
  const sideOf = (idx: number): "left" | "right" => (idx % 2 === 1 ? "right" : "left");
  const newEnd = old.startIdx + span(m) - 1;

  const sections: PagedInfo["sections"] = {};
  for (const [k, s] of Object.entries(info.sections)) {
    if (k === sid) {
      sections[k] = { ...old, pages: m.pages, chars: m.chars, fig: m.fig, endIdx: newEnd, end: old.end > 0 || !front ? numOf(newEnd) : old.end };
    } else if (d && s.startIdx > old.startIdx) {
      const startIdx = s.startIdx + d;
      const endIdx = s.endIdx + d;
      // 쪽 번호가 없던 면(앞붙이·번호 없는 쪽)은 그대로 0
      sections[k] = { ...s, startIdx, endIdx, start: s.start > 0 ? numOf(startIdx) : 0, end: s.end > 0 ? numOf(endIdx) : 0, side: sideOf(startIdx) };
    } else sections[k] = s;
  }

  // 장은 쪽 번호만 안다 — 번호가 있는 절이 늘었을 때만 그 뒤 장을 민다
  const oldNo = front ? 0 : numOf(old.startIdx);
  const chapters: PagedInfo["chapters"] = {};
  for (const [k, c] of Object.entries(info.chapters)) chapters[k] = d && !front && c.start > 0 && c.start > oldNo ? { start: c.start + d } : c;

  // 면 목록: 이 절 끝까지는 그대로, 늘면 빈 면이 아닌 면을 끼우고 줄면 뺀 뒤 뒤쪽 번호를 다시 매긴다
  let pages = info.pages;
  if (d && pages.length) {
    const cut = Math.min(old.endIdx, newEnd);
    const head = pages.slice(0, cut);
    const added = Array.from({ length: Math.max(0, d) }, (_, k) => ({ i: cut + k + 1, n: 0, side: "", blank: false }));
    const tail = pages.slice(old.endIdx);
    pages = [...head, ...added, ...tail].map((p, k) => {
      const i = k + 1;
      if (i <= cut) return p;
      const wasNumbered = p.n > 0 || (p.side === "" && !front);
      return { i, n: wasNumbered ? numOf(i) : 0, side: sideOf(i), blank: p.blank };
    });
  }
  return { ...info, total: info.total + d, bodyStart, sections, chapters, pages };
}
