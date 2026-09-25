"use client";

import { useEffect, useRef, useState } from "react";

/** 도구줄의 펼침 메뉴 — 바깥을 누르거나 Esc를 누르면 닫힌다. 안의 버튼을 누르면 닫힌다 */
export default function Menu({ label, tone = "", title, disabled, children }: { label: string; tone?: string; title?: string; disabled?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        className={`rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold shadow-sm hover:bg-stone-50 disabled:opacity-40 ${tone}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} // 본문 선택을 잃지 않게
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-40 mt-1 min-w-36 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-xl" onClick={(e) => (e.target as HTMLElement).closest("button") && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
