import type { Metadata } from "next";
import "./globals.css";
import { FeedbackHost } from "@/components/ui/feedback";

export const metadata: Metadata = {
  title: "withbook — 작가 서포트 집필 에이전트",
  description: "스케치를 문체 그대로 원고로, 부크크 A5 규격 그대로 PDF·HWPX로",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // 브라우저 확장 프로그램이 <html>/<body>에 속성을 끼워 넣어도 hydration 경고를 내지 않게 한다 (이 두 요소의 속성만 해당)
    <html lang="ko" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        <FeedbackHost />
      </body>
    </html>
  );
}
