"use client";

import type { ReactNode } from "react";

export type PanelTab = "ai" | "refs" | "memory" | "images" | "versions" | "proof" | "notes";

/** 설명은 마우스를 올리면 보인다. 위 줄 = 쓸 때, 아래 줄 = 쓴 뒤 살펴볼 때 */
type TabDef = { k: PanelTab; label: string; desc: string };

export const PANEL_TABS: TabDef[] = [
  { k: "ai", label: "집필 지시", desc: "AI 집필에 덧붙일 지시 · 교정 강도" },
  { k: "refs", label: "자료", desc: "이 절의 근거 자료 — AI가 참고하고 출처를 표시합니다" },
  { k: "memory", label: "책 기억", desc: "작가가 정한 정의·표현 — 모든 AI 작업이 지킵니다" },
  { k: "images", label: "이미지", desc: "문단에 맞는 도표·그림 추천 또는 AI로 만들기" },
  { k: "notes", label: "각주", desc: "이 절의 각주 목록 · 자동 각주" },
  { k: "proof", label: "교정 내역", desc: "교정·교열이 고친 곳 — 하나씩 또는 전체 되돌리기" },
  { k: "versions", label: "버전 기록", desc: "저장된 이전 원고 — 비교하고 되돌리기" },
];
const ROWS = [PANEL_TABS.slice(0, 4), PANEL_TABS.slice(4)];

/**
 * 오른쪽 패널 탭 — 두 줄, 칸마다 테두리를 둔 단추(서로 잘 구분되게) + 고른 탭은 진하게 채운다.
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
      className="space-y-1 border-b border-stone-200 bg-white p-1.5"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          move(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      {ROWS.map((row, i) => (
        <div key={i} className={`grid gap-1 ${row.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
          {row.map((t) => {
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
                className={`min-w-0 truncate rounded-md border px-1 py-1.5 text-[12.5px] leading-4 transition ${
                  on ? "border-stone-800 bg-stone-800 font-semibold text-white" : "border-stone-300 bg-stone-50 text-stone-700 hover:border-stone-400 hover:bg-white"
                }`}
              >
                {labels?.[t.k] ?? t.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
