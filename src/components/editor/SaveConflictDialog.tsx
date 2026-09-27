"use client";

import { useEffect, useMemo, useState } from "react";
import { docParagraphs, parseDoc } from "@/lib/doc/doc";
import { ParagraphDiff } from "../InlineDiff";

/**
 * 저장 충돌 — 이 절을 연 뒤 다른 창이나 서버 작업(책 전체 바꾸기·장 퇴고·팩트체크 등)이 먼저 고쳤다.
 * 조용히 덮어쓰지 않고 고르게 한다. 어느 쪽을 골라도 다른 쪽 원고는 버전 기록(저장 충돌)에 남는다.
 */
export default function SaveConflictDialog(props: {
  label: string;
  server: string;
  mine: string | undefined;
  onKeepMine: () => Promise<void>;
  onTakeServer: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"" | "mine" | "server">("");
  const [err, setErr] = useState("");
  const [diff, setDiff] = useState(false);
  const serverParas = useMemo(() => docParagraphs(parseDoc(props.server)), [props.server]);
  const mineParas = useMemo(() => (props.mine === undefined ? [] : docParagraphs(parseDoc(props.mine))), [props.mine]);
  useEffect(() => {
    // 골라야 닫힌다 — Esc가 뒤의 편집기·AI 중지로 새지 않게만 막는다
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && e.preventDefault();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const run = (which: "mine" | "server", fn: () => Promise<void>) => async () => {
    setBusy(which);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };
  const chars = (ps: string[]) => ps.join("").length.toLocaleString();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="저장 충돌" className="flex max-h-[88vh] w-[720px] max-w-full flex-col rounded-xl bg-white shadow-2xl">
        <div className="border-b border-stone-200 px-5 py-3">
          <h2 className="font-semibold text-red-800">저장 충돌 — {props.label}</h2>
          <p className="mt-1 text-sm leading-6 text-stone-700">
            이 절을 연 뒤 다른 창이나 서버 작업(책 전체 바꾸기·장 퇴고·팩트체크 등)이 이 절을 먼저 고쳤습니다. 그대로 저장하면 그 수정이 사라지므로 저장을 멈췄습니다.
            <br />
            어느 쪽을 골라도 <b>고르지 않은 원고는 버전 기록(저장 충돌)에 남습니다</b>.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-3 text-sm">
          <div className="mb-2 flex items-center gap-3 text-xs text-stone-500">
            <span>다른 곳에서 고친 원고 {chars(serverParas)}자</span>
            <span>·</span>
            <span>이 창의 내 원고 {chars(mineParas)}자</span>
            <label className="ml-auto flex items-center gap-1">
              <input type="checkbox" checked={diff} onChange={(e) => setDiff(e.target.checked)} /> 바뀐 곳 보기
            </label>
          </div>
          {diff && (
            <div className="max-h-80 overflow-auto rounded border border-stone-200 p-2">
              <p className="mb-1 text-[11px] text-stone-400">빨강 = 다른 곳 원고에만 있음 · 초록 = 내 원고에만 있음</p>
              <ParagraphDiff before={serverParas} after={mineParas} />
            </div>
          )}
          {err && <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 px-5 py-3">
          <button className="btn" disabled={!!busy} onClick={run("server", props.onTakeServer)} title="내 원고는 버전 기록에 남기고, 다른 곳에서 고친 원고를 불러옵니다">
            {busy === "server" ? "불러오는 중…" : "다른 곳 원고 불러오기"}
          </button>
          <button className="btn-primary ml-auto" disabled={!!busy} onClick={run("mine", props.onKeepMine)} title="다른 곳에서 고친 원고는 버전 기록에 남기고, 내 원고로 저장합니다">
            {busy === "mine" ? "저장하는 중…" : "내 원고로 저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
