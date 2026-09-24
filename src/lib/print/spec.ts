/**
 * 부크크 A5 인쇄 규격 — 편집기·미리보기·PDF·HWPX가 모두 이 상수만 참조한다.
 * 출처: prd.md 3장 (부크크 FAQ 풀빼다 안내, 규격체크 v1.0, 부크크 A5 HWP 서식 실측)
 */
export const TRIM = { width: 148, height: 210 } as const; // 완성(재단) 크기 mm
export const BLEED = 3; // 재단 여백 사방 mm
export const DOC = { width: TRIM.width + BLEED * 2, height: TRIM.height + BLEED * 2 } as const; // 154 × 216
export const SIZE_TOLERANCE_MM = 1;

/** 문서(재단 여백 포함) 가장자리 기준 여백 mm — 부크크 서식과 동일 */
export const MARGIN = {
  inner: 28,
  outer: 23,
  top: 18,
  bottom: 18,
  header: 7,
  footer: 13,
} as const;

/** 부크크 최소 안전 영역 — 재단선 기준 mm */
export const SAFE_MIN_FROM_TRIM = { top: 7, bottom: 7, outer: 7, inner: 12 } as const;

export const TYPO = {
  bodyFont: "KoPub바탕체 Light",
  bodyFontCss: "BookBody",
  headingFont: "KoPub돋움체 Medium",
  headingFontCss: "BookHeading",
  bodySizePt: 10,
  lineHeight: 1.6,
  pageNumberSizePt: 9,
  indentEm: 1,
} as const;

export const MIN_DPI = 300;
export const LOW_DPI = 150;
export const DEFAULT_CHARS_PER_PAGE = 700;

export type Margins = { inner: number; outer: number; top: number; bottom: number; header: number; footer: number };

/** 본문 영역(문서 기준) */
export function bodyBox(m: Margins = MARGIN) {
  const top = m.top + m.header;
  const bottom = m.bottom + m.footer;
  return {
    top,
    bottom,
    width: DOC.width - m.inner - m.outer, // 103
    height: DOC.height - top - bottom, // 160
  };
}

/** 사용자 여백이 부크크 최소 안전 영역을 지키는지 검사 (문서 기준 여백 입력) */
export function validateMargins(m: Margins): string[] {
  const errors: string[] = [];
  const fromTrim = {
    inner: m.inner - BLEED,
    outer: m.outer - BLEED,
    top: m.top + m.header - BLEED,
    bottom: m.bottom + m.footer - BLEED,
  };
  (Object.keys(SAFE_MIN_FROM_TRIM) as (keyof typeof SAFE_MIN_FROM_TRIM)[]).forEach((k) => {
    if (fromTrim[k] < SAFE_MIN_FROM_TRIM[k]) {
      errors.push(`${label(k)} 여백이 재단선 기준 ${fromTrim[k]}mm로 부크크 최소 ${SAFE_MIN_FROM_TRIM[k]}mm보다 작습니다.`);
    }
  });
  return errors;
}

function label(k: string) {
  return ({ inner: "안쪽", outer: "바깥쪽", top: "위", bottom: "아래" } as Record<string, string>)[k] ?? k;
}

/** 인쇄 크기 기준 유효 DPI */
export function effectiveDpi(widthPx: number, printWidthMm: number) {
  if (!printWidthMm) return 0;
  return widthPx / (printWidthMm / 25.4);
}

export const MM_TO_HWPUNIT = 7200 / 25.4; // 283.465
export const mmToHwp = (mm: number) => Math.round(mm * MM_TO_HWPUNIT);
