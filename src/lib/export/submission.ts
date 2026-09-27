/**
 * 부크크 제출 전 한눈 점검 — 본문 PDF·표지·원고 상태를 모아 항목마다 통과/주의/문제로 판정한다.
 * 데이터 모으기는 라우트(/api/projects/[id]/submission-check)가 하고, 판정은 여기서 한다(DB 없이 테스트).
 */

export type SubmitStatus = "pass" | "warn" | "fail";
export type SubmitFix = { label: string; href?: string; action?: "pdf" | "checks" | "cover" | "settings" };
export type SubmitItem = { id: string; label: string; status: SubmitStatus; detail: string; fix?: SubmitFix };

export type SubmitInput = {
  projectId: string;
  /** 마지막 책 전체 PDF 점검 (없으면 아직 만들지 않음) */
  pdf: { pages: number; widthMm: number; heightMm: number; sizeOk: boolean; kopubEmbedded: boolean; fontsEmbedded: string[]; size: "bleed" | "trim"; at: string } | null;
  /** 실제 조판 쪽수 기록 (집필 화면 측정 또는 PDF) */
  pageCount: { total: number; source: "editor" | "pdf"; at: string } | null;
  /** 원고 마지막 수정 시각(ISO) */
  lastEditAt: string | null;
  cover: { saved: boolean; size: string; pages: number; pagesManual: boolean; issues: { level: "error" | "warn"; message: string }[] };
  /** 글꼴 파일이 없어 PDF를 만들 수 없는 등 사전 점검 오류 */
  preflightErrors: string[];
  /** 이미지 해상도 경고 수 */
  lowDpi: number;
  /** 원고에 있지만 저장소에 없는 이미지 (위치) */
  missingImages: string[];
  /** [확인 필요]·[이미지 제안] 표시 수 */
  marks: number;
  emptySections: number;
  isbn: string;
};

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function submissionItems(x: SubmitInput): SubmitItem[] {
  const items: SubmitItem[] = [];
  const coverHref = `/projects/${x.projectId}/cover`;
  const settingsHref = `/projects/${x.projectId}/settings`;
  const pdfFix: SubmitFix = { label: "PDF 만들기", action: "pdf" };

  // 본문 PDF
  if (!x.pdf) items.push({ id: "pdf", label: "본문 PDF", status: "warn", detail: "아직 책 전체 PDF를 만들지 않았습니다. 판형·글꼴·쪽수는 PDF를 만들면 확인합니다.", fix: pdfFix });
  else if (x.lastEditAt && Date.parse(x.lastEditAt) > Date.parse(x.pdf.at))
    items.push({ id: "pdf", label: "본문 PDF", status: "warn", detail: `PDF(${fmt(x.pdf.at)})를 만든 뒤 원고가 바뀌었습니다(${fmt(x.lastEditAt)}). 제출 전에 다시 만드세요.`, fix: pdfFix });
  else items.push({ id: "pdf", label: "본문 PDF", status: "pass", detail: `${fmt(x.pdf.at)}에 만든 PDF · ${x.pdf.pages}쪽 · ${x.pdf.size === "bleed" ? "154×216mm(재단 여백 포함)" : "148×210mm"}` });

  // 판형
  const coverA5 = x.cover.size === "A5";
  if (x.pdf && !x.pdf.sizeOk) items.push({ id: "trim", label: "판형", status: "fail", detail: `본문 PDF가 ${x.pdf.widthMm}×${x.pdf.heightMm}mm로 A5 규격과 다릅니다.`, fix: pdfFix });
  else if (!coverA5) items.push({ id: "trim", label: "판형", status: "fail", detail: `표지 판형이 ${x.cover.size}인데 본문은 A5(148×210mm)입니다. 표지 판형을 A5로 바꾸세요.`, fix: { label: "표지 열기", href: coverHref, action: "cover" } });
  else items.push({ id: "trim", label: "판형", status: x.pdf ? "pass" : "warn", detail: x.pdf ? "본문 A5 · 표지 A5 — 일치" : "표지는 A5입니다. 본문 판형은 PDF를 만들면 확인합니다." });

  // 글꼴 임베딩
  if (x.preflightErrors.some((e) => /글꼴/.test(e))) items.push({ id: "fonts", label: "글꼴 포함", status: "fail", detail: "KoPub 글꼴 파일을 찾지 못해 PDF에 글꼴을 넣을 수 없습니다. 관리자에게 글꼴 저장소 설정을 확인해 달라고 하세요." });
  else if (!x.pdf) items.push({ id: "fonts", label: "글꼴 포함", status: "warn", detail: "PDF를 만들면 KoPub 글꼴이 들어갔는지 확인합니다.", fix: pdfFix });
  else if (!x.pdf.kopubEmbedded) items.push({ id: "fonts", label: "글꼴 포함", status: "fail", detail: `마지막 PDF에 KoPub 글꼴이 들어가지 않았습니다(들어간 글꼴: ${x.pdf.fontsEmbedded.slice(0, 4).join(", ") || "없음"}).`, fix: pdfFix });
  else items.push({ id: "fonts", label: "글꼴 포함", status: "pass", detail: `KoPub 글꼴 포함 (${x.pdf.fontsEmbedded.filter((f) => /KoPub/i.test(f)).length}종)` });

  // 짝수 쪽
  const pages = x.pdf?.pages ?? x.pageCount?.total ?? null;
  if (!pages) items.push({ id: "even", label: "총 쪽수 짝수", status: "warn", detail: "아직 쪽수를 재지 않았습니다.", fix: pdfFix });
  else if (pages % 2) items.push({ id: "even", label: "총 쪽수 짝수", status: "warn", detail: `${pages}쪽(홀수)입니다. PDF를 만들 때 [총 페이지 짝수로 맞추기]를 켜세요.`, fix: pdfFix });
  else items.push({ id: "even", label: "총 쪽수 짝수", status: "pass", detail: `${pages}쪽` });

  // 표지 쪽수(책등)
  if (!x.cover.saved) items.push({ id: "cover-pages", label: "표지 쪽수·책등", status: "warn", detail: "표지를 아직 만들지 않았습니다.", fix: { label: "표지 만들기", href: coverHref, action: "cover" } });
  else if (!pages) items.push({ id: "cover-pages", label: "표지 쪽수·책등", status: "warn", detail: `표지는 ${x.cover.pages}쪽 기준입니다. 본문 쪽수를 재면 비교합니다.`, fix: pdfFix });
  else if (x.cover.pages !== pages)
    items.push({ id: "cover-pages", label: "표지 쪽수·책등", status: "fail", detail: `표지는 ${x.cover.pages}쪽 기준인데 본문은 ${pages}쪽입니다. 책등 폭이 달라집니다${x.cover.pagesManual ? "(표지 쪽수를 직접 고정해 두었습니다)" : ""}.`, fix: { label: "표지 열기", href: coverHref, action: "cover" } });
  else items.push({ id: "cover-pages", label: "표지 쪽수·책등", status: "pass", detail: `표지·본문 모두 ${pages}쪽` });

  // 이미지
  if (x.missingImages.length)
    items.push({ id: "images", label: "이미지", status: "fail", detail: `원고의 이미지 ${x.missingImages.length}개를 찾을 수 없습니다 — ${x.missingImages.slice(0, 3).join(", ")}${x.missingImages.length > 3 ? " 외" : ""}. 다시 넣으세요.` });
  else if (x.lowDpi) items.push({ id: "images", label: "이미지", status: "warn", detail: `인쇄 권장 해상도(300 DPI)보다 낮은 이미지가 ${x.lowDpi}개 있습니다. PDF 탭의 사전 점검에서 위치를 확인하세요.`, fix: { label: "사전 점검 보기", action: "pdf" } });
  else items.push({ id: "images", label: "이미지", status: "pass", detail: "빠진 이미지 없음 · 해상도 문제 없음" });

  // 확인 표시
  if (x.marks) items.push({ id: "marks", label: "[확인 필요] 표시", status: "warn", detail: `[확인 필요]·[이미지 제안] 표시가 ${x.marks}곳 남아 있습니다. 표시 글자도 그대로 인쇄됩니다.`, fix: { label: "확인할 것 열기", action: "checks" } });
  else items.push({ id: "marks", label: "[확인 필요] 표시", status: "pass", detail: "남은 표시 없음" });

  // 표지 인쇄 점검
  const errs = x.cover.issues.filter((i) => i.level === "error");
  const warns = x.cover.issues.filter((i) => i.level === "warn");
  if (!x.cover.saved) {
    // 위에서 이미 알렸다
  } else if (errs.length || warns.length) {
    const top = [...errs, ...warns].slice(0, 2).map((i) => i.message).join(" / ");
    items.push({ id: "cover", label: "표지 인쇄 점검", status: errs.length ? "fail" : "warn", detail: `${errs.length ? `문제 ${errs.length}건` : ""}${errs.length && warns.length ? " · " : ""}${warns.length ? `주의 ${warns.length}건` : ""} — ${top}`, fix: { label: "표지 열기", href: coverHref, action: "cover" } });
  } else items.push({ id: "cover", label: "표지 인쇄 점검", status: "pass", detail: "해상도·재단 여백·안전 영역·바코드 자리 모두 괜찮습니다." });

  // 그 밖의 사전 점검
  const other = x.preflightErrors.filter((e) => !/글꼴/.test(e));
  if (other.length) items.push({ id: "preflight", label: "조판 설정", status: "fail", detail: other.join(" / "), fix: { label: "책 설정", href: settingsHref, action: "settings" } });
  if (x.emptySections) items.push({ id: "empty", label: "빈 절", status: "warn", detail: `아직 비어 있는 절이 ${x.emptySections}개 있습니다(제목만 인쇄됩니다).` });
  if (!x.isbn.trim()) items.push({ id: "isbn", label: "ISBN", status: "warn", detail: "판권면 ISBN이 비어 있습니다. 부크크에서 ISBN을 받은 뒤 넣으세요(바코드는 부크크가 표지에 넣습니다).", fix: { label: "책 설정 → 조판·판권면", href: settingsHref, action: "settings" } });

  return items;
}
