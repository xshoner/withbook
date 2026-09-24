import { MARGIN, type Margins } from "./print/spec";

export type NumberFormat = "basic" | "formal"; // basic: 1장 / 1.1, formal: 제1장 / 01

export type LayoutSettings = {
  numberFormat: NumberFormat;
  chapterStartRight: boolean; // 장은 오른쪽 페이지에서 시작
  margins: Margins;
  bodySizePt: number;
  lineHeight: number; // 줄 간격 (글자 크기의 배수, 1.6 = 160%)
  paraSpacingMm: number; // 문단과 문단 사이 추가 간격 mm
  grayscalePreview: boolean; // 흑백 인쇄 미리보기
  colophon: {
    position: "end" | "afterTitle";
    publishDate: string;
    publisher: string; // 펴낸이
    publisherName: string; // 펴낸곳
    registration: string;
    address: string;
    phone: string;
    email: string;
    isbn: string;
    website: string;
    copyrightYear: string;
    notice: string;
  };
};

export const DEFAULT_LAYOUT: LayoutSettings = {
  numberFormat: "basic",
  chapterStartRight: true,
  margins: { ...MARGIN },
  bodySizePt: 10,
  lineHeight: 1.6,
  paraSpacingMm: 0,
  grayscalePreview: true,
  colophon: {
    position: "end",
    publishDate: "",
    publisher: "한건희",
    publisherName: "주식회사 부크크",
    registration: "2014.07.15.(제2014-16호)",
    address: "서울특별시 금천구 가산디지털1로 119 SK트윈타워 A동 305호",
    phone: "1670-8316",
    email: "info@bookk.co.kr",
    isbn: "",
    website: "www.bookk.co.kr",
    copyrightYear: String(new Date().getFullYear()),
    notice: "본 책은 저작자의 지적 재산으로서 무단 전재와 복제를 금합니다.",
  },
};

export function parseLayout(raw: string | null | undefined): LayoutSettings {
  let v: Partial<LayoutSettings> = {};
  try {
    v = raw ? JSON.parse(raw) : {};
  } catch {}
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    ...DEFAULT_LAYOUT,
    ...v,
    bodySizePt: num(v.bodySizePt, DEFAULT_LAYOUT.bodySizePt, 8, 14),
    lineHeight: num(v.lineHeight, DEFAULT_LAYOUT.lineHeight, 1.2, 2.4),
    paraSpacingMm: num(v.paraSpacingMm, DEFAULT_LAYOUT.paraSpacingMm, 0, 8),
    margins: { ...DEFAULT_LAYOUT.margins, ...(v.margins ?? {}) },
    colophon: { ...DEFAULT_LAYOUT.colophon, ...(v.colophon ?? {}) },
  };
}

export function chapterLabel(fmt: NumberFormat, n: number) {
  return fmt === "formal" ? `제${n}장` : `${n}장`;
}

export function sectionLabel(fmt: NumberFormat, ch: number, sec: number) {
  return fmt === "formal" ? String(sec).padStart(2, "0") : `${ch}.${sec}`;
}
