"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PagedInfo } from "./types";

/** 독자 시점 펼침면 미리보기 — 짝수=왼쪽, 홀수=오른쪽, 1쪽은 오른쪽 단독 */
export default function PreviewPane({ projectId, focus, reloadKey, onInfo }: { projectId: string; focus: string | null; reloadKey: number; onInfo: (i: PagedInfo) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"spread" | "single">("spread");
  const [zoom, setZoom] = useState(0.85);
  const [guides, setGuides] = useState({ trim: true, safe: false, body: false });
  const [gray, setGray] = useState(true);
  const [info, setInfo] = useState<PagedInfo | null>(null);
  const [spread, setSpread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const src = useMemo(() => {
    const q = new URLSearchParams({ mode: "preview", view, gTrim: guides.trim ? "1" : "0", gSafe: guides.safe ? "1" : "0", gBody: guides.body ? "1" : "0" });
    q.set("t", String(reloadKey + nonce));
    return `/book/${projectId}?${q}`;
    // 가이드·보기·선택 절 변경은 postMessage로 처리하므로 초기값만 URL에 반영 (목차 클릭에 다시 조판하지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reloadKey, nonce]);

  useEffect(() => setLoading(true), [src]);

  const post = (m: object) => ref.current?.contentWindow?.postMessage(m, location.origin);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || e.origin !== location.origin || e.data?.type !== "paged" || e.data.mode !== "preview") return;
      setInfo(e.data.info);
      onInfo(e.data.info);
      setLoading(false);
      post({ type: "zoom", z: zoom });
      const f = focusRef.current;
      if (f && e.data.info.sections[f]) {
        post({ type: "focus", sid: f });
        setSpread(Math.floor(e.data.info.sections[f].startIdx / 2));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // 목차에서 다른 절을 고르면 이미 조판된 쪽에서 그 절로 옮겨 간다
  useEffect(() => {
    if (!focus || !info?.sections[focus]) return;
    post({ type: "focus", sid: focus });
    setSpread(Math.floor(info.sections[focus].startIdx / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => post({ type: "zoom", z: zoom }), [zoom]);
  useEffect(() => post({ type: "guides", ...guides }), [guides]);
  useEffect(() => post({ type: "view", view }), [view]);
  useEffect(() => post({ type: "gray", on: gray }), [gray]);

  const spreads = info ? Math.floor(info.total / 2) + 1 : 0;
  const go = (s: number) => {
    const n = Math.max(0, Math.min(spreads - 1, s));
    setSpread(n);
    post({ type: "goto", index: Math.max(0, n * 2 - 1) });
  };
  const spreadLabel = (s: number) => {
    if (!info) return "";
    const left = info.pages[s * 2 - 1];
    const right = info.pages[s * 2];
    const f = (p?: { n: number; i: number }) => (p ? (p.n ? `${p.n}쪽` : `(${p.i}면)`) : "—");
    return `${f(left)} | ${f(right)}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2 text-xs">
        <div className="flex overflow-hidden rounded-md border border-stone-300">
          {(["spread", "single"] as const).map((v) => (
            <button key={v} className={`px-2.5 py-1 ${view === v ? "bg-stone-800 text-white" : "bg-white"}`} onClick={() => setView(v)}>
              {v === "spread" ? "펼침면" : "한 쪽씩"}
            </button>
          ))}
        </div>
        <button className="btn px-2 py-1 text-xs" onClick={() => go(spread - 1)} disabled={!info}>
          ◀
        </button>
        <span className="min-w-28 text-center text-stone-600">{spreadLabel(spread)}</span>
        <button className="btn px-2 py-1 text-xs" onClick={() => go(spread + 1)} disabled={!info}>
          ▶
        </button>
        <span className="text-stone-400">총 {info?.total ?? "…"}면</span>
        <span className="mx-1 h-4 w-px bg-stone-300" />
        {(
          [
            ["trim", "재단선·재단 여백", "text-red-600"],
            ["safe", "안전 영역", "text-blue-600"],
            ["body", "본문 영역", "text-green-700"],
          ] as const
        ).map(([k, l, c]) => (
          <label key={k} className={`flex items-center gap-1 ${c}`}>
            <input type="checkbox" checked={guides[k]} onChange={(e) => setGuides({ ...guides, [k]: e.target.checked })} />
            {l}
          </label>
        ))}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={gray} onChange={(e) => setGray(e.target.checked)} /> 흑백
        </label>
        <select className="ml-auto rounded border border-stone-300 px-1 py-0.5" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          {[0.6, 0.75, 0.85, 1, 1.25].map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <button className="btn px-2 py-1 text-xs" onClick={() => setNonce((n) => n + 1)}>
          ↻ 다시 조판
        </button>
      </div>
      {info && !info.fontOk && (
        <div className="bg-red-50 px-4 py-2 text-xs text-red-700">KoPub바탕체 Light 글꼴을 불러오지 못했습니다. public/fonts 폴더에 KoPubBatangLight.ttf가 있는지 확인하세요.</div>
      )}
      <div className="relative min-h-0 flex-1 bg-stone-300">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-stone-300/70 text-sm text-stone-600">
            <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-stone-600 border-t-transparent" />
            부크크 A5 규격으로 조판 중…
          </div>
        )}
        <iframe ref={ref} src={src} title="미리보기" className="h-full w-full border-0" />
      </div>
      <div className="border-t border-stone-200 bg-white px-4 py-1.5 text-[11px] text-stone-500">
        문서 154×216mm(재단 여백 사방 3mm 포함) → 완성 148×210mm · 안쪽 여백 28mm가 제본 쪽(오른쪽 면은 왼쪽, 왼쪽 면은 오른쪽)에 위치 · 쪽 번호는 바깥쪽 아래
      </div>
    </div>
  );
}
