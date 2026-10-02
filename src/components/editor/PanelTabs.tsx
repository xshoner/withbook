"use client";

import type { ReactNode } from "react";

export type PanelTab = "ai" | "refs" | "memory" | "images" | "versions" | "proof" | "notes";

/** 탭 이름은 짧게(좁은 패널 한 줄에 모두 보이게), 설명은 마우스를 올리면 보인다 */
type TabDef = { k: PanelTab; label: string; desc: string };

export const PANEL_TABS: TabDef[] = [
  { k: "ai", label: "지시", desc: "AI 집필에 덧붙일 지시 · 교정 강도" },
  { k: "refs", label: "자료", desc: "이 절의 근거 자료 — AI가 참고하고 출처를 표시합니다" },
  { k: "memory", label: "책 기억", desc: "작가가 정한 정의·표현 — 모든 AI 작업이 지킵니다" },
  { k: "images", label: "이미지", desc: "문단에 맞는 도표·그림 추천 또는 AI로 만들기" },
  { k: "notes", label: "각주", desc: "이 절의 각주 목록 · 자동 각주" },
  { k: "proof", label: "교정", desc: "교정·교열이 고친 곳 — 하나씩 또는 전체 되돌리기" },
  { k: "versions", label: "기록", desc: "저장된 이전 원고 — 비교하고 되돌리기" },
];

/**
 * 오른쪽 패널 탭 — 한 줄, 짧은 이름 + 고른 탭 밑줄.
 * 좌우 방향키로 탭을 옮긴다(탭 목록 표준 동작).
 */
export default function PanelTabs({ tab, onTab, labels }: { tab: PanelTab; onTab: (t: PanelTab) => void; labels?: Partial<Record<PanelTab, ReactNode>> }) {
  const move = (dir: 1 | -1) => {
    const i = PANEL_TABS.findIndex((t) => t.k === tab);
    const next = PANEL_TABS[(i + dir + PANEL_TABS.length) % PANEL_TABS.length];
    onTab(next.k);
    requestAnimationFrame(() => document.getElementById(`panel-tab-${next.k}`)?.focus());
  };
  return (
    <div
      role="tablist"
      aria-label="보조 패널"
      className="flex border-b border-stone-200 bg-white px-1 pt-1"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          move(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      {PANEL_TABS.map((t) => {
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
            className={`min-w-0 flex-1 whitespace-nowrap border-b-2 px-0.5 py-2 text-[12.5px] leading-4 transition ${
              on ? "border-amber-600 font-semibold text-stone-900" : "border-transparent text-stone-500 hover:text-stone-900"
            }`}
          >
            {labels?.[t.k] ?? t.label}
          </button>
        );
      })}
    </div>
  );
}
