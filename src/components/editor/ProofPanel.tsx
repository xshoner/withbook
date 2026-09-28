"use client";

import { useState } from "react";

export type AppliedChange = {
  paragraph: number;
  before: string;
  after: string;
  type: string;
  reason: string;
  state: "applied" | "reverted" | "failed";
};

const TYPE: Record<string, string> = {
  spacing: "띄어쓰기",
  spelling: "맞춤법",
  punctuation: "문장부호",
  loanword: "외래어",
  number: "숫자·단위",
  glossary: "용어 통일",
  grammar: "문법",
  redundancy: "중복·번역투",
};

export default function ProofPanel({
  changes,
  busy,
  onRevert,
  onRevertAll,
  onLocate,
  onKeep,
}: {
  changes: AppliedChange[] | null;
  busy: boolean;
  onRevert: (i: number) => void;
  onRevertAll: () => void;
  onLocate: (c: AppliedChange) => void;
  /** 되돌린 제안을 '표현 유지'로 책의 기억에 남긴다 — 다음 교정·퇴고가 같은 곳을 다시 고치자고 하지 않게 */
  onKeep?: (c: AppliedChange) => Promise<boolean>;
}) {
  const [kept, setKept] = useState<Set<number>>(new Set());
  if (busy) return <p className="p-4 text-center text-xs text-stone-500">교정·교열 중… 문단 단위로 검토하고 있습니다.</p>;
  if (!changes) return <p className="p-4 text-center text-xs text-stone-400">[교정·교열]을 누르면 이 절 전체에 일괄 적용되고, 바뀐 내용이 여기에 나옵니다.</p>;
  const applied = changes.filter((c) => c.state === "applied").length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2 text-xs">
        <span>
          적용 <b>{applied}</b> · 되돌림 {changes.filter((c) => c.state === "reverted").length} · 적용 실패 {changes.filter((c) => c.state === "failed").length}
        </span>
        {applied > 0 && (
          <button className="btn-ghost text-xs text-red-600" onClick={onRevertAll}>
            전체 되돌리기
          </button>
        )}
      </div>
      {changes.length === 0 && <p className="p-4 text-center text-xs text-stone-500">고칠 곳을 찾지 못했습니다. 👍</p>}
      <ul className="min-h-0 flex-1 divide-y divide-stone-100 overflow-auto">
        {changes.map((c, i) => (
          <li key={i} className={`px-3 py-2 text-xs ${c.state === "failed" ? "opacity-50" : c.state === "reverted" ? "opacity-70" : ""}`}>
            <div className="mb-1 flex items-center justify-between">
              <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-600">
                {TYPE[c.type] ?? c.type} · {c.paragraph}문단
              </span>
              {c.state === "applied" && (
                <span className="flex gap-1">
                  <button className="btn-ghost px-1 py-0 text-[11px]" onClick={() => onLocate(c)}>
                    위치
                  </button>
                  <button className="btn-ghost px-1 py-0 text-[11px]" onClick={() => onRevert(i)}>
                    되돌리기
                  </button>
                </span>
              )}
              {c.state === "reverted" && (
                <span className="flex items-center gap-1 text-stone-400">
                  되돌림
                  {onKeep && !kept.has(i) && (
                    <button
                      className="btn-ghost px-1 py-0 text-[11px] text-amber-800"
                      title="이 표현을 책의 기억(표현 유지)에 남깁니다 — 다음 교정·퇴고가 다시 고치자고 하지 않습니다"
                      onClick={async () => (await onKeep(c)) && setKept(new Set(kept).add(i))}
                    >
                      다시 제안 안 함
                    </button>
                  )}
                  {kept.has(i) && <span className="text-amber-700">· 표현 유지로 기억</span>}
                </span>
              )}
              {c.state === "failed" && <span className="text-red-500">적용 실패</span>}
            </div>
            <div className="font-book leading-5">
              <span className="bg-red-50 text-red-700 line-through">{c.before}</span>
              <span className="mx-1 text-stone-400">→</span>
              <span className="bg-emerald-50 text-emerald-800">{c.after}</span>
            </div>
            {c.reason && <div className="mt-0.5 text-stone-500">{c.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
