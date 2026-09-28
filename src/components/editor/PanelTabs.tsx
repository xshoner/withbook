"use client";

import type { ReactNode } from "react";

export type PanelTab = "ai" | "refs" | "memory" | "images" | "versions" | "proof" | "notes";

/**
 * 탭 색 — 고른 탭의 밑줄과 설명 띠에만 쓴다(Tailwind가 찾을 수 있게 클래스는 글자 그대로 둔다).
 * 예전에는 탭마다 색 아이콘 상자를 달아 좁은 패널(320px)에서 글자가 잘려 읽히지 않았다 — 이제 글자만, 이름 전체를 보인다.
 */
const TONE = {
  violet: { line: "border-violet-600", bar: "border-violet-500 bg-violet-50 text-violet-900" },
  emerald: { line: "border-emerald-600", bar: "border-emerald-500 bg-emerald-50 text-emerald-900" },
  teal: { line: "border-teal-600", bar: "border-teal-500 bg-teal-50 text-teal-900" },
  indigo: { line: "border-indigo-600", bar: "border-indigo-500 bg-indigo-50 text-indigo-900" },
  sky: { line: "border-sky-600", bar: "border-sky-500 bg-sky-50 text-sky-900" },
  rose: { line: "border-rose-600", bar: "border-rose-500 bg-rose-50 text-rose-900" },
  amber: { line: "border-amber-600", bar: "border-amber-500 bg-amber-50 text-amber-900" },
} as const;

type TabDef = { k: PanelTab; label: string; tone: keyof typeof TONE; desc: string };

/** 쓰는 중에 쓰는 것 / 쓴 뒤 살펴보는 것 — 두 줄로 나눠 한 줄에 3~4개만 둔다 */
export const PANEL_GROUPS: { name: string; tabs: TabDef[] }[] = [
  {
    name: "쓰기",
    tabs: [
      { k: "ai", label: "AI 옵션", tone: "violet", desc: "집필 추가 지시 · 교정 강도 · AI가 참고하는 것" },
      { k: "refs", label: "자료", tone: "emerald", desc: "이 절의 근거 자료 — AI 집필이 참고하고 출처를 표시" },
      { k: "memory", label: "책 기억", tone: "teal", desc: "작가가 확정한 정의·주장·쓴 사례·쓰지 않을 것·표현 유지 — 모든 AI 작업이 지킨다" },
      { k: "images", label: "이미지", tone: "indigo", desc: "문단에 맞는 도표·그래프·도식 추천 또는 직접 만들기 → 승인하면 캡션과 함께 삽입" },
    ],
  },
  {
    name: "검토",
    tabs: [
      { k: "versions", label: "버전 기록", tone: "sky", desc: "저장된 이전 원고 — 비교하고 되돌리기" },
      { k: "proof", label: "교정 내역", tone: "rose", desc: "교정·교열이 고친 곳 — 하나씩 또는 전체 되돌리기" },
      { k: "notes", label: "각주", tone: "amber", desc: "이 절의 각주 목록 — 고치기·AI로 다시 쓰기·지우기" },
    ],
  },
];
export const PANEL_TABS: TabDef[] = PANEL_GROUPS.flatMap((g) => g.tabs);

/**
 * 오른쪽 패널 탭 — [쓰기] [검토] 두 줄, 글자만 있는 버튼(이름 전체가 보인다) + 고른 탭의 색 밑줄 + 설명 띠.
 * 좌우 방향키로 탭을 옮긴다(탭 목록 표준 동작).
 */
export default function PanelTabs({ tab, onTab, labels }: { tab: PanelTab; onTab: (t: PanelTab) => void; labels?: Partial<Record<PanelTab, ReactNode>> }) {
  const cur = PANEL_TABS.find((t) => t.k === tab) ?? PANEL_TABS[0];
  const move = (dir: 1 | -1) => {
    const i = PANEL_TABS.findIndex((t) => t.k === tab);
    const next = PANEL_TABS[(i + dir + PANEL_TABS.length) % PANEL_TABS.length];
    onTab(next.k);
    requestAnimationFrame(() => document.getElementById(`panel-tab-${next.k}`)?.focus());
  };
  return (
    <div className="border-b border-stone-200 bg-white">
      <div
        role="tablist"
        aria-label="보조 패널"
        className="space-y-0.5 px-1.5 pt-1.5"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            move(e.key === "ArrowRight" ? 1 : -1);
          }
        }}
      >
        {PANEL_GROUPS.map((g) => (
          <div key={g.name} className="flex items-stretch gap-1">
            <span className="w-7 shrink-0 self-center text-[10px] font-semibold text-stone-400">{g.name}</span>
            {g.tabs.map((t) => {
              const on = t.k === tab;
              return (
                <button
                  key={t.k}
                  id={`panel-tab-${t.k}`}
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  title={t.desc}
                  onClick={() => onTab(t.k)}
                  className={`min-w-0 flex-1 whitespace-nowrap rounded-t-md border-b-2 px-1 py-1.5 text-[12.5px] leading-4 transition ${
                    on ? `${TONE[t.tone].line} bg-stone-100 font-semibold text-stone-900` : "border-transparent text-stone-600 hover:bg-stone-50 hover:text-stone-900"
                  }`}
                >
                  {labels?.[t.k] ?? t.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className={`border-l-4 px-3 py-1.5 text-[11px] leading-4 ${TONE[cur.tone].bar}`}>
        <b className="mr-1">{labels?.[cur.k] ?? cur.label}</b>
        <span className="opacity-80">{cur.desc}</span>
      </div>
    </div>
  );
}
