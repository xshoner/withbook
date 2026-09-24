import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium", "@prisma/client", "unpdf", "mammoth"],
  devIndicators: false,
  poweredByHeader: false,
  // 로그아웃 버튼 등 화면에서 웹/로컬 모드를 알 수 있게
  env: { NEXT_PUBLIC_APP_ACCESS_MODE: process.env.APP_ACCESS_MODE ?? "local" },
  outputFileTracingIncludes: {
    "/*": ["./prompts/**/*.md", "./instruction.md"],
    "/pagedjs": ["./node_modules/pagedjs/dist/paged.polyfill.js"],
    // Vercel에서 PDF를 만드는 서버용 Chromium
    // playwright-core는 browsers.json 등을 실행 중에 읽으므로 패키지 전체를 넣는다
    "/api/projects/[id]/export/pdf": ["./node_modules/@sparticuz/chromium/bin/**", "./node_modules/playwright-core/**"],
  },
  outputFileTracingExcludes: { "/*": ["./data/**/*", "./style reference/**/*", "./.env*", "./test-results/**/*", "./public/fonts/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    ] }];
  },
};

export default nextConfig;
