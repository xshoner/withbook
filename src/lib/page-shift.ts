import type { PagedInfo, SectionPageInfo } from "../components/types";

export type ShiftOptions = {
  /** 새 장은 오른쪽(홀수) 쪽에서 시작 (layout.chapterStartRight) */
  startRight: boolean;
  /** 책 순서의 장과 그 절 id — 이 절 뒤에 장이 더 있는지 알려고 쓴다 */
  chapters: { id: string; sectionIds: string[] }[];
};

/**
 * 절 하나를 다시 잰 결과를 책 전체 측정값에 합친다 — 그 절이 차지하는 쪽 수가 달라진 만큼(d) 뒤 절·장의 쪽을 민다.
 * - 쪽 번호는 첫 면부터 센 면 번호 그대로이고, 머리말(numStart)부터 보인다. 그 앞(표제지·판권면·속표지·차례)에는 절이 없다.
 * - d가 홀수이고 뒤에 오른쪽 시작(빈 쪽 자동 삽입) 경계가 있으면 빈 쪽이 생기거나 없어져 여기서는 맞출 수 없다 → null(책 전체를 다시 잰다).
 *   본문 시작(bodyStart)은 늘 오른쪽이라 앞붙이 절이 홀수로 바뀌면 설정과 상관없이 다시 잰다.
 * - 왼쪽·오른쪽은 면 번호의 홀짝으로 다시 정한다 (1면 = 오른쪽).
 */
export function shiftSection(info: PagedInfo, sid: string, m: SectionPageInfo, o: ShiftOptions): PagedInfo | null {
  const old = info.sections[sid];
  if (!old) return info;
  // 예전 방식(본문 시작 = 1쪽)으로 잰 결과 — 번호 체계가 달라 책 전체를 다시 잰다
  if (info.numStart === undefined) return null;
  const span = (x: SectionPageInfo) => x.endIdx - x.startIdx + 1;
  const d = span(m) - span(old);
  const front = old.startIdx < info.bodyStart; // 본문 시작 앞(앞붙이) 절
  if (d % 2 !== 0) {
    const ci = o.chapters.findIndex((c) => c.sectionIds.includes(sid));
    const later = ci >= 0 && o.chapters.slice(ci + 1).some((c) => c.sectionIds.length > 0);
    if (front || (o.startRight && later)) return null;
  }
  const bodyStart = front ? info.bodyStart + d : info.bodyStart;
  const numStart = info.numStart;
  const numOf = (idx: number) => (idx >= numStart ? idx : 0);
  const sideOf = (idx: number): "left" | "right" => (idx % 2 === 1 ? "right" : "left");
  const newEnd = old.startIdx + span(m) - 1;

  const sections: PagedInfo["sections"] = {};
  for (const [k, s] of Object.entries(info.sections)) {
    if (k === sid) {
      sections[k] = { ...old, pages: m.pages, chars: m.chars, fig: m.fig, endIdx: newEnd, end: numOf(newEnd) };
    } else if (d && s.startIdx > old.startIdx) {
      const startIdx = s.startIdx + d;
      const endIdx = s.endIdx + d;
      sections[k] = { ...s, startIdx, endIdx, start: numOf(startIdx), end: numOf(endIdx), side: sideOf(startIdx) };
    } else sections[k] = s;
  }

  // 장은 쪽 번호(= 면 번호)만 안다 — 이 절 뒤에서 시작하는 장을 민다
  const chapters: PagedInfo["chapters"] = {};
  for (const [k, c] of Object.entries(info.chapters)) chapters[k] = d && c.start > old.startIdx ? { start: c.start + d } : c;

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
      // 끼운 면은 번호가 보이는 면, 원래 번호가 없던 면(장 제목 쪽 등)은 그대로 0
      const wasNumbered = p.n > 0 || p.side === "";
      return { i, n: wasNumbered ? numOf(i) : 0, side: sideOf(i), blank: p.blank };
    });
  }
  return { ...info, total: info.total + d, bodyStart, sections, chapters, pages };
}
