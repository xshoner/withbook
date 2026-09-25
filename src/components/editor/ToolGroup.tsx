"use client";

/** 도구줄 기능 묶음 — 왼쪽 색 이름표 + 칸막이로 나눈 버튼들 */
export default function ToolGroup({ label, tone, title, children }: { label: string; tone: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-stone-300 bg-white shadow-sm" title={title}>
      <span className={`flex items-center px-1.5 text-[11px] font-semibold tracking-tight text-white ${tone}`}>{label}</span>
      <div className="flex items-center divide-x divide-stone-200">{children}</div>
    </div>
  );
}
