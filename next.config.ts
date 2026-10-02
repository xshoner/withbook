import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium", "@prisma/client", "unpdf", "mammoth"],
  devIndicators: false,
  poweredByHeader: false,
  // 로그아웃 버튼 등 화면에서 웹/로컬 모드를 알 수 있게
  env: { NEXT_PUBLIC_APP_ACCESS_MODE: process.env.APP_ACCESS_MODE ?? "local" },
  outputFileTracingIncludes: {
    "/**": ["./prompts/**/*.md", "./instruction.md"],
    "/pagedjs": ["./node_modules/pagedjs/dist/paged.polyfill.min.js"],
    // Vercel에서 PDF를 만드는 서버용 Chromium
    // playwright-core는 browsers.json 등을 실행 중에 읽으므로 패키지 전체를 넣는다
    "/api/projects/*/export/pdf": ["./node_modules/@sparticuz/chromium/bin/**", "./node_modules/playwright-core/**"],
    // 표지 인쇄용 PDF도 같은 Chromium으로 만든다
    "/api/projects/*/cover/export": ["./node_modules/@sparticuz/chromium/bin/**", "./node_modules/playwright-core/**"],
  },
  outputFileTracingExcludes: {
    "/**": [
      "./data/**/*",
      "./style reference/**/*",
      "./.env*",
      "./test-results/**/*",
      "./public/fonts/**/*",
      // 배포마다 함수 크기를 줄인다(배포 파일이 쌓여 용량이 커지던 문제) — Prisma는 runtime/library.js와 OS별 엔진(.so.node)만 쓴다.
      // 다른 DB·엣지용 wasm 런타임과 소스맵, 네이티브 sharp가 있으면 안 쓰는 wasm 대체본은 빼도 된다
      "./node_modules/@prisma/client/runtime/*.wasm*",
      "./node_modules/@prisma/client/runtime/query_engine_bg.*",
      "./node_modules/@prisma/client/runtime/query_compiler_bg.*",
      "./node_modules/@prisma/client/runtime/edge*",
      "./node_modules/@prisma/client/runtime/react-native*",
      "./node_modules/@prisma/client/runtime/wasm*",
      "./node_modules/@prisma/client/runtime/*.map",
      "./node_modules/.prisma/client/query_engine_bg.*",
      "./node_modules/.prisma/client/*.wasm",
      "./node_modules/@img/sharp-wasm32/**/*",
    ],
  },
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
