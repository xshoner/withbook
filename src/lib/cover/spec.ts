/**
 * 표지(펼침면) 규격과 디자인 데이터 — 편집기·조판(PDF)·AI 이미지 요청이 모두 이 파일만 참조한다.
 * 브라우저·서버·테스트 공용이라 다른 모듈을 불러오지 않는다.
 *
 * 펼침면(왼쪽 → 오른쪽): 뒷날개 | 뒷표지 | 책등 | 앞표지 | 앞날개.
 * 출처: 부크크 표지 규격 자동 확인(https://bookk.co.kr/auto-size-preview.html) — 날개 100mm, 재단 여백 3mm.
 * 날개 있는 책: 앞·뒤표지는 판형 폭 + 3mm(날개 쪽으로 연장, 예: A5 151mm), 날개는 그만큼 줄어 97mm.
 *   재단 여백은 날개 바깥 끝과 위·아래에만 둔다. 전체 폭은 부크크 안내와 같다(책등 15.3mm → 517.3mm).
 * 날개 없는 책: 앞·뒤표지 = 판형 폭, 재단 여백은 사방.
 */

export const COVER_BLEED = 3; // 재단 여백 사방 mm
export const FLAP_WIDTH = 100; // 날개 폭 mm
export const SAFE_INSET = 5; // 글·중요 요소는 재단선·접는 선에서 이만큼 안쪽 mm
/** 날개 있는 책에서 앞·뒤표지가 날개 쪽으로 더 넓은 폭 (접을 때 밀려도 흰 틈이 보이지 않게) — 표지 패널에 포함된다 */
export const FOLD_EXTEND = 3;
export const PRINT_DPI = 300;

export const BOOK_SIZES = {
  A5: { label: "A5 (148×210)", width: 148, height: 210 },
  A4: { label: "A4 (210×297)", width: 210, height: 297 },
} as const;
export type BookSize = keyof typeof BOOK_SIZES;

/** 종이별 책등 두께 — 미색모조 100g: {(쪽수 / 2) × 0.11} + 1.6mm */
export const PAPERS = {
  ivory100: { label: "미색모조 100g", perSheet: 0.11, cover: 1.6 },
} as const;
export type Paper = keyof typeof PAPERS;

export function spineWidth(pages: number, paper: Paper = "ivory100") {
  const p = PAPERS[paper] ?? PAPERS.ivory100;
  const n = Math.max(0, Math.round(Number(pages) || 0));
  return Math.round(((n / 2) * p.perSheet + p.cover) * 10) / 10;
}

export type PanelId = "backFlap" | "back" | "spine" | "front" | "frontFlap";
export const PANEL_LABEL: Record<PanelId, string> = { backFlap: "뒷날개", back: "뒷표지", spine: "책등", front: "앞표지", frontFlap: "앞날개" };
export type Region = PanelId | "full";
export const REGION_LABEL: Record<Region, string> = { full: "펼침면 전체", ...PANEL_LABEL };

/* ---------------- 디자인 데이터 ---------------- */

export type CoverImage = {
  assetId: string;
  widthPx: number;
  heightPx: number;
  fit: "cover" | "contain";
  /** 남는 쪽을 어디에 맞출지 0~100 (%) */
  posX: number;
  posY: number;
  /** 1 = 영역에 맞춤, 크면 확대 */
  zoom: number;
  /** AI로 만든 그림이면 만들 때의 책등 폭 — 쪽수가 바뀌면 다시 만들라고 알린다 */
  spineMm?: number;
  ai?: boolean;
};

export type TextEl = {
  id: string;
  kind: "text";
  panel: PanelId;
  /** 패널 왼쪽 재단선(책등은 왼쪽 경계) 기준 mm — 쪽수가 바뀌어 패널이 옮겨 가도 따라간다 */
  x: number;
  y: number; // 위 재단선 기준 mm
  w: number; // 글 상자 폭 mm (세로쓰기면 높이)
  text: string;
  font: FontKey;
  sizePt: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number; // em
  vertical: boolean;
  /** 글 상자 배경 (빈 값이면 없음) */
  bg: string;
  bgOpacity: number; // 0~1
  bgPad: number; // 배경이 글 둘레로 넘치는 폭 mm (글 위치는 그대로)
  bgRadius: number; // 배경 모서리 둥글기 mm
  shadow: boolean;
  /** 글자 테두리(외곽선) 색 (빈 값이면 없음) */
  strokeColor: string;
  strokeWidth: number; // 글자 테두리 굵기 mm
};

export type ImageEl = {
  id: string;
  kind: "image";
  panel: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  assetId: string;
  widthPx: number;
  heightPx: number;
  radius: number; // mm
  round: boolean;
};

export type CoverEl = TextEl | ImageEl;

export type CoverDesign = {
  v: 1;
  size: BookSize;
  paper: Paper;
  pages: number;
  /** 쪽수를 작가가 직접 고쳤는지 — false면 책의 실제 조판 쪽수를 따라간다(열 때마다 맞춤) */
  pagesManual?: boolean;
  /** 직접 넣은 책등 폭(mm). 없으면 쪽수로 계산 */
  spineOverride: number | null;
  flaps: boolean;
  bgColor: string;
  images: Partial<Record<Region, CoverImage>>;
  elements: CoverEl[];
  ai: {
    instruction: string;
    withTitle: boolean;
    requestSize: string;
    /** 작가가 직접 고친 프롬프트(영역별). 있으면 자동 프롬프트 대신 이 글을 그대로 보낸다 */
    prompts: Partial<Record<Region, string>>;
    history: { assetId: string; widthPx: number; heightPx: number; region: Region; at: string; edit?: boolean }[] };
  updatedAt?: string;
};

/* ---------------- 글꼴 ---------------- */

/** 표지 글꼴 — kopub*는 앱 글꼴(/api/fonts), 나머지는 Google Fonts(OFL, PDF에 포함 가능) */
export const FONTS = {
  kopubBatang: { label: "KoPub 바탕 (본문)", css: "BookBody, serif", google: "" },
  kopubDotum: { label: "KoPub 돋움", css: "BookHeading, sans-serif", google: "" },
  notoSans: { label: "Noto Sans KR", css: "'Noto Sans KR', sans-serif", google: "Noto+Sans+KR:wght@400;700;900" },
  notoSerif: { label: "Noto Serif KR", css: "'Noto Serif KR', serif", google: "Noto+Serif+KR:wght@400;700;900" },
  blackHan: { label: "검은고딕 (Black Han Sans)", css: "'Black Han Sans', sans-serif", google: "Black+Han+Sans" },
  doHyeon: { label: "도현", css: "'Do Hyeon', sans-serif", google: "Do+Hyeon" },
  gowunBatang: { label: "고운바탕", css: "'Gowun Batang', serif", google: "Gowun+Batang:wght@400;700" },
  nanumMyeongjo: { label: "나눔명조", css: "'Nanum Myeongjo', serif", google: "Nanum+Myeongjo:wght@400;700;800" },
  nanumPen: { label: "나눔손글씨 펜", css: "'Nanum Pen Script', cursive", google: "Nanum+Pen+Script" },
} as const;
export type FontKey = keyof typeof FONTS;

export function googleFontsHref() {
  const fams = Object.values(FONTS).map((f) => f.google).filter(Boolean);
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f}`).join("&")}&display=block`;
}

/* ---------------- 펼침면 배치 ---------------- */

export type Box = { x: number; y: number; w: number; h: number };
export type CoverLayout = {
  bleed: number;
  trimW: number; // 앞표지 한 면 폭 (날개 있으면 판형 + 3mm)
  trimH: number;
  spine: number;
  flap: number; // 날개 없으면 0
  sheetW: number; // 재단 여백 포함 전체
  sheetH: number;
  /** 패널 재단 상자(재단 여백 미포함), 펼침면 왼쪽 위(재단 여백 바깥) 기준 mm */
  panels: Record<PanelId, Box>;
  /** 세로 접는 선·책등 경계 x (mm) */
  folds: number[];
};

export function coverSpine(d: Pick<CoverDesign, "pages" | "paper" | "spineOverride">) {
  return d.spineOverride != null && d.spineOverride > 0 ? Math.round(d.spineOverride * 10) / 10 : spineWidth(d.pages, d.paper);
}

export function coverLayout(d: Pick<CoverDesign, "size" | "pages" | "paper" | "spineOverride" | "flaps">): CoverLayout {
  const b = COVER_BLEED;
  const size = BOOK_SIZES[d.size] ?? BOOK_SIZES.A5;
  const spine = coverSpine(d);
  const flap = d.flaps ? FLAP_WIDTH - FOLD_EXTEND : 0;
  const W = size.width + (d.flaps ? FOLD_EXTEND : 0);
  const H = size.height;
  let x = b;
  const box = (w: number): Box => {
    const r = { x, y: b, w, h: H };
    x = Math.round((x + w) * 100) / 100;
    return r;
  };
  const panels = { backFlap: box(flap), back: box(W), spine: box(spine), front: box(W), frontFlap: box(flap) };
  const sheetW = Math.round((x + b) * 100) / 100;
  const folds = [panels.back.x, panels.spine.x, panels.front.x, panels.frontFlap.x].filter((v, i) => flap || (i !== 0 && i !== 3));
  return { bleed: b, trimW: W, trimH: H, spine, flap, sheetW, sheetH: H + 2 * b, panels, folds };
}

export function panelsOf(l: CoverLayout): PanelId[] {
  return (["backFlap", "back", "spine", "front", "frontFlap"] as PanelId[]).filter((p) => l.panels[p].w > 0);
}

/**
 * 그림이 채울 영역 (재단 여백 포함).
 * 바깥 가장자리(위·아래, 펼침면 양 끝)는 재단 여백까지 늘린다.
 */
export function regionBox(l: CoverLayout, r: Region): Box {
  const b = l.bleed;
  if (r === "full") return { x: 0, y: 0, w: l.sheetW, h: l.sheetH };
  const p = l.panels[r];
  let x0 = p.x;
  let x1 = p.x + p.w;
  const first = l.flap ? "backFlap" : "back";
  const last = l.flap ? "frontFlap" : "front";
  if (r === first) x0 -= b;
  if (r === last) x1 += b;
  return { x: x0, y: 0, w: x1 - x0, h: l.sheetH };
}

/** 그림 그리기 순서 — 날개 → 표지 → 책등 (표지의 연장 부분이 날개 위에, 책등이 경계 위에 온다) */
export const REGION_ORDER: Region[] = ["full", "backFlap", "frontFlap", "back", "front", "spine"];

/** 영역 안에 그림을 놓을 위치·크기(mm) — 편집기와 PDF가 같은 계산을 쓴다 */
export function placeImage(img: Pick<CoverImage, "widthPx" | "heightPx" | "fit" | "posX" | "posY" | "zoom">, box: Box) {
  const iw = Math.max(1, img.widthPx);
  const ih = Math.max(1, img.heightPx);
  const base = img.fit === "contain" ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
  const mmPerPx = base * Math.max(0.1, img.zoom || 1);
  const w = iw * mmPerPx;
  const h = ih * mmPerPx;
  const px = Math.min(100, Math.max(0, img.posX ?? 50)) / 100;
  const py = Math.min(100, Math.max(0, img.posY ?? 50)) / 100;
  return { x: box.x + (box.w - w) * px, y: box.y + (box.h - h) * py, w, h, dpi: Math.round(25.4 / mmPerPx) };
}

/** 300 DPI로 인쇄할 때 필요한 픽셀 */
export const pxAt300 = (mm: number) => Math.ceil((mm / 25.4) * PRINT_DPI);
/**
 * AI 그림을 저장할 해상도 — 300 DPI보다 조금 높게 둔다. 쪽수가 늘어 책등·펼침면이 몇 mm 넓어져도
 * (그림이 그만큼 더 늘어나도) 300 DPI 아래로 떨어지지 않게 (예: 펼침면 517mm → 534mm까지 300 DPI 유지)
 */
export const AI_DPI = 310;
export const pxForAi = (mm: number) => Math.ceil((mm / 25.4) * AI_DPI);

/** 요소의 펼침면 절대 위치 */
export function elAbs(l: CoverLayout, el: Pick<CoverEl, "panel" | "x" | "y">) {
  const p = l.panels[el.panel] ?? l.panels.front;
  return { x: p.x + el.x, y: p.y + el.y };
}

/** 펼침면 x 위치가 속한 패널 */
export function panelAt(l: CoverLayout, x: number): PanelId {
  const ids = panelsOf(l);
  for (const id of ids) {
    const p = l.panels[id];
    if (x < p.x + p.w) return id;
  }
  return ids[ids.length - 1];
}

/** 쪽수·날개가 바뀌어 책등 폭이 달라지면 책등 요소를 가운데 기준으로 옮긴다 */
export function reflowSpine(els: CoverEl[], oldSpine: number, newSpine: number): CoverEl[] {
  const dx = (newSpine - oldSpine) / 2;
  if (!dx) return els;
  return els.map((e) => (e.panel === "spine" ? { ...e, x: Math.round((e.x + dx) * 10) / 10 } : e));
}

/* ---------------- 기본값·정리 ---------------- */

export const DEFAULT_SYSTEM_PROMPT = `너는 전문적인 책 표지 디자이너다. 트렌디하고 매력적인 느낌으로, 서점 매대와 온라인 서점 썸네일에서 한눈에 눈에 띄는 도서 표지를 완성한다.
- 이 그림은 인쇄용 펼침 표지 한 장이다. 아래 [배치]의 영역 순서와 비율을 정확히 지킨다.
- 배경·색·그래픽이 뒷날개부터 앞날개까지 끊기지 않고 자연스럽게 이어지게 디자인한다. 영역 경계에 선·테두리·여백 띠를 그리지 않는다.
- 앞표지가 주인공이다. 강한 시각적 중심과 분명한 위계로, 제목이 가장 크고 선명하게 읽히게 한다.
- 책등에는 제목을 세로로(위에서 아래로) 쓰고, 책등 폭 안에 여유 있게 들어가게 한다.
- 뒷표지와 날개는 나중에 책 소개·추천사·저자 소개 글을 올릴 수 있게 차분하고 여백 있는 배경으로 둔다.
- 재단 여백까지 배경을 꽉 채우고, 글자와 중요한 요소는 재단선·접는 선에서 5mm 이상 안쪽에 둔다.
- 평면 인쇄용 원고로 만든다. 책 목업·입체 사진·그림자·액자·워터마크·서명·가짜 바코드를 넣지 않는다.
- 선명한 디테일과 풍부하지만 인쇄에 안전한 색으로, 고해상도 품질로 그린다.`;

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/** 쪽수 값 정리 (2~3000, 정수) — 잘못된 값이면 null */
export function cleanPages(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(3000, Math.max(2, n)) : null;
}

/** 기본 디자인 — 쪽수는 실제 조판 쪽수, 아직 모르면 목표 쪽수(없으면 200) */
export function defaultCover(project: { title?: string; subtitle?: string; author?: string; targetPages?: number } = {}, actualPages?: number | null): CoverDesign {
  const d: CoverDesign = {
    v: 1,
    size: "A5",
    paper: "ivory100",
    pages: cleanPages(actualPages) ?? Math.max(2, Math.round(project.targetPages ?? 200)),
    pagesManual: false,
    spineOverride: null,
    flaps: true,
    bgColor: "#ffffff",
    images: {},
    elements: [],
    ai: { instruction: "", withTitle: true, requestSize: "auto", prompts: {}, history: [] },
  };
  return d;
}

/** 책 정보로 제목·부제·저자명·책등 제목 글 상자를 만든다 (그림에 글자를 넣지 않았을 때) */
export function titleElements(d: Pick<CoverDesign, "size" | "pages" | "paper" | "spineOverride" | "flaps">, book: { title?: string; subtitle?: string; author?: string }): TextEl[] {
  const l = coverLayout(d);
  const t = (panel: PanelId, patch: Partial<TextEl>): TextEl => ({ ...textDefaults(), panel, ...patch, id: newId() });
  const spinePt = Math.min(12, Math.max(6, Math.round(l.spine * 1.6 * 2) / 2));
  const spineThick = spinePt * 0.3528 * 1.2;
  return [
    t("front", { x: 14, y: 40, w: l.trimW - 28, text: book.title || "책 제목", font: "notoSerif", sizePt: 30, bold: true, align: "center", lineHeight: 1.25 }),
    ...(book.subtitle ? [t("front", { x: 14, y: 80, w: l.trimW - 28, text: book.subtitle, sizePt: 12, align: "center" })] : []),
    t("front", { x: 14, y: l.trimH - 34, w: l.trimW - 28, text: book.author || "지은이", sizePt: 12, align: "center" }),
    t("spine", { x: Math.round((l.spine / 2 - spineThick / 2) * 10) / 10, y: 16, w: Math.min(130, l.trimH - 40), text: [book.title || "책 제목", book.author].filter(Boolean).join("   "), sizePt: spinePt, bold: true, vertical: true, lineHeight: 1.2 }),
  ];
}

export function textDefaults(): Omit<TextEl, "id" | "panel"> {
  return {
    kind: "text",
    x: 10,
    y: 20,
    w: 80,
    text: "",
    font: "notoSans",
    sizePt: 10,
    color: "#1c1917",
    bold: false,
    italic: false,
    align: "left",
    lineHeight: 1.6,
    letterSpacing: 0,
    vertical: false,
    bg: "",
    bgOpacity: 0.8,
    bgPad: 1.5,
    bgRadius: 0,
    shadow: false,
    strokeColor: "",
    strokeWidth: 0.3,
  };
}

/** 날개·표지에 바로 넣을 글 상자 틀 */
export const TEXT_PRESETS: { label: string; panel: PanelId; patch: Partial<TextEl> }[] = [
  { label: "제목", panel: "front", patch: { text: "책 제목", font: "notoSerif", sizePt: 28, bold: true, align: "center", lineHeight: 1.25 } },
  { label: "부제", panel: "front", patch: { text: "부제를 입력하세요", sizePt: 12, align: "center" } },
  { label: "저자명", panel: "front", patch: { text: "지은이", sizePt: 12, align: "center" } },
  { label: "책등 제목 (세로)", panel: "spine", patch: { text: "책 제목", sizePt: 10, bold: true, vertical: true, w: 120 } },
  { label: "저자 소개", panel: "frontFlap", patch: { text: "지은이 이름\n\n저자 소개와 약력을 입력하세요.", sizePt: 9, lineHeight: 1.7 } },
  { label: "책 소개", panel: "back", patch: { text: "책 내용 요약을 입력하세요.", sizePt: 10, lineHeight: 1.7 } },
  { label: "추천사", panel: "back", patch: { text: "“추천사를 입력하세요.”\n— 추천인", sizePt: 9.5, italic: true, lineHeight: 1.7 } },
  { label: "출판사의 다른 책", panel: "backFlap", patch: { text: "함께 읽으면 좋은 책\n\n· 도서명 — 한 줄 소개\n· 도서명 — 한 줄 소개", sizePt: 9, lineHeight: 1.7 } },
  { label: "가격·ISBN 자리", panel: "back", patch: { text: "값 00,000원\nISBN 000-00-000-0000-0", sizePt: 8, lineHeight: 1.5 } },
];

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const str = (v: unknown, max: number, dflt = "") => (typeof v === "string" ? v.slice(0, max) : dflt);
const color = (v: unknown, dflt: string) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : dflt);
const id = (v: unknown) => (typeof v === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v) ? v : "");
const PANELS = ["backFlap", "back", "spine", "front", "frontFlap"];
const REGIONS = ["full", ...PANELS];
/** 직접 고친 프롬프트 최대 길이 */
export const PROMPT_MAX = 12000;

function normImage(v: any): CoverImage | null {
  if (!v || !id(v.assetId)) return null;
  return {
    assetId: v.assetId,
    widthPx: num(v.widthPx, 1, 100000, 1),
    heightPx: num(v.heightPx, 1, 100000, 1),
    fit: v.fit === "contain" ? "contain" : "cover",
    posX: num(v.posX, 0, 100, 50),
    posY: num(v.posY, 0, 100, 50),
    zoom: num(v.zoom, 0.2, 5, 1),
    ...(v.spineMm != null ? { spineMm: num(v.spineMm, 0, 500, 0) } : {}),
    ...(v.ai ? { ai: true } : {}),
  };
}

function normEl(v: any): CoverEl | null {
  if (!v || !id(v.id)) return null;
  const panel = PANELS.includes(v.panel) ? (v.panel as PanelId) : "front";
  const pos = { id: v.id, panel, x: num(v.x, -600, 600, 0), y: num(v.y, -50, 400, 0) };
  if (v.kind === "image") {
    if (!id(v.assetId)) return null;
    return { ...pos, kind: "image", w: num(v.w, 2, 600, 30), h: num(v.h, 2, 400, 30), assetId: v.assetId, widthPx: num(v.widthPx, 1, 100000, 1), heightPx: num(v.heightPx, 1, 100000, 1), radius: num(v.radius, 0, 100, 0), round: Boolean(v.round) };
  }
  const d = textDefaults();
  return {
    ...d,
    ...pos,
    kind: "text",
    w: num(v.w, 2, 600, d.w),
    text: str(v.text, 5000),
    font: Object.hasOwn(FONTS, v.font) ? v.font : d.font,
    sizePt: num(v.sizePt, 4, 200, d.sizePt),
    color: color(v.color, d.color),
    bold: Boolean(v.bold),
    italic: Boolean(v.italic),
    align: ["left", "center", "right"].includes(v.align) ? v.align : "left",
    lineHeight: num(v.lineHeight, 0.8, 3, d.lineHeight),
    letterSpacing: num(v.letterSpacing, -0.2, 1, 0),
    vertical: Boolean(v.vertical),
    bg: v.bg ? color(v.bg, "") : "",
    bgOpacity: num(v.bgOpacity, 0, 1, d.bgOpacity),
    bgPad: num(v.bgPad, 0, 20, d.bgPad),
    bgRadius: num(v.bgRadius, 0, 20, d.bgRadius),
    shadow: Boolean(v.shadow),
    strokeColor: v.strokeColor ? color(v.strokeColor, "") : "",
    strokeWidth: num(v.strokeWidth, 0.05, 3, d.strokeWidth),
  };
}

/** 저장 전 검사·정리 — 알 수 없는 값은 기본값으로 */
export function normalizeCover(v: any): CoverDesign {
  const d = defaultCover();
  const images: CoverDesign["images"] = {};
  for (const r of REGIONS) {
    const img = normImage(v?.images?.[r]);
    if (img) images[r as Region] = img;
  }
  const hist = Array.isArray(v?.ai?.history) ? v.ai.history : [];
  return {
    v: 1,
    size: Object.hasOwn(BOOK_SIZES, v?.size) ? v.size : d.size,
    paper: Object.hasOwn(PAPERS, v?.paper) ? v.paper : d.paper,
    pages: Math.round(num(v?.pages, 2, 3000, d.pages)),
    pagesManual: Boolean(v?.pagesManual),
    spineOverride: v?.spineOverride == null || v.spineOverride === "" ? null : num(v.spineOverride, 1, 200, 10),
    flaps: v?.flaps === undefined ? true : Boolean(v.flaps),
    bgColor: color(v?.bgColor, "#ffffff"),
    images,
    elements: (Array.isArray(v?.elements) ? v.elements : []).slice(0, 200).map(normEl).filter(Boolean) as CoverEl[],
    ai: {
      instruction: str(v?.ai?.instruction, 4000),
      withTitle: v?.ai?.withTitle === undefined ? true : Boolean(v.ai.withTitle),
      requestSize: /^(auto|\d{3,5}x\d{3,5})$/.test(v?.ai?.requestSize ?? "") ? v.ai.requestSize : "auto",
      prompts: Object.fromEntries(REGIONS.map((r) => [r, str(v?.ai?.prompts?.[r], PROMPT_MAX)]).filter(([, t]) => t.trim())),
      history: hist
        .filter((h: any) => h && id(h.assetId) && REGIONS.includes(h.region))
        .slice(-24)
        .map((h: any) => ({ assetId: h.assetId, widthPx: num(h.widthPx, 1, 100000, 1), heightPx: num(h.heightPx, 1, 100000, 1), region: h.region, at: str(h.at, 40), ...(h.edit ? { edit: true } : {}) })),
    },
    ...(typeof v?.updatedAt === "string" ? { updatedAt: v.updatedAt } : {}),
  };
}

/**
 * 쪽수 자동 맞춤 — 직접 고친 쪽수가 아니면 실제 조판 쪽수로 바꾸고 책등 요소를 가운데 기준으로 옮긴다.
 * 직접 고친 쪽수는 그대로 둔다(편집기가 실제 쪽수와 다르다고 알리고 [적용] 버튼을 보인다).
 */
export function syncActualPages(d: CoverDesign, actualPages: number | null | undefined): CoverDesign {
  const actual = cleanPages(actualPages);
  if (!actual || d.pagesManual || d.pages === actual) return d;
  const next = { ...d, pages: actual };
  return { ...next, elements: reflowSpine(d.elements, coverLayout(d).spine, coverLayout(next).spine) };
}

/** 이 디자인이 쓰는 이미지 ID (내 프로젝트 이미지인지 확인할 때) */
export function coverAssetIds(d: CoverDesign) {
  const ids = new Set<string>();
  for (const img of Object.values(d.images)) if (img) ids.add(img.assetId);
  for (const e of d.elements) if (e.kind === "image") ids.add(e.assetId);
  for (const h of d.ai.history) ids.add(h.assetId);
  return ids;
}

/* ---------------- AI 이미지 요청 ---------------- */

/**
 * 모델에 요청할 크기 — 영역 비율에 맞춘 가장 큰 크기(긴 변 3840px, 16의 배수, 가로세로 3:1 이내, 830만 화소 이하).
 * 모델 출력은 인쇄 해상도보다 작으므로 서버가 받은 뒤 300 DPI 크기로 다시 키운다.
 */
export function requestSize(box: Pick<Box, "w" | "h">, pref = "auto") {
  if (pref !== "auto") return pref;
  const ratio = Math.min(3, Math.max(1 / 3, box.w / box.h));
  const MAX_EDGE = 3840;
  const MAX_PX = 8_294_400;
  let w = ratio >= 1 ? MAX_EDGE : MAX_EDGE * ratio;
  let h = w / ratio;
  const over = (w * h) / MAX_PX;
  if (over > 1) {
    w /= Math.sqrt(over);
    h /= Math.sqrt(over);
  }
  const r16 = (n: number) => Math.max(16, Math.floor(n / 16) * 16);
  return `${r16(w)}x${r16(h)}`;
}

export type BookInfo = { title: string; subtitle: string; author: string; topic: string; keyMessage: string; audience: string; tone: string; chapters: string[] };

const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(1)}%`;

/** AI 제작 프롬프트 — 기본 지시(디자이너 역할, 고정) + 책 정보 + 배치 + 글자 지시 + 사용자 지시 */
export function buildImagePrompt(d: CoverDesign, book: BookInfo, region: Region) {
  const l = coverLayout(d);
  const box = regionBox(l, region);
  const lines: string[] = [DEFAULT_SYSTEM_PROMPT, ""];

  lines.push("[책 정보]");
  lines.push(`- 제목: ${book.title}`);
  if (book.subtitle) lines.push(`- 부제: ${book.subtitle}`);
  if (book.author) lines.push(`- 저자: ${book.author}`);
  if (book.topic) lines.push(`- 주제: ${book.topic}`);
  if (book.keyMessage) lines.push(`- 핵심 메시지: ${book.keyMessage}`);
  if (book.audience) lines.push(`- 대상 독자: ${book.audience}`);
  if (book.tone) lines.push(`- 분위기·어조: ${book.tone}`);
  if (book.chapters.length) lines.push(`- 목차(일부): ${book.chapters.slice(0, 12).join(" / ")}`);
  lines.push("");

  lines.push("[배치]");
  if (region === "full") {
    lines.push(`- 그림 전체 = 펼친 표지 ${l.sheetW} × ${l.sheetH}mm (가장자리 ${l.bleed}mm는 재단되어 잘려 나가는 여백).`);
    lines.push("- 왼쪽 끝에서부터 가로 위치(그림 폭 기준 %):");
    for (const p of panelsOf(l)) {
      const b = l.panels[p];
      lines.push(`  · ${PANEL_LABEL[p]}: ${pct(b.x, l.sheetW)} ~ ${pct(b.x + b.w, l.sheetW)} (${b.w}mm)`);
    }
    lines.push(`- 책등은 폭 ${l.spine}mm의 좁은 세로 띠다. 앞표지는 그림의 오른쪽${l.flap ? "에서 두 번째" : ""} 영역이다.`);
  } else {
    lines.push(`- 그림 전체 = ${REGION_LABEL[region]} 한 면, ${box.w.toFixed(1)} × ${box.h}mm (가장자리 ${l.bleed}mm는 재단 여백).`);
    if (region === "spine") lines.push("- 아주 좁은 세로 띠다. 제목은 세로로 쓴다.");
  }
  lines.push("");

  lines.push("[글자]");
  if (d.ai.withTitle) {
    const t = `“${book.title}”`;
    if (region === "full" || region === "front") lines.push(`- 앞표지에 제목 ${t}${book.subtitle ? `, 부제 “${book.subtitle}”` : ""}${book.author ? `, 저자명 “${book.author}”` : ""}을 한글 철자 그대로 정확하게 쓴다.`);
    if (region === "full" || region === "spine") lines.push(`- 책등에 제목 ${t}${book.author ? `과 저자명 “${book.author}”` : ""}을 세로로 쓴다.`);
    if (region !== "full" && region !== "front" && region !== "spine") lines.push("- 이 면에는 글자를 넣지 않는다.");
    lines.push("- 그 밖의 글자(가짜 문장·로고·바코드)는 넣지 않는다.");
  } else {
    lines.push("- 그림에 글자를 전혀 넣지 않는다. 제목과 글은 나중에 따로 올린다. 제목이 들어갈 앞표지 위쪽과 책등은 글이 잘 읽히게 비워 둔다.");
  }

  if (d.ai.instruction.trim()) {
    lines.push("", "[작가 지시 — 가장 우선]", d.ai.instruction.trim());
  }
  return lines.join("\n");
}

/** 실제로 보낼 프롬프트 — 작가가 고친 글이 있으면 그것, 없으면 자동 프롬프트 */
export function effectivePrompt(d: CoverDesign, book: BookInfo, region: Region) {
  const own = d.ai.prompts?.[region]?.trim();
  return own ? own.slice(0, PROMPT_MAX) : buildImagePrompt(d, book, region);
}

/* ---------------- AI 그림 수정 ---------------- */

export type Rect = { x: number; y: number; w: number; h: number };

/** 펼침면 좌표(mm)의 사각형 → 그림 안 비율(0~1). 그림 밖이면 null */
export function maskFraction(img: Pick<CoverImage, "widthPx" | "heightPx" | "fit" | "posX" | "posY" | "zoom">, box: Box, r: Rect) {
  const at = placeImage(img, box);
  const x0 = Math.max(0, (r.x - at.x) / at.w);
  const y0 = Math.max(0, (r.y - at.y) / at.h);
  const x1 = Math.min(1, (r.x + r.w - at.x) / at.w);
  const y1 = Math.min(1, (r.y + r.h - at.y) / at.h);
  if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 수정 요청 크기 안에 원본 비율 그대로 들어갈 자리 (가운데, 남는 곳은 여백으로 채워 보낸다).
 * 받은 그림에서 이 자리만 잘라 원본 크기로 되돌린다.
 */
export function editFrame(size: string, iw: number, ih: number) {
  const m = /^(\d+)x(\d+)$/.exec(size);
  const RW = m ? Number(m[1]) : iw;
  const RH = m ? Number(m[2]) : ih;
  const a = iw / ih;
  const cw = Math.min(RW, Math.round(RH * a));
  const ch = Math.min(RH, Math.round(cw / a));
  return { RW, RH, cw, ch, ox: Math.floor((RW - cw) / 2), oy: Math.floor((RH - ch) / 2) };
}

type PxRect = { left: number; top: number; width: number; height: number };

/**
 * 부분 수정 — 원본 픽셀 기준 지정 영역(hole)과, 모델에 보낼 주변 포함 잘라 낸 부분(crop), 경계를 녹일 폭(feather).
 * 지정 부분만 크게 보내야 모델이 자세히 고치고, 받은 그림은 hole(+feather)만 원본에 다시 붙여 나머지는 한 픽셀도 바뀌지 않는다.
 */
export function editCrop(iw: number, ih: number, f: { x: number; y: number; w: number; h: number }) {
  const hole: PxRect = { left: Math.floor(f.x * iw), top: Math.floor(f.y * ih), width: Math.max(1, Math.ceil(f.w * iw)), height: Math.max(1, Math.ceil(f.h * ih)) };
  const feather = Math.max(8, Math.round(Math.min(hole.width, hole.height) * 0.06));
  const pad = Math.max(feather * 2, Math.round(Math.max(hole.width, hole.height) * 0.5)); // 주변 맥락
  const x0 = Math.max(0, hole.left - pad);
  const y0 = Math.max(0, hole.top - pad);
  const x1 = Math.min(iw, hole.left + hole.width + pad);
  const y1 = Math.min(ih, hole.top + hole.height + pad);
  return { hole, feather, crop: { left: x0, top: y0, width: x1 - x0, height: y1 - y0 } };
}

/**
 * w×h 크기의 알파(0~255): hole 안 255, 밖으로 feather 픽셀에 걸쳐 0까지 부드럽게 — 이음매(사각형 자국)가 남지 않게.
 * grow만큼 hole을 넓혀 잰다(모델에 보낼 마스크는 grow = feather로 녹이는 띠까지 포함).
 */
export function featherAlpha(w: number, h: number, hole: PxRect, feather: number, grow = 0) {
  const a = new Uint8Array(w * h);
  const l = hole.left - grow, t = hole.top - grow, r = hole.left + hole.width + grow, b = hole.top + hole.height + grow;
  for (let y = 0; y < h; y++) {
    const dy = y < t ? t - y : y >= b ? y - b + 1 : 0;
    for (let x = 0; x < w; x++) {
      const dx = x < l ? l - x : x >= r ? x - r + 1 : 0;
      const d = Math.hypot(dx, dy);
      a[y * w + x] = d <= 0 ? 255 : d >= feather ? 0 : Math.round(255 * (1 - d / feather));
    }
  }
  return a;
}

/**
 * 수정 결과(ai)의 색을 원본(orig)에 맞추는 채널별 a·x+b — AI는 고치지 않은 곳도 밝기·색감을 조금씩 바꿔 그려
 * 바뀐 곳만 붙이면 이음매가 보이고 바뀐 곳을 찾을 때도 전체가 바뀐 것처럼 보인다.
 * 두 그림 모두 같은 크기의 RGB raw. 바뀐 픽셀이 섞여도 휘지 않게 채널 차이가 작은 픽셀(중앙값 기준)로만 맞춘다.
 */
export function colorFit(orig: Uint8Array, ai: Uint8Array) {
  const n = orig.length / 3;
  const fit = (use: (i: number) => boolean) =>
    [0, 1, 2].map((c) => {
      let k = 0, so = 0, sa = 0, soo = 0, saa = 0;
      for (let i = 0; i < n; i++) {
        if (!use(i)) continue;
        const o = orig[i * 3 + c], a = ai[i * 3 + c];
        k++; so += o; sa += a; soo += o * o; saa += a * a;
      }
      if (k < 16) return { a: 1, b: 0 };
      const mo = so / k, ma = sa / k;
      const vo = Math.max(0, soo / k - mo * mo), va = Math.max(1, saa / k - ma * ma);
      const g = Math.min(1.25, Math.max(0.8, Math.sqrt(vo / va) || 1));
      return { a: g, b: Math.min(40, Math.max(-40, mo - g * ma)) };
    });
  const first = fit(() => true);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(orig[i * 3 + c] - (first[c].a * ai[i * 3 + c] + first[c].b)));
    d[i] = m;
  }
  const cut = Math.max(12, [...d].sort((x, y) => x - y)[Math.floor(n * 0.5)] * 2);
  return fit((i) => d[i] <= cut);
}

/**
 * 원본과 수정 결과(색을 맞춘 뒤)를 견줘 실제로 바뀐 곳만 1(255)인 부드러운 알파 — 둘 다 작게 줄이고 살짝 흐린 w×h RGB raw.
 * 차이가 threshold보다 큰 픽셀 → 점 잡음 걷어 내기(열기) → 바뀐 것 둘레까지 넓히기(grow) → 경계 녹이기(soft).
 * 반환 fraction: 바뀐 넓이 비율 (0이면 바뀐 곳이 없다, 크면 그림 전체를 바꾼 요청).
 */
export function changeAlpha(orig: Uint8Array, ai: Uint8Array, w: number, h: number, fitc = colorFit(orig, ai), opts: { threshold?: number; grow?: number; soft?: number } = {}) {
  const T = opts.threshold ?? 26;
  const grow = opts.grow ?? Math.max(2, Math.round(Math.max(w, h) / 120));
  const soft = opts.soft ?? Math.max(2, Math.round(Math.max(w, h) / 160));
  let m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(orig[i * 3 + c] - (fitc[c].a * ai[i * 3 + c] + fitc[c].b)));
    m[i] = d > T ? 1 : 0;
  }
  // 정사각형 이웃(r)으로 줄이기·넓히기
  const morph = (src: Uint8Array, r: number, dilate: boolean) => {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (dilate ? src[y * w + k] : !src[y * w + k]) { v = dilate ? 1 : 0; break; }
        tmp[y * w + x] = v;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (dilate ? tmp[k * w + x] : !tmp[k * w + x]) { v = dilate ? 1 : 0; break; }
        out[y * w + x] = v;
      }
    return out;
  };
  m = morph(morph(m, 1, false), 1, true); // 열기: 흩어진 점(재생성 잡음)은 버린다
  let changed = 0;
  for (const v of m) changed += v;
  m = morph(m, grow, true);
  // 상자 흐림 두 번(가로·세로)으로 경계를 녹인다 — ×2로 넓힌 곳 안쪽은 255, 바깥으로 0까지
  const box = (src: Float32Array, len: number, stride: number, lines: number, step: number) => {
    const out = new Float32Array(src.length);
    for (let l = 0; l < lines; l++) {
      const base = l * step;
      for (let i = 0; i < len; i++) {
        let s = 0, k = 0;
        for (let j = Math.max(0, i - soft); j <= Math.min(len - 1, i + soft); j++) { s += src[base + j * stride]; k++; }
        out[base + i * stride] = s / k;
      }
    }
    return out;
  };
  let a = Float32Array.from(m, (v) => v * 255);
  for (let pass = 0; pass < 2; pass++) a = box(box(a, w, 1, h, w), h, w, w, 1);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = Math.min(255, Math.round(a[i] * 2));
  return { alpha, fraction: changed / (w * h) };
}

/** 수정 프롬프트 — 바꿀 것만 바꾸고 나머지(구도·색·글자·영역 배치)는 그대로 두게 한다 */
export function buildEditPrompt(d: CoverDesign, region: Region, request: string, masked: boolean) {
  const l = coverLayout(d);
  const lines = ["너는 전문적인 책 표지 디자이너이자 리터칭 전문가다. 주어진 그림을 아래 [수정 요청]대로만 고친다."];
  if (masked) {
    lines.push(
      "- 입력 그림은 표지 그림의 일부를 잘라 낸 것이다. 마스크의 투명한 부분이 '수정 영역'이다.",
      "- 수정 영역 안만 다시 그린다. 수정 영역 밖은 원본 그대로 둔다.",
      "- 수정 영역 안에서도 요청과 관계없는 배경·색감·질감·조명·원근은 바로 옆 원본과 똑같이 이어서 그린다.",
      "- 요청이 '지우기·없애기'가 아니면 수정 영역을 비우거나 단색·흐림·회색으로 채우지 않는다. 원래 있던 것을 요청대로 바꾼 모습으로 채운다.",
      "- 수정 영역의 경계가 보이면 안 된다. 사각형 테두리·선·틀·선택 표시·박스·그림자 띠를 절대 그리지 않는다.",
      "- 그림체(일러스트·사진 등)와 해상도·선명도를 주변과 같게 맞춘다.",
    );
  } else {
    lines.push(
      "- 요청하지 않은 부분(전체 구도, 색감, 그림체, 인물·사물, 글자, 여백)은 원본 그대로 유지한다.",
      "- 그림의 크기·비율·영역 배치를 바꾸지 않는다. 테두리·액자·목업을 더하지 않는다.",
      "- 바꾼 부분이 주변과 자연스럽게 이어지게 한다.",
    );
  }
  lines.push("- 글자를 넣거나 고치라는 요청이면 한글 철자를 그대로 정확하게 쓴다. 요청하지 않은 글자는 더하지 않는다.");
  if (masked) {
    lines.push("", `[위치] 이 부분은 ${REGION_LABEL[region]}에 있다.`);
  } else if (region === "full") {
    lines.push("", "[배치 — 그대로 유지]", `- 펼친 표지 ${l.sheetW} × ${l.sheetH}mm, 왼쪽부터:`);
    for (const p of panelsOf(l)) lines.push(`  · ${PANEL_LABEL[p]}: ${pct(l.panels[p].x, l.sheetW)} ~ ${pct(l.panels[p].x + l.panels[p].w, l.sheetW)}`);
    lines.push("- 책등의 세로 제목은 책등 띠 안에 둔다.");
  } else {
    lines.push("", `[배치] 이 그림은 ${REGION_LABEL[region]} 한 면이다.`);
  }
  lines.push("", "[수정 요청]", request.trim());
  return lines.join("\n");
}

/* ---------------- ISBN 바코드 자리 ---------------- */

/**
 * ISBN 바코드 자리(안내용 추정값) — 부크크가 뒷표지 아래쪽에 바코드를 넣는다.
 * 여기 값은 편집기 안내선과 겹침 경고에만 쓰며, 정확한 위치·크기는 부크크 표지 가이드(바코드 영역)로 확인한다.
 *   widthMm × heightMm: 바코드 상자 크기 · fromSpineMm: 책등 쪽 재단선에서 · fromBottomMm: 아래 재단선에서
 */
export const BARCODE_GUIDE = { panel: "back" as const, widthMm: 40, heightMm: 25, fromSpineMm: 10, fromBottomMm: 10 };
export const BARCODE_NOTE = "바코드는 인쇄소(출판 플랫폼)가 넣습니다. 이 상자는 예상 자리이며, 정확한 위치는 표지 가이드로 확인하세요.";

/** 바코드 자리 — 뒷표지 패널 기준(x: 뒷표지 왼쪽 재단선, y: 위 재단선) mm */
export function barcodeRect(l: Pick<CoverLayout, "panels">): Box {
  const p = l.panels.back;
  const g = BARCODE_GUIDE;
  return { x: Math.round((p.w - g.fromSpineMm - g.widthMm) * 100) / 100, y: Math.round((p.h - g.fromBottomMm - g.heightMm) * 100) / 100, w: g.widthMm, h: g.heightMm };
}

/* ---------------- 인쇄 점검 ---------------- */

export type CoverIssue = { level: "error" | "warn"; message: string };

/** 글자 한 자의 대략 폭 (em) — 한글·한자·전각은 1, 라틴 소문자·숫자 0.55, 대문자 0.68, 공백 0.3 */
function charEm(ch: string) {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x20) return 0.3;
  if (c >= 0x1100 && (c <= 0x11ff || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60))) return 1;
  if (c >= 0x2018 && c <= 0x201f) return 0.35;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[.,:;'!|il]/.test(ch)) return 0.3;
  return 0.55;
}

/**
 * 글이 실제로 차지하는 자리 (요소 기준 mm) — 상자 폭 전체가 아니라 정렬에 따라 글자가 놓이는 곳.
 * 가운데 맞춤한 짧은 글을 상자 폭이 넘게 옮겨도 글자가 안전 영역 안이면 문제 삼지 않도록.
 * 줄바꿈(keep-all)은 단어 단위로 어림한다. 편집기는 화면에서 잰 값(measured)을 대신 쓴다.
 */
export function textInkBox(el: TextEl): Box {
  const sizeMm = el.sizePt * 0.3528;
  const lineMm = sizeMm * el.lineHeight;
  const spacing = el.letterSpacing * sizeMm;
  // 세로쓰기(upright)는 영문·숫자도 한 자가 한 칸(1em)을 차지한다
  const widthOf = (s: string) => [...s].reduce((a, ch) => a + (el.vertical && ch !== " " ? 1 : charEm(ch)) * sizeMm + spacing, 0);
  const avail = el.w; // 가로쓰기면 상자 폭, 세로쓰기면 상자 높이(한 줄의 길이)
  const lines: number[] = [];
  for (const para of el.text.split("\n")) {
    let cur = 0;
    for (const word of para.split(/(?<= )/)) {
      const ww = widthOf(word);
      if (cur > 0 && cur + ww > avail + 0.01) {
        lines.push(Math.min(cur, avail));
        cur = widthOf(word.trimStart());
      } else cur += ww;
    }
    lines.push(Math.min(widthOf(para.trimEnd()) === 0 ? 0 : cur, avail));
  }
  const long = Math.max(0, ...lines);
  const across = Math.max(1, lines.length) * lineMm;
  if (el.vertical) {
    // 세로쓰기: 글줄은 위에서 아래로, 줄은 오른쪽에서 왼쪽으로 쌓인다(상자 왼쪽 위 기준으로 그린다)
    return { x: 0, y: 0, w: across, h: long };
  }
  const offset = el.align === "center" ? (avail - long) / 2 : el.align === "right" ? avail - long : 0;
  return { x: Math.max(0, offset), y: 0, w: long, h: across };
}

/**
 * actualPages: 책의 실제 조판 쪽수(편집기 측정·본문 PDF). 모르면 null
 * measured: 편집기가 화면에서 잰 글의 실제 자리(요소 기준 mm) — 없으면 textInkBox로 어림한다
 */
export function coverIssues(d: CoverDesign, opts: { actualPages?: number | null; measured?: Record<string, Box> } = {}): CoverIssue[] {
  const l = coverLayout(d);
  const out: CoverIssue[] = [];
  const actual = cleanPages(opts.actualPages);
  if (actual && actual !== d.pages) {
    out.push({ level: "warn", message: `쪽수가 ${d.pages}쪽으로, 책의 실제 조판 쪽수(${actual}쪽)와 다릅니다. 책등 폭(${spineWidth(d.pages, d.paper)}mm → 실제 ${spineWidth(actual, d.paper)}mm)을 확인하세요.` });
  } else if (!actual && opts.actualPages !== undefined && !d.pagesManual) {
    out.push({ level: "warn", message: `책의 실제 쪽수를 아직 재지 않아 ${d.pages}쪽으로 책등을 계산했습니다. 집필 화면에서 조판이 끝나거나 본문 PDF를 만들면 실제 쪽수로 맞춥니다.` });
  }
  const hasFull = Boolean(d.images.full);
  for (const p of panelsOf(l)) {
    if (!hasFull && !d.images[p] && d.bgColor.toLowerCase() === "#ffffff") {
      out.push({ level: "warn", message: `${PANEL_LABEL[p]}에 그림·배경색이 없습니다 (흰 종이로 인쇄).` });
    }
  }
  for (const r of REGION_ORDER) {
    const img = d.images[r];
    if (!img) continue;
    const at = placeImage(img, regionBox(l, r));
    if (at.dpi < PRINT_DPI) out.push({ level: at.dpi < 150 ? "error" : "warn", message: `${REGION_LABEL[r]} 그림 해상도가 ${at.dpi} DPI입니다 (인쇄 권장 ${PRINT_DPI} DPI 이상).` });
    if (img.fit === "contain") out.push({ level: "warn", message: `${REGION_LABEL[r]} 그림이 ‘전체 보이기’라 재단 여백까지 채우지 못할 수 있습니다.` });
    if (img.ai && img.spineMm != null && r === "full" && Math.abs(img.spineMm - l.spine) > 0.5) {
      out.push({ level: "warn", message: `AI 그림을 만든 뒤 책등 폭이 ${img.spineMm}mm → ${l.spine}mm로 바뀌었습니다. 책등 위치가 어긋날 수 있으니 다시 만드세요.` });
    }
  }
  for (const e of d.elements) {
    const p = l.panels[e.panel];
    if (!p || p.w <= 0) {
      out.push({ level: "error", message: `${PANEL_LABEL[e.panel]}이 없는데 그 위에 요소가 있습니다 (날개 설정 확인).` });
      continue;
    }
    const label = e.kind === "text" ? `‘${e.text.split("\n")[0].slice(0, 12) || "빈 글"}’` : "사진";
    // 겹침·안전 영역은 글자가 실제로 놓인 자리로 본다 (빈 글 상자는 인쇄되지 않으므로 건너뛴다)
    const ink: Box | null = e.kind === "text" ? (e.text.trim() ? (opts.measured?.[e.id] ?? textInkBox(e)) : null) : { x: 0, y: 0, w: e.w, h: e.h };
    const x = e.x + (ink?.x ?? 0);
    const y = e.y + (ink?.y ?? 0);
    const w = ink?.w ?? 0;
    const h = ink?.h ?? 0;
    const inset = e.panel === "spine" ? 0.5 : SAFE_INSET;
    const TOL = 0.2; // 반올림·글꼴 차이
    if (ink) {
      const sides = [x < inset - TOL && "왼쪽", x + w > p.w - inset + TOL && "오른쪽", y < SAFE_INSET - TOL && "위", y + h > p.h - SAFE_INSET + TOL && "아래"].filter(Boolean);
      if (sides.length) out.push({ level: "warn", message: `${PANEL_LABEL[e.panel]}의 ${label}이 안전 영역(재단선·접는 선에서 ${e.panel === "spine" ? `좌우 ${inset}mm·위아래 ${SAFE_INSET}mm` : `${inset}mm`}) ${sides.join("·")}으로 나갑니다.` });
    }
    if (e.kind === "text" && e.text.trim() && e.sizePt < 6) out.push({ level: "warn", message: `${label} 글자가 너무 작습니다 (${e.sizePt}pt, 6pt 이상 권장).` });
    if (e.panel === BARCODE_GUIDE.panel && (e.kind === "image" || e.text.trim())) {
      const b = barcodeRect(l);
      if (ink && x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) {
        out.push({ level: "warn", message: `뒷표지의 ${label}이 ISBN 바코드 자리(아래쪽 ${BARCODE_GUIDE.widthMm}×${BARCODE_GUIDE.heightMm}mm)와 겹칩니다. 바코드가 가릴 수 있으니 옮기세요(정확한 자리는 인쇄소 표지 가이드 확인).` });
      }
    }
    if (e.kind === "image") {
      const dpi = Math.round(e.widthPx / (e.w / 25.4));
      if (dpi < PRINT_DPI) out.push({ level: dpi < 150 ? "error" : "warn", message: `${PANEL_LABEL[e.panel]} 사진 해상도가 ${dpi} DPI입니다 (권장 ${PRINT_DPI} DPI).` });
    }
  }
  if (l.spine < 5 && d.elements.some((e) => e.panel === "spine" && e.kind === "text" && e.text.trim())) {
    out.push({ level: "warn", message: `책등이 ${l.spine}mm로 얇아 글자가 접힘 선에 걸릴 수 있습니다.` });
  }
  return out;
}
