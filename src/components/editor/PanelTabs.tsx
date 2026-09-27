"use client";

import type { ReactNode } from "react";

export type PanelTab = "ai" | "refs" | "images" | "versions" | "proof" | "notes";

/** 탭마다 색·아이콘·설명을 달리해 한눈에 구분한다 (Tailwind가 찾을 수 있게 클래스는 글자 그대로 둔다) */
const TONE = {
  violet: { on: "bg-white text-violet-900 ring-violet-300", icon: "bg-violet-600 text-white", iconOff: "bg-violet-100 text-violet-700", bar: "border-violet-500 bg-violet-50 text-violet-900" },
  emerald: { on: "bg-white text-emerald-900 ring-emerald-300", icon: "bg-emerald-600 text-white", iconOff: "bg-emerald-100 text-emerald-700", bar: "border-emerald-500 bg-emerald-50 text-emerald-900" },
  indigo: { on: "bg-white text-indigo-900 ring-indigo-300", icon: "bg-indigo-600 text-white", iconOff: "bg-indigo-100 text-indigo-700", bar: "border-indigo-500 bg-indigo-50 text-indigo-900" },
  sky: { on: "bg-white text-sky-900 ring-sky-300", icon: "bg-sky-600 text-white", iconOff: "bg-sky-100 text-sky-700", bar: "border-sky-500 bg-sky-50 text-sky-900" },
  rose: { on: "bg-white text-rose-900 ring-rose-300", icon: "bg-rose-600 text-white", iconOff: "bg-rose-100 text-rose-700", bar: "border-rose-500 bg-rose-50 text-rose-900" },
  amber: { on: "bg-white text-amber-900 ring-amber-300", icon: "bg-amber-600 text-white", iconOff: "bg-amber-100 text-amber-800", bar: "border-amber-500 bg-amber-50 text-amber-900" },
} as const;

const svg = (d: ReactNode) => (
  <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const ICON: Record<PanelTab, ReactNode> = {
  ai: svg(<path d="M10 2.5l1.8 4.2 4.2 1.8-4.2 1.8L10 14.5l-1.8-4.2L4 8.5l4.2-1.8zM15.5 13.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" />),
  refs: svg(<path d="M3.5 4.5c2-1 4.5-1 6.5.5 2-1.5 4.5-1.5 6.5-.5v11c-2-1-4.5-1-6.5.5-2-1.5-4.5-1.5-6.5-.5zM10 5v11" />),
  images: svg(
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="M3 15l4.5-4.5 3 3 2.5-2.5L17 15" />
    </>,
  ),
  versions: svg(
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 2" />
    </>,
  ),
  proof: svg(<path d="M4 10.5l3.5 3.5L16 5.5" />),
  notes: svg(<path d="M5 3.5h7l3 3v10H5zM12 3.5v3h3M7.5 10h5M7.5 13h3.5" />),
};

export const PANEL_TABS: { k: PanelTab; label: string; tone: keyof typeof TONE; desc: string }[] = [
  { k: "ai", label: "AI 옵션", tone: "violet", desc: "집필 추가 지시 · 교정 강도 · AI가 참고하는 것" },
  { k: "refs", label: "자료", tone: "emerald", desc: "이 절의 근거 자료 — AI 집필이 참고하고 출처를 표시" },
  { k: "images", label: "이미지", tone: "indigo", desc: "문단에 맞는 논문 도표·그래프·도식 추천 → 승인하면 캡션과 함께 삽입" },
  { k: "versions", label: "버전 기록", tone: "sky", desc: "저장된 이전 원고 — 비교하고 되돌리기" },
  { k: "proof", label: "교정 내역", tone: "rose", desc: "교정·교열이 고친 곳 — 하나씩 또는 전체 되돌리기" },
  { k: "notes", label: "각주", tone: "amber", desc: "이 절의 각주 목록 — 고치기·AI로 다시 쓰기·지우기" },
];

/**
 * 오른쪽 패널 탭 — 3×2 격자의 색 아이콘 버튼 + 고른 탭의 색 띠(이름·설명).
 * 예전 한 줄 밑줄 탭은 다섯 개가 비슷해 보여 구분이 어려웠다.
 */
export default function PanelTabs({ tab, onTab, labels }: { tab: PanelTab; onTab: (t: PanelTab) => void; labels?: Partial<Record<PanelTab, ReactNode>> }) {
  const cur = PANEL_TABS.find((t) => t.k === tab) ?? PANEL_TABS[0];
  return (
    <div className="border-b border-stone-200">
      <div role="tablist" aria-label="보조 패널" className="grid grid-cols-3 gap-1 bg-stone-200/70 p-1.5">
        {PANEL_TABS.map((t) => {
          const on = t.k === tab;
          const tone = TONE[t.tone];
          return (
            <button
              key={t.k}
              role="tab"
              aria-selected={on}
              title={t.desc}
              onClick={() => onTab(t.k)}
              className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs transition ${on ? `font-semibold shadow-sm ring-1 ${tone.on}` : "text-stone-600 hover:bg-white/70"}`}
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${on ? tone.icon : tone.iconOff}`}>{ICON[t.k]}</span>
              <span className="truncate">{labels?.[t.k] ?? t.label}</span>
            </button>
          );
        })}
      </div>
      <div className={`border-l-4 px-3 py-1.5 text-[11px] leading-4 ${TONE[cur.tone].bar}`}>
        <b className="mr-1">{labels?.[cur.k] ?? cur.label}</b>
        <span className="opacity-80">{cur.desc}</span>
      </div>
    </div>
  );
}
