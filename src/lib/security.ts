/**
 * 요청 출처 검사 — 모든 페이지·API에 적용된다.
 * - 로컬 모드(APP_ACCESS_MODE≠web): 이 컴퓨터(localhost)에서 온 요청만 허용
 * - 웹 모드: 로그인 확인은 proxy.ts(Supabase 세션)가 맡고, 여기서는 다른 사이트에서 보낸 변경 요청(CSRF)을 막는다
 */
export const webMode = () => process.env.APP_ACCESS_MODE === "web";

export function checkAccess(req: Request): Response | null {
  const url = new URL(req.url);
  const host = (req.headers.get("host") ?? url.host).toLowerCase();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  if (!webMode() && !local) return Response.json({ error: "외부 접근이 비활성화되어 있습니다." }, { status: 403 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const trusted = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : `${url.protocol}//${host}`;
    const proto = req.headers.get("x-forwarded-proto");
    const sameHost = origin ? new URL(origin).host === host && (!proto || new URL(origin).protocol === `${proto}:`) : true;
    if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== trusted && !sameHost)) {
      return Response.json({ error: "다른 사이트에서 보낸 변경 요청은 허용하지 않습니다." }, { status: 403 });
    }
  }
  return null;
}

/* ---------------- AI 연결 설정 검사 ---------------- */

/** 키 이름: …_API_KEY 형식만, 앱 비밀(DB·Supabase·렌더 서명 등) 이름은 거부 — 다른 환경변수가 AI 서버로 새지 않게 */
const KEY_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$|^LLM_API_KEY$/;
const KEY_DENY = [/^SUPABASE_/, /^NEXT_PUBLIC_/, /^DATABASE_/, /^DIRECT_/, /^RENDER_/, /^POSTGRES/, /^VERCEL/, /^AWS_/, /SECRET/, /SERVICE/, /PASSWORD/, /TOKEN/];

export function aiKeyNameError(name: string): string | null {
  if (!KEY_NAME.test(name)) return "호출 이름은 영문 대문자·숫자·밑줄로 쓰고 _API_KEY로 끝나야 합니다 (예: GEMINI_API_KEY).";
  if (KEY_DENY.some((p) => p.test(name))) return "앱 비밀 값에 쓰는 환경변수 이름은 AI 키로 쓸 수 없습니다.";
  return null;
}

/** 사설·루프백·링크 로컬·메타데이터 등 내부망 IP 리터럴인지 (IPv4, IPv6, IPv4-mapped IPv6) */
export function privateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!h.includes(":")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return privateIp(mapped[1]);
  // WHATWG URL은 ::ffff:a.b.c.d를 ::ffff:xxxx:xxxx(16진)로 바꾼다
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return privateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return h === "::" || h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h) || /^ff/.test(h);
}

const LOCAL_NAMES = /^(localhost|.*\.localhost|metadata|metadata\.google\.internal|.*\.internal|.*\.local|.*\.localdomain|instance-data)$/;

/**
 * AI 기본 주소 검사 (서버가 대신 요청을 보내는 주소라 내부망 접근을 막는다)
 * - 웹 모드: https만, localhost·내부 IP·메타데이터 주소 거부. AI_ALLOWED_HOSTS(쉼표 목록)가 있으면 그 호스트(하위 도메인 포함)만
 * - 로컬 모드: https, 또는 이 컴퓨터(localhost)의 http
 * DNS로 내부 주소를 가리키는 이름까지는 막지 못하므로, 웹 배포에는 AI_ALLOWED_HOSTS를 권장한다.
 */
export function aiBaseUrlError(raw: string, opts: { web?: boolean; allowedHosts?: string } = {}): string | null {
  const web = opts.web ?? webMode();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "기본 주소(Base URL) 형식이 올바르지 않습니다.";
  }
  if (u.username || u.password) return "기본 주소에 아이디·비밀번호를 넣을 수 없습니다.";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !web && loopback)) {
    return web ? "기본 주소는 https://로 시작해야 합니다." : "기본 주소는 https://로 시작해야 합니다 (http는 이 컴퓨터 주소만 허용).";
  }
  if (web) {
    if (LOCAL_NAMES.test(host) || privateIp(host) || /^\d+$/.test(host)) return "내부망·로컬 주소는 AI 기본 주소로 쓸 수 없습니다.";
    const allow = (opts.allowedHosts ?? process.env.AI_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.some((a) => host === a || host.endsWith("." + a))) return `허용되지 않은 AI 서버 주소입니다 (허용 목록: ${allow.join(", ")}).`;
  }
  return null;
}
