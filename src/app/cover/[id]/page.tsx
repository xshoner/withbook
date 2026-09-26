import { notFound } from "next/navigation";
import CoverSheet from "@/components/cover/CoverSheet";
import PrintReady from "@/components/cover/PrintReady";
import { coverLayout, googleFontsHref } from "@/lib/cover/spec";
import { loadCover } from "@/lib/cover/store";

export const dynamic = "force-dynamic";

/** 표지 PDF 조판용 페이지 — 서버 안 Chromium이 열어 재단 여백 포함 크기 한 장으로 인쇄한다 */
export default async function CoverPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await loadCover(id).catch(() => null);
  if (!r) notFound();
  const l = coverLayout(r.design);
  return (
    <>
      <link rel="stylesheet" href={googleFontsHref()} precedence="default" />
      <style>{`@page { size: ${l.sheetW}mm ${l.sheetH}mm; margin: 0 } html, body { margin: 0; padding: 0; background: #fff !important; height: auto } body { -webkit-print-color-adjust: exact; print-color-adjust: exact }`}</style>
      <CoverSheet design={r.design} assetSrc={(a) => `/api/assets/${a}`} />
      <PrintReady />
    </>
  );
}
