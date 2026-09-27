import "server-only";

/**
 * 전문 이미지 검색 — Wikimedia Commons (키 없이 쓰는 공개 API).
 * 논문 도표(PMC 오픈 액세스 논문에서 옮겨 온 그림), 그래프, 도식, 지도, 사진이 자유 이용 허락(CC·퍼블릭 도메인)과 함께 올라 있다.
 * 결과에는 저작자·라이선스를 함께 담아 캡션의 출처 표기에 쓴다.
 * 가져오기(내려받기)는 Wikimedia 파일 서버(upload·thumb.wikimedia.org) 주소만 허용한다 — 사용자가 넘긴 임의 주소를 서버가 열지 않게.
 */

const API = "https://commons.wikimedia.org/w/api.php";
/** Wikimedia 정책: 연락처가 든 User-Agent를 보낸다 */
export const COMMONS_UA = "withbook/1.0 (https://withbook.vercel.app; book-writing assistant)";
const OK_MIME = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/tiff"]);
/** 인쇄용으로 받을 폭 — A5 본문 폭(약 110mm) 300 DPI ≈ 1,300px */
const PRINT_WIDTH = 1600;

export type CommonsImage = {
  title: string;
  /** 화면 미리보기(작은 썸네일) */
  thumb: string;
  /** 넣을 때 내려받을 주소 (SVG·TIFF·큰 그림은 PNG/JPEG 썸네일) */
  src: string;
  width: number;
  height: number;
  mime: string;
  description: string;
  artist: string;
  license: string;
  licenseUrl: string;
  pageUrl: string;
};

/** Commons 설명의 HTML을 글로 */
export function stripHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** 추적용 쿼리(utm_…)를 뺀 파일 주소 */
export function cleanFileUrl(url: string) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** 썸네일 주소의 폭만 바꾼다 (…/thumb/…/1920px-이름.png → 330px-, Wikimedia 표준 썸네일 폭). 썸네일이 아니면 그대로 */
export function resizeThumb(url: string, width: number) {
  return /\/thumb\//.test(url) ? url.replace(/\/(\d+)px-([^/?]+)(\?.*)?$/, `/${width}px-$2`) : url;
}

const FILE_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);

/** 가져오기에 허용하는 주소 — https://upload.wikimedia.org/ · https://thumb.wikimedia.org/ 만 */
export function commonsDownloadAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && FILE_HOSTS.has(u.hostname) && !u.username && !u.password && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}

type Page = {
  title: string;
  index?: number;
  imageinfo?: {
    url: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width: number;
    height: number;
    mime: string;
    descriptionurl: string;
    extmetadata?: Record<string, { value?: unknown }>;
  }[];
};

export function parseCommons(json: any): CommonsImage[] {
  const pages: Page[] = json?.query?.pages ?? [];
  return [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p) => {
      const ii = p.imageinfo?.[0];
      if (!ii || !OK_MIME.has(ii.mime)) return [];
      if (ii.width < 300 || ii.height < 150) return []; // 아이콘·작은 기호는 인쇄에 못 쓴다
      const m = ii.extmetadata ?? {};
      // 벡터·TIFF·큰 그림은 썸네일(PNG/JPEG), 작은 비트맵은 원본
      const needThumb = ii.mime === "image/svg+xml" || ii.mime === "image/tiff" || ii.width > PRINT_WIDTH;
      const src = cleanFileUrl(needThumb && ii.thumburl ? ii.thumburl : ii.url);
      if (!commonsDownloadAllowed(src)) return [];
      const thumbBase = cleanFileUrl(ii.thumburl ?? ii.url);
      // 받을 그림의 크기(어림) — 실제 픽셀은 가져올 때 다시 잰다
      const w = needThumb && ii.thumbwidth ? ii.thumbwidth : ii.width;
      const h = needThumb && ii.thumbheight ? ii.thumbheight : ii.height;
      return [
        {
          title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
          thumb: resizeThumb(thumbBase, 330),
          src,
          width: w,
          height: h,
          mime: ii.mime,
          description: stripHtml(m.ImageDescription?.value ?? m.ObjectName?.value).slice(0, 300),
          artist: stripHtml(m.Artist?.value).slice(0, 120),
          license: stripHtml(m.LicenseShortName?.value ?? m.UsageTerms?.value).slice(0, 60),
          licenseUrl: stripHtml(m.LicenseUrl?.value).slice(0, 300),
          pageUrl: ii.descriptionurl,
        },
      ];
    });
}

/** 검색어 하나로 Commons 파일(이미지) 검색 */
export async function searchCommons(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<CommonsImage[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q) return [];
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `${q} -filetype:video -filetype:audio -filetype:multimedia -filetype:office`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(20, opts.limit ?? 10)),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(PRINT_WIDTH),
    iiextmetadatafilter: "ImageDescription|ObjectName|Artist|LicenseShortName|LicenseUrl|UsageTerms",
    iiextmetadatalanguage: "ko",
    uselang: "ko",
  });
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": COMMONS_UA, Accept: "application/json" }, signal });
  if (!res.ok) throw Object.assign(new Error(`이미지 검색 서버 응답 ${res.status}`), { status: 502 });
  return parseCommons(await res.json());
}

/** 추천 이미지 내려받기 — 허용 주소만, 20MB까지, 이미지 형식만 */
export async function downloadCommons(url: string, maxBytes: number): Promise<Buffer> {
  if (!commonsDownloadAllowed(url)) throw Object.assign(new Error("가져올 수 없는 이미지 주소입니다."), { status: 400 });
  const res = await fetch(url, { headers: { "User-Agent": COMMONS_UA }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw Object.assign(new Error(`이미지를 내려받지 못했습니다 (응답 ${res.status}).`), { status: 502 });
  const type = res.headers.get("content-type") ?? "";
  if (!/^image\/(png|jpeg|webp)/.test(type)) throw Object.assign(new Error("PNG·JPEG 이미지가 아니라 넣지 못했습니다."), { status: 400 });
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw Object.assign(new Error("이미지가 너무 큽니다(20MB 초과)."), { status: 413 });
  const reader = res.body?.getReader();
  if (!reader) throw Object.assign(new Error("이미지를 내려받지 못했습니다."), { status: 502 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("이미지가 너무 큽니다(20MB 초과)."), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 캡션 끝에 붙이는 출처 — 자유 이용 허락 조건(저작자·라이선스 표시) */
export function creditLine(img: Pick<CommonsImage, "artist" | "license">) {
  const parts = [img.artist && img.artist.length <= 60 ? img.artist : "", img.license, "Wikimedia Commons"].filter(Boolean);
  return `출처: ${parts.join(", ")}`;
}
