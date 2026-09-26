import "server-only";
import fs from "node:fs";
import { BLEED, DOC, SIZE_TOLERANCE_MM, TRIM } from "../print/spec";
import { RENDER_HEADER, makeRenderToken } from "../render-token";

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function browserPath() {
  const env = process.env.PDF_BROWSER_PATH?.trim();
  if (env && fs.existsSync(env)) return env;
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error("PDF를 만들 Chromium 계열 브라우저(Edge/Chrome)를 찾지 못했습니다. .env의 PDF_BROWSER_PATH를 지정하세요.");
  return found;
}

export type PdfResult = { pdf: Buffer; info: any; check: PdfCheck };
export type PdfCheck = { pages: number; widthMm: number; heightMm: number; sizeOk: boolean; fontsEmbedded: string[]; kopubEmbedded: boolean };

/** 책 HTML을 Chromium으로 열어 Paged.js 조판이 끝나면 PDF로 인쇄 */
/** Vercel(서버리스)은 @sparticuz/chromium, 로컬은 설치된 Edge/Chrome */
async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    return chromium.launch({ executablePath: await sparticuz.executablePath(), args: sparticuz.args, headless: true });
  }
  return chromium.launch({ executablePath: browserPath(), headless: true });
}

/**
 * 시간 예산 (Vercel maxDuration 300초 안): 브라우저 실행부터 조판 완료까지 합쳐 최대 250초,
 * 그중 페이지 열기(goto)는 최대 60초. 남은 시간은 PDF 인쇄·후처리·업로드 몫이다.
 */
export const PDF_BUDGET_MS = 250_000;
const GOTO_MAX_MS = 60_000;
const MIN_LAYOUT_MS = 10_000;

export class PdfTimeoutError extends Error {
  readonly expose = true;
  readonly httpStatus = 504;
  constructor(stage: "open" | "layout") {
    super(
      stage === "open"
        ? "조판 페이지를 제한 시간 안에 열지 못했습니다. 잠시 후 다시 시도하세요."
        : "조판이 제한 시간(약 4분) 안에 끝나지 않았습니다. 장·절 단위로 나눠 출력하거나 이미지 수를 줄인 뒤 다시 시도하세요.",
    );
    this.name = "PdfTimeoutError";
  }
}

const isTimeout = (e: any) => e?.name === "TimeoutError" || /Timeout .*exceeded/i.test(String(e?.message ?? ""));

/** 책 본문이 아닌 용지(표지 펼침면 등): 재단 여백 포함 크기와 재단 여백 */
export type PdfSheet = { widthMm: number; heightMm: number; bleedMm: number };

export async function renderPdf(url: string, opts: { projectId?: string; budgetMs?: number; sheet?: PdfSheet; extraOrigins?: string[] } = {}): Promise<PdfResult> {
  const deadline = Date.now() + (opts.budgetMs ?? PDF_BUDGET_MS);
  const browser = await launchBrowser();
  try {
    const origin = new URL(url).origin;
    // 글꼴은 Supabase Storage 공개 주소로 넘어가므로 그 출처도 허용한다
    const fontOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : "";
    const page = await browser.newPage();
    const token = makeRenderToken(5 * 60_000, opts.projectId ?? "");
    await page.route("**/*", (route) => {
      const req = route.request();
      const target = new URL(req.url());
      // 내부 토큰은 우리 서버로 가는 요청에만 붙인다
      if (target.origin === origin) return route.continue({ headers: { ...req.headers(), [RENDER_HEADER]: token } });
      // 저장소에서는 공개 글꼴과, 이미지 주소가 보내 주는 서명된 원고 이미지만 받는다
      const storagePath = target.pathname.startsWith("/storage/v1/object/public/fonts/") || target.pathname.startsWith("/storage/v1/object/sign/assets/");
      const ok = target.protocol === "data:" || (fontOrigin && target.origin === fontOrigin && storagePath) || opts.extraOrigins?.includes(target.origin);
      return ok ? route.continue() : route.abort();
    });
    const left = () => deadline - Date.now();
    try {
      await page.goto(url, { waitUntil: "load", timeout: Math.max(1_000, Math.min(GOTO_MAX_MS, left() - MIN_LAYOUT_MS)) });
    } catch (e) {
      throw isTimeout(e) ? new PdfTimeoutError("open") : e;
    }
    try {
      await page.waitForFunction("window.__PAGED_DONE === true", null, { timeout: Math.max(MIN_LAYOUT_MS, left()), polling: 250 });
    } catch (e) {
      throw isTimeout(e) ? new PdfTimeoutError("layout") : e;
    }
    const info = await page.evaluate("window.__PAGED_INFO");
    const err = await page.evaluate("window.__PAGED_ERROR");
    if (err) throw new Error("조판 오류: " + err);
    const trim = url.includes("size=trim");
    const sheet: PdfSheet = opts.sheet ?? (trim ? { widthMm: TRIM.width, heightMm: TRIM.height, bleedMm: 0 } : { widthMm: DOC.width, heightMm: DOC.height, bleedMm: BLEED });
    const raw = await page.pdf({
      width: `${sheet.widthMm}mm`,
      height: `${sheet.heightMm}mm`,
      preferCSSPageSize: false,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    const pdf = await fixBoxes(raw, sheet);
    return { pdf, info, check: await checkPdf(pdf, trim, opts.sheet) };
  } finally {
    await browser.close();
  }
}

/**
 * Chromium은 용지 크기를 정수 pt로 올림(+0.2mm)하므로, 왼쪽 위 기준으로 MediaBox를 정확한 mm로 맞추고
 * 인쇄용 TrimBox(재단선)·BleedBox(재단 여백)를 넣는다.
 */
async function fixBoxes(raw: Uint8Array, sheet: PdfSheet): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(raw);
  const mm = 72 / 25.4;
  const W = sheet.widthMm * mm;
  const H = sheet.heightMm * mm;
  const b = sheet.bleedMm * mm;
  doc.setProducer("BookK Writer");
  doc.setCreator("BookK Writer (Paged.js + Chromium)");
  for (const page of doc.getPages()) {
    const { height } = page.getMediaBox();
    const y0 = height - H; // 위쪽 정렬 유지, 아래 여분 제거
    page.setMediaBox(0, y0, W, H);
    page.setCropBox(0, y0, W, H);
    page.setBleedBox(0, y0, W, H);
    page.setTrimBox(b, y0 + b, W - 2 * b, H - 2 * b);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** 출력된 PDF의 판형·쪽수·글꼴 임베딩 확인 */
export async function checkPdf(pdf: Buffer, trim: boolean, sheet?: PdfSheet): Promise<PdfCheck> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const p1 = await doc.getPage(1);
  const [x0, y0, x1, y1] = p1.view;
  const ptToMm = 25.4 / 72;
  const widthMm = +((x1 - x0) * ptToMm).toFixed(2);
  const heightMm = +((y1 - y0) * ptToMm).toFixed(2);
  const target = sheet ? { width: sheet.widthMm, height: sheet.heightMm } : trim ? TRIM : DOC;
  const sizeOk = Math.abs(widthMm - target.width) < SIZE_TOLERANCE_MM && Math.abs(heightMm - target.height) < SIZE_TOLERANCE_MM;
  const latin = pdf.toString("latin1");
  const names = new Set<string>();
  for (const m of latin.matchAll(/\/FontName\s*\/([A-Za-z0-9+\-_#]+)/g)) names.add(m[1].replace(/#20/g, " "));
  const fontsEmbedded = [...names];
  const kopubEmbedded = fontsEmbedded.some((n) => /KoPub/i.test(n)) && /\/FontFile[23]?/.test(latin);
  return { pages: doc.numPages, widthMm, heightMm, sizeOk, fontsEmbedded, kopubEmbedded };
}
