/**
 * 편집 화면 단축키 — 단축키 창·AI 옵션 안내·버튼 툴팁이 모두 이 목록을 쓴다 (한 곳만 고치면 된다).
 */
export const KEYS = {
  save: "Ctrl+S",
  prevSection: "Alt+↑",
  nextSection: "Alt+↓",
  nextEmpty: "Alt+Shift+↓",
  find: "Ctrl+F",
  replace: "Ctrl+H",
  stop: "Esc",
  help: "?",
} as const;

export const SHORTCUTS: [string, string][] = [
  [KEYS.save, "지금 저장"],
  [`${KEYS.prevSection} / ${KEYS.nextSection}`, "이전 / 다음 절"],
  [KEYS.nextEmpty, "아직 본문이 없는 다음 절"],
  [KEYS.find, "이 절에서 찾기"],
  [KEYS.replace, "이 절에서 바꾸기"],
  ["Enter / Shift+Enter", "찾기 칸에서 다음 / 이전 결과"],
  [KEYS.stop, "창·메뉴 닫기 · 진행 창이 뜬 절에서 AI 집필 중지 (쓴 데까지 넣음)"],
  ["Ctrl+Z / Ctrl+Y", "실행 취소 / 다시 실행"],
  ["F2", "목차에서 고른 절 이름 바꾸기"],
  ["Space + 화살표", "목차에서 ⋮⋮에 초점을 두고 순서 바꾸기"],
  [KEYS.help, "단축키 목록 열기·닫기"],
];

/** 한 줄 안내 (AI 옵션 탭) */
export const SHORTCUT_HINT = `${KEYS.save} 저장 · ${KEYS.stop} 집필 중지 · ${KEYS.prevSection}/${KEYS.nextSection} 이전/다음 절 · ${KEYS.find} 찾기 · ${KEYS.help} 단축키 전체`;

/** 절 이동 단축키인가 — Alt(맥 Option)+↑/↓ (Ctrl·Cmd와 함께 누르면 아니다) */
export function sectionNavKey(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; key: string }): "prev" | "next" | "nextEmpty" | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === "ArrowDown") return e.shiftKey ? "nextEmpty" : "next";
  if (e.key === "ArrowUp" && !e.shiftKey) return "prev";
  return null;
}
