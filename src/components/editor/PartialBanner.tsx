"use client";

import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { confirmDialog } from "../ui/feedback";
import { clearPartial } from "./aiJobs";

export type PartialDraft = { text: string; mode: string; chars: number; startedAt: string; updatedAt: string };

const MODE: Record<string, string> = { overwrite: "새로 쓰기", continue: "이어쓰기", candidate: "새 버전", newVersion: "새 버전" };

/**
 * 중단된 AI 집필 — 쓰는 도중 창이 닫히거나 연결이 끊기면 서버가 그때까지 쓴 글을 보관한다(GET /api/sections/[id]/partial).
 * 이 절을 열었을 때 돌고 있는 작업이 없고 보관본이 있으면 알려 주고, 본문 끝에 붙이거나 새 버전 후보로 비교하거나 버린다.
 * 서버에 이 기능이 아직 없으면(404) 아무것도 보이지 않는다.
 */
export default function PartialBanner({
  sectionId,
  busy,
  onAppend,
  onCompare,
}: {
  sectionId: string;
  /** 이 절에서 AI가 쓰는 중 — 보관본은 곧 새 글로 바뀌므로 보이지 않는다 */
  busy: boolean;
  onAppend: (text: string) => Promise<boolean>;
  onCompare: (text: string) => void;
}) {
  const [p, setP] = useState<PartialDraft | null>(null);
  const [working, setWorking] = useState(false);
  // 이 절에서 AI가 쓰기 시작하면 보관본은 곧 그 작업의 것이 된다 — 끝난 뒤 옛 보관본을 다시 보이지 않게 버린다
  useEffect(() => {
    if (busy) setP(null);
  }, [busy]);
  useEffect(() => {
    if (busy) return;
    let alive = true;
    api<{ partial: PartialDraft | null }>(`/api/sections/${sectionId}/partial`, { timeoutMs: 20_000 })
      .then((r) => alive && setP(r?.partial?.text?.trim() ? r.partial : null))
      .catch(() => {}); // 아직 없는 기능(404)·연결 오류는 조용히 넘긴다
    return () => {
      alive = false;
    };
    // 절을 열 때 한 번 (돌던 작업이 끝나 busy가 풀리면 서버가 이미 치웠다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);
  if (!p || busy) return null;
  const chars = p.chars || p.text.length;
  const done = async (fn: () => Promise<unknown> | unknown) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <span>
        <b>중단된 AI 집필 {chars.toLocaleString()}자가 보관돼 있습니다</b>
        <span className="ml-1 text-xs text-amber-700">
          ({MODE[p.mode] ?? p.mode} · {fmtDate(p.updatedAt || p.startedAt)} 마지막 글)
        </span>
      </span>
      <button
        className="ml-auto rounded bg-amber-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
        disabled={working}
        onClick={() =>
          done(async () => {
            if (!(await onAppend(p.text))) return;
            await clearPartial(sectionId);
            setP(null);
          })
        }
        title="보관된 글을 지금 본문 끝에 붙입니다 (붙이기 전 원고는 버전 기록에 남습니다)"
      >
        본문 끝에 붙이기
      </button>
      <button
        className="rounded border border-amber-400 bg-white px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-50"
        disabled={working}
        onClick={() => {
          onCompare(p.text); // 후보를 고르거나 버릴 때 보관본을 치운다
          setP(null);
        }}
        title="지금 본문은 그대로 두고 새 버전 후보로 비교합니다"
      >
        새 버전으로 비교
      </button>
      <button
        className="text-xs text-amber-800 hover:underline disabled:opacity-50"
        disabled={working}
        onClick={() =>
          done(async () => {
            if (!(await confirmDialog(`보관된 AI 글 ${chars.toLocaleString()}자를 버릴까요? 되돌릴 수 없습니다.`, { danger: true, okLabel: "버리기" }))) return;
            await clearPartial(sectionId);
            setP(null);
          })
        }
      >
        버리기
      </button>
    </div>
  );
}
