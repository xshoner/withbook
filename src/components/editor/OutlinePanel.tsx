"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { confirmDialog, toast, toastError } from "../ui/feedback";

type OutlineState = { outline: string | null; edited: boolean; stale: boolean };

/**
 * 집필 전 개요 보기·고치기 (스케치 칸 아래).
 * - [개요 보기·수정]: 저장된 개요를 불러오고, 없으면 [개요 만들기]로 AI가 스케치·분량으로 짠다
 * - 고친 개요를 [저장]하면 [AI 집필하기]가 그 개요를 그대로 쓴다 (edited)
 * - 스케치가 개요를 만든 뒤 바뀌었으면 "오래됨"을 알리고 [개요 다시 만들기]를 권한다 (stale)
 */
export default function OutlinePanel({
  sectionId,
  sketch,
  targetPages,
  open,
  onOpenChange,
  beforeRequest,
  disabled,
  disabledReason,
}: {
  sectionId: string;
  sketch: string;
  targetPages: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 요청 전에 밀린 스케치를 저장한다 (서버가 지금 스케치로 오래됨을 판단하게) */
  beforeRequest: () => Promise<boolean>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [data, setData] = useState<OutlineState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<null | "load" | "gen" | "save" | "del">(null);
  const [unavailable, setUnavailable] = useState(false);
  const alive = useRef(true);
  /** 서버에 있는 개요 — 고치던 글(draft)을 조용한 다시 읽기가 덮지 않게 비교한다 */
  const serverOutline = useRef<string | null>(null);
  const targetPagesRef = useRef(targetPages);
  targetPagesRef.current = targetPages;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setBusy("load");
      try {
        const r = await api<OutlineState>(`/api/sections/${sectionId}/outline?targetPages=${targetPagesRef.current}`);
        if (!alive.current) return;
        setUnavailable(false);
        setData(r);
        // 고치던 글은 덮지 않는다 — 아직 고치지 않았을 때만 새 개요로
        const prev = serverOutline.current ?? "";
        serverOutline.current = r.outline;
        setDraft((d) => (d !== prev ? d : (r.outline ?? "")));
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof Error && /\(404\)/.test(e.message)) setUnavailable(true);
        else if (!quiet) toastError(e, "개요를 불러오지 못했습니다: ");
      } finally {
        if (!quiet && alive.current) setBusy(null);
      }
    },
    [sectionId],
  );

  // 처음 한 번 조용히 불러와 닫혀 있을 때도 상태(저장한 개요 · 오래됨)를 보여 준다
  useEffect(() => {
    setData(null);
    setDraft("");
    serverOutline.current = null;
    void load(true);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  // 스케치·분량을 고치면(자동 저장 뒤) 오래됨 표시를 다시 받는다
  const firstSketch = useRef(true);
  useEffect(() => {
    if (firstSketch.current) {
      firstSketch.current = false;
      return;
    }
    if (!data?.outline) return;
    const t = setTimeout(() => void load(true), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch, targetPages]);

  async function generate() {
    if (disabled) return;
    const dirty = !!data?.outline && draft !== data.outline;
    if ((data?.edited || dirty) && !(await confirmDialog("고친 개요를 버리고 AI가 스케치로 새로 짤까요?", { okLabel: "다시 만들기" }))) return;
    setBusy("gen");
    try {
      if (!(await beforeRequest())) throw new Error("스케치 저장을 완료한 뒤 다시 시도하세요.");
      const r = await api<{ outline: string }>(`/api/sections/${sectionId}/outline`, { method: "POST", json: { sketch, targetPages } });
      if (!alive.current) return;
      serverOutline.current = r.outline;
      setData({ outline: r.outline, edited: false, stale: false });
      setDraft(r.outline);
      onOpenChange(true);
    } catch (e) {
      toastError(e, "개요를 만들지 못했습니다: ");
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function save() {
    const outline = draft.trim();
    if (!outline) return toast("개요가 비어 있습니다. 지우려면 [지우기]를 누르세요.");
    setBusy("save");
    try {
      const r = await api<{ outline: string }>(`/api/sections/${sectionId}/outline`, { method: "PUT", json: { outline, targetPages } });
      if (!alive.current) return;
      // 서버가 파트 형식으로 정리한 개요를 보여 준다
      const saved = r.outline || outline;
      serverOutline.current = saved;
      setData({ outline: saved, edited: true, stale: false });
      setDraft(saved);
      toast.success("개요를 저장했습니다. [AI 집필하기]가 이 개요대로 씁니다.");
    } catch (e) {
      toastError(e, "개요를 저장하지 못했습니다: ");
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirmDialog("저장한 개요를 지울까요? 집필할 때 AI가 개요를 새로 짭니다.", { okLabel: "지우기", danger: true }))) return;
    setBusy("del");
    try {
      await api(`/api/sections/${sectionId}/outline`, { method: "DELETE" });
      if (!alive.current) return;
      serverOutline.current = null;
      setData({ outline: null, edited: false, stale: false });
      setDraft("");
    } catch (e) {
      toastError(e, "개요를 지우지 못했습니다: ");
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const dirty = !!data && draft !== (data.outline ?? "");
  const canSave = !!draft.trim() && (dirty || !data?.edited);
  return (
    <div className="mt-2 text-[11px] text-sky-900">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded border border-sky-300 bg-white px-2 py-0.5 font-semibold text-sky-800 hover:bg-sky-100"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          title="AI가 집필할 때 따를 개요(파트별 소제목·요점)를 미리 보고 고칩니다"
        >
          {open ? "▾" : "▸"} 개요 보기·수정
        </button>
        {data?.edited && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">저장한 개요로 집필합니다</span>}
        {data?.outline && data.stale && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">스케치가 바뀌어 개요가 오래됨</span>}
        {busy === "gen" && <span className="text-sky-600">개요 짜는 중… (1분 안팎)</span>}
      </div>
      {open && (
        <div className="mt-1.5 rounded border border-sky-200 bg-white p-2">
          {unavailable ? (
            <p className="text-stone-500">[AI 집필하기]가 개요를 알아서 짭니다.</p>
          ) : busy === "load" && !data ? (
            <p className="text-stone-400">불러오는 중…</p>
          ) : !data?.outline && !draft ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-stone-500">아직 개요가 없습니다. 스케치와 분량({targetPages}쪽)으로 AI가 개요를 짭니다.</span>
              <button className="btn-accent px-2 py-0.5 text-[11px]" disabled={disabled || !!busy} title={disabled ? disabledReason : undefined} onClick={generate}>
                {busy === "gen" ? "만드는 중…" : "개요 만들기"}
              </button>
            </div>
          ) : (
            <>
              {data?.stale && (
                <p className="mb-1.5 rounded bg-amber-50 px-2 py-1 text-amber-800">개요를 만든 뒤 스케치가 바뀌었습니다. [개요 다시 만들기]로 새로 짜거나, 이 개요를 고쳐 저장하세요.</p>
              )}
              <textarea
                className="w-full resize-y rounded border border-sky-200 p-2 font-sans text-[12px] leading-5 outline-none focus:border-sky-400"
                rows={10}
                aria-label="집필 개요"
                value={draft}
                disabled={!!busy && busy !== "load"}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button className="btn-primary px-2 py-0.5 text-[11px]" disabled={!canSave || !!busy} onClick={save}>
                  {busy === "save" ? "저장 중…" : "저장 — 이 개요로 집필"}
                </button>
                <button className="btn px-2 py-0.5 text-[11px]" disabled={disabled || !!busy} title={disabled ? disabledReason : "스케치·분량으로 AI가 개요를 새로 짭니다"} onClick={generate}>
                  {busy === "gen" ? "만드는 중…" : "개요 다시 만들기"}
                </button>
                {data?.outline && (
                  <button className="text-stone-400 hover:text-red-600 hover:underline" disabled={!!busy} onClick={remove}>
                    지우기
                  </button>
                )}
                <span className="ml-auto text-stone-400">
                  {data?.edited && !dirty ? "저장됨 — 집필 때 그대로 씁니다" : "고친 뒤 저장하면 집필이 이 개요를 그대로 씁니다"}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
